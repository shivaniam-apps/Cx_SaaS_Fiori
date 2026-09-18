// Enterprise-volume load test (roadmap T7) for the three pages the
// performance rules name first: Dashboard, Usage Insight and User & Role
// Landscape. It fills one extraction run with a generated enterprise-sized
// data set straight into the database (no S/4 round trips), then drives the
// exact reads the client issues under concurrency and checks two things:
//
//   1. every response stays bounded (page size, never "everything"), and
//   2. the p95 latency stays under a budget.
//
// Scale: ADOPTOPS_LOAD_SCALE multiplies the base volumes (1 = CI-sized, a few
// seconds; 20 = the enterprise reference: ~8,000 transactions, 50,000 users,
// 200,000 user x transaction rows, 5,000 roles, 120,000 assignments). Budget:
// ADOPTOPS_LOAD_BUDGET_MS (default 1000 at scale < 10, else 3000). Rows are
// removed again in after() so later suites see the shared database as before.
// `npm run test:load` runs the enterprise reference and prints the table that
// docu/13-operations-observability/performance-baseline.md records.
import { expect } from 'chai';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cds, test, as, json, expectInMemoryDb, fixtures } from './helpers/cds-http-test.mjs';

const { INSERT, DELETE } = cds.ql;
const F = fixtures('LOAD');
const SCALE = Math.max(1, Number(process.env.ADOPTOPS_LOAD_SCALE) || 1);
const BUDGET_MS = Number(process.env.ADOPTOPS_LOAD_BUDGET_MS) || (SCALE >= 10 ? 3000 : 1000);
const CONCURRENCY = 6;
const ROUNDS = 3;
const CHUNK = 500;

const VOLUME = {
  tcodes: 400 * SCALE,
  users: 2500 * SCALE,
  userTcodeRows: 10000 * SCALE,
  roles: 250 * SCALE,
  roleUsers: 6000 * SCALE,
  roleTcodes: 2500 * SCALE,
  proposals: 300 * SCALE
};

// Deterministic pseudo-random so two runs seed the same data.
let seed = 42;
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (list) => list[Math.floor(random() * list.length)];
const pad = (n, width) => String(n).padStart(width, '0');
const COMPONENTS = ['SD-SLS', 'MM-PUR', 'FI-GL', 'FI-AP', 'CO-OM', 'PP-SFC', 'HR-PA', 'BC-SEC'];
const LOBS = ['Sales', 'Procurement', 'Finance', 'Finance', 'Controlling', 'Manufacturing', 'Human Resources', 'Basis'];
const TENANT = 'GLOBAL';

async function insertChunked(entity, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await INSERT.into(entity).entries(rows.slice(i, i + CHUNK));
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const results = [];

// Runs `request` CONCURRENCY x ROUNDS times, records p50/p95/max and the row
// count of the payload, asserts bounded rows and the budget.
async function measure(label, request, { maxRows }) {
  const durations = [];
  let rows = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const batch = await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      const started = process.hrtime.bigint();
      const response = await request();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      expect(response.status, `${label}: ${JSON.stringify(response.data).slice(0, 200)}`).to.equal(200);
      return { ms, rows: countRows(response.data) };
    }));
    for (const item of batch) {
      durations.push(item.ms);
      rows = item.rows;
    }
  }
  const row = { label, rows, p50: Math.round(percentile(durations, 50)), p95: Math.round(percentile(durations, 95)), max: Math.round(Math.max(...durations)) };
  results.push(row);
  expect(rows, `${label}: payload must stay bounded`).to.be.at.most(maxRows);
  expect(row.p95, `${label}: p95 ${row.p95} ms over the budget of ${BUDGET_MS} ms`).to.be.at.most(BUDGET_MS);
  return row;
}

function countRows(data) {
  if (Array.isArray(data?.value)) return data.value.length;
  if (Array.isArray(data?.Items)) return data.Items.length;
  if (typeof data?.value === 'string') {
    const parsed = JSON.parse(data.value);
    return Array.isArray(parsed?.Items) ? parsed.Items.length : Object.keys(parsed || {}).length;
  }
  return 1;
}

