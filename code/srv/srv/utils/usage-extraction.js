const cds = require('@sap/cds');
const { randomUUID, createHash } = require('node:crypto');
const { shouldMockSap } = require('./s4-http-client.js');
const {
  fetchTransactionUsagePage,
  fetchUserTransactionUsagePage
} = require('./s4-fiori-adapter.js');

const { SELECT, INSERT, UPDATE } = cds.ql;
const LOG = cds.log('usage-extraction');

// ---------------------------------------------------------------------------
// USAGE_EXTRACTION task handler. Creates the ExtractionRuns/UsageSnapshots
// header rows, pages usage facts from the ZADO add-on (or the seeded mock),
// and writes each page BEFORE requesting the next - memory stays bounded and
// a mid-run failure leaves a usable PARTIAL run.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 500;

// Application-component derivation for the module rollup. First segment of
// the component (FI-GL -> FI) is the line of business.
function lineOfBusinessOf(applicationComponent) {
  return String(applicationComponent || '').split('-')[0] || 'OTHER';
}

function isCustomTcode(tcode) {
  return /^[YZ]/i.test(String(tcode || ''));
}

async function runUsageExtraction({ task, payload, reportProgress, log, isCancelRequested }) {
  const db = cds.db;
  const {
    targetSystemId,
    sources = ['ST03N'],
    periodFrom,
    periodTo,
    granularity = 'MONTH',
    topUsersPerTcode = 20,
    minExecutions = 1,
    runId
  } = payload || {};

  const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: targetSystemId });
  if (!targetSystem) throw new Error('Target system not found.');

  const run = await SELECT.one.from('adops.db.ExtractionRuns').where({ ID: runId });
  if (!run) throw new Error('Extraction run row not found.');

  await UPDATE('adops.db.ExtractionRuns')
    .set({ Status: 'RUNNING', StartedAt: new Date().toISOString() })
    .where({ ID: runId });

  const startedAt = Date.now();
  const rollup = { transactions: 0, users: 0, roles: 0, fiori: 0, truncated: false };

  try {
    // --- ST03N: transaction profile -------------------------------------
    if (sources.includes('ST03N')) {
      await reportProgress({ phase: 'Collecting transaction profile (ST03N)', processedItems: 0, totalItems: 0 });
      const snapshotId = await createSnapshot(db, run, targetSystem, 'ST03N', granularity, periodFrom, periodTo);

      const fetchPage = shouldMockSap()
        ? (skip) => mockTransactionUsagePage({ periodFrom, periodTo, skip, top: PAGE_SIZE })
        : (skip) => fetchTransactionUsagePage({ targetSystem, periodFrom, periodTo, top: PAGE_SIZE, skip });

      rollup.transactions = await pageInto(db, {
        fetchPage,
        snapshotId,
        targetSystemId,
        mapRow: (row) => ({
          ID: randomUUID(),
          snapshot_ID: snapshotId,
          targetSystem_ID: targetSystemId,
          TenantId: run.TenantId,
          TransactionCode: row.TransactionCode,
          TransactionText: row.TransactionText,
          ProgramName: row.ProgramName,
          ApplicationComponent: row.ApplicationComponent,
          LineOfBusiness: lineOfBusinessOf(row.ApplicationComponent),
          PeriodFrom: row.PeriodFrom || periodFrom,
          PeriodTo: row.PeriodTo || periodTo,
          ExecutionCount: row.ExecutionCount,
          DialogStepCount: row.DialogStepCount,
          DistinctUserCount: row.DistinctUserCount,
          TotalResponseTimeMs: row.TotalResponseTimeMs,
          AvgResponseTimeMs: row.AvgResponseTimeMs
            || (row.ExecutionCount ? Math.round((row.TotalResponseTimeMs / row.ExecutionCount) * 100) / 100 : 0),
          TotalCpuTimeMs: row.TotalCpuTimeMs,
          TotalDbTimeMs: row.TotalDbTimeMs,
          FirstUsedOn: row.FirstUsedOn || periodFrom,
          LastUsedOn: row.LastUsedOn || periodTo,
          IsCustom: isCustomTcode(row.TransactionCode),
          IsStandard: !isCustomTcode(row.TransactionCode),
          Source: 'ST03N'
        }),
        into: 'adops.db.TransactionUsage',
        reportProgress,
        phase: 'Collecting transaction profile (ST03N)',
        isCancelRequested
      });
      await log('INFO', 'ST03N', `${rollup.transactions} transaction rows`);
    }

    // --- ST03N: user x tcode (the USERTCODE aggregate) --------------------
    if (sources.includes('ST03N') && !(await isCancelRequested())) {
      await reportProgress({ phase: 'Collecting user activity (USERTCODE)', processedItems: 0, totalItems: 0 });
      const snapshotId = await createSnapshot(db, run, targetSystem, 'ST03N', granularity, periodFrom, periodTo, 'USERTCODE');

      const pseudonymise = run.Pseudonymised !== false && !targetSystem.identifiedUsageAllowed;
      const fetchPage = shouldMockSap()
        ? (skip) => mockUserTransactionUsagePage({ periodFrom, periodTo, skip, top: PAGE_SIZE, topUsersPerTcode })
        : (skip) => fetchUserTransactionUsagePage({ targetSystem, periodFrom, periodTo, topUsersPerTcode, minExecutions, top: PAGE_SIZE, skip });

      rollup.users = await pageInto(db, {
        fetchPage,
        snapshotId,
        targetSystemId,
        mapRow: (row) => ({
          ID: randomUUID(),
          snapshot_ID: snapshotId,
          targetSystem_ID: targetSystemId,
          TenantId: run.TenantId,
          // Server-side pseudonymisation is the ABAP add-on's job in live
          // mode; this is defence in depth for mock and misconfigured runs.
          UserKey: pseudonymise ? pseudonymiseUser(row.UserKey, run.TenantId) : row.UserKey,
          TransactionCode: row.TransactionCode,
          PeriodFrom: row.PeriodFrom || periodFrom,
          PeriodTo: row.PeriodTo || periodTo,
          ExecutionCount: row.ExecutionCount,
          DialogStepCount: row.DialogStepCount,
          LastUsedOn: row.LastUsedOn || periodTo
        }),
        into: 'adops.db.UserTransactionUsage',
        reportProgress,
        phase: 'Collecting user activity (USERTCODE)',
        isCancelRequested
      });
      await log('INFO', 'USERTCODE', `${rollup.users} user-tcode rows`);
    }

    const cancelled = await isCancelRequested();
    await UPDATE('adops.db.ExtractionRuns')
      .set({
        Status: cancelled ? 'PARTIAL' : 'COMPLETED',
        CompletedAt: new Date().toISOString(),
        DurationMs: Date.now() - startedAt,
        TransactionRowCount: rollup.transactions,
        UserRowCount: rollup.users,
        RoleRowCount: rollup.roles,
        FioriRowCount: rollup.fiori,
        Truncated: rollup.truncated
      })
      .where({ ID: runId });

    return { runId, ...rollup, cancelled };
  } catch (error) {
    await UPDATE('adops.db.ExtractionRuns')
      .set({
        Status: 'PARTIAL',
        CompletedAt: new Date().toISOString(),
        DurationMs: Date.now() - startedAt,
        TransactionRowCount: rollup.transactions,
        UserRowCount: rollup.users,
        ErrorText: String(error.message).slice(0, 2000)
      })
      .where({ ID: runId });
    throw error;
  }
}

