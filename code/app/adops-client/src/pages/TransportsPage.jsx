import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Title } from '@ui5/webcomponents-react/Title';
import { Text } from '@ui5/webcomponents-react/Text';
import { Label } from '@ui5/webcomponents-react/Label';
import { Button } from '@ui5/webcomponents-react/Button';
import { Select } from '@ui5/webcomponents-react/Select';
import { Option } from '@ui5/webcomponents-react/Option';
import { TextArea } from '@ui5/webcomponents-react/TextArea';
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
import { fetchUserInfo } from '../services/coreService.js';
import { hasActivatorAccess } from '../features/auth/memberAccess.js';
import {
  listTargetSystems,
  queryTransportRequests,
  releaseTransport,
  verifyTransportImport,
  recordTransportImport,
  readTransportImport,
  getServiceErrorMessage
} from '../services/fioriService.js';
import {
  RELEASE_STATUS_DESIGN,
  RECORDABLE_IMPORT_STATUSES,
  importStatusTag,
  verdictTag,
  formatStamp,
  followOnSystemsFor,
  defaultFollowOnSystem,
  canVerifyImport,
  canRecordImport,
  verificationSummary,
  verificationRows,
  verificationDesign
} from '../features/transports/transportModel.js';

// Status buckets shared with the cockpit (dashboard-summary.js on the server
// expands a bucket to its statuses).
const TRANSPORT_STATUS_OPTIONS = [
  { id: '', label: 'All statuses' },
  { id: 'OPEN', label: 'Open (modifiable / releasing)' },
  { id: 'RELEASED', label: 'Released' },
  { id: 'FAILED', label: 'Release failed' }
];

const systemLabel = (s) => `${s.displayName}${s.environment ? ` (${s.environment})` : ''}`;

