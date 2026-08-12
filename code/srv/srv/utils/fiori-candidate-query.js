const cds = require('@sap/cds');

const { SELECT } = cds.ql;

// ---------------------------------------------------------------------------
// The I/O half of the recommendation pipeline: builds the candidate set for
// one extraction run by joining usage facts against the curated overlay and
// (when present) the backend-derived catalog. Aggregation happens in the
// database or over source-bounded row sets - never by downloading raw tables
// to sum in JavaScript.
//
// THE rule this module owns: distinct users per candidate are a UNION over
// the matched tcodes' user sets, never a sum of per-tcode counts - summing
// double-counts the person who runs both VA01 and VA02.
// ---------------------------------------------------------------------------

async function snapshotIdsOf(runId) {
  const snapshots = await SELECT.from('adops.db.UsageSnapshots').columns('ID')
    .where({ extractionRun_ID: runId });
  return snapshots.map((s) => s.ID);
}

// Overlay with customer precedence: a CUSTOMER row replaces the SHIPPED row
// carrying the same MappingKey (or the one it names via SupersedesMappingKey).
async function effectiveOverlay() {
  const rows = await SELECT.from('adops.db.AppMappingOverlay')
    .where({ Active: true, Suppressed: false });
  const byKey = new Map();
  for (const row of rows) {
    const key = row.MappingKey;
    const existing = byKey.get(key);
    if (!existing || (row.Origin === 'CUSTOMER' && existing.Origin !== 'CUSTOMER')) {
      byKey.set(key, row);
    }
  }
  for (const row of rows) {
    if (row.Origin === 'CUSTOMER' && row.SupersedesMappingKey) {
      byKey.delete(row.SupersedesMappingKey);
      byKey.set(row.MappingKey, row);
    }
  }
  return [...byKey.values()];
}