async function createSnapshot(db, run, targetSystem, source, granularity, periodFrom, periodTo, taskType) {
  const snapshotId = randomUUID();
  await db.run(INSERT.into('adops.db.UsageSnapshots').entries({
    ID: snapshotId,
    extractionRun_ID: run.ID,
    targetSystem_ID: targetSystem.ID,
    TenantId: run.TenantId,
    Source: source,
    SapAggregationLevel: granularity,
    TaskType: taskType || 'DIALOG',
    PeriodFrom: periodFrom,
    PeriodTo: periodTo,
    CollectedAt: new Date().toISOString(),
    RowCount: 0,
    Truncated: false
  }));
  return snapshotId;
}

// Write each page before requesting the next; check cancellation at page
// boundaries (in-flight S/4 requests are allowed to complete).
async function pageInto(db, { fetchPage, snapshotId, mapRow, into, reportProgress, phase, isCancelRequested }) {
  let skip = 0;
  let written = 0;
  let totalCount = 0;

  for (;;) {
    if (await isCancelRequested()) break;
    const page = await fetchPage(skip);
    if (page.totalCount) totalCount = page.totalCount;
    if (!page.rows.length) break;

    await db.run(INSERT.into(into).entries(page.rows.map(mapRow)));
    written += page.rows.length;
    skip += page.rows.length;
    await reportProgress({ phase, processedItems: written, totalItems: totalCount || written });
    if (!page.hasMore) break;
  }

  await UPDATE('adops.db.UsageSnapshots').set({ RowCount: written }).where({ ID: snapshotId });
  return written;
}

