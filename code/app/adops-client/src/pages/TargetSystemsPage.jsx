import { useEffect, useState } from 'react';
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
  checkConnection,
  getServiceErrorMessage
} from '../services/fioriService.js';

const ENVIRONMENTS = ['DEV', 'QAS', 'PRD', 'SANDBOX'];

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
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState({});
  const [verdicts, setVerdicts] = useState({});
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listTargetSystems()
      .then((rows) => { if (!cancelled) { setSystems(rows); setError(''); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e, 'Could not load target systems.')); });
    return () => { cancelled = true; };
  }, [reloadToken]);

  const saveDraft = async () => {
    setSaving(true);
    try {
      await createTargetSystem(draft);
      setDialogOpen(false);
      setDraft(EMPTY_DRAFT);
      setReloadToken((t) => t + 1);
    } catch (e) {
      setError(getServiceErrorMessage(e, 'Could not create the target system.'));
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
        <Button design="Emphasized" icon="add" onClick={() => setDialogOpen(true)}>
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
                <Button
                  design="Transparent"
                  icon="connected"
                  disabled={Boolean(testing[system.ID])}
                  onClick={() => testSystem(system)}
                >
                  {testing[system.ID] ? 'Testing…' : 'Test Connection'}
                </Button>
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

      <Dialog
        open={dialogOpen}
        headerText="Register Target System"
        onClose={() => setDialogOpen(false)}
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
        </div>
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button design="Emphasized" disabled={!draftValid || saving} onClick={saveDraft}>
            {saving ? 'Saving…' : 'Register'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export default TargetSystemsPage;