async function buildCandidates({ runId, minExecutions = 1, lineOfBusinessIn = [] }) {
  const snapshotIds = await snapshotIdsOf(runId);
  if (!snapshotIds.length) return { candidates: [], context: null };

  const usageWhere = { snapshot_ID: { in: snapshotIds } };
  if (minExecutions > 1) usageWhere.ExecutionCount = { '>=': minExecutions };
  const usageRows = await SELECT.from('adops.db.TransactionUsage').where(usageWhere);

  const overlay = await effectiveOverlay();
  const overlayByTcode = new Map();
  for (const row of overlay) {
    const list = overlayByTcode.get(row.TransactionCode) || [];
    list.push(row);
    overlayByTcode.set(row.TransactionCode, list);
  }

  // User sets per tcode (rows are top-N-bounded at the source, so this set
  // is small by construction).
  const userRows = await SELECT.from('adops.db.UserTransactionUsage')
    .columns('UserKey', 'TransactionCode')
    .where({ snapshot_ID: { in: snapshotIds } });
  const usersByTcode = new Map();
  const allUsers = new Set();
  for (const row of userRows) {
    let set = usersByTcode.get(row.TransactionCode);
    if (!set) { set = new Set(); usersByTcode.set(row.TransactionCode, set); }
    set.add(row.UserKey);
    allUsers.add(row.UserKey);
  }

  // Backend-derived truth, if a catalog derivation ran for this system
  // (Phase 2 ABAP); UNKNOWN availability otherwise - confidence reflects it.
  const run = await SELECT.one.from('adops.db.ExtractionRuns').where({ ID: runId });
  const catalogRows = run?.targetSystem_ID
    ? await SELECT.from('adops.db.BackendCatalogApps').where({ targetSystem_ID: run.targetSystem_ID })
    : [];
  const catalogByFioriId = new Map(catalogRows.map((row) => [row.FioriId, row]));

  const fioriUsage = run?.targetSystem_ID
    ? await SELECT.from('adops.db.FioriUsage').columns('FioriId')
        .where({ targetSystem_ID: run.targetSystem_ID })
    : [];
  const adoptedIds = new Set(fioriUsage.map((row) => row.FioriId));

  // Group usage x overlay by Fiori app.
  const byApp = new Map();
  for (const usage of usageRows) {
    if (lineOfBusinessIn.length && !lineOfBusinessIn.includes(usage.LineOfBusiness)) continue;
    const mappings = overlayByTcode.get(usage.TransactionCode) || [];
    for (const mapping of mappings) {
      let candidate = byApp.get(mapping.FioriId);
      if (!candidate) {
        candidate = {
          fioriId: mapping.FioriId,
          appTitle: mapping.AppTitle,
          appType: 'SAPUI5',
          lineOfBusiness: mapping.LineOfBusiness,
          persona: mapping.Persona,
          requiredBusinessRole: mapping.RequiredBusinessRole,
          requiredBusinessCatalog: mapping.RequiredBusinessCatalog,
          minS4Release: mapping.MinS4Release,
          editorialConfidence: mapping.EditorialConfidence,
          prerequisiteNote: mapping.PrerequisiteNote,
          matchedTcodes: [],
          totalExecutions: 0,
          totalDialogSteps: 0,
          lastUsedOn: null,
          periodFrom: usage.PeriodFrom,
          periodTo: usage.PeriodTo
        };
        byApp.set(mapping.FioriId, candidate);
      }
      candidate.matchedTcodes.push({
        tcode: usage.TransactionCode,
        tcodeText: usage.TransactionText,
        executions: Number(usage.ExecutionCount || 0),
        dialogSteps: Number(usage.DialogStepCount || 0),
        userCount: Number(usage.DistinctUserCount || 0),
        mappingType: mapping.MappingType,
        coveragePercent: mapping.CoveragePercent,
        mappingSource: mapping.Origin === 'CUSTOMER' ? 'OVERLAY_CUSTOMER' : 'OVERLAY',
        lastUsedOn: usage.LastUsedOn
      });
      candidate.totalExecutions += Number(usage.ExecutionCount || 0);
      candidate.totalDialogSteps += Number(usage.DialogStepCount || 0);
      if (!candidate.lastUsedOn || String(usage.LastUsedOn) > String(candidate.lastUsedOn)) {
        candidate.lastUsedOn = usage.LastUsedOn;
      }
    }
  }

  // Distinct users: UNION across matched tcodes; roles/backend enrichment.
  const candidates = [...byApp.values()].map((candidate) => {
    const union = new Set();
    for (const matched of candidate.matchedTcodes) {
      for (const user of usersByTcode.get(matched.tcode) || []) union.add(user);
    }
    const catalogRow = catalogByFioriId.get(candidate.fioriId);
    return {
      ...candidate,
      distinctUserCount: union.size ||
        // No per-user rows (source bound them away): fall back to the MAX
        // per-tcode count - a lower bound that never double-counts.
        Math.max(0, ...candidate.matchedTcodes.map((m) => m.userCount)),
      availability: catalogRow?.Availability || 'UNKNOWN',
      businessCatalogId: catalogRow?.BusinessCatalogId || candidate.requiredBusinessCatalog || '',
      businessRoleId: catalogRow?.BusinessRoleId || candidate.requiredBusinessRole || '',
      alreadyAdopted: adoptedIds.has(candidate.fioriId),
      prerequisiteCount: candidate.prerequisiteNote ? 1 : 0,
      newRolesNeeded: 1,
      activationStepCount: 4
    };
  });

  const context = {
    maxExecutionsInRun: Math.max(1, ...candidates.map((c) => c.totalExecutions)),
    totalActiveDialogUsers: Math.max(allUsers.size, 1),
    coveredTcodes: new Set(candidates.flatMap((c) => c.matchedTcodes.map((m) => m.tcode))),
    totalTcodes: new Set(usageRows.map((row) => row.TransactionCode)).size,
    totalExecutionsInRun: usageRows.reduce((sum, row) => sum + Number(row.ExecutionCount || 0), 0)
  };

  return { candidates, context };
}

module.exports = { buildCandidates, effectiveOverlay };
