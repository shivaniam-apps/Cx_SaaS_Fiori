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
import { Dialog } from '@ui5/webcomponents-react/Dialog';
import { Input } from '@ui5/webcomponents-react/Input';
import { Select } from '@ui5/webcomponents-react/Select';
import { Option } from '@ui5/webcomponents-react/Option';
import { Label } from '@ui5/webcomponents-react/Label';
import { TextArea } from '@ui5/webcomponents-react/TextArea';
import { CheckBox } from '@ui5/webcomponents-react/CheckBox';
import { fetchUserInfo } from '../services/coreService.js';
import { hasAdminAccess } from '../features/auth/memberAccess.js';
import {
  fetchAccessRequests,
  fetchAccessRequestSummary,
  decideAccessRequest,
  getServiceErrorMessage
} from '../services/accessRequestService.js';
import Kpi from '../components/Kpi.jsx';
import RestrictedState from '../components/RestrictedState.jsx';
import {
  ACCESS_REQUEST_STATUS_OPTIONS,
  ACCESS_REQUEST_URGENCY_OPTIONS,
  ACCESS_REQUEST_STATUS_DESIGN,
  ACCESS_REQUEST_FILTER_DEFAULTS,
  GRANT_STATUS_DESIGN,
  accessRequestAreaOptions,
  accessRequestAreaLabel,
  accessRequestStatusLabel,
  accessRequestUrgencyLabel,
  grantStatusLabel,
  buildAccessRequestFilter,
  hasActiveFilters,
  canDecide,
  decisionDescription,
  accessRequestSummaryCards,
  requesterDisplay,
  formatTimestamp
} from '../features/auth/accessRequestModel.js';

