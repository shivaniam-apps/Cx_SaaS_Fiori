// Pure view-model for the User & Role Landscape page (PublicService
// UserInventory / RoleInventory / RoleUsers / RoleTransactions, filled by
// the S8 readers per extraction run). Dependency-free: runs under node --test.
//
// Every read the page performs is bounded and scoped to one extraction run:
// the list reads carry $filter/$orderby/$top/$skip/$count, the KPI strip
// comes from $apply=filter(<same $filter>)/groupby(...) so a card and its
// table slice are always the same server-side expression (performance.md).

import { odataString } from '../audit/auditModel.js';

export const LANDSCAPE_VIEWS = [
  { id: 'users', routeSuffix: '', label: 'Users', icon: 'employee' },
  { id: 'roles', routeSuffix: 'roles', label: 'Roles', icon: 'key-user-settings' }
];

const VIEW_BY_ID = new Map(LANDSCAPE_VIEWS.map((view) => [view.id, view]));

export function resolveLandscapeView(param) {
  const candidate = String(param || '').trim().toLowerCase();
  return VIEW_BY_ID.has(candidate) ? candidate : LANDSCAPE_VIEWS[0].id;
}

// Tab switches keep the run scope in the query string so the page never
// falls back to a broad default (fiori-ux.md, Navigation). Cross-links
// (a role from a user's detail, a user from a role's detail) travel as
// `role` / `user` params so the target slice is shareable and survives a
// reload, not only the in-memory state of this page.
export function getLandscapeViewPath(id, params) {
  const view = VIEW_BY_ID.get(id);
  const base = view?.routeSuffix ? `/landscape/${view.routeSuffix}` : '/landscape';
  const query = Object.entries(params || {})
    .filter(([, value]) => String(value ?? '').trim())
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value).trim())}`)
    .join('&');
  return query ? `${base}?${query}` : base;
}

// Initial filters from the query string: a deep link pre-applies its search
// (draft and applied together, so the bar never disagrees with the list).
export function userFilterFromParams(params) {
  const user = String(params?.user ?? '').trim();
  return user ? { ...EMPTY_USER_FILTER, search: user } : EMPTY_USER_FILTER;
}

export function roleFilterFromParams(params) {
  const role = String(params?.role ?? '').trim();
  return role ? { ...EMPTY_ROLE_FILTER, search: role } : EMPTY_ROLE_FILTER;
}

export const LANDSCAPE_PAGE_SIZE = 100;
export const DETAIL_PAGE_SIZE = 200;

// Inventory rows exist only for runs that included the USR02 / AGR sources
// and reached a terminal-with-data state. The list is already bounded and
// ordered newest-first by the service; this only drops unusable runs.
export function landscapeRuns(rows) {
  return (rows || []).filter((run) => {
    if (!['COMPLETED', 'PARTIAL'].includes(run?.Status)) return false;
    let sources;
    try { sources = JSON.parse(run?.SourcesJson || '[]'); } catch { sources = []; }
    return Array.isArray(sources) && sources.some((s) => ['USR02', 'AGR'].includes(String(s).toUpperCase()));
  });
}

// USR02-USTYP.
export const USER_TYPES = [
  { id: 'A', label: 'Dialog' },
  { id: 'B', label: 'System' },
  { id: 'C', label: 'Communication' },
  { id: 'S', label: 'Service' },
  { id: 'L', label: 'Reference' }
];
const USER_TYPE_BY_ID = new Map(USER_TYPES.map((t) => [t.id, t]));

export function userTypeLabel(type) {
  const key = String(type || '').trim().toUpperCase();
  return USER_TYPE_BY_ID.get(key)?.label || (key ? `Type ${key}` : '—');
}

// Two-letter lock status mapped by the S8 adapter (lockStatusOf).
export const LOCK_STATUS = {
  '': { label: 'Unlocked', design: 'Positive' },
  AD: { label: 'Locked by administrator', design: 'Negative' },
  PW: { label: 'Locked after failed logons', design: 'Critical' },
  LK: { label: 'Locked', design: 'Negative' }
};

export function lockStatusInfo(status) {
  const key = String(status || '').trim().toUpperCase();
  return LOCK_STATUS[key] || { label: `Locked (${key})`, design: 'Negative' };
}

// Row status tag: locked wins, then dialog activity inside the window.
export function userStatus(user) {
  const lock = String(user?.LockStatus || '').trim();
  if (lock) return lockStatusInfo(lock);
  if (String(user?.UserType || '').toUpperCase() !== 'A') return { label: 'Non-dialog', design: 'Neutral' };
  return user?.IsActiveDialogUser
    ? { label: 'Active', design: 'Positive' }
    : { label: 'Inactive in window', design: 'Critical' };
}

export const ACTIVITY_OPTIONS = [
  { id: '', label: 'All users' },
  { id: 'ACTIVE', label: 'Active dialog users' },
  { id: 'INACTIVE', label: 'Not active in window' }
];

export const USER_SORTS = [
  { id: 'activity', label: 'Most transactions used', orderby: 'DistinctTcodeCount desc,UserKey' },
  { id: 'roles', label: 'Most roles', orderby: 'RoleCount desc,UserKey' },
  { id: 'logon', label: 'Latest logon', orderby: 'LastLogonOn desc,UserKey' },
  { id: 'key', label: 'User key', orderby: 'UserKey' }
];

export const EMPTY_USER_FILTER = { search: '', userType: '', userGroup: '', activity: '', sort: 'activity' };

const clean = (v) => String(v ?? '').trim();

// Run scope shared by every read on the page. The run id is a UUID literal
// (unquoted in OData V4); it is validated so nothing else can be injected.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function runScope(runId) {
  const id = clean(runId);
  if (!UUID.test(id)) throw new Error('A valid extraction run is required.');
  return `extractionRun_ID eq ${id.toLowerCase()}`;
}

export function buildUserFilter(runId, filter) {
  const f = { ...EMPTY_USER_FILTER, ...(filter || {}) };
  const clauses = [runScope(runId)];
  const search = clean(f.search);
  if (search) clauses.push(`(contains(UserKey,${odataString(search)}) or contains(FullName,${odataString(search)}))`);
  if (clean(f.userType)) clauses.push(`UserType eq ${odataString(clean(f.userType).toUpperCase())}`);
  if (clean(f.userGroup)) clauses.push(`UserGroup eq ${odataString(clean(f.userGroup))}`);
  if (f.activity === 'ACTIVE') clauses.push('IsActiveDialogUser eq true');
  else if (f.activity === 'INACTIVE') clauses.push('IsActiveDialogUser eq false');
  return clauses.join(' and ');
}

export function userOrderby(sortId) {
  return (USER_SORTS.find((s) => s.id === sortId) || USER_SORTS[0]).orderby;
}

export function hasActiveUserFilter(filter) {
  const f = { ...EMPTY_USER_FILTER, ...(filter || {}) };
  return Boolean(clean(f.search) || clean(f.userType) || clean(f.userGroup) || clean(f.activity));
}

// Roles: AGR_DEFINE typing from the S8 reader.
export const ROLE_TYPES = [
  { id: 'SINGLE', label: 'Single' },
  { id: 'COMPOSITE', label: 'Composite' },
  { id: 'DERIVED', label: 'Derived' }
];
const ROLE_TYPE_BY_ID = new Map(ROLE_TYPES.map((t) => [t.id, t]));

export function roleTypeLabel(type) {
  const key = String(type || '').trim().toUpperCase();
  return ROLE_TYPE_BY_ID.get(key)?.label || (key ? key.charAt(0) + key.slice(1).toLowerCase() : '—');
}

export const ORIGIN_OPTIONS = [
  { id: '', label: 'All roles' },
  { id: 'CUSTOM', label: 'Customer roles' },
  { id: 'SAP', label: 'SAP-delivered' }
];

export const ASSIGNMENT_OPTIONS = [
  { id: '', label: 'Any assignment' },
  { id: 'ASSIGNED', label: 'With users' },
  { id: 'UNASSIGNED', label: 'Without users' }
];

export const ROLE_SORTS = [
  { id: 'users', label: 'Most users', orderby: 'UserCount desc,RoleName' },
  { id: 'menu', label: 'Most menu transactions', orderby: 'MenuTcodeCount desc,RoleName' },
  { id: 'changed', label: 'Recently changed', orderby: 'ChangedOn desc,RoleName' },
  { id: 'name', label: 'Role name', orderby: 'RoleName' }
];

export const EMPTY_ROLE_FILTER = { search: '', roleType: '', origin: '', assignment: '', sort: 'users' };

export function buildRoleFilter(runId, filter) {
  const f = { ...EMPTY_ROLE_FILTER, ...(filter || {}) };
  const clauses = [runScope(runId)];
  const search = clean(f.search);
  if (search) clauses.push(`(contains(RoleName,${odataString(search)}) or contains(RoleText,${odataString(search)}))`);
  if (clean(f.roleType)) clauses.push(`RoleType eq ${odataString(clean(f.roleType).toUpperCase())}`);
  if (f.origin === 'SAP') clauses.push('IsSapDelivered eq true');
  else if (f.origin === 'CUSTOM') clauses.push('IsSapDelivered eq false');
  if (f.assignment === 'ASSIGNED') clauses.push('UserCount gt 0');
  else if (f.assignment === 'UNASSIGNED') clauses.push('UserCount eq 0');
  return clauses.join(' and ');
}

export function roleOrderby(sortId) {
  return (ROLE_SORTS.find((s) => s.id === sortId) || ROLE_SORTS[0]).orderby;
}

export function hasActiveRoleFilter(filter) {
  const f = { ...EMPTY_ROLE_FILTER, ...(filter || {}) };
  return Boolean(clean(f.search) || clean(f.roleType) || clean(f.origin) || clean(f.assignment));
}

// Detail reads (one bounded read per opened row, never per list row).
export function buildUserRolesFilter(runId, userKey) {
  return `${runScope(runId)} and UserKey eq ${odataString(clean(userKey))}`;
}

export function buildRoleMembersFilter(runId, roleName) {
  return `${runScope(runId)} and RoleName eq ${odataString(clean(roleName))}`;
}

// --- KPI strips from the grouped reads --------------------------------------
// `grouped` rows look like [{ <field>: value, count: n }] (server groupby).

function countsByValue(rows, field, normalise = (v) => v) {
  const map = new Map();
  for (const row of rows || []) {
    const key = normalise(row?.[field]);
    map.set(key, (map.get(key) || 0) + Number(row?.count || 0));
  }
  return map;
}

const upper = (v) => String(v ?? '').trim().toUpperCase();
const bool = (v) => v === true || v === 1 || v === 'true';

// Partition cards by user type (they sum to the total of the filter scope)
// plus one distinct indicator: dialog users active inside the window.
export function userCards(byType, byActive) {
  const types = countsByValue(byType, 'UserType', upper);
  const active = countsByValue(byActive, 'IsActiveDialogUser', bool);
  const total = [...types.values()].reduce((a, b) => a + b, 0);
  const partition = [{ key: 'TOTAL', label: 'Users', value: total }];
  for (const type of USER_TYPES) {
    if (types.has(type.id)) partition.push({ key: type.id, label: `${type.label} users`, value: types.get(type.id) });
  }
  for (const [key, value] of types) {
    if (!USER_TYPE_BY_ID.has(key)) partition.push({ key: key || 'UNKNOWN', label: key ? `Type ${key}` : 'Untyped', value });
  }
  return {
    partition,
    indicators: [{ key: 'ACTIVE', label: 'Active dialog users', value: active.get(true) || 0 }]
  };
}

// Partition cards by role type plus the SAP-delivered indicator.
export function roleCards(byType, bySap) {
  const types = countsByValue(byType, 'RoleType', upper);
  const sap = countsByValue(bySap, 'IsSapDelivered', bool);
  const total = [...types.values()].reduce((a, b) => a + b, 0);
  const partition = [{ key: 'TOTAL', label: 'Roles', value: total }];
  for (const type of ROLE_TYPES) {
    if (types.has(type.id)) partition.push({ key: type.id, label: `${type.label} roles`, value: types.get(type.id) });
  }
  for (const [key, value] of types) {
    if (!ROLE_TYPE_BY_ID.has(key)) partition.push({ key: key || 'UNKNOWN', label: key ? `${roleTypeLabel(key)} roles` : 'Untyped', value });
  }
  return {
    partition,
    indicators: [{ key: 'SAP', label: 'SAP-delivered', value: sap.get(true) || 0 }]
  };
}

// Option list from a grouped read (server-side distinct); the applied value
// stays selectable even when the current scope no longer returns it.
export function groupedOptions(rows, field, current) {
  const values = new Set((rows || []).map((r) => clean(r?.[field])).filter(Boolean));
  if (clean(current)) values.add(clean(current));
  return [...values].sort((a, b) => a.localeCompare(b));
}

export function hasMore(count, loaded) {
  return Number(count || 0) > Number(loaded || 0);
}

// Granted transactions of a role, split by provenance for the detail panel.
export function splitRoleTransactions(rows) {
  const menu = [];
  const auth = [];
  for (const row of rows || []) {
    const code = clean(row?.TransactionCode);
    if (!code) continue;
    (upper(row?.Source) === 'AUTH' ? auth : menu).push(code);
  }
  const uniq = (list) => [...new Set(list)].sort((a, b) => a.localeCompare(b));
  return { menu: uniq(menu), auth: uniq(auth) };
}

// ISO date (yyyy-mm-dd) -> locale date; '' for empty or the 9999-12-31 sentinel.
export function formatDate(value) {
  const text = clean(value);
  if (!text || text.startsWith('9999')) return '';
  const date = new Date(`${text.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' });
}

// Pseudonymised runs show hashed user keys; identified runs (audited opt-in)
// may carry names. The row label prefers the name when it exists.
export function userLabel(user) {
  return clean(user?.FullName) || clean(user?.UserKey) || '—';
}
