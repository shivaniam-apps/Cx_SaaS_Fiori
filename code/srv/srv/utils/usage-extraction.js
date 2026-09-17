const cds = require('@sap/cds');
const { randomUUID, createHash } = require('node:crypto');
const { shouldMockSap } = require('./s4-http-client.js');
const {
  fetchTransactionUsagePage,
  fetchUserTransactionUsagePage,
  fetchUserInventoryPage,
  fetchRoleInventoryPage,
  fetchRoleUsersPage,
  fetchRoleTransactionsPage,
  INVENTORY_PAGE_SIZE
} = require('./s4-fiori-adapter.js');
const { pseudonymSaltFor } = require('./tenant-secrets.js');

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
  const rollup = { transactions: 0, users: 0, roles: 0, fiori: 0, inventoryUsers: 0, roleUsers: 0, roleTcodes: 0, truncated: false };
  // Server-side pseudonymisation is the ABAP add-on's job in live mode;
  // hashing again here is defence in depth for mock and misconfigured runs.
  // Applied identically to usage, inventory and assignment rows so the
  // pseudonyms still correlate across the four tables.
  const pseudonymise = run.Pseudonymised !== false && !targetSystem.identifiedUsageAllowed;
  const salt = pseudonymise ? await pseudonymSaltFor(run.TenantId) : null;
  const userKeyOf = (key) => (pseudonymise ? pseudonymiseUser(key, salt) : key);
  let userTcodeSnapshotId = null;

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
      userTcodeSnapshotId = snapshotId;

      await log('INFO', 'USERTCODE', `Source bound: top ${topUsersPerTcode || 'all'} users per transaction, at least ${minExecutions} execution(s) per user row.`);
      let parameterWarningLogged = false;
      const fetchPage = shouldMockSap()
        ? (skip) => mockUserTransactionUsagePage({ periodFrom, periodTo, skip, top: PAGE_SIZE, topUsersPerTcode, minExecutions })
        : async (skip) => {
          const page = await fetchUserTransactionUsagePage({ targetSystem, periodFrom, periodTo, topUsersPerTcode, minExecutions, tenantId: run.TenantId, top: PAGE_SIZE, skip });
          if (page.parametersApplied === false && !parameterWarningLogged) {
            parameterWarningLogged = true;
            await log('WARN', 'USERTCODE', 'The add-on ignored topUsersPerTcode / minExecutions (no parameterized UserTransactionUsage entity - ZADO older than S6); the reader defaults (20 users, 1 execution) apply.');
          }
          return page;
        };

      rollup.users = await pageInto(db, {
        fetchPage,
        snapshotId,
        targetSystemId,
        mapRow: (row) => ({
          ID: randomUUID(),
          snapshot_ID: snapshotId,
          targetSystem_ID: targetSystemId,
          TenantId: run.TenantId,
          UserKey: userKeyOf(row.UserKey),
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

    // --- USR02: user inventory (S8) --------------------------------------
    // Paged at the database by the ZADO provider (real user id order), the
    // pseudonym is the same hash the ST03N reader emits.
    if (sources.includes('USR02') && !(await isCancelRequested())) {
      await reportProgress({ phase: 'Collecting user inventory (USR02)', processedItems: 0, totalItems: 0 });
      const snapshotId = await createSnapshot(db, run, targetSystem, 'USR02', granularity, periodFrom, periodTo, 'INVENTORY');
      const fetchPage = shouldMockSap()
        ? (skip) => mockUserInventoryPage({ periodTo, skip, top: INVENTORY_PAGE_SIZE })
        : (skip) => fetchUserInventoryPage({ targetSystem, top: INVENTORY_PAGE_SIZE, skip });
      rollup.inventoryUsers = await pageInto(db, {
        fetchPage,
        snapshotId,
        targetSystemId,
        mapRow: (row) => ({
          ID: randomUUID(),
          extractionRun_ID: run.ID,
          targetSystem_ID: targetSystemId,
          TenantId: run.TenantId,
          UserKey: userKeyOf(row.UserKey),
          FullName: '',
          Email: '',
          UserType: row.UserType || '',
          UserGroup: row.UserGroup || '',
          Department: '',
          CostCenter: '',
          ValidFrom: row.ValidFrom || null,
          ValidTo: row.ValidTo || null,
          LockStatus: row.LockStatus || '',
          LastLogonOn: row.LastLogonOn || null,
          // Dialog user, not locked, logged on inside the extraction window.
          IsActiveDialogUser: row.UserType === 'A' && !row.LockStatus && Boolean(row.LastLogonOn) && String(row.LastLogonOn) >= String(periodFrom),
          RoleCount: Number(row.RoleCount || 0),
          DistinctTcodeCount: 0,
          UsesFioriToday: false
        }),
        into: 'adops.db.UserInventory',
        reportProgress,
        phase: 'Collecting user inventory (USR02)',
        isCancelRequested
      });
      await log('INFO', 'USR02', `${rollup.inventoryUsers} user inventory rows`);
    }

    // --- AGR_*: roles, assignments and granted transactions (S8) ----------
    if (sources.includes('AGR') && !(await isCancelRequested())) {
      await reportProgress({ phase: 'Collecting roles (AGR_DEFINE)', processedItems: 0, totalItems: 0 });
      const snapshotId = await createSnapshot(db, run, targetSystem, 'AGR', granularity, periodFrom, periodTo, 'INVENTORY');
      const inventoryRow = (extra) => ({
        ID: randomUUID(), extractionRun_ID: run.ID, targetSystem_ID: targetSystemId, TenantId: run.TenantId, ...extra
      });

      rollup.roles = await pageInto(db, {
        fetchPage: shouldMockSap()
          ? (skip) => mockRoleInventoryPage({ periodTo, skip, top: INVENTORY_PAGE_SIZE })
          : (skip) => fetchRoleInventoryPage({ targetSystem, top: INVENTORY_PAGE_SIZE, skip }),
        snapshotId,
        targetSystemId,
        mapRow: (row) => inventoryRow({
          RoleName: row.RoleName,
          RoleText: row.RoleText || '',
          RoleType: row.RoleType || 'SINGLE',
          ParentRole: row.ParentRole || '',
          IsSapDelivered: Boolean(row.IsSapDelivered),
          MenuTcodeCount: Number(row.MenuTcodeCount || 0),
          AuthTcodeCount: Number(row.AuthTcodeCount || 0),
          UserCount: Number(row.UserCount || 0),
          HasFioriCatalog: false,
          BusinessCatalogCount: 0,
          ChangedOn: row.ChangedOn || null
        }),
        into: 'adops.db.RoleInventory',
        reportProgress,
        phase: 'Collecting roles (AGR_DEFINE)',
        isCancelRequested
      });
      await log('INFO', 'AGR', `${rollup.roles} role rows`);

      if (!(await isCancelRequested())) {
        const roleUsersSnapshotId = await createSnapshot(db, run, targetSystem, 'AGR_USERS', granularity, periodFrom, periodTo, 'INVENTORY');
        rollup.roleUsers = await pageInto(db, {
          fetchPage: shouldMockSap()
            ? (skip) => mockRoleUsersPage({ periodTo, skip, top: INVENTORY_PAGE_SIZE })
            : (skip) => fetchRoleUsersPage({ targetSystem, top: INVENTORY_PAGE_SIZE, skip }),
          snapshotId: roleUsersSnapshotId,
          targetSystemId,
          mapRow: (row) => inventoryRow({
            RoleName: row.RoleName,
            UserKey: userKeyOf(row.UserKey),
            ValidFrom: row.ValidFrom || null,
            ValidTo: row.ValidTo || null
          }),
          into: 'adops.db.RoleUsers',
          reportProgress,
          phase: 'Collecting role assignments (AGR_USERS)',
          isCancelRequested
        });
        await log('INFO', 'AGR', `${rollup.roleUsers} role-user rows`);
      }

      for (const source of ['MENU', 'AUTH']) {
        if (await isCancelRequested()) break;
        const tcodesSnapshotId = await createSnapshot(db, run, targetSystem, source === 'MENU' ? 'AGR_TCODES' : 'AGR_1251', granularity, periodFrom, periodTo, 'INVENTORY');
        rollup.roleTcodes += await pageInto(db, {
          fetchPage: shouldMockSap()
            ? (skip) => mockRoleTransactionsPage({ source, skip, top: INVENTORY_PAGE_SIZE })
            : (skip) => fetchRoleTransactionsPage({ targetSystem, source, top: INVENTORY_PAGE_SIZE, skip }),
          snapshotId: tcodesSnapshotId,
          targetSystemId,
          mapRow: (row) => inventoryRow({ RoleName: row.RoleName, TransactionCode: row.TransactionCode, Source: source }),
          into: 'adops.db.RoleTransactions',
          reportProgress,
          phase: `Collecting role transactions (${source === 'MENU' ? 'AGR_TCODES' : 'AGR_1251 S_TCODE'})`,
          isCancelRequested
        });
      }
      await log('INFO', 'AGR', `${rollup.roleTcodes} role-transaction rows (menu + S_TCODE)`);
    }

    // --- Rollup: distinct transactions per inventory user -------------------
    // USERTCODE is bounded at the source (top-N per tcode), so the set of
    // (user, tcode) pairs is bounded too; one update per user that has any.
    if (userTcodeSnapshotId && rollup.inventoryUsers > 0 && !(await isCancelRequested())) {
      await reportProgress({ phase: 'Rolling up user activity', processedItems: 0, totalItems: 0 });
      const pairs = await SELECT.distinct.from('adops.db.UserTransactionUsage')
        .columns('UserKey', 'TransactionCode').where({ snapshot_ID: userTcodeSnapshotId });
      const perUser = new Map();
      for (const pair of pairs) perUser.set(pair.UserKey, (perUser.get(pair.UserKey) || 0) + 1);
      for (const [userKey, count] of perUser) {
        await UPDATE('adops.db.UserInventory').set({ DistinctTcodeCount: count })
          .where({ extractionRun_ID: run.ID, UserKey: userKey });
      }
      await log('INFO', 'USR02', `${perUser.size} inventory users carry usage in the window`);
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

// SHA-256 over a per-tenant random secret (tenant-secrets.js) and the
// uppercased user id, 24 hex chars like the add-on's ZCL_ADO_PSEUDONYM. The
// salt is a secret, never the tenant id: a pseudonym must not be
// reproducible by anyone who merely knows which tenant it belongs to.
function pseudonymiseUser(userKey, salt) {
  if (!salt) throw new Error('pseudonymiseUser: a tenant salt is required');
  return createHash('sha256')
    .update(`ADOPS::${salt}::${String(userKey || '').toUpperCase()}`)
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

// Mirrors the ABAP reader's bounds (S6): threshold first, then top-N per
// transaction; topUsersPerTcode <= 0 means no limit.
function mockUserTransactionUsagePage({ periodFrom, periodTo, skip, top, topUsersPerTcode = 20, minExecutions = 1 }) {
  const random = seededRandom(4711);
  const rows = [];
  const threshold = Math.max(1, Number(minExecutions) || 1);
  for (const r of mockRows()) {
    const userCount = topUsersPerTcode > 0 ? Math.min(r.users, topUsersPerTcode) : r.users;
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
  const kept = rows.filter((row) => row.ExecutionCount >= threshold);
  kept.sort((a, b) => a.TransactionCode.localeCompare(b.TransactionCode) || a.UserKey.localeCompare(b.UserKey));
  const page = kept.slice(skip, skip + top);
  return { rows: page, totalCount: kept.length, hasMore: skip + page.length < kept.length, parametersApplied: true };
}

// --- Mock inventory (S8): coherent with the mock usage above ----------------
// Users are the USERTCODE user keys (department-prefixed) plus a few system
// users; every department has one Z role granting its transactions, and the
// three SAP_BR_* business roles carry S_TCODE values only (AGR_1251).

const MOCK_DEPARTMENT_COMPONENTS = {
  Sales: ['SD'], Procurement: ['MM'], Finance: ['FI', 'CO'], Production: ['PP'],
  Quality: ['QM'], Maintenance: ['PM'], HR: ['HR', 'PA'], IT: ['BC']
};
const MOCK_SAP_ROLES = [
  ['SAP_BR_INTERNAL_SALES_REP', 'Internal Sales Representative', ['VA01', 'VA02', 'VA03', 'VA05']],
  ['SAP_BR_PURCHASER', 'Purchaser', ['ME21N', 'ME22N', 'ME23N', 'ME51N']],
  ['SAP_BR_BILLING_CLERK', 'Billing Clerk', ['VF01', 'VF03']]
];

const departmentOfUserKey = (userKey) => MOCK_DEPARTMENTS.find((d) => userKey.startsWith(d.toUpperCase().slice(0, 4))) || 'IT';
const departmentRole = (department) => `Z_${department.toUpperCase()}_CLERK`;

function mockInventoryUsers() {
  const usage = mockUserTransactionUsagePage({ periodFrom: '2026-01-01', periodTo: '2026-12-31', skip: 0, top: 100000, topUsersPerTcode: 20, minExecutions: 1 });
  const keys = [...new Set(usage.rows.map((r) => r.UserKey))].sort();
  const users = keys.map((key, i) => ({
    UserKey: key, UserType: 'A', UserGroup: departmentOfUserKey(key).toUpperCase().slice(0, 12),
    LockFlag: i % 9 === 8 ? 64 : 0, Stale: i % 7 === 6
  }));
  for (let i = 1; i <= 3; i++) users.push({ UserKey: `SYS_BATCH_${String(i).padStart(3, '0')}`, UserType: 'B', UserGroup: 'SYSTEM', LockFlag: 0, Stale: false });
  return users;
}

function mockRoleUsers() {
  const rows = [];
  mockInventoryUsers().filter((u) => u.UserType === 'A').forEach((u, i) => {
    rows.push({ RoleName: departmentRole(departmentOfUserKey(u.UserKey)), UserKey: u.UserKey });
    if (i % 5 === 0) rows.push({ RoleName: MOCK_SAP_ROLES[i % MOCK_SAP_ROLES.length][0], UserKey: u.UserKey });
  });
  return rows.sort((a, b) => a.RoleName.localeCompare(b.RoleName) || a.UserKey.localeCompare(b.UserKey));
}

function mockRoleTransactions(source) {
  const rows = [];
  if (source === 'MENU') {
    for (const department of MOCK_DEPARTMENTS) {
      const components = MOCK_DEPARTMENT_COMPONENTS[department] || [];
      for (const r of mockRows()) {
        if (components.includes(lineOfBusinessOf(r.component))) rows.push({ RoleName: departmentRole(department), TransactionCode: r.code, Source: 'MENU' });
      }
    }
  } else {
    for (const [role, , tcodes] of MOCK_SAP_ROLES) for (const tcode of tcodes) rows.push({ RoleName: role, TransactionCode: tcode, Source: 'AUTH' });
  }
  return rows.sort((a, b) => a.RoleName.localeCompare(b.RoleName) || a.TransactionCode.localeCompare(b.TransactionCode));
}

const pageOf = (rows, skip, top) => {
  const page = rows.slice(skip, skip + top);
  return { rows: page, totalCount: rows.length, hasMore: skip + page.length < rows.length };
};

function mockUserInventoryPage({ periodTo, skip, top }) {
  const assignments = mockRoleUsers();
  const rows = mockInventoryUsers().map((u) => ({
    UserKey: u.UserKey, UserType: u.UserType, UserGroup: u.UserGroup,
    ValidFrom: '2020-01-01', ValidTo: '9999-12-31',
    LockStatus: u.LockFlag === 64 ? 'AD' : '',
    LastLogonOn: u.Stale ? '2025-01-15' : periodTo,
    RoleCount: assignments.filter((a) => a.UserKey === u.UserKey).length
  }));
  return pageOf(rows, skip, top);
}

function mockRoleInventoryPage({ periodTo, skip, top }) {
  const assignments = mockRoleUsers();
  const menu = mockRoleTransactions('MENU');
  const auth = mockRoleTransactions('AUTH');
  const rows = [
    ...MOCK_DEPARTMENTS.map((d) => ({ RoleName: departmentRole(d), RoleText: `${d} clerk (mock)`, RoleType: 'SINGLE', ParentRole: '', IsSapDelivered: false })),
    ...MOCK_SAP_ROLES.map(([role, text]) => ({ RoleName: role, RoleText: text, RoleType: 'SINGLE', ParentRole: '', IsSapDelivered: true }))
  ].map((role) => ({
    ...role,
    MenuTcodeCount: menu.filter((t) => t.RoleName === role.RoleName).length,
    AuthTcodeCount: auth.filter((t) => t.RoleName === role.RoleName).length,
    UserCount: assignments.filter((a) => a.RoleName === role.RoleName).length,
    ChangedOn: periodTo
  })).sort((a, b) => a.RoleName.localeCompare(b.RoleName));
  return pageOf(rows, skip, top);
}

function mockRoleUsersPage({ skip, top }) {
  return pageOf(mockRoleUsers().map((a) => ({ ...a, ValidFrom: '2020-01-01', ValidTo: '9999-12-31' })), skip, top);
}

function mockRoleTransactionsPage({ source, skip, top }) {
  return pageOf(mockRoleTransactions(source), skip, top);
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
  // eslint-disable-next-line no-control-regex -- stripping raw control bytes is the point
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
    const salt = keepIdentified || pseudonymised ? null : await pseudonymSaltFor(tenantId);
    await db.run(INSERT.into('adops.db.UserTransactionUsage').entries(userTcodes.map((row) => ({
      ID: randomUUID(),
      snapshot_ID: userSnapshot,
      targetSystem_ID: targetSystem.ID,
      TenantId: tenantId,
      UserKey: keepIdentified ? row.user : (pseudonymised ? row.user : pseudonymiseUser(row.user, salt)),
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
  sanitizeExtractJson,
  mockUserTransactionUsagePage,
  mockUserInventoryPage,
  mockRoleInventoryPage,
  mockRoleUsersPage,
  mockRoleTransactionsPage
};
