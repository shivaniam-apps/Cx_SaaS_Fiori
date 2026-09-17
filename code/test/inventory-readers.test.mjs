import { expect } from 'chai';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const cds = require('@sap/cds');
const { SELECT, INSERT } = cds.ql;
const {
  mapUserInventory,
  mapRoleInventory,
  mapRoleUser,
  mapRoleTransaction,
  lockStatusOf
} = require('../srv/srv/utils/s4-fiori-adapter.js');
const {
  runUsageExtraction,
  pseudonymiseUser,
  mockUserInventoryPage,
  mockRoleInventoryPage,
  mockRoleUsersPage,
  mockRoleTransactionsPage
} = require('../srv/srv/utils/usage-extraction.js');

// ---------------------------------------------------------------------------
// S8: roles and users readers (USR02, AGR_*) fill the inventory tables.
// ---------------------------------------------------------------------------

describe('inventory row mappers (the ZADO inventory entities <-> CAP contract)', () => {
  it('maps USR02 rows and derives the lock status from UFLAG', () => {
    expect(lockStatusOf(0)).to.equal('');
    expect(lockStatusOf(128)).to.equal('PW');
    expect(lockStatusOf(64)).to.equal('AD');
    expect(lockStatusOf(32)).to.equal('AD');
    expect(lockStatusOf(192)).to.equal('LK');
    const row = mapUserInventory({ UserKey: 'abc', UserType: 'A', UserGroup: 'SALES', ValidFrom: '2020-01-01', ValidTo: '9999-12-31', LockFlag: 128, LastLogonOn: '2026-06-01', RoleCount: '3' });
    expect(row).to.include({ UserKey: 'abc', UserType: 'A', UserGroup: 'SALES', LockStatus: 'PW', LastLogonOn: '2026-06-01', RoleCount: 3 });
    // Raw USR02 aliases degrade gracefully.
    expect(mapUserInventory({ Bname: 'x', Ustyp: 'B', Uflag: 0 })).to.include({ UserKey: 'x', UserType: 'B', LockStatus: '' });
  });

  it('maps roles, assignments and transactions with SAP namespace detection', () => {
    expect(mapRoleInventory({ RoleName: 'SAP_BR_PURCHASER', RoleType: 'SINGLE', IsSapDelivered: 'X', AuthTcodeCount: 4 }))
      .to.include({ RoleName: 'SAP_BR_PURCHASER', IsSapDelivered: true, AuthTcodeCount: 4, MenuTcodeCount: 0 });
    expect(mapRoleInventory({ AgrName: 'Z_SALES', ParentAgr: 'Z_BASE' })).to.include({ RoleName: 'Z_SALES', ParentRole: 'Z_BASE', IsSapDelivered: false });
    expect(mapRoleUser({ RoleName: 'Z_SALES', UserKey: 'u1', ValidFrom: '2020-01-01' })).to.include({ RoleName: 'Z_SALES', UserKey: 'u1' });
    expect(mapRoleTransaction({ RoleName: 'Z_SALES', TransactionCode: 'VA01', Source: 'MENU' })).to.deep.equal({ RoleName: 'Z_SALES', TransactionCode: 'VA01', Source: 'MENU' });
    expect(mapRoleTransaction({ AgrName: 'SAP_BR_X', Low: 'ME21N' })).to.deep.equal({ RoleName: 'SAP_BR_X', TransactionCode: 'ME21N', Source: 'MENU' });
  });
});

describe('mock inventory is coherent with the mock usage', () => {
  const big = { periodTo: '2026-06-30', skip: 0, top: 100000 };

  it('every role assignment points at an inventory user and an inventory role', () => {
    const users = new Set(mockUserInventoryPage(big).rows.map((u) => u.UserKey));
    const roles = new Set(mockRoleInventoryPage(big).rows.map((r) => r.RoleName));
    const assignments = mockRoleUsersPage(big).rows;
    expect(assignments.length).to.be.greaterThan(0);
    for (const a of assignments) {
      expect(users.has(a.UserKey), a.UserKey).to.equal(true);
      expect(roles.has(a.RoleName), a.RoleName).to.equal(true);
    }
  });

  it('role counts on the inventory rows match the assignment and transaction lists', () => {
    const roles = mockRoleInventoryPage(big).rows;
    const assignments = mockRoleUsersPage(big).rows;
    const menu = mockRoleTransactionsPage({ source: 'MENU', skip: 0, top: 100000 }).rows;
    const auth = mockRoleTransactionsPage({ source: 'AUTH', skip: 0, top: 100000 }).rows;
    for (const role of roles) {
      expect(role.UserCount, role.RoleName).to.equal(assignments.filter((a) => a.RoleName === role.RoleName).length);
      expect(role.MenuTcodeCount, role.RoleName).to.equal(menu.filter((t) => t.RoleName === role.RoleName).length);
      expect(role.AuthTcodeCount, role.RoleName).to.equal(auth.filter((t) => t.RoleName === role.RoleName).length);
    }
    expect(roles.filter((r) => r.IsSapDelivered).every((r) => r.MenuTcodeCount === 0 && r.AuthTcodeCount > 0)).to.equal(true, 'SAP_BR roles carry S_TCODE values only');
    expect(mockUserInventoryPage(big).rows.find((u) => u.RoleCount === 0)?.UserType).to.equal('B', 'only system users have no role');
  });

  it('pages deterministically', () => {
    const first = mockRoleUsersPage({ skip: 0, top: 10 });
    const second = mockRoleUsersPage({ skip: 10, top: 10 });
    expect(first.rows).to.have.length(10);
    expect(first.hasMore).to.equal(true);
    expect(second.rows[0]).to.not.deep.equal(first.rows[0]);
    expect(first.totalCount).to.equal(second.totalCount);
  });
});