function pseudonymiseUser(userKey, tenantId) {
  return createHash('sha256')
    .update(`${tenantId || 'GLOBAL'}::${String(userKey || '').toUpperCase()}`)
    .digest('hex')
    .slice(0, 24);
}

// ---------------------------------------------------------------------------
// Seeded mock: realistic, heavy-tailed usage so the analytics screens are
// demonstrable on A4H/local sqlite where ST03N history is thin. Deterministic
// (seeded PRNG) so repeated demo extractions look stable.
// ---------------------------------------------------------------------------

const MOCK_TCODES = [
  ['VA01', 'Create Sales Order', 'SD-SLS', 90], ['VA02', 'Change Sales Order', 'SD-SLS', 70],
  ['VA03', 'Display Sales Order', 'SD-SLS', 100], ['VL02N', 'Change Outbound Delivery', 'LE-SHP', 55],
  ['VF01', 'Create Billing Document', 'SD-BIL', 45], ['VF03', 'Display Billing Document', 'SD-BIL', 35],
  ['ME21N', 'Create Purchase Order', 'MM-PUR', 80], ['ME22N', 'Change Purchase Order', 'MM-PUR', 50],
  ['ME23N', 'Display Purchase Order', 'MM-PUR', 85], ['ME51N', 'Create Purchase Requisition', 'MM-PUR', 40],
  ['MIGO', 'Goods Movement', 'MM-IM', 95], ['MIRO', 'Enter Incoming Invoice', 'MM-IV', 60],
  ['MB52', 'Warehouse Stock', 'MM-IM', 30], ['MMBE', 'Stock Overview', 'MM-IM', 42],
  ['FB01', 'Post Document', 'FI-GL', 38], ['FB03', 'Display Document', 'FI-GL', 65],
  ['FB50', 'G/L Account Posting', 'FI-GL', 44], ['FBL1N', 'Vendor Line Items', 'FI-AP', 58],
  ['FBL3N', 'G/L Line Items', 'FI-GL', 62], ['FBL5N', 'Customer Line Items', 'FI-AR', 48],
  ['F-28', 'Post Incoming Payment', 'FI-AR', 33], ['F110', 'Payment Run', 'FI-AP', 22],
  ['KSB1', 'Cost Center Line Items', 'CO-OM', 36], ['KS01', 'Create Cost Center', 'CO-OM', 8],
  ['CO01', 'Create Production Order', 'PP-SFC', 28], ['CO02', 'Change Production Order', 'PP-SFC', 24],
  ['MD04', 'Stock/Requirements List', 'PP-MRP', 52], ['MD01', 'MRP Run', 'PP-MRP', 12],
  ['IW21', 'Create PM Notification', 'PM-WOC', 18], ['IW31', 'Create PM Order', 'PM-WOC', 20],
  ['QA32', 'Inspection Lot Usage Decision', 'QM-IM', 15], ['QE51N', 'Results Recording', 'QM-IM', 11],
  ['PA20', 'Display HR Master Data', 'PA-PA', 26], ['PA30', 'Maintain HR Master Data', 'PA-PA', 21],
  ['SE16', 'Data Browser', 'BC-DWB', 40], ['SE38', 'ABAP Editor', 'BC-DWB', 14],
  ['SM37', 'Job Overview', 'BC-CCM', 25], ['SU01', 'User Maintenance', 'BC-SEC', 16],
  ['ZSD_PRICE_UPD', 'Update Price Conditions (custom)', 'SD-SLS', 27],
  ['ZMM_STOCK_RPT', 'Custom Stock Report', 'MM-IM', 31],
  ['ZFI_PAYMENTS', 'Custom Payment Workbench', 'FI-AP', 19],
  ['ZPP_SHOPFLOOR', 'Custom Shopfloor Cockpit', 'PP-SFC', 17]
];

