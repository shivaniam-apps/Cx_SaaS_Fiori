import { useEffect, useMemo, useState } from 'react';
import { Title } from '@ui5/webcomponents-react/Title';
import { Button } from '@ui5/webcomponents-react/Button';
import { Table } from '@ui5/webcomponents-react/Table';
import { TableHeaderRow } from '@ui5/webcomponents-react/TableHeaderRow';
import { TableHeaderCell } from '@ui5/webcomponents-react/TableHeaderCell';
import { TableRow } from '@ui5/webcomponents-react/TableRow';
import { TableCell } from '@ui5/webcomponents-react/TableCell';
import { Dialog } from '@ui5/webcomponents-react/Dialog';
import { Input } from '@ui5/webcomponents-react/Input';
import { Label } from '@ui5/webcomponents-react/Label';
import { Select } from '@ui5/webcomponents-react/Select';
import { Option } from '@ui5/webcomponents-react/Option';
import { Tag } from '@ui5/webcomponents-react/Tag';
import { BusyIndicator } from '@ui5/webcomponents-react/BusyIndicator';
import { IllustratedMessage } from '@ui5/webcomponents-react/IllustratedMessage';
import { MessageStrip } from '@ui5/webcomponents-react/MessageStrip';
import {
  listTargetSystems,
  createTargetSystem,
  updateTargetSystem,
  checkConnection,
  getServiceErrorMessage
} from '../services/fioriService.js';
import { listBtpDestinations, getBtpAccountInfo, isForbidden } from '../services/adminService.js';
import { buildDestinationCatalog, draftFromDestination, DESTINATION_STATUS } from '../features/systems/destinationCatalog.js';

const ENVIRONMENTS = ['DEV', 'QAS', 'PRD', 'SANDBOX'];

function destinationStatusTag(status) {
  if (status === DESTINATION_STATUS.EXPOSED) return <Tag design="Positive">Exposed</Tag>;
  if (status === DESTINATION_STATUS.MAPPED) return <Tag design="Information">Mapped</Tag>;
  return <Tag design="Neutral">Available</Tag>;
}

const EMPTY_DRAFT = {
  displayName: '',
  destinationName: '',
  systemId: '',
  client: '',
  environment: 'DEV',
  s4Release: '2023'
};

function connectionTag(system, liveVerdicts) {
  const verdict = liveVerdicts[system.destinationName];
  const status = verdict ? (verdict.Ok ? 'OK' : verdict.Stage) : system.lastCheckStatus;
  if (!status) return <Tag design="Neutral">Untested</Tag>;
  if (status === 'OK') return <Tag design="Positive">Connected</Tag>;
  return <Tag design="Negative">{status === 'DESTINATION' ? 'Destination failed' : 'Service failed'}</Tag>;
}

