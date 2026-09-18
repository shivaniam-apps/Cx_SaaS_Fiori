import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Title } from '@ui5/webcomponents-react/Title';
import { Text } from '@ui5/webcomponents-react/Text';
import { Button } from '@ui5/webcomponents-react/Button';
import { Table } from '@ui5/webcomponents-react/Table';
import { TableHeaderRow } from '@ui5/webcomponents-react/TableHeaderRow';
import { TableHeaderCell } from '@ui5/webcomponents-react/TableHeaderCell';
import { TableRow } from '@ui5/webcomponents-react/TableRow';
import { TableCell } from '@ui5/webcomponents-react/TableCell';
import { Tag } from '@ui5/webcomponents-react/Tag';
import { BusyIndicator } from '@ui5/webcomponents-react/BusyIndicator';
import { IllustratedMessage } from '@ui5/webcomponents-react/IllustratedMessage';
import { MessageStrip } from '@ui5/webcomponents-react/MessageStrip';
import { Panel } from '@ui5/webcomponents-react/Panel';
import { Popover } from '@ui5/webcomponents-react/Popover';
import { Select } from '@ui5/webcomponents-react/Select';
import { Option } from '@ui5/webcomponents-react/Option';
import { Input } from '@ui5/webcomponents-react/Input';
import { Label } from '@ui5/webcomponents-react/Label';
import {
  listExtractionRuns,
  queryInventoryPage,
  queryInventoryGroups,
  getServiceErrorMessage
} from '../services/fioriService.js';
import Kpi from '../components/Kpi.jsx';
import AdopsPageTabs from '../components/AdopsPageTabs.jsx';
import {
  LANDSCAPE_VIEWS,
  LANDSCAPE_PAGE_SIZE,
  DETAIL_PAGE_SIZE,
  resolveLandscapeView,
  getLandscapeViewPath,
  landscapeRuns,
  USER_TYPES,
  ACTIVITY_OPTIONS,
  USER_SORTS,
  EMPTY_USER_FILTER,
  buildUserFilter,
  userOrderby,
  hasActiveUserFilter,
  userTypeLabel,
  userStatus,
  lockStatusInfo,
  userLabel,
  ROLE_TYPES,
  ORIGIN_OPTIONS,
  ASSIGNMENT_OPTIONS,
  ROLE_SORTS,
  EMPTY_ROLE_FILTER,
  buildRoleFilter,
  roleOrderby,
  hasActiveRoleFilter,
  roleTypeLabel,
  buildUserRolesFilter,
  buildRoleMembersFilter,
  userCards,
  roleCards,
  groupedOptions,
  hasMore,
  splitRoleTransactions,
  formatDate,
  userFilterFromParams,
  roleFilterFromParams
} from '../features/landscape/landscapeModel.js';

const num = (v) => Number(v || 0).toLocaleString();

function Meta({ label, value }) {
  return (
    <div style={{ minWidth: '9rem' }}>
      <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)', fontSize: '0.8rem' }}>{label}</Text>
      <br />
      <Text style={{ wordBreak: 'break-all' }}>{value || '—'}</Text>
    </div>
  );
}

function Field({ label, minWidth = '11rem', children }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth }}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function ChoiceSelect({ label, value, options, onChange, minWidth }) {
  return (
    <Field label={label} minWidth={minWidth}>
      <Select onChange={(e) => onChange(e.detail.selectedOption.dataset.value || '')}>
        {options.map((o) => <Option key={o.id || 'all'} data-value={o.id} selected={value === o.id}>{o.label}</Option>)}
      </Select>
    </Field>
  );
}

function CardStrip({ cards }) {
  if (!cards) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)', alignItems: 'stretch' }}>
      {cards.partition.map((card) => <Kpi key={card.key} label={card.label} value={num(card.value)} />)}
      <div style={{ alignSelf: 'center', color: 'var(--sapNeutralTextColor, #6a6d70)', padding: '0 var(--adops-space-xs)' }}>·</div>
      {cards.indicators.map((card) => <Kpi key={card.key} label={card.label} value={num(card.value)} />)}
    </div>
  );
}

