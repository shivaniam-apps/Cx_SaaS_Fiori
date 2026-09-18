const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');
const { shouldMockSap } = require('./s4-http-client.js');
const { fetchCatalogAppsPage, fetchLaunchpadContentPage } = require('./s4-fiori-adapter.js');

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const LOG = cds.log('catalog-derivation');

// ---------------------------------------------------------------------------
// CATALOG_DERIVATION task handler (S9 part 1). Reads what the backend
// system itself knows about its Fiori content - installed apps with their
// BSP application, ICF / OData / UI component state, business catalogs and
// roles, launchpad spaces and pages - through the ZADO catalog read unit
// and persists it per target system in BackendCatalogApps /
// BackendLaunchpadContent. That backend truth is what
// fiori-candidate-query.js answers Availability from and what
// createActivationPlan takes the ICF node (BspApplication) from.
//
// Replace-per-system semantics: rows are written under the new run; the
// previous run's rows are deleted only after the new set is complete, so
// a failed derivation keeps the last good catalog.
//
// The mapping tcode -> Fiori app is NOT derived here (that is the overlay /
// reference-library question behind PO-1). An add-on without the catalog
// service (S9 part 2, or an older installation) answers 404: the run ends
// PARTIAL with a clear log line and the last good catalog stays in place.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 500;
const SOURCE = 'CATALOG';

const AVAILABILITY = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  MISSING_SERVICE: 'MISSING_SERVICE',
  NOT_INSTALLED: 'NOT_INSTALLED',
  UNKNOWN: 'UNKNOWN'
});

// Pure: the availability verdict from the three backend states, the same
// rule the ABAP reader applies when it can (kept here so mock and live
// rows are judged identically and the contract is testable).
function availabilityOf({ UiComponentState, IcfNodeState, ServiceActivationState } = {}) {
  const ui = String(UiComponentState || '').toUpperCase();
  const icf = String(IcfNodeState || '').toUpperCase();
  const svc = String(ServiceActivationState || '').toUpperCase();
  if (!ui && !icf && !svc) return AVAILABILITY.UNKNOWN;
  if (ui === 'MISSING') return AVAILABILITY.NOT_INSTALLED;
  if (svc === 'MISSING' || svc === 'INACTIVE' || icf === 'MISSING' || icf === 'INACTIVE') return AVAILABILITY.MISSING_SERVICE;
  if (ui === 'INSTALLED' && icf === 'ACTIVE' && (svc === 'ACTIVE' || !svc)) return AVAILABILITY.AVAILABLE;
  return AVAILABILITY.UNKNOWN;
}