const odata = (entity, query) => `/fiori/${entity}?${Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;

describe(`enterprise-volume load (scale ${SCALE}, budget ${BUDGET_MS} ms)`, function () {
  this.timeout(SCALE >= 10 ? 1800000 : 300000);

  const ids = { system: null, run: null, analysis: null, snapshots: {} };
  const tcodes = [];
  let seedMs = 0;

  before(async () => {
    expectInMemoryDb();
    const started = Date.now();
    const system = await test.axios.post('/fiori/TargetSystems', {
      displayName: F.name('Load DEV'), destinationName: F.destination('DEV'), systemId: 'LOD', client: '100', environment: 'DEV'
    }, json('alice'));
    expect(system.status, JSON.stringify(system.data)).to.equal(201);
    ids.system = system.data.ID;

    ids.run = randomUUID();
    const period = { PeriodFrom: '2026-01-01', PeriodTo: '2026-06-30' };
    await INSERT.into('adops.db.ExtractionRuns').entries({
      ID: ids.run, TenantId: TENANT, targetSystem_ID: ids.system, Title: F.name('Enterprise volume'), Status: 'COMPLETED',
      SourcesJson: JSON.stringify(['ST03N', 'USR02', 'AGR']), ...period, PeriodGranularity: 'MONTH', Pseudonymised: true,
      TransactionRowCount: VOLUME.tcodes, UserRowCount: VOLUME.users, RoleRowCount: VOLUME.roles
    });
    for (const source of ['ST03N', 'USR02', 'AGR']) {
      ids.snapshots[source] = randomUUID();
      await INSERT.into('adops.db.UsageSnapshots').entries({
        ID: ids.snapshots[source], TenantId: TENANT, extractionRun_ID: ids.run, targetSystem_ID: ids.system, Source: source,
        SapAggregationLevel: 'MONTH', TaskType: 'DIALOG', ...period, CollectedAt: new Date().toISOString(), RowCount: 0, Truncated: false, DataSource: 'MOCK'
      });
    }

    // Transactions: heavy-tailed executions, ~15% custom.
    const usage = [];
    for (let i = 0; i < VOLUME.tcodes; i += 1) {
      const custom = i % 7 === 0;
      const code = custom ? `Z${pad(i, 5)}` : `T${pad(i, 5)}`;
      const weight = 1 / (1 + i / 50);
      const executions = Math.max(1, Math.round(weight * weight * 500000 + random() * 50));
      const componentIndex = i % COMPONENTS.length;
      tcodes.push(code);
      usage.push({
        ID: randomUUID(), TenantId: TENANT, snapshot_ID: ids.snapshots.ST03N, targetSystem_ID: ids.system,
        TransactionCode: code, TransactionText: `Transaction ${code}`, ApplicationComponent: COMPONENTS[componentIndex], LineOfBusiness: LOBS[componentIndex],
        ...period, ExecutionCount: executions, DialogStepCount: executions * 3, DistinctUserCount: Math.max(1, Math.round(weight * 800)),
        TotalResponseTimeMs: executions * 420, AvgResponseTimeMs: 420, IsCustom: custom, IsStandard: !custom, Source: 'ST03N'
      });
    }
    await insertChunked('adops.db.TransactionUsage', usage);

    // Users and their transaction rows (top users per transaction).
    const userKeys = Array.from({ length: VOLUME.users }, (_, i) => `USR${pad(i, 6)}`);
    const users = userKeys.map((key, i) => ({
      ID: randomUUID(), TenantId: TENANT, targetSystem_ID: ids.system, extractionRun_ID: ids.run, UserKey: key, FullName: '', Email: '',
      UserType: i % 25 === 0 ? 'B' : 'A', UserGroup: `GRP${pad(i % 40, 2)}`, Department: `Dept ${i % 60}`, ValidTo: '9999-12-31', LockStatus: i % 33 === 0 ? '64' : '00',
      LastLogonOn: `2026-0${1 + (i % 6)}-${pad(1 + (i % 28), 2)}`, IsActiveDialogUser: i % 5 !== 0, RoleCount: 1 + (i % 12), DistinctTcodeCount: 1 + (i % 45), UsesFioriToday: i % 9 === 0
    }));
    await insertChunked('adops.db.UserInventory', users);

    const userTcodes = [];
    for (let i = 0; i < VOLUME.userTcodeRows; i += 1) {
      const code = tcodes[Math.min(tcodes.length - 1, Math.floor((i / VOLUME.userTcodeRows) ** 2 * tcodes.length))];
      const executions = Math.max(1, Math.round(random() * 5000));
      userTcodes.push({
        ID: randomUUID(), TenantId: TENANT, snapshot_ID: ids.snapshots.ST03N, targetSystem_ID: ids.system, UserKey: pick(userKeys),
        TransactionCode: code, ...period, ExecutionCount: executions, DialogStepCount: executions * 3, LastUsedOn: '2026-06-20'
      });
    }
    await insertChunked('adops.db.UserTransactionUsage', userTcodes);

    // Roles, assignments and menu transactions.
    const roleNames = Array.from({ length: VOLUME.roles }, (_, i) => (i % 4 === 0 ? `SAP_BR_ROLE_${pad(i, 5)}` : `Z_ROLE_${pad(i, 5)}`));
    await insertChunked('adops.db.RoleInventory', roleNames.map((name, i) => ({
      ID: randomUUID(), TenantId: TENANT, targetSystem_ID: ids.system, extractionRun_ID: ids.run, RoleName: name, RoleText: `Role ${name}`,
      RoleType: i % 10 === 0 ? 'COMPOSITE' : 'SINGLE', IsSapDelivered: name.startsWith('SAP_'), MenuTcodeCount: 1 + (i % 30), AuthTcodeCount: 5 + (i % 80),
      UserCount: i % 17 === 0 ? 0 : 1 + (i % 400), HasFioriCatalog: i % 6 === 0, BusinessCatalogCount: i % 6 === 0 ? 1 + (i % 4) : 0, ChangedOn: `2025-${pad(1 + (i % 12), 2)}-15`
    })));
    await insertChunked('adops.db.RoleUsers', Array.from({ length: VOLUME.roleUsers }, () => ({
      ID: randomUUID(), TenantId: TENANT, targetSystem_ID: ids.system, extractionRun_ID: ids.run, RoleName: pick(roleNames), UserKey: pick(userKeys), ValidFrom: '2020-01-01', ValidTo: '9999-12-31'
    })));
    await insertChunked('adops.db.RoleTransactions', Array.from({ length: VOLUME.roleTcodes }, (_, i) => ({
      ID: randomUUID(), TenantId: TENANT, targetSystem_ID: ids.system, extractionRun_ID: ids.run, RoleName: pick(roleNames), TransactionCode: pick(tcodes), Source: i % 3 === 0 ? 'AUTH' : 'MENU'
    })));

    // A completed analysis with proposals so the dashboard has something to count.
    ids.analysis = randomUUID();
    await INSERT.into('adops.db.AnalysisRuns').entries({
      ID: ids.analysis, TenantId: TENANT, targetSystem_ID: ids.system, extractionRun_ID: ids.run, Title: F.name('Analysis'), Status: 'COMPLETED',
      ScoringProfile: 'BALANCED', CompletedAt: new Date().toISOString(), ProposalCount: VOLUME.proposals
    });
    const statuses = ['NEW', 'NEW', 'NEW', 'APPROVED', 'REJECTED', 'DEFERRED', 'SUPERSEDED'];
    await insertChunked('adops.db.AppProposals', Array.from({ length: VOLUME.proposals }, (_, i) => ({
      ID: randomUUID(), TenantId: TENANT, analysisRun_ID: ids.analysis, targetSystem_ID: ids.system, FioriId: `F${pad(i, 4)}`, AppTitle: `App ${i}`,
      LineOfBusiness: LOBS[i % LOBS.length], Score: 100 - (i % 100), Rank: i + 1, Confidence: 'HIGH', TotalExecutions: 1000 + i, DistinctUserCount: 10 + (i % 300), ReviewStatus: statuses[i % statuses.length]
    })));
    seedMs = Date.now() - started;
  });

  after(async () => {
    const summary = [
      '',
      `| Read | Rows | p50 ms | p95 ms | max ms |`, '|---|---|---|---|---|',
      ...results.map((r) => `| ${r.label} | ${r.rows} | ${r.p50} | ${r.p95} | ${r.max} |`),
      '',
      `scale ${SCALE}: ${VOLUME.tcodes} transactions, ${VOLUME.users} users, ${VOLUME.userTcodeRows} user x transaction rows, ${VOLUME.roles} roles, ${VOLUME.roleUsers} assignments, ${VOLUME.roleTcodes} role transactions, ${VOLUME.proposals} proposals; seeded in ${seedMs} ms; ${CONCURRENCY} concurrent x ${ROUNDS} rounds per read; budget ${BUDGET_MS} ms.`
    ].join('\n');
    // cds.test captures console output; stdout and an optional report file get the table.
    process.stdout.write(`${summary}\n`);
    if (process.env.ADOPTOPS_LOAD_REPORT) writeFileSync(process.env.ADOPTOPS_LOAD_REPORT, `${summary}\n`);

    // Leave the shared database as it was for the suites that run later.
    if (ids.analysis) await DELETE.from('adops.db.AppProposals').where({ analysisRun_ID: ids.analysis });
    if (ids.analysis) await DELETE.from('adops.db.AnalysisRuns').where({ ID: ids.analysis });
    if (ids.run) {
      for (const entity of ['RoleTransactions', 'RoleUsers', 'RoleInventory', 'UserInventory']) {
        await DELETE.from(`adops.db.${entity}`).where({ extractionRun_ID: ids.run });
      }
      const snapshotIds = Object.values(ids.snapshots);
      await DELETE.from('adops.db.UserTransactionUsage').where({ snapshot_ID: { in: snapshotIds } });
      await DELETE.from('adops.db.TransactionUsage').where({ snapshot_ID: { in: snapshotIds } });
      await DELETE.from('adops.db.UsageSnapshots').where({ extractionRun_ID: ids.run });
      await DELETE.from('adops.db.ExtractionRuns').where({ ID: ids.run });
    }
    if (ids.system) await DELETE.from('adops.db.TargetSystems').where({ ID: ids.system });
  });

  it('Dashboard: the cockpit summary stays one grouped read', async () => {
    await measure('Dashboard summary (one system)', () => test.axios.get(`/fiori/queryDashboardSummary(targetSystemId=${ids.system})`, as('carol')), { maxRows: 20 });
    await measure('Dashboard summary (all systems)', () => test.axios.get('/fiori/queryDashboardSummary(targetSystemId=null)', as('carol')), { maxRows: 20 });
  });

  it('Usage Insight: paged transaction reads and the user drill-down stay bounded', async () => {
    const post = (body) => test.axios.post('/fiori/queryTransactionUsage', { extractionRunId: ids.run, ...body }, json('carol'));
    await measure('Usage: first page with summary (top 200)', () => post({ top: 200 }), { maxRows: 200 });
    await measure('Usage: middle page (skip half)', () => post({ top: 200, skip: Math.floor(VOLUME.tcodes / 2), includeSummary: false }), { maxRows: 200 });
    await measure('Usage: search "T00" with summary', () => post({ top: 200, search: 'T00' }), { maxRows: 200 });
    await measure('Usage: custom only, sorted by code', () => post({ top: 200, customOnly: true, sortField: 'TransactionCode', sortDirection: 'asc' }), { maxRows: 200 });
    await measure('Usage: overview', () => test.axios.get(`/fiori/queryUsageOverview(extractionRunId=${ids.run})`, as('carol')), { maxRows: 20 });
    const hot = tcodes[0];
    await measure('Usage: users of a transaction (client filter)', () => test.axios.get(odata('UserTransactionUsage', { $filter: `TransactionCode eq '${hot}'`, $orderby: 'ExecutionCount desc', $top: 50, $count: 'true' }), as('carol')), { maxRows: 50 });
    await measure('Usage: users of a transaction (run-scoped)', () => test.axios.get(odata('UserTransactionUsage', { $filter: `snapshot_ID eq ${ids.snapshots.ST03N} and TransactionCode eq '${hot}'`, $orderby: 'ExecutionCount desc', $top: 50, $count: 'true' }), as('carol')), { maxRows: 50 });
  });

  it('Landscape: users and roles page server-side with counts and groups', async () => {
    const scope = `extractionRun_ID eq ${ids.run}`;
    await measure('Landscape: users, most transactions (top 100)', () => test.axios.get(odata('UserInventory', { $filter: scope, $orderby: 'DistinctTcodeCount desc,UserKey', $top: 100, $count: 'true' }), as('carol')), { maxRows: 100 });
    await measure('Landscape: users, page 3 (skip 200)', () => test.axios.get(odata('UserInventory', { $filter: scope, $orderby: 'LastLogonOn desc,UserKey', $top: 100, $skip: 200, $count: 'true' }), as('carol')), { maxRows: 100 });
    await measure('Landscape: users, search + active filter', () => test.axios.get(odata('UserInventory', { $filter: `${scope} and (contains(UserKey,'USR00') or contains(FullName,'USR00')) and IsActiveDialogUser eq true`, $orderby: 'UserKey', $top: 100, $count: 'true' }), as('carol')), { maxRows: 100 });
    await measure('Landscape: user groups by type', () => test.axios.get(`/fiori/UserInventory?$apply=${encodeURIComponent(`filter(${scope})/groupby((UserType),aggregate($count as count))`)}`, as('carol')), { maxRows: 10 });
    await measure('Landscape: user groups by group', () => test.axios.get(`/fiori/UserInventory?$apply=${encodeURIComponent(`filter(${scope})/groupby((UserGroup),aggregate($count as count))`)}`, as('carol')), { maxRows: 100 });
    await measure('Landscape: roles of one user', () => test.axios.get(odata('RoleUsers', { $filter: `${scope} and UserKey eq 'USR000001'`, $orderby: 'RoleName', $top: 100, $count: 'true' }), as('carol')), { maxRows: 100 });
    await measure('Landscape: roles, most users (top 100)', () => test.axios.get(odata('RoleInventory', { $filter: scope, $orderby: 'UserCount desc,RoleName', $top: 100, $count: 'true' }), as('carol')), { maxRows: 100 });
    await measure('Landscape: roles, custom + search', () => test.axios.get(odata('RoleInventory', { $filter: `${scope} and (contains(RoleName,'Z_ROLE_00') or contains(RoleText,'Z_ROLE_00')) and IsSapDelivered eq false`, $orderby: 'RoleName', $top: 100, $count: 'true' }), as('carol')), { maxRows: 100 });
    await measure('Landscape: role groups by type', () => test.axios.get(`/fiori/RoleInventory?$apply=${encodeURIComponent(`filter(${scope})/groupby((RoleType),aggregate($count as count))`)}`, as('carol')), { maxRows: 10 });
    await measure('Landscape: members of one role', () => test.axios.get(odata('RoleUsers', { $filter: `${scope} and RoleName eq 'Z_ROLE_00001'`, $orderby: 'UserKey', $top: 100, $count: 'true' }), as('carol')), { maxRows: 100 });
    await measure('Landscape: transactions of one role', () => test.axios.get(odata('RoleTransactions', { $filter: `${scope} and RoleName eq 'Z_ROLE_00001'`, $orderby: 'TransactionCode', $top: 100, $count: 'true' }), as('carol')), { maxRows: 100 });
  });
});