function LoadMore({ list, loadMore, loadingMore }) {
  if (!list || !hasMore(list.count, list.items.length)) return null;
  return (
    <div style={{ marginTop: 'var(--adops-space-sm)' }}>
      <Button design="Transparent" icon="navigation-down-arrow" disabled={loadingMore} onClick={loadMore}>
        Load {Math.min(LANDSCAPE_PAGE_SIZE, list.count - list.items.length)} more
      </Button>
    </div>
  );
}

function CountLine({ list, noun }) {
  return (
    <Text style={{ display: 'block', marginBottom: 'var(--adops-space-xs)', color: 'var(--sapNeutralTextColor, #6a6d70)' }}>
      {num(list.items.length)} of {num(list.count)} {noun}
    </Text>
  );
}

// Bounded list + KPI groupbys over one filter scope; shared by both tabs.
// Every read carries the run scope, so a tab without a run reads nothing.
function useInventoryList({ entity, filter, orderby, groupFields, reloadToken }) {
  const [list, setList] = useState(null);
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!filter) return undefined;
    let cancelled = false;
    setList(null);
    Promise.all([
      queryInventoryPage(entity, { filter, orderby, top: LANDSCAPE_PAGE_SIZE }),
      ...groupFields.map((field) => queryInventoryGroups(entity, filter, field))
    ])
      .then(([rows, ...grouped]) => {
        if (cancelled) return;
        setList(rows);
        setGroups(grouped);
        setError('');
      })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [entity, filter, orderby, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    if (!list || loadingMore) return;
    try {
      setLoadingMore(true);
      const next = await queryInventoryPage(entity, { filter, orderby, top: LANDSCAPE_PAGE_SIZE, skip: list.items.length });
      setList({ items: [...list.items, ...next.items], count: next.count });
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  return { list, groups, error, setError, loadMore, loadingMore };
}

// One bounded read per opened row (never per list row).
function useDetail(loader, key) {
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (!key) { setDetail(null); return undefined; }
    let cancelled = false;
    setDetail({ loading: true });
    loader()
      .then((result) => { if (!cancelled) setDetail({ loading: false, ...result }); })
      .catch((e) => { if (!cancelled) setDetail({ loading: false, error: getServiceErrorMessage(e) }); });
    return () => { cancelled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return detail;
}

// --- Users tab ----------------------------------------------------------------

function UsersTab({ runId, reloadToken, filters, onOpenRole }) {
  const { draft, setDraft, applied, setApplied } = filters;
  const filter = runId ? buildUserFilter(runId, applied) : '';
  const { list, groups, error, setError, loadMore, loadingMore } = useInventoryList({
    entity: 'UserInventory', filter, orderby: userOrderby(applied.sort),
    groupFields: ['UserType', 'IsActiveDialogUser', 'UserGroup'], reloadToken
  });
  const [selected, setSelected] = useState(null);
  useEffect(() => { setSelected(null); }, [filter, reloadToken]);

  const roles = useDetail(
    () => queryInventoryPage('RoleUsers', { filter: buildUserRolesFilter(runId, selected.UserKey), orderby: 'RoleName', top: DETAIL_PAGE_SIZE })
      .then((page) => ({ roles: page })),
    selected ? `${runId}:${selected.UserKey}` : ''
  );

  const cards = groups ? userCards(groups[0], groups[1]) : null;
  const groupOptions = groupedOptions(groups?.[2], 'UserGroup', applied.userGroup);
  const items = list?.items || null;
  const status = selected ? userStatus(selected) : null;

  return (
    <>
      {error ? <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip> : null}

      <div style={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
        <Field label="User" minWidth="14rem">
          <Input value={draft.search} placeholder="user key or name contains…" onInput={(e) => setDraft({ ...draft, search: e.target.value })} />
        </Field>
        <ChoiceSelect label="User type" value={draft.userType} onChange={(v) => setDraft({ ...draft, userType: v })}
          options={[{ id: '', label: 'All types' }, ...USER_TYPES.map((t) => ({ id: t.id, label: t.label }))]} />
        <ChoiceSelect label="User group" value={draft.userGroup} onChange={(v) => setDraft({ ...draft, userGroup: v })}
          options={[{ id: '', label: 'All groups' }, ...groupOptions.map((g) => ({ id: g, label: g }))]} />
        <ChoiceSelect label="Activity" value={draft.activity} onChange={(v) => setDraft({ ...draft, activity: v })} options={ACTIVITY_OPTIONS} minWidth="13rem" />
        <ChoiceSelect label="Sort by" value={draft.sort} onChange={(v) => setDraft({ ...draft, sort: v })} options={USER_SORTS} minWidth="13rem" />
        <Button design="Emphasized" onClick={() => setApplied(draft)}>Go</Button>
        <Button design="Transparent" onClick={() => { setDraft(EMPTY_USER_FILTER); setApplied(EMPTY_USER_FILTER); }}>Clear</Button>
      </div>

      <CardStrip cards={cards} />

      {!items ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : items.length === 0 ? (
        <IllustratedMessage
          name="NoData"
          titleText={hasActiveUserFilter(applied) ? 'No users match the filter' : 'No user inventory in this run'}
          subtitleText="Run an extraction with the USR02 source to collect the user inventory of the target system."
        />
      ) : (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <CountLine list={list} noun="users" />
          <Table
            headerRow={
              <TableHeaderRow sticky>
                <TableHeaderCell><span>User</span></TableHeaderCell>
                <TableHeaderCell><span>Type</span></TableHeaderCell>
                <TableHeaderCell><span>Group</span></TableHeaderCell>
                <TableHeaderCell><span>Status</span></TableHeaderCell>
                <TableHeaderCell><span>Roles</span></TableHeaderCell>
                <TableHeaderCell><span>Transactions used</span></TableHeaderCell>
                <TableHeaderCell><span>Last logon</span></TableHeaderCell>
                <TableHeaderCell><span>Valid to</span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {items.map((user) => {
              const rowStatus = userStatus(user);
              const isSelected = selected?.ID === user.ID;
              return (
                <TableRow key={user.ID} interactive onClick={() => setSelected(isSelected ? null : user)}>
                  <TableCell><span style={{ fontWeight: isSelected ? 700 : 600, fontFamily: user.FullName ? undefined : 'var(--sapFontFamily-monospaced, monospace)' }}>{userLabel(user)}</span></TableCell>
                  <TableCell><span>{userTypeLabel(user.UserType)}</span></TableCell>
                  <TableCell><span>{user.UserGroup || '—'}</span></TableCell>
                  <TableCell><Tag design={rowStatus.design}>{rowStatus.label}</Tag></TableCell>
                  <TableCell><span>{num(user.RoleCount)}</span></TableCell>
                  <TableCell><span>{num(user.DistinctTcodeCount)}</span></TableCell>
                  <TableCell><span>{formatDate(user.LastLogonOn) || '—'}</span></TableCell>
                  <TableCell><span>{formatDate(user.ValidTo) || 'unlimited'}</span></TableCell>
                </TableRow>
              );
            })}
          </Table>
          <LoadMore list={list} loadMore={loadMore} loadingMore={loadingMore} />
        </div>
      )}

      {selected ? (
        <Panel headerText={`User ${userLabel(selected)}`} style={{ marginTop: 'var(--adops-space-md)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-md)' }}>
            <Meta label="User key" value={selected.UserKey} />
            <Meta label="Type" value={userTypeLabel(selected.UserType)} />
            <Meta label="Group" value={selected.UserGroup} />
            <Meta label="Lock status" value={lockStatusInfo(selected.LockStatus).label} />
            <Meta label="Activity" value={status.label} />
            <Meta label="Department" value={selected.Department} />
            <Meta label="Cost center" value={selected.CostCenter} />
            <Meta label="Valid from" value={formatDate(selected.ValidFrom)} />
            <Meta label="Valid to" value={formatDate(selected.ValidTo) || 'unlimited'} />
            <Meta label="Last logon" value={formatDate(selected.LastLogonOn)} />
            <Meta label="Transactions used in window" value={num(selected.DistinctTcodeCount)} />
          </div>
          <div style={{ marginTop: 'var(--adops-space-md)' }}>
            <Text style={{ fontWeight: 600 }}>Assigned roles ({num(selected.RoleCount)})</Text>
            {!roles || roles.loading ? (
              <BusyIndicator active delay={200} style={{ display: 'block', marginTop: 'var(--adops-space-sm)' }} />
            ) : roles.error ? (
              <MessageStrip design="Negative" hideCloseButton style={{ marginTop: 'var(--adops-space-sm)' }}>{roles.error}</MessageStrip>
            ) : roles.roles.items.length === 0 ? (
              <Text style={{ display: 'block', marginTop: 'var(--adops-space-xs)' }}>No role assignments were collected for this user.</Text>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-xs)', marginTop: 'var(--adops-space-sm)' }}>
                {roles.roles.items.map((row) => (
                  <Button key={row.ID} design="Transparent" title={`Open role ${row.RoleName}`} onClick={() => onOpenRole(row.RoleName)}>
                    {row.RoleName}{formatDate(row.ValidTo) ? ` (until ${formatDate(row.ValidTo)})` : ''}
                  </Button>
                ))}
                {hasMore(roles.roles.count, roles.roles.items.length) ? (
                  <Text style={{ alignSelf: 'center', color: 'var(--sapNeutralTextColor, #6a6d70)' }}>
                    first {num(roles.roles.items.length)} of {num(roles.roles.count)}
                  </Text>
                ) : null}
              </div>
            )}
          </div>
        </Panel>
      ) : null}
    </>
  );
}

// --- Roles tab ----------------------------------------------------------------

function RolesTab({ runId, reloadToken, filters, onOpenUser }) {
  const { draft, setDraft, applied, setApplied } = filters;
  const filter = runId ? buildRoleFilter(runId, applied) : '';
  const { list, groups, error, setError, loadMore, loadingMore } = useInventoryList({
    entity: 'RoleInventory', filter, orderby: roleOrderby(applied.sort),
    groupFields: ['RoleType', 'IsSapDelivered'], reloadToken
  });
  const [selected, setSelected] = useState(null);
  useEffect(() => { setSelected(null); }, [filter, reloadToken]);

  const detail = useDetail(
    () => Promise.all([
      queryInventoryPage('RoleTransactions', { filter: buildRoleMembersFilter(runId, selected.RoleName), orderby: 'Source,TransactionCode', top: DETAIL_PAGE_SIZE }),
      queryInventoryPage('RoleUsers', { filter: buildRoleMembersFilter(runId, selected.RoleName), orderby: 'UserKey', top: DETAIL_PAGE_SIZE })
    ]).then(([transactions, members]) => ({ transactions, members })),
    selected ? `${runId}:${selected.RoleName}` : ''
  );

  const cards = groups ? roleCards(groups[0], groups[1]) : null;
  const items = list?.items || null;
  const split = detail?.transactions ? splitRoleTransactions(detail.transactions.items) : null;

  return (
    <>
      {error ? <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip> : null}

      <div style={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
        <Field label="Role" minWidth="14rem">
          <Input value={draft.search} placeholder="name or description contains…" onInput={(e) => setDraft({ ...draft, search: e.target.value })} />
        </Field>
        <ChoiceSelect label="Role type" value={draft.roleType} onChange={(v) => setDraft({ ...draft, roleType: v })}
          options={[{ id: '', label: 'All types' }, ...ROLE_TYPES.map((t) => ({ id: t.id, label: t.label }))]} />
        <ChoiceSelect label="Origin" value={draft.origin} onChange={(v) => setDraft({ ...draft, origin: v })} options={ORIGIN_OPTIONS} />
        <ChoiceSelect label="Assignment" value={draft.assignment} onChange={(v) => setDraft({ ...draft, assignment: v })} options={ASSIGNMENT_OPTIONS} />
        <ChoiceSelect label="Sort by" value={draft.sort} onChange={(v) => setDraft({ ...draft, sort: v })} options={ROLE_SORTS} minWidth="14rem" />
        <Button design="Emphasized" onClick={() => setApplied(draft)}>Go</Button>
        <Button design="Transparent" onClick={() => { setDraft(EMPTY_ROLE_FILTER); setApplied(EMPTY_ROLE_FILTER); }}>Clear</Button>
      </div>

      <CardStrip cards={cards} />

      {!items ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : items.length === 0 ? (
        <IllustratedMessage
          name="NoData"
          titleText={hasActiveRoleFilter(applied) ? 'No roles match the filter' : 'No role inventory in this run'}
          subtitleText="Run an extraction with the AGR source to collect the PFCG roles of the target system."
        />
      ) : (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <CountLine list={list} noun="roles" />
          <Table
            headerRow={
              <TableHeaderRow sticky>
                <TableHeaderCell><span>Role</span></TableHeaderCell>
                <TableHeaderCell><span>Description</span></TableHeaderCell>
                <TableHeaderCell><span>Type</span></TableHeaderCell>
                <TableHeaderCell><span>Origin</span></TableHeaderCell>
                <TableHeaderCell><span>Users</span></TableHeaderCell>
                <TableHeaderCell><span>Menu transactions</span></TableHeaderCell>
                <TableHeaderCell><span>S_TCODE values</span></TableHeaderCell>
                <TableHeaderCell><span>Changed on</span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {items.map((role) => {
              const isSelected = selected?.ID === role.ID;
              return (
                <TableRow key={role.ID} interactive onClick={() => setSelected(isSelected ? null : role)}>
                  <TableCell><span style={{ fontWeight: isSelected ? 700 : 600 }}>{role.RoleName}</span></TableCell>
                  <TableCell><span>{role.RoleText || '—'}</span></TableCell>
                  <TableCell><span>{roleTypeLabel(role.RoleType)}{role.ParentRole ? ` of ${role.ParentRole}` : ''}</span></TableCell>
                  <TableCell><Tag design={role.IsSapDelivered ? 'Information' : 'Neutral'}>{role.IsSapDelivered ? 'SAP' : 'Customer'}</Tag></TableCell>
                  <TableCell><span>{num(role.UserCount)}</span></TableCell>
                  <TableCell><span>{num(role.MenuTcodeCount)}</span></TableCell>
                  <TableCell><span>{num(role.AuthTcodeCount)}</span></TableCell>
                  <TableCell><span>{formatDate(role.ChangedOn) || '—'}</span></TableCell>
                </TableRow>
              );
            })}
          </Table>
          <LoadMore list={list} loadMore={loadMore} loadingMore={loadingMore} />
        </div>
      )}

      {selected ? (
        <Panel headerText={`Role ${selected.RoleName}`} style={{ marginTop: 'var(--adops-space-md)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-md)' }}>
            <Meta label="Description" value={selected.RoleText} />
            <Meta label="Type" value={roleTypeLabel(selected.RoleType)} />
            <Meta label="Parent role" value={selected.ParentRole} />
            <Meta label="Origin" value={selected.IsSapDelivered ? 'SAP-delivered' : 'Customer'} />
            <Meta label="Users" value={num(selected.UserCount)} />
            <Meta label="Menu transactions" value={num(selected.MenuTcodeCount)} />
            <Meta label="S_TCODE values" value={num(selected.AuthTcodeCount)} />
            <Meta label="Changed on" value={formatDate(selected.ChangedOn)} />
          </div>
          {!detail || detail.loading ? (
            <BusyIndicator active delay={200} style={{ display: 'block', marginTop: 'var(--adops-space-sm)' }} />
          ) : detail.error ? (
            <MessageStrip design="Negative" hideCloseButton style={{ marginTop: 'var(--adops-space-sm)' }}>{detail.error}</MessageStrip>
          ) : (
            <>
              <div style={{ marginTop: 'var(--adops-space-md)' }}>
                <Text style={{ fontWeight: 600 }}>Granted transactions ({num(detail.transactions.count)})</Text>
                {split.menu.length === 0 && split.auth.length === 0 ? (
                  <Text style={{ display: 'block', marginTop: 'var(--adops-space-xs)' }}>No transactions were collected for this role.</Text>
                ) : (
                  <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', marginTop: 'var(--adops-space-xs)' }}>
                    {split.menu.length ? <Text><b>Menu:</b> {split.menu.join(', ')}</Text> : null}
                    {split.auth.length ? <Text><b>S_TCODE:</b> {split.auth.join(', ')}</Text> : null}
                    {hasMore(detail.transactions.count, detail.transactions.items.length) ? (
                      <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)' }}>first {num(detail.transactions.items.length)} of {num(detail.transactions.count)}</Text>
                    ) : null}
                  </div>
                )}
              </div>
              <div style={{ marginTop: 'var(--adops-space-md)' }}>
                <Text style={{ fontWeight: 600 }}>Assigned users ({num(detail.members.count)})</Text>
                {detail.members.items.length === 0 ? (
                  <Text style={{ display: 'block', marginTop: 'var(--adops-space-xs)' }}>No user assignments were collected for this role.</Text>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-xs)', marginTop: 'var(--adops-space-sm)' }}>
                    {detail.members.items.map((row) => (
                      <Button key={row.ID} design="Transparent" title={`Open user ${row.UserKey}`} onClick={() => onOpenUser(row.UserKey)}>
                        <span style={{ fontFamily: 'var(--sapFontFamily-monospaced, monospace)' }}>{row.UserKey}</span>
                      </Button>
                    ))}
                    {hasMore(detail.members.count, detail.members.items.length) ? (
                      <Text style={{ alignSelf: 'center', color: 'var(--sapNeutralTextColor, #6a6d70)' }}>
                        first {num(detail.members.items.length)} of {num(detail.members.count)}
                      </Text>
                    ) : null}
                  </div>
                )}
              </div>
            </>
          )}
        </Panel>
      ) : null}
    </>
  );
}

// --- Page ---------------------------------------------------------------------

export function LandscapePage() {
  const { view } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTabId = resolveLandscapeView(view);
  const runFromUrl = searchParams.get('run') || '';

  const [runs, setRuns] = useState(null);
  const [runId, setRunId] = useState(runFromUrl);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [infoOpen, setInfoOpen] = useState(false);

  // Filters start from the deep-link params; the app shell remounts the page
  // on every path change, so a tab switch starts from the URL again.
  const deepLink = { user: searchParams.get('user') || '', role: searchParams.get('role') || '' };
  const [userDraft, setUserDraft] = useState(() => userFilterFromParams(deepLink));
  const [userApplied, setUserApplied] = useState(() => userFilterFromParams(deepLink));
  const [roleDraft, setRoleDraft] = useState(() => roleFilterFromParams(deepLink));
  const [roleApplied, setRoleApplied] = useState(() => roleFilterFromParams(deepLink));

  // Go / Clear consume the deep link: the URL keeps only the run scope.
  const runParams = (id) => (id ? { run: id } : {});
  const commitUserFilter = (next) => { setUserApplied(next); if (deepLink.user) setSearchParams(runParams(runId), { replace: true }); };
  const commitRoleFilter = (next) => { setRoleApplied(next); if (deepLink.role) setSearchParams(runParams(runId), { replace: true }); };

  useEffect(() => {
    let cancelled = false;
    listExtractionRuns()
      .then((rows) => {
        if (cancelled) return;
        const usable = landscapeRuns(rows);
        setRuns(usable);
        if (usable.length && !usable.some((r) => r.ID === runFromUrl)) {
          setRunId(usable[0].ID);
          setSearchParams({ ...Object.fromEntries(searchParams), run: usable[0].ID }, { replace: true });
        }
      })
      .catch((e) => { if (!cancelled) { setRuns([]); setError(getServiceErrorMessage(e, 'Could not load extraction runs.')); } });
    return () => { cancelled = true; };
  }, [reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectRun = (value) => {
    setRunId(value);
    setSearchParams(runParams(value));
  };

  const openTab = (id) => navigate(getLandscapeViewPath(id, runParams(runId)));

  // In-content scope gestures apply immediately AND write the draft (both
  // are initialised from the deep link on the target tab), so the filter
  // bar never disagrees with the list (fiori-ux.md, Filters).
  const openRole = (roleName) => navigate(getLandscapeViewPath('roles', { ...runParams(runId), role: roleName }));
  const openUser = (userKey) => navigate(getLandscapeViewPath('users', { ...runParams(runId), user: userKey }));

  const run = runs?.find((r) => r.ID === runId) || null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--adops-space-xs)' }}>
          <Title level="H2">User &amp; Role Landscape</Title>
          <Button id="landscape-info" design="Transparent" icon="information" tooltip="About this page" accessibleName="About this page" onClick={() => setInfoOpen((open) => !open)} />
          <Popover opener="landscape-info" open={infoOpen} onClose={() => setInfoOpen(false)} headerText="About this page" placement="Bottom">
            <div style={{ maxWidth: '24rem', display: 'grid', gap: 'var(--adops-space-xs)' }}>
              <Text>The landscape is the user and role inventory the selected extraction run collected from USR02 and the PFCG tables (AGR_*).</Text>
              <Text>User keys are pseudonyms unless the target system runs in identified mode; names, e-mail and department stay empty in pseudonymised runs.</Text>
              <Text>Activity means a dialog user that is not locked and logged on inside the extraction window. Transactions used counts the distinct transactions attributed to the user in the window.</Text>
            </div>
          </Popover>
        </span>
        <span style={{ display: 'inline-flex', gap: 'var(--adops-space-xs)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Extraction run" minWidth="18rem">
            <Select disabled={!runs || runs.length === 0} onChange={(e) => selectRun(e.detail.selectedOption.dataset.value || '')}>
              {(runs || []).map((r) => <Option key={r.ID} data-value={r.ID} selected={runId === r.ID}>{r.Title}</Option>)}
            </Select>
          </Field>
          <Button design="Transparent" icon="refresh" onClick={() => setReloadToken((t) => t + 1)}>Refresh</Button>
        </span>
      </div>

      {error ? <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip> : null}

      <div style={{ marginTop: 'var(--adops-space-md)' }}>
        <AdopsPageTabs tabs={LANDSCAPE_VIEWS} activeTabId={activeTabId} ariaLabel="Landscape sections" onSelect={openTab} />
      </div>

      {!runs ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : runs.length === 0 ? (
        <IllustratedMessage
          name="NoData"
          titleText="No inventory extracted yet"
          subtitleText="Run an extraction with the USR02 and AGR sources on the Extractions page; the users and roles it collects appear here."
        />
      ) : (
        <>
          {run ? (
            <Text style={{ display: 'block', marginTop: 'var(--adops-space-sm)', color: 'var(--sapNeutralTextColor, #6a6d70)' }}>
              {run.Pseudonymised === false ? 'Identified run' : 'Pseudonymised run'} · window {formatDate(run.PeriodFrom)} – {formatDate(run.PeriodTo)}
              {run.Status === 'PARTIAL' ? ' · partial extraction' : ''}
            </Text>
          ) : null}
          {activeTabId === 'roles' ? (
            <RolesTab
              runId={runId} reloadToken={reloadToken}
              filters={{ draft: roleDraft, setDraft: setRoleDraft, applied: roleApplied, setApplied: commitRoleFilter }}
              onOpenUser={openUser}
            />
          ) : (
            <UsersTab
              runId={runId} reloadToken={reloadToken}
              filters={{ draft: userDraft, setDraft: setUserDraft, applied: userApplied, setApplied: commitUserFilter }}
              onOpenRole={openRole}
            />
          )}
        </>
      )}
    </div>
  );
}

export default LandscapePage;