export function TransportsPage() {
  const [userInfo, setUserInfo] = useState(null);
  const [items, setItems] = useState(null);
  const [followOnSystems, setFollowOnSystems] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(null); // transport row
  const [lastResult, setLastResult] = useState(null);         // { transportId, ...payload }
  const [verifying, setVerifying] = useState(null);           // { transport, systemId, result, loading }
  const [recording, setRecording] = useState(null);           // { transport, systemId, status, note }
  const [reloadToken, setReloadToken] = useState(0);
  const [systems, setSystems] = useState([]);

  // Navigation intent from the cockpit (`system`, `status` = bucket)
  // pre-applies the bar; the bar edits a DRAFT, Go commits, Clear resets.
  const [searchParams] = useSearchParams();
  const systemFromUrl = searchParams.get('system') || '';
  const statusFromUrl = (searchParams.get('status') || '').toUpperCase();
  const [draft, setDraft] = useState({ systemId: systemFromUrl, status: statusFromUrl });
  const [applied, setApplied] = useState({ systemId: systemFromUrl, status: statusFromUrl });

  useEffect(() => {
    let cancelled = false;
    fetchUserInfo()
      .then((info) => { if (!cancelled) setUserInfo(info); })
      .catch(() => {});
    listTargetSystems()
      .then((rows) => { if (!cancelled) setSystems(rows); })
      .catch(() => { /* the system select degrades to "all"; the list read reports errors */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    queryTransportRequests(applied.systemId || undefined, applied.status || undefined)
      .then((result) => {
        if (cancelled) return;
        setItems(result.Items);
        setFollowOnSystems(result.FollowOnSystems || []);
        setError('');
      })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [applied, reloadToken]);

  const runRelease = async (transport, simulate) => {
    try {
      setBusy(true);
      const result = await releaseTransport(transport.ID, simulate);
      setLastResult({ transportId: transport.ID, trkorr: transport.TransportRequestId, ...result });
      setConfirmRelease(null);
      if (!simulate) setReloadToken((t) => t + 1);
    } catch (e) {
      setError(getServiceErrorMessage(e));
      setConfirmRelease(null);
    } finally {
      setBusy(false);
    }
  };

  // --- Verification on a follow-on system (S10) ---------------------------------

  // Opening the dialog shows the last persisted verdicts for the preselected
  // system (no S/4 read); "Verify now" runs the reads.
  const openVerify = (transport) => {
    const system = defaultFollowOnSystem(transport, followOnSystems);
    setVerifying({ transport, systemId: system?.ID || '', result: null, loading: false });
    if (system) loadLastVerification(transport, system.ID);
  };

  const loadLastVerification = async (transport, systemId) => {
    const known = (transport.Imports || []).find((i) => i.targetSystem_ID === systemId);
    if (!known) {
      setVerifying((v) => (v ? { ...v, result: null } : v));
      return;
    }
    try {
      const payload = await readTransportImport(transport.ID, systemId);
      setVerifying((v) => (v && v.systemId === systemId
        ? { ...v, result: payload.Import ? { Import: payload.Import, Verification: payload.Import.Verification, fromRecord: true } : null }
        : v));
    } catch (e) {
      setError(getServiceErrorMessage(e));
    }
  };

  const pickVerifySystem = (systemId) => {
    setVerifying((v) => (v ? { ...v, systemId, result: null } : v));
    if (verifying?.transport && systemId) loadLastVerification(verifying.transport, systemId);
  };

  const runVerify = async () => {
    if (!verifying?.systemId) return;
    try {
      setVerifying((v) => ({ ...v, loading: true }));
      const payload = await verifyTransportImport(verifying.transport.ID, verifying.systemId);
      setVerifying((v) => (v ? { ...v, loading: false, result: { ...payload, fromRecord: false } } : v));
      setReloadToken((t) => t + 1);
    } catch (e) {
      setError(getServiceErrorMessage(e));
      setVerifying((v) => (v ? { ...v, loading: false } : v));
    }
  };

  const openRecord = (transport) => {
    const system = defaultFollowOnSystem(transport, followOnSystems);
    setRecording({ transport, systemId: system?.ID || '', status: 'IMPORTED', note: '' });
  };

  const runRecord = async () => {
    if (!recording?.systemId) return;
    try {
      setBusy(true);
      await recordTransportImport(recording.transport.ID, recording.systemId, recording.status, recording.note);
      setRecording(null);
      setReloadToken((t) => t + 1);
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const activator = hasActivatorAccess(userInfo);
  const verifyResult = verifying?.result || null;
  const verifyImport = verifyResult?.Import || null;
  const verifyRows = verificationRows(verifyResult?.Verification);
  const verifySystems = verifying ? followOnSystemsFor(verifying.transport, followOnSystems) : [];
  const recordSystems = recording ? followOnSystemsFor(recording.transport, followOnSystems) : [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
        <Title level="H2">Transports</Title>
        <Button design="Transparent" icon="refresh" onClick={() => setReloadToken((t) => t + 1)}>Refresh</Button>
      </div>

      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip>
      ) : null}

      {lastResult ? (
        <MessageStrip
          design={['RELEASED'].includes(lastResult.Status) || lastResult.Simulated ? 'Positive' : 'Negative'}
          style={{ marginTop: 'var(--adops-space-sm)' }}
          onClose={() => setLastResult(null)}
        >
          {lastResult.Simulated ? 'Release simulation' : 'Release'} for {lastResult.trkorr}:{' '}
          {(lastResult.Messages || []).map((m) => m.message).join(' ') || lastResult.Status}
        </MessageStrip>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
        <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '16rem' }}>
          <Label>Target system</Label>
          <Select onChange={(e) => setDraft({ ...draft, systemId: e.detail.selectedOption.dataset.value || '' })}>
            <Option data-value="" selected={draft.systemId === ''}>All target systems</Option>
            {systems.map((s) => (
              <Option key={s.ID} data-value={s.ID} selected={draft.systemId === s.ID}>
                {s.displayName}{s.environment ? ` (${s.environment})` : ''}
              </Option>
            ))}
          </Select>
        </div>
        <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '14rem' }}>
          <Label>Status</Label>
          <Select onChange={(e) => setDraft({ ...draft, status: e.detail.selectedOption.dataset.value || '' })}>
            {TRANSPORT_STATUS_OPTIONS.map((o) => (
              <Option key={o.id || 'all'} data-value={o.id} selected={draft.status === o.id}>{o.label}</Option>
            ))}
          </Select>
        </div>
        <Button design="Emphasized" onClick={() => setApplied(draft)}>Go</Button>
        <Button design="Transparent" onClick={() => { setDraft({ systemId: '', status: '' }); setApplied({ systemId: '', status: '' }); }}>Clear</Button>
      </div>

      {!items ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : items.length === 0 ? (
        <IllustratedMessage
          name="NoData"
          titleText={applied.status || applied.systemId ? 'No transport requests match the filter' : 'No transport requests yet'}
          subtitleText={applied.status || applied.systemId ? 'Clear the filter to see every transport request.' : 'Executing an activation plan creates the transport that carries its content.'}
        />
      ) : (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <Table
            headerRow={
              <TableHeaderRow sticky>
                <TableHeaderCell><span>Request</span></TableHeaderCell>
                <TableHeaderCell><span>Description</span></TableHeaderCell>
                <TableHeaderCell><span>Wave / Plan</span></TableHeaderCell>
                <TableHeaderCell><span>System</span></TableHeaderCell>
                <TableHeaderCell><span>Status</span></TableHeaderCell>
                <TableHeaderCell><span>Released</span></TableHeaderCell>
                <TableHeaderCell><span>Imports</span></TableHeaderCell>
                <TableHeaderCell><span></span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {items.map((row) => (
              <TableRow key={row.ID}>
                <TableCell><span style={{ fontWeight: 600 }}>{row.TransportRequestId}</span></TableCell>
                <TableCell><span>{row.Description}</span></TableCell>
                <TableCell><span>{[row.WaveName, row.PlanName].filter(Boolean).join(' / ') || '—'}</span></TableCell>
                <TableCell><span>{row.TargetSystemName || '—'}</span></TableCell>
                <TableCell><Tag design={RELEASE_STATUS_DESIGN[row.Status] || 'Neutral'}>{row.Status}</Tag></TableCell>
                <TableCell>
                  <span>{row.ReleasedAt ? `${formatStamp(row.ReleasedAt)}${row.ReleasedBy ? ` by ${row.ReleasedBy}` : ''}` : '—'}</span>
                </TableCell>
                <TableCell>
                  {(row.Imports || []).length ? (
                    <div style={{ display: 'grid', gap: 'var(--adops-space-xs)' }}>
                      {row.Imports.map((imp) => {
                        const tag = importStatusTag(imp.ImportStatus);
                        const summary = verificationSummary(imp);
                        return (
                          <div key={imp.ID} style={{ display: 'flex', alignItems: 'center', gap: 'var(--adops-space-xs)', flexWrap: 'wrap' }}>
                            <Tag design={tag.design}>{tag.label}</Tag>
                            <span>
                              {imp.TargetSystemName}
                              {imp.Source === 'OPERATOR' ? ' · recorded' : ''}
                              {imp.CheckedAt ? ` · ${formatStamp(imp.CheckedAt)}` : ''}
                              {summary ? ` · ${summary}` : ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : <span>—</span>}
                </TableCell>
                <TableCell>
                  <span style={{ display: 'inline-flex', gap: 'var(--adops-space-xs)', flexWrap: 'wrap' }}>
                    {activator && ['MODIFIABLE', 'RELEASE_FAILED'].includes(row.Status) ? (
                      <>
                        <Button design="Transparent" icon="simulate" disabled={busy} onClick={() => runRelease(row, true)}>
                          Check
                        </Button>
                        <Button design="Emphasized" icon="cargo-train" disabled={busy} onClick={() => setConfirmRelease(row)}>
                          Release
                        </Button>
                      </>
                    ) : null}
                    {canVerifyImport(row, followOnSystems) ? (
                      <Button design="Transparent" icon="checklist" disabled={busy} onClick={() => openVerify(row)}>
                        Verify
                      </Button>
                    ) : null}
                    {canRecordImport(row, activator) && followOnSystemsFor(row, followOnSystems).length ? (
                      <Button design="Transparent" icon="edit" disabled={busy} onClick={() => openRecord(row)}>
                        Record import
                      </Button>
                    ) : null}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      )}

      <Dialog
        open={Boolean(confirmRelease)}
        headerText="Release Transport Request"
        onClose={() => setConfirmRelease(null)}
      >
        {confirmRelease ? (
          <div style={{ padding: 'var(--adops-space-sm)', minWidth: '22rem' }}>
            <Text>
              Release {confirmRelease.TransportRequestId} ("{confirmRelease.Description}") on{' '}
              {confirmRelease.TargetSystemName || 'the target system'}? Releasing hands the request to the
              transport route and cannot be undone. Run Check first for the release checks without releasing.
            </Text>
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setConfirmRelease(null)}>Cancel</Button>
          <Button design="Negative" disabled={busy} onClick={() => runRelease(confirmRelease, false)}>Release</Button>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(verifying)}
        headerText={`Verify ${verifying?.transport?.TransportRequestId || ''} on a follow-on system`}
        onClose={() => setVerifying(null)}
        style={{ width: 'min(64rem, 96vw)' }}
      >
        {verifying ? (
          <div style={{ padding: 'var(--adops-space-sm)', display: 'grid', gap: 'var(--adops-space-sm)' }}>
            <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', maxWidth: '24rem' }}>
              <Label required>Follow-on system</Label>
              <Select disabled={verifying.loading} onChange={(e) => pickVerifySystem(e.detail.selectedOption.dataset.value || '')}>
                {verifySystems.map((s) => (
                  <Option key={s.ID} data-value={s.ID} selected={verifying.systemId === s.ID}>{systemLabel(s)}</Option>
                ))}
              </Select>
            </div>

            {verifying.loading ? <BusyIndicator active delay={0} style={{ display: 'block' }} /> : null}

            {verifyImport ? (
              <MessageStrip design={importStatusTag(verifyImport.ImportStatus).design === 'Positive' ? 'Positive' : importStatusTag(verifyImport.ImportStatus).design === 'Negative' ? 'Negative' : 'Information'} hideCloseButton>
                {importStatusTag(verifyImport.ImportStatus).label}
                {verifyImport.Source === 'OPERATOR' ? ' (recorded by an operator)' : ''}
                {verifyImport.CheckedAt ? ` · ${formatStamp(verifyImport.CheckedAt)}${verifyImport.CheckedBy ? ` by ${verifyImport.CheckedBy}` : ''}` : ''}
                {verifyImport.Note ? ` — ${verifyImport.Note}` : ''}
              </MessageStrip>
            ) : (
              <Text>No check on this system yet. Verify now reads the request and the wave's roles through the ZADO read unit.</Text>
            )}

            {verifyResult?.Verification ? (
              <>
                <MessageStrip design={verificationDesign(verifyResult.Verification)} hideCloseButton>
                  Manifest verification{verifyResult.fromRecord ? ' (last run)' : ''}: {verificationSummary(verifyResult.Verification.counts) || 'no entries'}
                </MessageStrip>
                <Table
                  headerRow={
                    <TableHeaderRow>
                      <TableHeaderCell><span>Section</span></TableHeaderCell>
                      <TableHeaderCell><span>Step</span></TableHeaderCell>
                      <TableHeaderCell><span>Object</span></TableHeaderCell>
                      <TableHeaderCell><span>Verdict</span></TableHeaderCell>
                      <TableHeaderCell><span>Detail</span></TableHeaderCell>
                    </TableHeaderRow>
                  }
                >
                  {verifyRows.map((r) => {
                    const tag = verdictTag(r.verdict);
                    return (
                      <TableRow key={`${r.section}-${r.sequence}`}>
                        <TableCell><span>{r.section}</span></TableCell>
                        <TableCell><span>{r.stepType}</span></TableCell>
                        <TableCell><span>{r.object}</span></TableCell>
                        <TableCell><Tag design={tag.design}>{tag.label}</Tag></TableCell>
                        <TableCell><span>{r.detail}</span></TableCell>
                      </TableRow>
                    );
                  })}
                </Table>
              </>
            ) : null}
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setVerifying(null)}>Close</Button>
          <Button design="Emphasized" icon="synchronize" disabled={!verifying?.systemId || verifying?.loading} onClick={runVerify}>Verify now</Button>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(recording)}
        headerText={`Record import of ${recording?.transport?.TransportRequestId || ''}`}
        onClose={() => setRecording(null)}
      >
        {recording ? (
          <div style={{ padding: 'var(--adops-space-sm)', display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '24rem' }}>
            <Label required>Follow-on system</Label>
            <Select onChange={(e) => setRecording({ ...recording, systemId: e.detail.selectedOption.dataset.value || '' })}>
              {recordSystems.map((s) => (
                <Option key={s.ID} data-value={s.ID} selected={recording.systemId === s.ID}>{systemLabel(s)}</Option>
              ))}
            </Select>
            <Label required>Outcome</Label>
            <Select onChange={(e) => setRecording({ ...recording, status: e.detail.selectedOption.dataset.value || 'IMPORTED' })}>
              {RECORDABLE_IMPORT_STATUSES.map((s) => (
                <Option key={s.value} data-value={s.value} selected={recording.status === s.value}>{s.label}</Option>
              ))}
            </Select>
            <Label>Note</Label>
            <TextArea
              rows={3}
              maxlength={500}
              value={recording.note}
              placeholder="Import return code, STMS log reference, who imported"
              onInput={(e) => setRecording({ ...recording, note: e.target.value })}
            />
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setRecording(null)}>Cancel</Button>
          <Button design="Emphasized" disabled={busy || !recording?.systemId} onClick={runRecord}>Record</Button>
        </div>
      </Dialog>
    </div>
  );
}

export default TransportsPage;