const MOCK_DEPARTMENTS = ['Sales', 'Procurement', 'Finance', 'Production', 'Quality', 'Maintenance', 'HR', 'IT'];

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function mockRows() {
  const random = seededRandom(42);
  return MOCK_TCODES.map(([code, text, component, weight]) => {
    // Heavy tail: weight^2 scaling plus jitter mirrors real ST03N shape.
    const executions = Math.round(weight * weight * (8 + random() * 6));
    const users = Math.max(1, Math.round(weight * (0.6 + random() * 0.8)));
    return { code, text, component, weight, executions, users };
  });
}

function mockTransactionUsagePage({ periodFrom, periodTo, skip, top }) {
  const rows = mockRows()
    .sort((a, b) => b.executions - a.executions || a.code.localeCompare(b.code))
    .map((r) => ({
      TransactionCode: r.code,
      TransactionText: r.text,
      ProgramName: `SAPM${r.code}`.slice(0, 12),
      ApplicationComponent: r.component,
      PeriodFrom: periodFrom,
      PeriodTo: periodTo,
      ExecutionCount: r.executions,
      DialogStepCount: r.executions * 3,
      DistinctUserCount: r.users,
      TotalResponseTimeMs: r.executions * (350 + (r.weight % 7) * 90),
      AvgResponseTimeMs: 350 + (r.weight % 7) * 90,
      TotalCpuTimeMs: r.executions * 120,
      TotalDbTimeMs: r.executions * 80,
      LastUsedOn: periodTo
    }));
  const page = rows.slice(skip, skip + top);
  return { rows: page, totalCount: rows.length, hasMore: skip + page.length < rows.length };
}

function mockUserTransactionUsagePage({ periodFrom, periodTo, skip, top, topUsersPerTcode = 20 }) {
  const random = seededRandom(4711);
  const rows = [];
  for (const r of mockRows()) {
    const userCount = Math.min(r.users, topUsersPerTcode);
    for (let i = 0; i < userCount; i++) {
      const department = MOCK_DEPARTMENTS[(r.weight + i) % MOCK_DEPARTMENTS.length];
      rows.push({
        UserKey: `${department.toUpperCase().slice(0, 4)}_USER_${String(i + 1).padStart(3, '0')}`,
        TransactionCode: r.code,
        PeriodFrom: periodFrom,
        PeriodTo: periodTo,
        // Zipf-ish share per user
        ExecutionCount: Math.max(1, Math.round(r.executions / userCount * (1.6 - i / userCount) * (0.7 + random() * 0.6))),
        DialogStepCount: 3,
        LastUsedOn: periodTo
      });
    }
  }
  rows.sort((a, b) => a.TransactionCode.localeCompare(b.TransactionCode) || a.UserKey.localeCompare(b.UserKey));
  const page = rows.slice(skip, skip + top);
  return { rows: page, totalCount: rows.length, hasMore: skip + page.length < rows.length };
}

// ---------------------------------------------------------------------------
// Offline file bridge: ingest a ZADO_EXPORT_USAGE JSON extract (downloaded
// via SAP GUI in landscapes where the Cloud Connector path is not open yet)
// as a normal ExtractionRun - same screens, same proposal engine.
// ---------------------------------------------------------------------------

