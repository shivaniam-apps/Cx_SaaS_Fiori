import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import { Dialog } from '@ui5/webcomponents-react/Dialog';
import { Select } from '@ui5/webcomponents-react/Select';
import { Option } from '@ui5/webcomponents-react/Option';
import { Input } from '@ui5/webcomponents-react/Input';
import { TextArea } from '@ui5/webcomponents-react/TextArea';
import { Label } from '@ui5/webcomponents-react/Label';
import { fetchUserInfo } from '../services/coreService.js';
import { hasAdminAccess } from '../features/auth/memberAccess.js';
import {
  fetchPilotFeedback,
  fetchPilotFeedbackStatusCounts,
  updateFeedbackTriage,
  fetchClientErrorReports,
  fetchClientErrorStatusCounts,
  updateClientErrorStatus,
  queryUsageSummary,
  queryPerformanceSummary,
  getServiceErrorMessage
} from '../services/adminService.js';
import { formatTimestamp } from '../features/activation-runs/runModel.js';
import Kpi from '../components/Kpi.jsx';
import AdopsPageTabs from '../components/AdopsPageTabs.jsx';
import RestrictedState from '../components/RestrictedState.jsx';
import {
  INSIGHTS_VIEWS,
  resolveInsightsView,
  getInsightsViewPath,
  FEEDBACK_STATUSES,
  FEEDBACK_CATEGORIES,
  FEEDBACK_IMPACTS,
  ERROR_STATUSES,
  ERROR_SEVERITIES,
  WINDOW_OPTIONS,
  DEFAULT_WINDOW_DAYS,
  LIST_PAGE_SIZE,
  FEEDBACK_STATUS_DESIGN,
  IMPACT_DESIGN,
  ERROR_STATUS_DESIGN,
  ERROR_SEVERITY_DESIGN,
  EMPTY_FEEDBACK_FILTER,
  EMPTY_ERROR_FILTER,
  buildFeedbackFilter,
  buildErrorFilter,
  statusCards,
  humanize,
  hasMore,
  triageDraft,
  triagePayload,
  triageChanged,
  usageCards,
  performanceCards,
  windowLabel
} from '../features/insights/insightsModel.js';

function Meta({ label, value }) {
  return (
    <div style={{ minWidth: '9rem' }}>
      <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)', fontSize: '0.8rem' }}>{label}</Text>
      <br />
      <Text style={{ wordBreak: 'break-word' }}>{value || '—'}</Text>
    </div>
  );
}

const cardValue = (v) => (typeof v === 'number' ? v.toLocaleString() : v);

function ChoiceSelect({ label, value, options, allLabel, onChange, minWidth = '11rem' }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth }}>
      <Label>{label}</Label>
      <Select accessibleName={label} onChange={(e) => onChange(e.detail.selectedOption.dataset.value || '')}>
        <Option data-value="" selected={value === ''}>{allLabel}</Option>
        {options.map((o) => <Option key={o} data-value={o} selected={value === o}>{humanize(o)}</Option>)}
      </Select>
    </div>
  );
}

