import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANDSCAPE_VIEWS,
  LANDSCAPE_PAGE_SIZE,
  resolveLandscapeView,
  getLandscapeViewPath,
  landscapeRuns,
  userTypeLabel,
  lockStatusInfo,
  userStatus,
  EMPTY_USER_FILTER,
  buildUserFilter,
  userOrderby,
  hasActiveUserFilter,
  roleTypeLabel,
  EMPTY_ROLE_FILTER,
  buildRoleFilter,
  roleOrderby,
  hasActiveRoleFilter,
  buildUserRolesFilter,
  buildRoleMembersFilter,
  userCards,
  roleCards,
  groupedOptions,
  hasMore,
  splitRoleTransactions,
  formatDate,
  userLabel,
  runScope,
  userFilterFromParams,
  roleFilterFromParams
} from './landscapeModel.js';

const RUN = '1af8c995-cdd2-464f-9992-ef1c74c87512';
const SCOPE = `extractionRun_ID eq ${RUN}`;

test('views resolve from the route param and keep the run in the path', () => {
  assert.deepEqual(LANDSCAPE_VIEWS.map((v) => v.id), ['users', 'roles']);
  assert.equal(resolveLandscapeView(undefined), 'users');
  assert.equal(resolveLandscapeView('ROLES'), 'roles');
  assert.equal(resolveLandscapeView('nope'), 'users');
  assert.equal(getLandscapeViewPath('users'), '/landscape');
  assert.equal(getLandscapeViewPath('roles'), '/landscape/roles');
  assert.equal(getLandscapeViewPath('roles', { run: RUN }), `/landscape/roles?run=${RUN}`);
  assert.equal(getLandscapeViewPath('users', { run: RUN, user: '' }), `/landscape?run=${RUN}`);
  assert.equal(getLandscapeViewPath('roles', { run: RUN, role: 'Z_A&B ' }), `/landscape/roles?run=${RUN}&role=Z_A%26B`);
});

test('deep-link params pre-apply the search of the target tab', () => {
  assert.deepEqual(userFilterFromParams({}), EMPTY_USER_FILTER);
  assert.deepEqual(userFilterFromParams({ user: ' abc ' }), { ...EMPTY_USER_FILTER, search: 'abc' });
  assert.deepEqual(roleFilterFromParams({ role: '' }), EMPTY_ROLE_FILTER);
  assert.deepEqual(roleFilterFromParams({ role: 'Z_SALES' }), { ...EMPTY_ROLE_FILTER, search: 'Z_SALES' });
});

test('landscapeRuns keeps terminal runs that carried an inventory source', () => {
  const rows = [
    { ID: 'a', Status: 'COMPLETED', SourcesJson: '["ST03N"]' },
    { ID: 'b', Status: 'COMPLETED', SourcesJson: '["ST03N","USR02","AGR"]' },
    { ID: 'c', Status: 'PARTIAL', SourcesJson: '["AGR"]' },
    { ID: 'd', Status: 'RUNNING', SourcesJson: '["USR02"]' },
    { ID: 'e', Status: 'COMPLETED', SourcesJson: 'not json' },
    { ID: 'f', Status: 'COMPLETED' }
  ];
  assert.deepEqual(landscapeRuns(rows).map((r) => r.ID), ['b', 'c']);
  assert.deepEqual(landscapeRuns(null), []);
});

test('user type, lock status and row status labels', () => {
  assert.equal(userTypeLabel('A'), 'Dialog');
  assert.equal(userTypeLabel('b'), 'System');
  assert.equal(userTypeLabel('X'), 'Type X');
  assert.equal(userTypeLabel(''), '—');
  assert.equal(lockStatusInfo('').label, 'Unlocked');
  assert.equal(lockStatusInfo('AD').design, 'Negative');
  assert.equal(lockStatusInfo('PW').design, 'Critical');
  assert.equal(lockStatusInfo('ZZ').label, 'Locked (ZZ)');
  assert.deepEqual(userStatus({ UserType: 'A', LockStatus: 'AD', IsActiveDialogUser: true }), lockStatusInfo('AD'));
  assert.equal(userStatus({ UserType: 'A', LockStatus: '', IsActiveDialogUser: true }).label, 'Active');
  assert.equal(userStatus({ UserType: 'A', LockStatus: '', IsActiveDialogUser: false }).label, 'Inactive in window');
  assert.equal(userStatus({ UserType: 'B', LockStatus: '' }).label, 'Non-dialog');
});

test('runScope validates the run id and never quotes it', () => {
  assert.equal(runScope(RUN.toUpperCase()), SCOPE);
  assert.throws(() => runScope(''), /extraction run/);
  assert.throws(() => runScope("x' or 1 eq 1"), /extraction run/);
});

test('buildUserFilter always scopes to the run and adds only set filters', () => {
  assert.equal(buildUserFilter(RUN, EMPTY_USER_FILTER), SCOPE);
  assert.equal(
    buildUserFilter(RUN, { search: "o'neil", userType: 'a', userGroup: 'SALES', activity: 'ACTIVE' }),
    `${SCOPE} and (contains(UserKey,'o''neil') or contains(FullName,'o''neil')) and UserType eq 'A' and UserGroup eq 'SALES' and IsActiveDialogUser eq true`
  );
  assert.equal(buildUserFilter(RUN, { activity: 'INACTIVE' }), `${SCOPE} and IsActiveDialogUser eq false`);
  assert.equal(buildUserFilter(RUN, { search: '   ' }), SCOPE);
  assert.equal(hasActiveUserFilter(EMPTY_USER_FILTER), false);
  assert.equal(hasActiveUserFilter({ sort: 'key' }), false);
  assert.equal(hasActiveUserFilter({ userGroup: 'HR' }), true);
});