// Deterministic mock: one catalog row per Fiori app the overlay knows, all
// installed and active (so a mock plan carries real-looking ICF nodes), plus
// a small launchpad content tree.
async function mockCatalogRows() {
  const overlay = await SELECT.from('adops.db.AppMappingOverlay')
    .columns('FioriId', 'AppTitle', 'RequiredBusinessCatalog', 'RequiredBusinessRole', 'RequiredBusinessGroup', 'MinS4Release')
    .orderBy('FioriId asc');
  const byId = new Map();
  for (const row of overlay) {
    if (!row.FioriId || byId.has(row.FioriId)) continue;
    const states = { UiComponentState: 'INSTALLED', IcfNodeState: 'ACTIVE', ServiceActivationState: 'ACTIVE' };
    byId.set(row.FioriId, {
      FioriId: row.FioriId,
      AppTitle: row.AppTitle || row.FioriId,
      AppSubtitle: '',
      AppType: 'SAPUI5',
      AppCategory: 'TRANSACTIONAL',
      SemanticObject: '',
      SemanticAction: 'manage',
      IamAppId: `MOCK_${row.FioriId}`,
      UI5ComponentName: `mock.app.${row.FioriId.toLowerCase()}`,
      BspApplication: `zmock_${row.FioriId.toLowerCase()}`,
      TechnicalCatalogId: 'SAP_TC_MOCK_COMMON',
      // The overlay names the business role; the mock catalog is its SAP_BC twin.
      BusinessCatalogId: row.RequiredBusinessCatalog || (row.RequiredBusinessRole ? String(row.RequiredBusinessRole).replace(/^SAP_BR_/, 'SAP_BC_') : ''),
      BusinessGroupId: row.RequiredBusinessGroup || '',
      BusinessRoleId: row.RequiredBusinessRole || '',
      ODataServicesJson: JSON.stringify([{ service: `ZMOCK_${row.FioriId}_SRV`, version: '0001', active: true }]),
      ...states,
      Availability: availabilityOf(states),
      RelatedTcodesJson: '[]',
      MinS4Release: row.MinS4Release || ''
    });
  }
  const apps = [...byId.values()];
  const catalogs = [...new Set(apps.map((a) => a.BusinessCatalogId).filter(Boolean))];
  const content = [
    { ContentType: 'SPACE', ContentId: 'SAP_MOCK_SPACE', Title: 'Mock space', ParentId: '', AssignedRolesJson: '[]', ItemCount: 1, IsSapDelivered: true },
    { ContentType: 'PAGE', ContentId: 'SAP_MOCK_PAGE', Title: 'Mock page', ParentId: 'SAP_MOCK_SPACE', AssignedRolesJson: '[]', ItemCount: catalogs.length, IsSapDelivered: true },
    ...catalogs.map((id) => ({ ContentType: 'CATALOG', ContentId: id, Title: id, ParentId: 'SAP_MOCK_PAGE', AssignedRolesJson: '[]', ItemCount: apps.filter((a) => a.BusinessCatalogId === id).length, IsSapDelivered: /^SAP_/.test(id) }))
  ];
  return { apps, content };
}

function pageOf(rows, skip, top) {
  const page = rows.slice(skip, skip + top);
  return { rows: page, totalCount: rows.length, hasMore: skip + page.length < rows.length, supported: true };
}