describe('extraction fills the inventory tables (mock, in-memory db)', function () {
  this.timeout(60000);
  const noProgress = async () => {};
  const notCancelled = async () => false;
  const logs = [];
  const log = async (severity, phase, message) => { logs.push({ severity, phase, message }); };

  before(async () => {
    process.env.ADOPTOPS_MOCK_S4 = 'true';
    const model = await cds.load(fileURLToPath(new URL('../db', import.meta.url)));
    await cds.deploy(model).to('sqlite::memory:');
  });
  after(() => { delete process.env.ADOPTOPS_MOCK_S4; });

  it('writes users, roles, assignments and transactions and rolls up per-user activity', async () => {
    const targetSystemId = randomUUID();
    const runId = randomUUID();
    await INSERT.into('adops.db.TargetSystems').entries({ ID: targetSystemId, TenantId: 'T', displayName: 'Mock DEV', destinationName: 'MOCK', environment: 'DEV', identifiedUsageAllowed: false });
    await INSERT.into('adops.db.ExtractionRuns').entries({ ID: runId, TenantId: 'T', targetSystem_ID: targetSystemId, Title: 'S8', Status: 'QUEUED', Pseudonymised: true });

    const summary = await runUsageExtraction({
      task: { ID: randomUUID() },
      payload: { targetSystemId, sources: ['ST03N', 'USR02', 'AGR'], periodFrom: '2026-01-01', periodTo: '2026-06-30', granularity: 'MONTH', topUsersPerTcode: 20, minExecutions: 1, runId },
      reportProgress: noProgress, log, isCancelRequested: notCancelled
    });
    expect(summary.inventoryUsers).to.be.greaterThan(0);
    expect(summary.roles).to.be.greaterThan(0);
    expect(summary.roleUsers).to.be.greaterThan(0);
    expect(summary.roleTcodes).to.be.greaterThan(0);

    const run = await SELECT.one.from('adops.db.ExtractionRuns').where({ ID: runId });
    expect(run.Status).to.equal('COMPLETED');
    expect(run.RoleRowCount).to.equal(summary.roles);

    const users = await SELECT.from('adops.db.UserInventory').where({ extractionRun_ID: runId });
    const roles = await SELECT.from('adops.db.RoleInventory').where({ extractionRun_ID: runId });
    const assignments = await SELECT.from('adops.db.RoleUsers').where({ extractionRun_ID: runId });
    const tcodes = await SELECT.from('adops.db.RoleTransactions').where({ extractionRun_ID: runId });
    expect(users.length).to.equal(summary.inventoryUsers);
    expect(roles.length).to.equal(summary.roles);
    expect(assignments.length).to.equal(summary.roleUsers);
    expect(tcodes.length).to.equal(summary.roleTcodes);
    expect(new Set(tcodes.map((t) => t.Source))).to.deep.equal(new Set(['MENU', 'AUTH']));

    // Pseudonyms correlate across usage, inventory and assignments.
    const usageKeys = new Set((await SELECT.from('adops.db.UserTransactionUsage').columns('UserKey').where({ targetSystem_ID: targetSystemId })).map((r) => r.UserKey));
    const inventoryKeys = new Set(users.map((u) => u.UserKey));
    expect([...usageKeys].every((k) => inventoryKeys.has(k))).to.equal(true, 'every usage user exists in the inventory');
    expect(assignments.every((a) => inventoryKeys.has(a.UserKey))).to.equal(true);
    expect(users[0].UserKey).to.equal(pseudonymiseUser(mockUserInventoryPage({ periodTo: '2026-06-30', skip: 0, top: 1 }).rows[0].UserKey, 'T'));

    // Rollups: active dialog users, role counts, distinct tcodes from usage.
    expect(users.some((u) => u.IsActiveDialogUser)).to.equal(true);
    expect(users.filter((u) => u.UserType === 'B').every((u) => !u.IsActiveDialogUser && u.RoleCount === 0)).to.equal(true);
    expect(users.filter((u) => u.LockStatus === 'AD').every((u) => !u.IsActiveDialogUser)).to.equal(true);
    expect(users.some((u) => u.DistinctTcodeCount > 0)).to.equal(true);
    expect(users.filter((u) => usageKeys.has(u.UserKey)).every((u) => u.DistinctTcodeCount > 0)).to.equal(true);
    expect(logs.some((l) => l.phase === 'AGR' && /role rows/.test(l.message))).to.equal(true);
  });
});