test('user and role sort ids map to server orderby expressions with a stable fallback', () => {
  assert.equal(userOrderby('activity'), 'DistinctTcodeCount desc,UserKey');
  assert.equal(userOrderby('logon'), 'LastLogonOn desc,UserKey');
  assert.equal(userOrderby('unknown'), 'DistinctTcodeCount desc,UserKey');
  assert.equal(roleOrderby('users'), 'UserCount desc,RoleName');
  assert.equal(roleOrderby('name'), 'RoleName');
  assert.equal(roleOrderby(undefined), 'UserCount desc,RoleName');
});

test('buildRoleFilter covers search, type, origin and assignment', () => {
  assert.equal(buildRoleFilter(RUN, EMPTY_ROLE_FILTER), SCOPE);
  assert.equal(
    buildRoleFilter(RUN, { search: 'clerk', roleType: 'single', origin: 'SAP', assignment: 'UNASSIGNED' }),
    `${SCOPE} and (contains(RoleName,'clerk') or contains(RoleText,'clerk')) and RoleType eq 'SINGLE' and IsSapDelivered eq true and UserCount eq 0`
  );
  assert.equal(buildRoleFilter(RUN, { origin: 'CUSTOM', assignment: 'ASSIGNED' }), `${SCOPE} and IsSapDelivered eq false and UserCount gt 0`);
  assert.equal(hasActiveRoleFilter(EMPTY_ROLE_FILTER), false);
  assert.equal(hasActiveRoleFilter({ origin: 'SAP' }), true);
  assert.equal(roleTypeLabel('COMPOSITE'), 'Composite');
  assert.equal(roleTypeLabel('other'), 'Other');
  assert.equal(roleTypeLabel(''), '—');
});

test('detail filters scope to the run and escape the key', () => {
  assert.equal(buildUserRolesFilter(RUN, 'abc'), `${SCOPE} and UserKey eq 'abc'`);
  assert.equal(buildRoleMembersFilter(RUN, "Z_O'NEIL"), `${SCOPE} and RoleName eq 'Z_O''NEIL'`);
});

test('userCards partitions by type, sums to the total and adds the active indicator', () => {
  const cards = userCards(
    [{ UserType: 'A', count: 160 }, { UserType: 'B', count: 3 }, { UserType: 'Q', count: 1 }],
    [{ IsActiveDialogUser: false, count: 41 }, { IsActiveDialogUser: true, count: 123 }]
  );
  assert.deepEqual(cards.partition.map((c) => [c.key, c.value]), [['TOTAL', 164], ['A', 160], ['B', 3], ['Q', 1]]);
  assert.equal(cards.partition[1].label, 'Dialog users');
  assert.equal(cards.partition[3].label, 'Type Q');
  assert.deepEqual(cards.indicators, [{ key: 'ACTIVE', label: 'Active dialog users', value: 123 }]);
  const empty = userCards([], []);
  assert.deepEqual(empty.partition, [{ key: 'TOTAL', label: 'Users', value: 0 }]);
  assert.equal(empty.indicators[0].value, 0);
});

test('roleCards partitions by role type and counts SAP-delivered roles', () => {
  const cards = roleCards(
    [{ RoleType: 'SINGLE', count: 8 }, { RoleType: 'COMPOSITE', count: 2 }, { RoleType: 'DERIVED', count: 1 }],
    [{ IsSapDelivered: false, count: 8 }, { IsSapDelivered: true, count: 3 }]
  );
  assert.deepEqual(cards.partition.map((c) => [c.key, c.value]), [['TOTAL', 11], ['SINGLE', 8], ['COMPOSITE', 2], ['DERIVED', 1]]);
  assert.deepEqual(cards.indicators, [{ key: 'SAP', label: 'SAP-delivered', value: 3 }]);
});

test('groupedOptions is sorted, distinct and keeps the applied value', () => {
  assert.deepEqual(groupedOptions([{ UserGroup: 'SALES' }, { UserGroup: 'HR' }, { UserGroup: ' ' }, { UserGroup: 'SALES' }], 'UserGroup', 'IT'), ['HR', 'IT', 'SALES']);
  assert.deepEqual(groupedOptions(null, 'UserGroup', ''), []);
});

test('hasMore and the page size', () => {
  assert.equal(LANDSCAPE_PAGE_SIZE, 100);
  assert.equal(hasMore(101, 100), true);
  assert.equal(hasMore(100, 100), false);
  assert.equal(hasMore(undefined, 0), false);
});

test('splitRoleTransactions separates menu from S_TCODE grants, deduped and sorted', () => {
  const split = splitRoleTransactions([
    { TransactionCode: 'VA02', Source: 'MENU' },
    { TransactionCode: 'VA01', Source: 'MENU' },
    { TransactionCode: 'VA01', Source: 'MENU' },
    { TransactionCode: 'ME21N', Source: 'AUTH' },
    { TransactionCode: '', Source: 'AUTH' }
  ]);
  assert.deepEqual(split, { menu: ['VA01', 'VA02'], auth: ['ME21N'] });
  assert.deepEqual(splitRoleTransactions(undefined), { menu: [], auth: [] });
});

test('formatDate hides the open-ended sentinel and tolerates junk', () => {
  assert.equal(formatDate('9999-12-31'), '');
  assert.equal(formatDate(''), '');
  assert.equal(formatDate(null), '');
  assert.equal(formatDate('not-a-date'), 'not-a-date');
  assert.match(formatDate('2026-08-31'), /2026/);
});

test('userLabel prefers the name of an identified run', () => {
  assert.equal(userLabel({ UserKey: 'abc', FullName: '' }), 'abc');
  assert.equal(userLabel({ UserKey: 'abc', FullName: 'Ada' }), 'Ada');
  assert.equal(userLabel(null), '—');
});
