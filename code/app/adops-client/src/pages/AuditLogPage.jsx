import { useEffect, useState } from 'react';
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
import { Select } from '@ui5/webcomponents-react/Select';
import { Option } from '@ui5/webcomponents-react/Option';
import { Input } from '@ui5/webcomponents-react/Input';
import { Label } from '@ui5/webcomponents-react/Label';
import { fetchUserInfo } from '../services/coreService.js';
import { hasAdminAccess } from '../features/auth/memberAccess.js';
import {
  fetchAuditEvents,
  fetchAuditDistinct,
  verifyAuditChain,
  getServiceErrorMessage
} from '../services/adminService.js';
import { formatTimestamp } from '../features/activation-runs/runModel.js';
import Kpi from '../components/Kpi.jsx';
import RestrictedState from '../components/RestrictedState.jsx';
import {
  AUDIT_PAGE_SIZE,
  EMPTY_FILTER,
  SEVERITIES,
  SEVERITY_DESIGN,
  buildAuditFilter,
  hasActiveFilter,
  eventTypeLabel,
  changeLabel,
  objectLabel,
  isChainedEvent,
  hasMore,
  chainVerdictSummary,
  optionList
} from '../features/audit/auditModel.js';

function Meta({ label, value }) {
  return (
    <div style={{ minWidth: '9rem' }}>
      <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)', fontSize: '0.8rem' }}>{label}</Text>
      <br />
      <Text style={{ wordBreak: 'break-all' }}>{value || '—'}</Text>
    </div>
  );
}