// Bounded, server-filtered list with KPI cards from a server groupby - the
// shared shape of the Feedback and Crash reports tabs.
function useAdminList({ fetchList, fetchCounts, filter, reloadToken }) {
  const [list, setList] = useState(null);
  const [counts, setCounts] = useState(null);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setList(null);
    Promise.all([fetchList({ filter, top: LIST_PAGE_SIZE }), fetchCounts()])
      .then(([rows, grouped]) => { if (!cancelled) { setList(rows); setCounts(grouped); setError(''); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [filter, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    if (!list || loadingMore) return;
    try {
      setLoadingMore(true);
      const next = await fetchList({ filter, top: LIST_PAGE_SIZE, skip: list.items.length });
      setList({ items: [...list.items, ...next.items], count: next.count });
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const replaceItem = (row) => setList((l) => (l ? { ...l, items: l.items.map((it) => (it.ID === row.ID ? row : it)) } : l));

  return { list, counts, error, setError, loadMore, loadingMore, replaceItem };
}

function LoadMore({ list, loadMore, loadingMore }) {
  if (!list || !hasMore(list.count, list.items.length)) return null;
  return (
    <div style={{ marginTop: 'var(--adops-space-sm)' }}>
      <Button design="Transparent" icon="navigation-down-arrow" disabled={loadingMore} onClick={loadMore}>
        Load {Math.min(LIST_PAGE_SIZE, list.count - list.items.length)} more
      </Button>
    </div>
  );
}

// --- Feedback tab --------------------------------------------------------------

function FeedbackView({ notify, reloadToken, bumpReload }) {
  const [draft, setDraft] = useState(EMPTY_FEEDBACK_FILTER);
  const [applied, setApplied] = useState(EMPTY_FEEDBACK_FILTER);
  const filter = buildFeedbackFilter(applied);
  const { list, counts, error, setError, loadMore, loadingMore, replaceItem } = useAdminList({
    fetchList: fetchPilotFeedback, fetchCounts: fetchPilotFeedbackStatusCounts, filter, reloadToken
  });
  const [triage, setTriage] = useState(null); // { row, draft }
  const [saving, setSaving] = useState(false);

  const saveTriage = async () => {
    if (!triage || !triageChanged(triage.row, triage.draft)) return;
    try {
      setSaving(true);
      const updated = await updateFeedbackTriage(triagePayload(triage.row.ID, triage.draft));
      replaceItem(updated);
      setTriage(null);
      notify({ design: 'Positive', text: `Feedback ${updated.ReferenceNumber || ''} set to ${humanize(updated.Status)} (audited).` });
      bumpReload();
    } catch (e) {
      setError(getServiceErrorMessage(e, 'The triage could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const items = list?.items || null;
  return (
    <div>
      {error ? <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip> : null}
      {counts ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
          {statusCards(counts, FEEDBACK_STATUSES).map((c) => <Kpi key={c.key} label={c.label} value={cardValue(c.value)} />)}
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
        <ChoiceSelect label="Status" value={draft.status} options={FEEDBACK_STATUSES} allLabel="All statuses" onChange={(v) => setDraft({ ...draft, status: v })} />
        <ChoiceSelect label="Category" value={draft.category} options={FEEDBACK_CATEGORIES} allLabel="All categories" onChange={(v) => setDraft({ ...draft, category: v })} minWidth="13rem" />
        <ChoiceSelect label="Impact" value={draft.impact} options={FEEDBACK_IMPACTS} allLabel="All impacts" onChange={(v) => setDraft({ ...draft, impact: v })} minWidth="9rem" />
        <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '14rem' }}>
          <Label>Search</Label>
          <Input accessibleName="Search" value={draft.search} placeholder="title, reference or feature" onInput={(e) => setDraft({ ...draft, search: e.target.value })} />
        </div>
        <Button design="Emphasized" onClick={() => setApplied(draft)}>Go</Button>
        <Button design="Transparent" onClick={() => { setDraft(EMPTY_FEEDBACK_FILTER); setApplied(EMPTY_FEEDBACK_FILTER); }}>Clear</Button>
      </div>

      {!items ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : items.length === 0 ? (
        <IllustratedMessage name="NoData" titleText={filter ? 'No feedback matches the filter' : 'No pilot feedback yet'} subtitleText="Feedback submitted from the app lands here for triage." />
      ) : (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <Text style={{ display: 'block', marginBottom: 'var(--adops-space-xs)', color: 'var(--sapNeutralTextColor, #6a6d70)' }}>
            {items.length.toLocaleString()} of {Number(list.count).toLocaleString()} entries
          </Text>
          <Table accessibleName="Pilot feedback"
            headerRow={
              <TableHeaderRow sticky>
                <TableHeaderCell><span>Submitted</span></TableHeaderCell>
                <TableHeaderCell><span>Reference</span></TableHeaderCell>
                <TableHeaderCell><span>Title</span></TableHeaderCell>
                <TableHeaderCell><span>Category</span></TableHeaderCell>
                <TableHeaderCell><span>Impact</span></TableHeaderCell>
                <TableHeaderCell><span>Feature</span></TableHeaderCell>
                <TableHeaderCell><span>By</span></TableHeaderCell>
                <TableHeaderCell><span>Status</span></TableHeaderCell>
                <TableHeaderCell><span>Assigned</span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {items.map((row) => (
              <TableRow key={row.ID} interactive onClick={() => setTriage({ row, draft: triageDraft(row) })}>
                <TableCell><span>{formatTimestamp(row.SubmittedAt) || '—'}</span></TableCell>
                <TableCell><span>{row.ReferenceNumber || '—'}</span></TableCell>
                <TableCell><span style={{ fontWeight: 600 }}>{row.Title}</span></TableCell>
                <TableCell><span>{humanize(row.Category)}</span></TableCell>
                <TableCell><Tag design={IMPACT_DESIGN[row.Impact] || 'Neutral'}>{row.Impact || '—'}</Tag></TableCell>
                <TableCell><span>{row.Feature || '—'}</span></TableCell>
                <TableCell><span>{row.SubmittedByName || row.SubmittedBy || '—'}</span></TableCell>
                <TableCell><Tag design={FEEDBACK_STATUS_DESIGN[row.Status] || 'Neutral'}>{humanize(row.Status)}</Tag></TableCell>
                <TableCell><span>{row.AssignedTo || '—'}</span></TableCell>
              </TableRow>
            ))}
          </Table>
          <LoadMore list={list} loadMore={loadMore} loadingMore={loadingMore} />
        </div>
      )}

      <Dialog open={Boolean(triage)} headerText={`Triage ${triage?.row?.ReferenceNumber || 'feedback'}`} onClose={() => setTriage(null)}>
        {triage ? (
          <div style={{ display: 'grid', gap: 'var(--adops-space-sm)', padding: 'var(--adops-space-sm)', minWidth: '28rem', maxWidth: '36rem' }}>
            <Text style={{ fontWeight: 600 }}>{triage.row.Title}</Text>
            <Text>{triage.row.Description}</Text>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-md)' }}>
              <Meta label="Category" value={humanize(triage.row.Category)} />
              <Meta label="Impact" value={triage.row.Impact} />
              <Meta label="Route" value={triage.row.Route} />
              <Meta label="Submitted by" value={`${triage.row.SubmittedByName || triage.row.SubmittedBy || ''}${triage.row.ContactAllowed ? ' (may be contacted)' : ''}`.trim()} />
              <Meta label="Correlation" value={triage.row.CorrelationId} />
            </div>
            <Label required>Status</Label>
            <Select accessibleName="Status" onChange={(e) => setTriage({ ...triage, draft: { ...triage.draft, status: e.detail.selectedOption.dataset.value } })}>
              {FEEDBACK_STATUSES.map((s) => <Option key={s} data-value={s} selected={triage.draft.status === s}>{humanize(s)}</Option>)}
            </Select>
            <Label>Assigned to</Label>
            <Input accessibleName="Assigned to" value={triage.draft.assignedTo} onInput={(e) => setTriage({ ...triage, draft: { ...triage.draft, assignedTo: e.target.value } })} />
            <Label>Admin notes</Label>
            <TextArea accessibleName="Admin notes" rows={3} value={triage.draft.adminNotes} onInput={(e) => setTriage({ ...triage, draft: { ...triage.draft, adminNotes: e.target.value } })} />
            <Label>Resolution notes</Label>
            <TextArea accessibleName="Resolution notes" rows={3} value={triage.draft.resolutionNotes} onInput={(e) => setTriage({ ...triage, draft: { ...triage.draft, resolutionNotes: e.target.value } })} />
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setTriage(null)}>Cancel</Button>
          <Button design="Emphasized" disabled={saving || !triage || !triageChanged(triage.row, triage.draft)} onClick={saveTriage}>Save</Button>
        </div>
      </Dialog>
    </div>
  );
}

// --- Crash reports tab ---------------------------------------------------------

function ErrorsView({ notify, reloadToken, bumpReload }) {
  const [draft, setDraft] = useState(EMPTY_ERROR_FILTER);
  const [applied, setApplied] = useState(EMPTY_ERROR_FILTER);
  const filter = buildErrorFilter(applied);
  const { list, counts, error, setError, loadMore, loadingMore, replaceItem } = useAdminList({
    fetchList: fetchClientErrorReports, fetchCounts: fetchClientErrorStatusCounts, filter, reloadToken
  });
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);

  const setStatus = async (row, status) => {
    if (!status || status === row.Status) return;
    try {
      setSaving(true);
      const updated = await updateClientErrorStatus(row.ID, status);
      replaceItem(updated);
      setSelected(updated);
      notify({ design: 'Positive', text: `Crash report set to ${humanize(updated.Status)}.` });
      bumpReload();
    } catch (e) {
      setError(getServiceErrorMessage(e, 'The status could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const items = list?.items || null;
  return (
    <div>
      {error ? <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip> : null}
      {counts ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
          {statusCards(counts, ERROR_STATUSES).map((c) => <Kpi key={c.key} label={c.label} value={cardValue(c.value)} />)}
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
        <ChoiceSelect label="Status" value={draft.status} options={ERROR_STATUSES} allLabel="All statuses" onChange={(v) => setDraft({ ...draft, status: v })} />
        <ChoiceSelect label="Severity" value={draft.severity} options={ERROR_SEVERITIES} allLabel="All severities" onChange={(v) => setDraft({ ...draft, severity: v })} minWidth="9rem" />
        <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '14rem' }}>
          <Label>Search</Label>
          <Input accessibleName="Search" value={draft.search} placeholder="message, route or feature" onInput={(e) => setDraft({ ...draft, search: e.target.value })} />
        </div>
        <Button design="Emphasized" onClick={() => setApplied(draft)}>Go</Button>
        <Button design="Transparent" onClick={() => { setDraft(EMPTY_ERROR_FILTER); setApplied(EMPTY_ERROR_FILTER); }}>Clear</Button>
      </div>

      {!items ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : items.length === 0 ? (
        <IllustratedMessage name="NoData" titleText={filter ? 'No crash reports match the filter' : 'No crash reports'} subtitleText="Render crashes reported by the client are grouped here by fingerprint." />
      ) : (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <Text style={{ display: 'block', marginBottom: 'var(--adops-space-xs)', color: 'var(--sapNeutralTextColor, #6a6d70)' }}>
            {items.length.toLocaleString()} of {Number(list.count).toLocaleString()} reports
          </Text>
          <Table accessibleName="Crash reports"
            headerRow={
              <TableHeaderRow sticky>
                <TableHeaderCell><span>Last seen</span></TableHeaderCell>
                <TableHeaderCell><span>Message</span></TableHeaderCell>
                <TableHeaderCell><span>Type</span></TableHeaderCell>
                <TableHeaderCell><span>Severity</span></TableHeaderCell>
                <TableHeaderCell><span>Route</span></TableHeaderCell>
                <TableHeaderCell><span>Occurrences</span></TableHeaderCell>
                <TableHeaderCell><span>Version</span></TableHeaderCell>
                <TableHeaderCell><span>Status</span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {items.map((row) => (
              <TableRow key={row.ID} interactive onClick={() => setSelected(selected?.ID === row.ID ? null : row)}>
                <TableCell><span>{formatTimestamp(row.LastSeenAt) || '—'}</span></TableCell>
                <TableCell><span style={{ fontWeight: selected?.ID === row.ID ? 700 : 600 }}>{row.ErrorMessage}</span></TableCell>
                <TableCell><span>{humanize(row.ErrorType)}</span></TableCell>
                <TableCell><Tag design={ERROR_SEVERITY_DESIGN[row.Severity] || 'Neutral'}>{row.Severity || '—'}</Tag></TableCell>
                <TableCell><span>{row.Route || '—'}</span></TableCell>
                <TableCell><span>{Number(row.OccurrenceCount || 0).toLocaleString()}</span></TableCell>
                <TableCell><span>{row.AppVersion || '—'}</span></TableCell>
                <TableCell><Tag design={ERROR_STATUS_DESIGN[row.Status] || 'Neutral'}>{humanize(row.Status)}</Tag></TableCell>
              </TableRow>
            ))}
          </Table>
          <LoadMore list={list} loadMore={loadMore} loadingMore={loadingMore} />
        </div>
      )}

      {selected ? (
        <Panel headerText={`Crash report · ${humanize(selected.ErrorType)}`} style={{ marginTop: 'var(--adops-space-md)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
            <Text style={{ fontWeight: 600 }}>{selected.ErrorMessage}</Text>
            <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '11rem' }}>
              <Label>Status</Label>
              <Select accessibleName="Status" disabled={saving} onChange={(e) => setStatus(selected, e.detail.selectedOption.dataset.value)}>
                {ERROR_STATUSES.map((s) => <Option key={s} data-value={s} selected={selected.Status === s}>{humanize(s)}</Option>)}
              </Select>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-md)', marginTop: 'var(--adops-space-sm)' }}>
            <Meta label="First seen" value={formatTimestamp(selected.FirstSeenAt)} />
            <Meta label="Last seen" value={formatTimestamp(selected.LastSeenAt)} />
            <Meta label="Occurrences" value={String(selected.OccurrenceCount ?? '')} />
            <Meta label="Feature" value={selected.Feature} />
            <Meta label="User" value={selected.UserId} />
            <Meta label="Session" value={selected.SessionId} />
            <Meta label="Correlation" value={selected.CorrelationId} />
            <Meta label="Fingerprint" value={selected.Fingerprint} />
            <Meta label="Browser" value={selected.BrowserInfo} />
          </div>
          {selected.StackTrace ? (
            <pre style={{ marginTop: 'var(--adops-space-sm)', maxHeight: '18rem', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '0.75rem', fontFamily: 'var(--sapFontFamily-monospaced, monospace)' }}>
              {selected.StackTrace}
            </pre>
          ) : <Text style={{ display: 'block', marginTop: 'var(--adops-space-sm)' }}>No stack trace stored (disabled in telemetry settings).</Text>}
          {selected.ComponentStack ? (
            <pre style={{ marginTop: 'var(--adops-space-xs)', maxHeight: '12rem', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '0.75rem', fontFamily: 'var(--sapFontFamily-monospaced, monospace)' }}>
              {selected.ComponentStack}
            </pre>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}

// --- Usage / Performance tabs (server summaries) --------------------------------

function WindowSelect({ days, onChange }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '10rem' }}>
      <Label>Window</Label>
      <Select accessibleName="Window" onChange={(e) => onChange(Number(e.detail.selectedOption.dataset.value))}>
        {WINDOW_OPTIONS.map((d) => <Option key={d} data-value={String(d)} selected={days === d}>{windowLabel(d)}</Option>)}
      </Select>
    </div>
  );
}

function CountTable({ title, headers, rows, render }) {
  if (!rows.length) return <Text>No data in this window.</Text>;
  return (
    <Table accessibleName={title || headers.join(', ')} headerRow={<TableHeaderRow>{headers.map((h) => <TableHeaderCell key={h}><span>{h}</span></TableHeaderCell>)}</TableHeaderRow>}>
      {rows.map((row, i) => <TableRow key={i}>{render(row).map((cell, j) => <TableCell key={j}><span>{cell}</span></TableCell>)}</TableRow>)}
    </Table>
  );
}

function useSummary(fetcher, days, reloadToken) {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    fetcher(days)
      .then((result) => { if (!cancelled) { setSummary(result); setError(''); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [days, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps
  return { summary, error, setError };
}

function UsageView({ reloadToken }) {
  const [days, setDays] = useState(DEFAULT_WINDOW_DAYS);
  const { summary, error, setError } = useSummary(queryUsageSummary, days, reloadToken);
  return (
    <div>
      {error ? <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip> : null}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
        <WindowSelect days={days} onChange={setDays} />
      </div>
      {!summary ? <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} /> : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
            {usageCards(summary).map((c) => <Kpi key={c.key} label={c.label} value={cardValue(c.value)} />)}
          </div>
          {summary.totalEvents === 0 && (summary.feedbackByFeature || []).length === 0 ? (
            <IllustratedMessage name="NoData" titleText="No usage events in this window" subtitleText="Client usage telemetry lands here once the app emits it (telemetry settings: usage events)." />
          ) : (
            <>
              <Panel headerText="By feature" style={{ marginTop: 'var(--adops-space-md)' }}>
                <CountTable headers={['Feature', 'Outcome', 'Events']} rows={summary.byFeature || []} render={(r) => [r.feature, r.outcome || '—', Number(r.count).toLocaleString()]} />
              </Panel>
              <Panel headerText="By event" style={{ marginTop: 'var(--adops-space-md)' }}>
                <CountTable headers={['Event', 'Count']} rows={summary.byEventName || []} render={(r) => [r.eventName, Number(r.count).toLocaleString()]} />
              </Panel>
              <Panel headerText="By app version" style={{ marginTop: 'var(--adops-space-md)' }}>
                <CountTable headers={['Version', 'Events']} rows={summary.byVersion || []} render={(r) => [r.appVersion, Number(r.count).toLocaleString()]} />
              </Panel>
              <Panel headerText="Feedback by feature" style={{ marginTop: 'var(--adops-space-md)' }}>
                <CountTable headers={['Feature', 'Entries']} rows={summary.feedbackByFeature || []} render={(r) => [r.feature, Number(r.count).toLocaleString()]} />
              </Panel>
            </>
          )}
        </>
      )}
    </div>
  );
}

function PerformanceView({ reloadToken }) {
  const [days, setDays] = useState(DEFAULT_WINDOW_DAYS);
  const { summary, error, setError } = useSummary(queryPerformanceSummary, days, reloadToken);
  return (
    <div>
      {error ? <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip> : null}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
        <WindowSelect days={days} onChange={setDays} />
      </div>
      {!summary ? <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} /> : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
            {performanceCards(summary).map((c) => <Kpi key={c.key} label={c.label} value={cardValue(c.value)} />)}
          </div>
          {summary.totalEvents === 0 ? (
            <IllustratedMessage name="NoData" titleText="No timed operations in this window" subtitleText="Route and API timings land here once the app emits them (telemetry settings: performance events)." />
          ) : (
            <Panel headerText="Slowest operations (top 25 by average)" style={{ marginTop: 'var(--adops-space-md)' }}>
              <CountTable
                headers={['Source', 'Operation', 'Count', 'Avg ms', 'Max ms']}
                rows={summary.operations || []}
                render={(r) => [r.source, r.operationName, Number(r.count).toLocaleString(), Number(r.avgMs).toLocaleString(), Number(r.maxMs).toLocaleString()]}
              />
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

// --- Page ------------------------------------------------------------------------

export function ProductInsightsPage() {
  const { view } = useParams();
  const navigate = useNavigate();
  const [userInfo, setUserInfo] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const activeTabId = resolveInsightsView(view);

  useEffect(() => {
    let cancelled = false;
    fetchUserInfo()
      .then((info) => { if (!cancelled) setUserInfo(info); })
      .catch((e) => { if (!cancelled) setLoadError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, []);

  const admin = hasAdminAccess(userInfo);
  const bumpReload = () => setReloadToken((t) => t + 1);

  if (userInfo && !admin) {
    return (
      <div>
        <Title level="H2">Product Insights</Title>
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <RestrictedState
            area="product-insights"
            title="Administrator access required"
            text="Pilot feedback, crash reports and usage telemetry are available to AdoptOps administrators only."
            userInfo={userInfo}
          />
        </div>
      </div>
    );
  }

  const viewProps = { notify: setNotice, reloadToken, bumpReload };
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
        <Title level="H2">Product Insights</Title>
        <span style={{ display: 'inline-flex', gap: 'var(--adops-space-xs)', flexWrap: 'wrap' }}>
          <Button design="Transparent" icon="action-settings" onClick={() => navigate('/settings/telemetry')}>Telemetry settings</Button>
          <Button design="Transparent" icon="refresh" onClick={bumpReload}>Refresh</Button>
        </span>
      </div>
      {loadError ? <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setLoadError('')}>{loadError}</MessageStrip> : null}
      {notice ? <MessageStrip design={notice.design} style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setNotice(null)}>{notice.text}</MessageStrip> : null}
      <div style={{ marginTop: 'var(--adops-space-md)' }}>
        <AdopsPageTabs tabs={INSIGHTS_VIEWS} activeTabId={activeTabId} ariaLabel="Product Insights views" onSelect={(id) => navigate(getInsightsViewPath(id))} />
      </div>
      {!userInfo ? <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '4vh' }} />
        : activeTabId === 'errors' ? <ErrorsView {...viewProps} />
          : activeTabId === 'usage' ? <UsageView reloadToken={reloadToken} />
            : activeTabId === 'performance' ? <PerformanceView reloadToken={reloadToken} />
              : <FeedbackView {...viewProps} />}
    </div>
  );
}

export default ProductInsightsPage;