async function runCatalogDerivation({ task, payload, reportProgress, log, isCancelRequested }) {
  const { targetSystemId, runId } = payload || {};
  const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: targetSystemId });
  if (!targetSystem) throw new Error('Target system not found.');
  const run = await SELECT.one.from('adops.db.ExtractionRuns').where({ ID: runId });
  if (!run) throw new Error('Derivation run row not found.');

  await UPDATE('adops.db.ExtractionRuns').set({ Status: 'RUNNING', StartedAt: new Date().toISOString() }).where({ ID: runId });
  const startedAt = Date.now();
  const rollup = { apps: 0, content: 0, supported: true, cancelled: false };

  try {
    const mock = shouldMockSap();
    const mocked = mock ? await mockCatalogRows() : null;
    const readApps = mock
      ? async (skip) => pageOf(mocked.apps, skip, PAGE_SIZE)
      : (skip) => fetchCatalogAppsPage({ targetSystem, top: PAGE_SIZE, skip });
    const readContent = mock
      ? async (skip) => pageOf(mocked.content, skip, PAGE_SIZE)
      : (skip) => fetchLaunchpadContentPage({ targetSystem, top: PAGE_SIZE, skip });

    // --- apps -----------------------------------------------------------------
    await reportProgress({ phase: 'Reading backend catalog (apps)', processedItems: 0, totalItems: 0 });
    let skip = 0;
    for (;;) {
      const page = await readApps(skip);
      if (page.supported === false) {
        rollup.supported = false;
        await log('WARN', SOURCE, 'The ZADO add-on has no catalog service (ZADO_CATALOG_SRV, S9 part 2) - availability stays UNKNOWN and the previous catalog, if any, is kept.');
        break;
      }
      if (page.rows.length) {
        await INSERT.into('adops.db.BackendCatalogApps').entries(page.rows.map((row) => ({
          ID: randomUUID(),
          TenantId: run.TenantId,
          targetSystem_ID: targetSystemId,
          derivationRun_ID: runId,
          ...row,
          Availability: row.Availability || availabilityOf(row),
          LastSeenAt: new Date().toISOString()
        })));
      }
      rollup.apps += page.rows.length;
      skip += page.rows.length;
      await reportProgress({ phase: 'Reading backend catalog (apps)', processedItems: rollup.apps, totalItems: page.totalCount || rollup.apps });
      if (!page.hasMore || !page.rows.length) break;
      if (await isCancelRequested()) { rollup.cancelled = true; break; }
    }
    if (rollup.supported && !rollup.cancelled) await log('INFO', SOURCE, `${rollup.apps} backend catalog app rows${mock ? ' (mock, from the shipped overlay)' : ''}`);

    // --- launchpad content -------------------------------------------------------
    if (rollup.supported && !rollup.cancelled) {
      await reportProgress({ phase: 'Reading launchpad content (spaces, pages, catalogs)', processedItems: 0, totalItems: 0 });
      skip = 0;
      for (;;) {
        const page = await readContent(skip);
        if (page.supported === false) break;
        if (page.rows.length) {
          await INSERT.into('adops.db.BackendLaunchpadContent').entries(page.rows.map((row) => ({
            ID: randomUUID(),
            TenantId: run.TenantId,
            targetSystem_ID: targetSystemId,
            derivationRun_ID: runId,
            ContentType: row.ContentType,
            ContentId: row.ContentId,
            Title: row.Title || '',
            ParentId: row.ParentId || '',
            AssignedRoles: row.AssignedRolesJson || row.AssignedRoles || '[]',
            ItemCount: Number(row.ItemCount) || 0,
            IsSapDelivered: Boolean(row.IsSapDelivered)
          })));
        }
        rollup.content += page.rows.length;
        skip += page.rows.length;
        if (!page.hasMore || !page.rows.length) break;
        if (await isCancelRequested()) { rollup.cancelled = true; break; }
      }
      await log('INFO', SOURCE, `${rollup.content} launchpad content rows (spaces, pages, catalogs)`);
    }

    // --- replace the previous catalog only after a complete read -------------------
    if (rollup.supported && !rollup.cancelled) {
      const deletedApps = await DELETE.from('adops.db.BackendCatalogApps')
        .where({ targetSystem_ID: targetSystemId, derivationRun_ID: { '!=': runId } });
      await DELETE.from('adops.db.BackendLaunchpadContent')
        .where({ targetSystem_ID: targetSystemId, derivationRun_ID: { '!=': runId } });
      if (Number(deletedApps) > 0) await log('INFO', SOURCE, `Previous catalog replaced (${deletedApps} app rows retired).`);
    } else {
      // Keep the last good catalog: drop this run's partial rows.
      await DELETE.from('adops.db.BackendCatalogApps').where({ derivationRun_ID: runId });
      await DELETE.from('adops.db.BackendLaunchpadContent').where({ derivationRun_ID: runId });
      rollup.apps = 0;
      rollup.content = 0;
    }

    const status = rollup.cancelled || !rollup.supported ? 'PARTIAL' : 'COMPLETED';
    await UPDATE('adops.db.ExtractionRuns').set({
      Status: status,
      CompletedAt: new Date().toISOString(),
      DurationMs: Date.now() - startedAt,
      FioriRowCount: rollup.apps,
      Truncated: false,
      ErrorText: rollup.supported ? null : 'Catalog service not available on the add-on (S9 part 2).'
    }).where({ ID: runId });
    return { runId, ...rollup, status };
  } catch (error) {
    LOG.error(`Catalog derivation ${runId} failed: ${error.message}`);
    await DELETE.from('adops.db.BackendCatalogApps').where({ derivationRun_ID: runId });
    await DELETE.from('adops.db.BackendLaunchpadContent').where({ derivationRun_ID: runId });
    await UPDATE('adops.db.ExtractionRuns').set({
      Status: 'FAILED',
      CompletedAt: new Date().toISOString(),
      DurationMs: Date.now() - startedAt,
      ErrorText: String(error.message || error).slice(0, 2000)
    }).where({ ID: runId });
    throw error;
  }
}

module.exports = { runCatalogDerivation, availabilityOf, mockCatalogRows, AVAILABILITY, SOURCE };