function FilterField({ label, children }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '11rem' }}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function AccessRequestsPage() {
  const [userInfo, setUserInfo] = useState(null);
  const [list, setList] = useState(null);          // { items, count }
  const [summary, setSummary] = useState(null);    // { Total, Pending, Approved, Declined, Other }
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);      // { design, text }
  const [reloadToken, setReloadToken] = useState(0);

  // Filter bar contract: controls edit a DRAFT; Go commits it to the applied
  // state the read consumes; Clear resets and applies; Refresh re-reads at
  // unchanged scope.
  const [draft, setDraft] = useState(ACCESS_REQUEST_FILTER_DEFAULTS);
  const [applied, setApplied] = useState(ACCESS_REQUEST_FILTER_DEFAULTS);

  // The decision payload stays in state through the close animation; only
  // `open` flips, so the dialog never falls back to empty wording mid-close.
  const [decision, setDecision] = useState({ open: false, request: null, action: null });
  const [decisionNotes, setDecisionNotes] = useState('');
  const [grantRole, setGrantRole] = useState(false);
  const [decisionError, setDecisionError] = useState('');
  const [decisionBusy, setDecisionBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchUserInfo()
      .then((info) => { if (!cancelled) setUserInfo(info); })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, []);

  const admin = hasAdminAccess(userInfo);

  useEffect(() => {
    if (!admin) return undefined;
    let cancelled = false;
    const filter = buildAccessRequestFilter(applied);
    Promise.all([fetchAccessRequests({ filter }), fetchAccessRequestSummary()])
      .then(([rows, counts]) => {
        if (cancelled) return;
        setList(rows);
        setSummary(counts);
        setError('');
      })
      .catch((e) => { if (!cancelled) { setList({ items: [], count: 0 }); setError(getServiceErrorMessage(e, 'Access requests could not be loaded.')); } });
    return () => { cancelled = true; };
  }, [admin, applied, reloadToken]);

  const openDecision = (request, action) => {
    if (!canDecide(request)) return;
    setDecisionNotes('');
    setGrantRole(false);
    setDecisionError('');
    setDecision({ open: true, request, action });
  };

  const closeDecision = () => {
    if (decisionBusy) return;
    setDecision((current) => ({ ...current, open: false }));
  };

  const confirmDecision = async () => {
    if (decisionBusy || !canDecide(decision.request)) return;
    setDecisionBusy(true);
    setDecisionError('');
    try {
      const updated = await decideAccessRequest({
        id: decision.request.id,
        decision: decision.action,
        decisionNotes: decisionNotes.trim(),
        grantRole: decision.action === 'APPROVE' && grantRole
      });
      if (updated.grantStatus === 'FAILED') {
        setNotice({
          design: 'Critical',
          text: `Request ${updated.referenceNumber} was approved, but the role grant failed: ${updated.grantError || 'unknown error'}. Assign the role collection manually in the BTP cockpit.`
        });
      } else {
        setNotice({
          design: 'Positive',
          text: decision.action === 'APPROVE'
            ? `Access request ${updated.referenceNumber} approved${updated.grantStatus === 'MANUAL' ? ' - assign the role collection in the BTP cockpit' : ''}.`
            : `Access request ${updated.referenceNumber} declined.`
        });
      }
      // Release busy and request the close in one commit; the row and the
      // summary come back from the re-read (both changed).
      setDecisionBusy(false);
      setDecision((current) => ({ ...current, open: false }));
      setReloadToken((t) => t + 1);
    } catch (e) {
      setDecisionBusy(false);
      setDecisionError(getServiceErrorMessage(e, 'The decision could not be saved. Please try again.'));
    }
  };

  if (userInfo && !admin) {
    return (
      <div>
        <Title level="H2">Access Requests</Title>
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <RestrictedState
            area="access-requests"
            title="Administrator access required"
            text="Access request triage is available to AdoptOps administrators only."
            userInfo={userInfo}
          />
        </div>
      </div>
    );
  }

  const items = list?.items || null;
  const cards = accessRequestSummaryCards(summary);
  const isApprove = decision.action === 'APPROVE';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
        <Title level="H2">Access Requests</Title>
        <Button design="Transparent" icon="refresh" onClick={() => setReloadToken((t) => t + 1)}>Refresh</Button>
      </div>

      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip>
      ) : null}
      {notice ? (
        <MessageStrip design={notice.design} style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setNotice(null)}>{notice.text}</MessageStrip>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
        <FilterField label="Search">
          <Input accessibleName="Search"
            value={draft.search}
            placeholder="Reference, requester, justification"
            showClearIcon
            onInput={(e) => setDraft({ ...draft, search: e.target.value })}
          />
        </FilterField>
        <FilterField label="Status">
          <Select accessibleName="Status" onChange={(e) => setDraft({ ...draft, status: e.detail.selectedOption.dataset.value || '' })}>
            <Option data-value="" selected={draft.status === ''}>All statuses</Option>
            {ACCESS_REQUEST_STATUS_OPTIONS.map((o) => (
              <Option key={o.value} data-value={o.value} selected={draft.status === o.value}>{o.label}</Option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Area">
          <Select accessibleName="Area" onChange={(e) => setDraft({ ...draft, area: e.detail.selectedOption.dataset.value || '' })}>
            <Option data-value="" selected={draft.area === ''}>All areas</Option>
            {accessRequestAreaOptions().map((o) => (
              <Option key={o.value} data-value={o.value} selected={draft.area === o.value}>{o.label}</Option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Urgency">
          <Select accessibleName="Urgency" onChange={(e) => setDraft({ ...draft, urgency: e.detail.selectedOption.dataset.value || '' })}>
            <Option data-value="" selected={draft.urgency === ''}>All urgencies</Option>
            {ACCESS_REQUEST_URGENCY_OPTIONS.map((o) => (
              <Option key={o.value} data-value={o.value} selected={draft.urgency === o.value}>{o.label}</Option>
            ))}
          </Select>
        </FilterField>
        <Button design="Emphasized" onClick={() => setApplied(draft)}>Go</Button>
        <Button design="Transparent" onClick={() => { setDraft(ACCESS_REQUEST_FILTER_DEFAULTS); setApplied(ACCESS_REQUEST_FILTER_DEFAULTS); }}>Clear</Button>
      </div>

      {summary ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
          <Kpi label="Requests" value={Number(summary.Total || 0).toLocaleString()} />
          {cards.map((card) => <Kpi key={card.key} label={card.label} value={Number(card.value).toLocaleString()} />)}
        </div>
      ) : null}

      {!items ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : items.length === 0 ? (
        <IllustratedMessage
          name="NoData"
          titleText={hasActiveFilters(applied) ? 'No access requests match the current filters' : 'No access requests yet'}
          subtitleText={hasActiveFilters(applied)
            ? 'Widen the filters or clear them to see every request.'
            : 'When users request access from a restricted page, the requests appear here.'}
        />
      ) : (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          {list.count > items.length ? (
            <MessageStrip design="Information" hideCloseButton style={{ marginBottom: 'var(--adops-space-xs)' }}>
              Showing the newest {items.length} of {list.count} requests - narrow the filters to see older ones.
            </MessageStrip>
          ) : null}
          <Table accessibleName="Access requests"
            headerRow={
              <TableHeaderRow sticky>
                <TableHeaderCell><span>Reference</span></TableHeaderCell>
                <TableHeaderCell><span>Requester</span></TableHeaderCell>
                <TableHeaderCell><span>Area</span></TableHeaderCell>
                <TableHeaderCell><span>Urgency</span></TableHeaderCell>
                <TableHeaderCell><span>Requested</span></TableHeaderCell>
                <TableHeaderCell><span>Justification</span></TableHeaderCell>
                <TableHeaderCell><span>Status</span></TableHeaderCell>
                <TableHeaderCell><span>Decision</span></TableHeaderCell>
                <TableHeaderCell><span></span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {items.map((row) => {
              const who = requesterDisplay(row);
              return (
                <TableRow key={row.id}>
                  <TableCell><span style={{ fontWeight: 600 }}>{row.referenceNumber}</span></TableCell>
                  <TableCell>
                    <span style={{ display: 'grid' }}>
                      <span>{who.primary}</span>
                      {who.secondary ? <span style={{ fontSize: '0.8rem', color: 'var(--sapNeutralTextColor, #6a6d70)' }}>{who.secondary}</span> : null}
                    </span>
                  </TableCell>
                  <TableCell><span>{accessRequestAreaLabel(row.area)}</span></TableCell>
                  <TableCell><span>{accessRequestUrgencyLabel(row.urgency)}</span></TableCell>
                  <TableCell><span>{formatTimestamp(row.requestedAt) || '—'}</span></TableCell>
                  <TableCell>
                    <span
                      title={row.justification || ''}
                      style={{ display: 'inline-block', maxWidth: '22rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}
                    >
                      {row.justification || '—'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span style={{ display: 'inline-flex', gap: 'var(--adops-space-xs)', flexWrap: 'wrap' }}>
                      <Tag design={ACCESS_REQUEST_STATUS_DESIGN[row.status] || 'Neutral'}>{accessRequestStatusLabel(row.status)}</Tag>
                      {row.grantStatus ? (
                        <Tag design={GRANT_STATUS_DESIGN[row.grantStatus] || 'Neutral'} title={row.grantError || undefined}>
                          {grantStatusLabel(row.grantStatus)}
                        </Tag>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span style={{ display: 'grid' }}>
                      <span>{row.decidedAt ? `${formatTimestamp(row.decidedAt)}${row.decidedBy ? ` by ${row.decidedBy}` : ''}` : '—'}</span>
                      {row.decisionNotes ? <span style={{ fontSize: '0.8rem', color: 'var(--sapNeutralTextColor, #6a6d70)' }} title={row.decisionNotes}>{row.decisionNotes.length > 60 ? `${row.decisionNotes.slice(0, 60)}…` : row.decisionNotes}</span> : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    {canDecide(row) ? (
                      <span style={{ display: 'inline-flex', gap: 'var(--adops-space-xs)' }}>
                        <Button design="Transparent" icon="accept" onClick={() => openDecision(row, 'APPROVE')}>Approve</Button>
                        <Button design="Transparent" icon="decline" onClick={() => openDecision(row, 'DECLINE')}>Decline</Button>
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </Table>
        </div>
      )}

      <Dialog
        open={decision.open}
        headerText={isApprove ? 'Approve Access Request' : 'Decline Access Request'}
        onClose={closeDecision}
      >
        <div style={{ display: 'grid', gap: 'var(--adops-space-sm)', padding: 'var(--adops-space-sm)', minWidth: '24rem', maxWidth: '36rem' }}>
          {decisionError ? <MessageStrip design="Negative" hideCloseButton>{decisionError}</MessageStrip> : null}
          <Text>{decisionDescription(decision.request, decision.action)}</Text>
          <Label>Decision notes (visible to the requester)</Label>
          <TextArea accessibleName="Decision notes"
            value={decisionNotes}
            rows={3}
            maxlength={2000}
            placeholder={isApprove ? 'Optional note for the requester' : 'Why is this request declined?'}
            onInput={(e) => setDecisionNotes(e.target.value)}
          />
          {isApprove ? (
            <CheckBox
              checked={grantRole}
              text="Also assign the role collection in SAP BTP now (otherwise assign it manually in the BTP cockpit)"
              onChange={(e) => setGrantRole(e.target.checked)}
            />
          ) : null}
        </div>
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" disabled={decisionBusy} onClick={closeDecision}>Cancel</Button>
          <Button design={isApprove ? 'Emphasized' : 'Negative'} disabled={decisionBusy} onClick={confirmDecision}>
            {isApprove ? 'Approve' : 'Decline'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export default AccessRequestsPage;