export function AuditLogPage() {
  const [userInfo, setUserInfo] = useState(null);
  const [error, setError] = useState('');
  const [verdict, setVerdict] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [options, setOptions] = useState({ eventTypes: [], objectTypes: [] });
  const [list, setList] = useState(null);           // { items, count }
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState(null);   // expanded event row
  const [reloadToken, setReloadToken] = useState(0);

  // Filter bar contract: the controls edit a DRAFT, Go commits it, Clear
  // resets and applies, Refresh re-reads at unchanged scope.
  const [draft, setDraft] = useState(EMPTY_FILTER);
  const [applied, setApplied] = useState(EMPTY_FILTER);

  useEffect(() => {
    let cancelled = false;
    fetchUserInfo()
      .then((info) => { if (!cancelled) setUserInfo(info); })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, []);

  const admin = hasAdminAccess(userInfo);

  // Verdict + distinct filter values: one round each, re-read on Refresh.
  useEffect(() => {
    if (!admin) return undefined;
    let cancelled = false;
    setVerifying(true);
    Promise.all([verifyAuditChain(), fetchAuditDistinct('EventType'), fetchAuditDistinct('ObjectType')])
      .then(([result, types, objects]) => {
        if (cancelled) return;
        setVerdict(result);
        setOptions({ eventTypes: types, objectTypes: objects });
      })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e, 'The audit chain could not be verified.')); })
      .finally(() => { if (!cancelled) setVerifying(false); });
    return () => { cancelled = true; };
  }, [admin, reloadToken]);

  useEffect(() => {
    if (!admin) return undefined;
    let cancelled = false;
    setList(null);
    setSelected(null);
    fetchAuditEvents({ filter: buildAuditFilter(applied), top: AUDIT_PAGE_SIZE })
      .then((result) => { if (!cancelled) { setList(result); setError(''); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [admin, applied, reloadToken]);

  const loadMore = async () => {
    if (!list || loadingMore) return;
    try {
      setLoadingMore(true);
      const next = await fetchAuditEvents({ filter: buildAuditFilter(applied), top: AUDIT_PAGE_SIZE, skip: list.items.length });
      setList({ items: [...list.items, ...next.items], count: next.count });
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  if (userInfo && !admin) {
    return (
      <div>
        <Title level="H2">Audit Log</Title>
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <RestrictedState
            area="audit-log"
            title="Administrator access required"
            text="The audit trail and its chain verification are available to AdoptOps administrators only."
            userInfo={userInfo}
          />
        </div>
      </div>
    );
  }

  const summary = chainVerdictSummary(verdict);
  const items = list?.items || null;
  const eventTypes = optionList(options.eventTypes, 'EventType', applied.eventType);
  const objectTypes = optionList(options.objectTypes, 'ObjectType', applied.objectType);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
        <Title level="H2">Audit Log</Title>
        <span style={{ display: 'inline-flex', gap: 'var(--adops-space-xs)', flexWrap: 'wrap' }}>
          <Button design="Default" icon="shield" disabled={verifying} onClick={() => setReloadToken((t) => t + 1)}>Verify chain</Button>
          <Button design="Transparent" icon="refresh" onClick={() => setReloadToken((t) => t + 1)}>Refresh</Button>
        </span>
      </div>

      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip>
      ) : null}

      {summary ? (
        <>
          <MessageStrip design={summary.design} hideCloseButton style={{ marginTop: 'var(--adops-space-sm)' }}>
            Chain {summary.status}{summary.brokenAt !== null ? ` at sequence ${summary.brokenAt}` : ''}: {summary.message}
            {summary.checkedAt ? ` Checked ${formatTimestamp(summary.checkedAt)}.` : ''}
          </MessageStrip>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-sm)' }}>
            {summary.cards.map((card) => (
              <Kpi key={card.key} label={card.label} value={typeof card.value === 'number' ? card.value.toLocaleString() : card.value} />
            ))}
          </div>
        </>
      ) : verifying ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: 'var(--adops-space-sm)' }} />
      ) : null}

      <div style={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
        <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '14rem' }}>
          <Label>Event type</Label>
          <Select onChange={(e) => setDraft({ ...draft, eventType: e.detail.selectedOption.dataset.value || '' })}>
            <Option data-value="" selected={draft.eventType === ''}>All event types</Option>
            {eventTypes.map((type) => (
              <Option key={type} data-value={type} selected={draft.eventType === type}>{eventTypeLabel(type)}</Option>
            ))}
          </Select>
        </div>
        <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '12rem' }}>
          <Label>Object type</Label>
          <Select onChange={(e) => setDraft({ ...draft, objectType: e.detail.selectedOption.dataset.value || '' })}>
            <Option data-value="" selected={draft.objectType === ''}>All objects</Option>
            {objectTypes.map((type) => (
              <Option key={type} data-value={type} selected={draft.objectType === type}>{type}</Option>
            ))}
          </Select>
        </div>
        <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '12rem' }}>
          <Label>Object</Label>
          <Input value={draft.objectName} placeholder="contains…" onInput={(e) => setDraft({ ...draft, objectName: e.target.value })} />
        </div>
        <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '10rem' }}>
          <Label>User</Label>
          <Input value={draft.userId} placeholder="contains…" onInput={(e) => setDraft({ ...draft, userId: e.target.value })} />
        </div>
        <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '9rem' }}>
          <Label>Severity</Label>
          <Select onChange={(e) => setDraft({ ...draft, severity: e.detail.selectedOption.dataset.value || '' })}>
            <Option data-value="" selected={draft.severity === ''}>All</Option>
            {SEVERITIES.map((s) => <Option key={s} data-value={s} selected={draft.severity === s}>{s}</Option>)}
          </Select>
        </div>
        <Button design="Emphasized" onClick={() => setApplied(draft)}>Go</Button>
        <Button design="Transparent" onClick={() => { setDraft(EMPTY_FILTER); setApplied(EMPTY_FILTER); }}>Clear</Button>
      </div>

      {!items ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : items.length === 0 ? (
        <IllustratedMessage
          name="NoData"
          titleText={hasActiveFilter(applied) ? 'No audit events match the filter' : 'No audit events yet'}
          subtitleText="Proposal decisions, activation steps, access decisions and privacy changes are recorded here."
        />
      ) : (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <Text style={{ display: 'block', marginBottom: 'var(--adops-space-xs)', color: 'var(--sapNeutralTextColor, #6a6d70)' }}>
            {items.length.toLocaleString()} of {Number(list.count).toLocaleString()} events
          </Text>
          <Table
            headerRow={
              <TableHeaderRow sticky>
                <TableHeaderCell><span>Seq</span></TableHeaderCell>
                <TableHeaderCell><span>When</span></TableHeaderCell>
                <TableHeaderCell><span>Event</span></TableHeaderCell>
                <TableHeaderCell><span>Severity</span></TableHeaderCell>
                <TableHeaderCell><span>Object</span></TableHeaderCell>
                <TableHeaderCell><span>Target system</span></TableHeaderCell>
                <TableHeaderCell><span>User</span></TableHeaderCell>
                <TableHeaderCell><span>Change</span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {items.map((ev) => (
              <TableRow key={ev.ID} interactive onClick={() => setSelected(selected?.ID === ev.ID ? null : ev)}>
                <TableCell><span>{isChainedEvent(ev) ? ev.Sequence : '—'}</span></TableCell>
                <TableCell><span>{formatTimestamp(ev.Timestamp || ev.createdAt) || '—'}</span></TableCell>
                <TableCell><span style={{ fontWeight: selected?.ID === ev.ID ? 700 : 600 }}>{eventTypeLabel(ev.EventType) || ev.EventType}</span></TableCell>
                <TableCell><Tag design={SEVERITY_DESIGN[ev.Severity] || 'Neutral'}>{ev.Severity || '—'}</Tag></TableCell>
                <TableCell><span>{objectLabel(ev) || '—'}</span></TableCell>
                <TableCell><span>{ev.TargetSystem || '—'}</span></TableCell>
                <TableCell><span>{ev.UserId || '—'}</span></TableCell>
                <TableCell><span>{changeLabel(ev) || '—'}</span></TableCell>
              </TableRow>
            ))}
          </Table>
          {hasMore(list.count, items.length) ? (
            <div style={{ marginTop: 'var(--adops-space-sm)' }}>
              <Button design="Transparent" icon="navigation-down-arrow" disabled={loadingMore} onClick={loadMore}>
                Load {Math.min(AUDIT_PAGE_SIZE, list.count - items.length)} more
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {selected ? (
        <Panel headerText={`Event ${isChainedEvent(selected) ? `#${selected.Sequence}` : '(legacy, unchained)'} · ${eventTypeLabel(selected.EventType)}`} style={{ marginTop: 'var(--adops-space-md)' }}>
          <Text style={{ display: 'block', marginBottom: 'var(--adops-space-sm)' }}>{selected.Message || '—'}</Text>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-md)' }}>
            <Meta label="Object" value={objectLabel(selected)} />
            <Meta label="Object ID" value={selected.ObjectId} />
            <Meta label="Source" value={selected.Source} />
            <Meta label="Correlation" value={selected.CorrelationId} />
            <Meta label="Before" value={selected.BeforeValue} />
            <Meta label="After" value={selected.AfterValue} />
            <Meta label="Hash" value={selected.Hash} />
            <Meta label="Previous hash" value={selected.PrevHash} />
          </div>
          {selected.SAPResponse ? (
            <pre style={{ marginTop: 'var(--adops-space-sm)', whiteSpace: 'pre-wrap', fontSize: '0.8rem', fontFamily: 'var(--sapFontFamily-monospaced, monospace)' }}>
              {selected.SAPResponse}
            </pre>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}

export default AuditLogPage;