export function TargetSystemsPage() {
  const [systems, setSystems] = useState(null);
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState('create'); // 'create' | 'edit'
  const [editingId, setEditingId] = useState(null);
  const [editingOriginalDest, setEditingOriginalDest] = useState('');
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState({});
  const [verdicts, setVerdicts] = useState({});
  const [reloadToken, setReloadToken] = useState(0);
  const [destinations, setDestinations] = useState(null); // null = not loaded / unavailable
  const [accountInfo, setAccountInfo] = useState(null);
  const [destError, setDestError] = useState('');
  const [refreshingDest, setRefreshingDest] = useState(false);
  const [destToken, setDestToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listTargetSystems()
      .then((rows) => { if (!cancelled) { setSystems(rows); setError(''); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e, 'Could not load target systems.')); });
    return () => { cancelled = true; };
  }, [reloadToken]);

  // The BTP destination catalog is Admin-only. Load it opportunistically:
  // a 403 (non-Admin) simply hides the panel; other errors surface inline.
  useEffect(() => {
    let cancelled = false;
    setRefreshingDest(true);
    Promise.all([listBtpDestinations(), getBtpAccountInfo().catch(() => null)])
      .then(([rows, info]) => {
        if (cancelled) return;
        setDestinations(rows);
        setAccountInfo(info);
        setDestError('');
      })
      .catch((e) => {
        if (cancelled) return;
        if (isForbidden(e)) { setDestinations(null); setDestError(''); }
        else { setDestinations([]); setDestError(getServiceErrorMessage(e, 'Could not read BTP destinations.')); }
      })
      .finally(() => { if (!cancelled) setRefreshingDest(false); });
    return () => { cancelled = true; };
  }, [destToken]);

  const catalog = useMemo(
    () => buildDestinationCatalog(destinations || [], systems || []),
    [destinations, systems]
  );

  const openCreate = () => {
    setDialogMode('create');
    setEditingId(null);
    setEditingOriginalDest('');
    setDraft(EMPTY_DRAFT);
    setDialogOpen(true);
  };

  const openEdit = (system) => {
    setDialogMode('edit');
    setEditingId(system.ID);
    setEditingOriginalDest(system.destinationName || '');
    setDraft({
      displayName: system.displayName || '',
      destinationName: system.destinationName || '',
      systemId: system.systemId || '',
      client: system.client || '',
      environment: system.environment || 'DEV',
      s4Release: system.s4Release || ''
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingId(null);
    setEditingOriginalDest('');
    setDraft(EMPTY_DRAFT);
  };

  // Clicking a catalog row: edit the existing target system if this
  // destination is already registered, otherwise open Register prefilled from
  // the destination metadata.
  const exposeDestination = (entry) => {
    if (entry.system) { openEdit(entry.system); return; }
    setDialogMode('create');
    setEditingId(null);
    setEditingOriginalDest('');
    setDraft(draftFromDestination(entry, EMPTY_DRAFT));
    setDialogOpen(true);
  };

  const refreshDestinations = () => setDestToken((t) => t + 1);

  const saveDraft = async () => {
    setSaving(true);
    try {
      if (dialogMode === 'edit') {
        const patch = {
          displayName: draft.displayName,
          destinationName: draft.destinationName,
          systemId: draft.systemId,
          client: draft.client,
          environment: draft.environment,
          s4Release: draft.s4Release
        };
        // Changing the destination invalidates the persisted last-check
        // verdict (it was keyed on the previous destination), so clear it
        // rather than show a stale Connected/Failed tag for a new endpoint.
        const destChanged = draft.destinationName !== editingOriginalDest;
        if (destChanged) {
          patch.lastCheckStatus = null;
          patch.lastCheckMessage = null;
          patch.lastCheckedAt = null;
        }
        await updateTargetSystem(editingId, patch);
        if (destChanged) {
          setVerdicts((v) => {
            const next = { ...v };
            delete next[editingOriginalDest];
            return next;
          });
        }
      } else {
        await createTargetSystem(draft);
      }
      closeDialog();
      setReloadToken((t) => t + 1);
    } catch (e) {
      setError(getServiceErrorMessage(
        e,
        dialogMode === 'edit' ? 'Could not update the target system.' : 'Could not create the target system.'
      ));
    } finally {
      setSaving(false);
    }
  };

  const testSystem = async (system) => {
    setTesting((t) => ({ ...t, [system.ID]: true }));
    try {
      const verdict = await checkConnection(system.destinationName, system.serviceRootPath || null);
      setVerdicts((v) => ({ ...v, [system.destinationName]: verdict }));
    } catch (e) {
      setVerdicts((v) => ({
        ...v,
        [system.destinationName]: { Ok: false, Stage: 'DESTINATION', Message: getServiceErrorMessage(e) }
      }));
    } finally {
      setTesting((t) => ({ ...t, [system.ID]: false }));
    }
  };

  const draftValid = draft.displayName.trim() && draft.destinationName.trim();

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level="H2">Target Systems</Title>
        <Button design="Emphasized" icon="add" onClick={openCreate}>
          Register System
        </Button>
      </div>

      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>
          {error}
        </MessageStrip>
      ) : null}

      {!systems ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '10vh' }} />
      ) : systems.length === 0 ? (
        <IllustratedMessage
          name="NoData"
          titleText="No target systems yet"
          subtitleText="Register the S/4HANA system this subaccount's destination points at."
        />
      ) : (
        <Table
          style={{ marginTop: 'var(--adops-space-md)' }}
          headerRow={
            <TableHeaderRow sticky>
              <TableHeaderCell><span>System</span></TableHeaderCell>
              <TableHeaderCell><span>Role</span></TableHeaderCell>
              <TableHeaderCell><span>SID / Client</span></TableHeaderCell>
              <TableHeaderCell><span>S/4 Release</span></TableHeaderCell>
              <TableHeaderCell><span>Connection</span></TableHeaderCell>
              <TableHeaderCell><span>Actions</span></TableHeaderCell>
            </TableHeaderRow>
          }
        >
          {systems.map((system) => (
            <TableRow key={system.ID}>
              <TableCell><span style={{ fontWeight: 600 }}>{system.displayName}</span></TableCell>
              <TableCell><span>{system.environment || '—'}</span></TableCell>
              <TableCell><span>{system.systemId || '—'} / {system.client || '—'}</span></TableCell>
              <TableCell><span>{system.s4Release || '—'}</span></TableCell>
              <TableCell>{connectionTag(system, verdicts)}</TableCell>
              <TableCell>
                <div style={{ display: 'flex', gap: 'var(--adops-space-xs)' }}>
                  <Button
                    design="Transparent"
                    icon="edit"
                    onClick={() => openEdit(system)}
                  >
                    Edit
                  </Button>
                  <Button
                    design="Transparent"
                    icon="connected"
                    disabled={Boolean(testing[system.ID])}
                    onClick={() => testSystem(system)}
                  >
                    {testing[system.ID] ? 'Testing…' : 'Test Connection'}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      )}

      {Object.entries(verdicts).map(([name, verdict]) => !verdict.Ok ? (
        <MessageStrip key={name} design="Negative" hideCloseButton style={{ marginTop: 'var(--adops-space-sm)' }}>
          {name}: {verdict.Message || 'Connection check failed.'}
        </MessageStrip>
      ) : null)}

      {destinations !== null || destError ? (
        <div style={{ marginTop: 'var(--adops-space-xl)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Title level="H3">Available Destinations{destinations ? ` (${catalog.length})` : ''}</Title>
              {accountInfo?.Available ? (
                <span style={{ fontSize: '0.8125rem', color: 'var(--sapContent_LabelColor)' }}>
                  BTP subaccount: {accountInfo.Subdomain || '—'}{accountInfo.Region ? ` · ${accountInfo.Region}` : ''}
                </span>
              ) : null}
            </div>
            <Button design="Transparent" icon="refresh" disabled={refreshingDest} onClick={refreshDestinations}>
              {refreshingDest ? 'Refreshing…' : 'Refresh Destinations'}
            </Button>
          </div>

          {destError ? (
            <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setDestError('')}>
              {destError}
            </MessageStrip>
          ) : null}

          {!destinations ? (
            <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '2rem' }} />
          ) : catalog.length === 0 ? (
            <IllustratedMessage
              name="NoData"
              titleText="No destinations found"
              subtitleText="This subaccount has no destinations, or the catalog could not be read."
            />
          ) : (
            <Table
              style={{ marginTop: 'var(--adops-space-md)' }}
              headerRow={
                <TableHeaderRow sticky>
                  <TableHeaderCell><span>Destination</span></TableHeaderCell>
                  <TableHeaderCell><span>Type</span></TableHeaderCell>
                  <TableHeaderCell><span>Endpoint</span></TableHeaderCell>
                  <TableHeaderCell><span>Exposure</span></TableHeaderCell>
                  <TableHeaderCell><span>Actions</span></TableHeaderCell>
                </TableHeaderRow>
              }
            >
              {catalog.map((entry) => (
                <TableRow key={entry.name}>
                  <TableCell>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontWeight: 600 }}>{entry.name}</span>
                      {entry.description ? (
                        <span style={{ fontSize: '0.8125rem', color: 'var(--sapContent_LabelColor)' }}>{entry.description}</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell><span>{[entry.type, entry.proxyType].filter(Boolean).join(' · ') || '—'}</span></TableCell>
                  <TableCell><span>{entry.url || '—'}</span></TableCell>
                  <TableCell>{destinationStatusTag(entry.status)}</TableCell>
                  <TableCell>
                    <Button
                      design="Transparent"
                      icon={entry.system ? 'edit' : 'add'}
                      onClick={() => exposeDestination(entry)}
                    >
                      {entry.system ? 'Edit' : 'Expose'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          )}
        </div>
      ) : null}

      <Dialog
        open={dialogOpen}
        headerText={dialogMode === 'edit' ? 'Edit Target System' : 'Register Target System'}
        onClose={closeDialog}
      >
        <div style={{ display: 'grid', gap: 'var(--adops-space-sm)', padding: 'var(--adops-space-sm)', minWidth: '22rem' }}>
          <Label for="ts-name" required>Display name</Label>
          <Input id="ts-name" value={draft.displayName} onInput={(e) => setDraft({ ...draft, displayName: e.target.value })} placeholder="RD1 Development" />
          <Label for="ts-dest" required>BTP destination name</Label>
          <Input id="ts-dest" value={draft.destinationName} onInput={(e) => setDraft({ ...draft, destinationName: e.target.value })} placeholder="S4H_2023" />
          <Label for="ts-sid">SAP system ID</Label>
          <Input id="ts-sid" value={draft.systemId} maxlength={3} onInput={(e) => setDraft({ ...draft, systemId: e.target.value.toUpperCase() })} placeholder="RD1" />
          <Label for="ts-client">Client</Label>
          <Input id="ts-client" value={draft.client} maxlength={3} onInput={(e) => setDraft({ ...draft, client: e.target.value })} placeholder="100" />
          <Label for="ts-env">Environment</Label>
          <Select id="ts-env" onChange={(e) => setDraft({ ...draft, environment: e.detail.selectedOption.dataset.value })}>
            {ENVIRONMENTS.map((env) => (
              <Option key={env} data-value={env} selected={draft.environment === env}>{env}</Option>
            ))}
          </Select>
          <Label for="ts-release">S/4 release</Label>
          <Input id="ts-release" value={draft.s4Release} onInput={(e) => setDraft({ ...draft, s4Release: e.target.value })} placeholder="2023" />
        </div>
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={closeDialog}>Cancel</Button>
          <Button design="Emphasized" disabled={!draftValid || saving} onClick={saveDraft}>
            {saving ? 'Saving…' : (dialogMode === 'edit' ? 'Save' : 'Register')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export default TargetSystemsPage;