// The file's tcode field is the raw SWNC ENTRY_ID: "<name> <task-type>" for
// interactive entries ("PFCG T", "SAPMSSY1 R"), "<report> <jobname...>" for
// batch. The export truncates to 20 chars, so a suffix may be cut off; an
// entry that cannot be classified is treated as non-dialog.
const TASK_TYPE_SUFFIX = /\s[A-Z]$/;

// The ABAP exporter escapes quotes and backslashes but raw SWNC fields can
// carry control bytes (observed on RD1: an ACCOUNT of 12 NULs from an aborted
// session) that strict JSON.parse rejects. Strip C0 controls except tab/CR/LF
// so one garbage row cannot block a whole file import.
function sanitizeExtractJson(payload) {
  return String(payload || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function parseSwncEntryId(entryId) {
  const raw = String(entryId || '').trim();
  const match = /^(.+)\s([A-Z])$/.exec(raw);
  if (!match) return { tcode: raw, taskType: null, isDialog: false };
  return { tcode: match[1].trim(), taskType: match[2], isDialog: match[2] === 'T' };
}

// Only dialog transactions ("... T") can match Fiori apps; on RD1 the rest -
// update task, bgRFC daemons, batch jobs - was 98.9% of executions. Filter at
// import and strip the suffix so TransactionCode is a clean tcode. A file
// without any task-type suffixes (already-clean tcodes) imports unchanged.
function filterDialogRows(transactions, userTcodes) {
  const hasTaskTypes = transactions.some((row) => TASK_TYPE_SUFFIX.test(String(row.tcode || '').trim()));
  if (!hasTaskTypes) {
    return { transactions, userTcodes, skippedTransactions: 0, skippedUserRows: 0 };
  }
  const keep = (rows) => rows.flatMap((row) => {
    const parsed = parseSwncEntryId(row.tcode);
    return parsed.isDialog ? [{ ...row, tcode: parsed.tcode }] : [];
  });
  const keptTransactions = keep(transactions);
  const keptUserTcodes = keep(userTcodes);
  return {
    transactions: keptTransactions,
    userTcodes: keptUserTcodes,
    skippedTransactions: transactions.length - keptTransactions.length,
    skippedUserRows: userTcodes.length - keptUserTcodes.length
  };
}

async function importUsageExtract({ targetSystem, extract, requestedBy, tenantId }) {
  const db = cds.db;
  if (extract?.format !== 'adops-usage-extract') {
    throw new Error('Not an AdoptOps usage extract (missing format marker).');
  }
  const periodFrom = extract.periodFrom;
  const periodTo = extract.periodTo;
  if (!periodFrom || !periodTo) throw new Error('The extract carries no period.');
  const rawTransactions = Array.isArray(extract.transactions) ? extract.transactions : [];
  const rawUserTcodes = Array.isArray(extract.userTcodes) ? extract.userTcodes : [];
  if (!rawTransactions.length) throw new Error('The extract contains no transaction rows.');

  const { transactions, userTcodes, skippedTransactions, skippedUserRows } =
    filterDialogRows(rawTransactions, rawUserTcodes);
  if (!transactions.length) {
    throw new Error('The extract contains no dialog transaction rows - only background/technical entries.');
  }
  if (skippedTransactions || skippedUserRows) {
    LOG.info(`Import filter: kept ${transactions.length}/${rawTransactions.length} transaction rows, ` +
      `${userTcodes.length}/${rawUserTcodes.length} user rows (dialog task type only).`);
  }

  const runId = randomUUID();
  const now = new Date().toISOString();
  const pseudonymised = extract.pseudonymised !== false;

  await db.run(INSERT.into('adops.db.ExtractionRuns').entries({
    ID: runId,
    targetSystem_ID: targetSystem.ID,
    TenantId: tenantId,
    Title: `${targetSystem.displayName || extract.system || 'Import'} ${periodFrom}..${periodTo} (file import)`,
    Status: 'RUNNING',
    SourcesJson: JSON.stringify(['ST03N_FILE']),
    PeriodFrom: periodFrom,
    PeriodTo: periodTo,
    PeriodGranularity: 'MONTH',
    Pseudonymised: pseudonymised,
    RequestedBy: requestedBy || null,
    StartedAt: now
  }));

  const run = { ID: runId, TenantId: tenantId };
  const txSnapshot = await createSnapshot(db, run, targetSystem, 'ST03N', 'MONTH', periodFrom, periodTo);
  await db.run(INSERT.into('adops.db.TransactionUsage').entries(transactions.map((row) => ({
    ID: randomUUID(),
    snapshot_ID: txSnapshot,
    targetSystem_ID: targetSystem.ID,
    TenantId: tenantId,
    TransactionCode: row.tcode,
    TransactionText: row.text || '',
    ApplicationComponent: row.component || '',
    LineOfBusiness: lineOfBusinessOf(row.component),
    PeriodFrom: periodFrom,
    PeriodTo: periodTo,
    ExecutionCount: Number(row.executions || 0),
    DialogStepCount: Number(row.dialogSteps || 0),
    DistinctUserCount: Number(row.users || 0),
    TotalResponseTimeMs: Number(row.respMs || 0),
    AvgResponseTimeMs: Number(row.executions) ? Math.round((Number(row.respMs || 0) / Number(row.executions)) * 100) / 100 : 0,
    TotalCpuTimeMs: Number(row.cpuMs || 0),
    TotalDbTimeMs: Number(row.dbMs || 0),
    FirstUsedOn: periodFrom,
    LastUsedOn: periodTo,
    IsCustom: isCustomTcode(row.tcode),
    IsStandard: !isCustomTcode(row.tcode),
    Source: 'ST03N'
  }))));
  await UPDATE('adops.db.UsageSnapshots').set({ RowCount: transactions.length }).where({ ID: txSnapshot });

  let userRows = 0;
  if (userTcodes.length) {
    const userSnapshot = await createSnapshot(db, run, targetSystem, 'ST03N', 'MONTH', periodFrom, periodTo, 'USERTCODE');
    // Defence in depth: hash again unless the file explicitly declares an
    // identified export AND the system allows identified usage.
    const keepIdentified = !pseudonymisedRequired(extract, targetSystem);
    await db.run(INSERT.into('adops.db.UserTransactionUsage').entries(userTcodes.map((row) => ({
      ID: randomUUID(),
      snapshot_ID: userSnapshot,
      targetSystem_ID: targetSystem.ID,
      TenantId: tenantId,
      UserKey: keepIdentified ? row.user : (pseudonymised ? row.user : pseudonymiseUser(row.user, tenantId)),
      TransactionCode: row.tcode,
      PeriodFrom: periodFrom,
      PeriodTo: periodTo,
      ExecutionCount: Number(row.executions || 0),
      DialogStepCount: Number(row.dialogSteps || 0),
      LastUsedOn: periodTo
    }))));
    userRows = userTcodes.length;
    await UPDATE('adops.db.UsageSnapshots').set({ RowCount: userRows }).where({ ID: userSnapshot });
  }

  await UPDATE('adops.db.ExtractionRuns').set({
    Status: 'COMPLETED',
    CompletedAt: new Date().toISOString(),
    TransactionRowCount: transactions.length,
    UserRowCount: userRows
  }).where({ ID: runId });

  return { runId, transactions: transactions.length, userRows, skippedTransactions, skippedUserRows };
}

function pseudonymisedRequired(extract, targetSystem) {
  // Identified data survives only when the export was explicitly identified
  // AND the target system's audited opt-in allows it.
  return !(extract.pseudonymised === false && targetSystem.identifiedUsageAllowed);
}

module.exports = {
  runUsageExtraction,
  importUsageExtract,
  pseudonymiseUser,
  lineOfBusinessOf,
  isCustomTcode,
  parseSwncEntryId,
  filterDialogRows,
  sanitizeExtractJson
};
