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
import { MessageStrip } from '@ui5/webcomponents-react/MessageStrip';
import { Panel } from '@ui5/webcomponents-react/Panel';
import { Dialog } from '@ui5/webcomponents-react/Dialog';
import { Switch } from '@ui5/webcomponents-react/Switch';
import { Input } from '@ui5/webcomponents-react/Input';
import { Select } from '@ui5/webcomponents-react/Select';
import { Option } from '@ui5/webcomponents-react/Option';
import { Label } from '@ui5/webcomponents-react/Label';
import { fetchUserInfo } from '../services/coreService.js';
import { hasAdminAccess } from '../features/auth/memberAccess.js';
import {
  listTargetSystems,
  updateTargetSystem,
  listIdentifiedUsageAuditEvents,
  getServiceErrorMessage
} from '../services/fioriService.js';
import { getTelemetrySettings, updateTelemetrySettings } from '../services/adminService.js';
import { formatTimestamp } from '../features/activation-runs/runModel.js';
import AdopsPageTabs from '../components/AdopsPageTabs.jsx';
import RestrictedState from '../components/RestrictedState.jsx';
import {
  SETTINGS_VIEWS,
  resolveSettingsView,
  getSettingsViewPath,
  usageModeLabel,
  systemSettingsDraft,
  systemSettingsPatch,
  needsIdentifiedUsageConfirmation,
  auditChangeLabel,
  IDENTIFICATION_MODES,
  TELEMETRY_FIELDS,
  TELEMETRY_GROUPS,
  telemetryFormFrom,
  validateTelemetryForm,
  telemetryPayload,
  telemetryChanged
} from '../features/settings/settingsViews.js';

// --- Target Systems tab -------------------------------------------------------

function TargetSystemsSettings({ notify }) {
  const [systems, setSystems] = useState(null);
  const [drafts, setDrafts] = useState({});          // by system ID
  const [events, setEvents] = useState(null);
  const [saving, setSaving] = useState('');          // system ID being saved
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [confirm, setConfirm] = useState(null);      // system awaiting opt-in confirmation
  // The UI5 Switch flips itself on click; declining the confirmation must
  // flip it back, which a remount (key) does reliably where a prop echo does not.
  const [switchNonce, setSwitchNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listTargetSystems(), listIdentifiedUsageAuditEvents(20)])
      .then(([rows, audit]) => {
        if (cancelled) return;
        setSystems(rows);
        setEvents(audit);
        setDrafts(Object.fromEntries(rows.map((s) => [s.ID, systemSettingsDraft(s)])));
        setError('');
      })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [reloadToken]);

  const setDraft = (system, patch) => {
    setDrafts((d) => ({ ...d, [system.ID]: { ...(d[system.ID] || systemSettingsDraft(system)), ...patch } }));
  };

  const declineIdentified = () => { setConfirm(null); setSwitchNonce((n) => n + 1); };

  const toggleIdentified = (system, checked) => {
    if (needsIdentifiedUsageConfirmation(system, checked)) { setConfirm(system); return; }
    setDraft(system, { identifiedUsageAllowed: checked });
  };

  const save = async (system) => {
    const patch = systemSettingsPatch(system, drafts[system.ID]);
    if (!patch) return;
    try {
      setSaving(system.ID);
      await updateTargetSystem(system.ID, patch);
      const parts = [];
      if (patch.identifiedUsageAllowed !== undefined) parts.push(`usage mode ${usageModeLabel(patch.identifiedUsageAllowed).toLowerCase()} (audited)`);
      if (patch.activationRootPath !== undefined) parts.push(patch.activationRootPath ? 'activation root path set' : 'activation root path cleared');
      notify({ design: 'Positive', text: `${system.displayName}: ${parts.join(', ')}.` });
      setReloadToken((t) => t + 1);
    } catch (e) {
      setError(getServiceErrorMessage(e, 'The target system could not be updated.'));
    } finally {
      setSaving('');
    }
  };

  return (
    <div>
      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip>
      ) : null}

      {!systems ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '4vh' }} />
      ) : systems.length === 0 ? (
        <Text style={{ display: 'block', marginTop: 'var(--adops-space-md)' }}>
          No target systems registered yet. Register one on the Target Systems page first.
        </Text>
      ) : (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <Table
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell><span>System</span></TableHeaderCell>
                <TableHeaderCell><span>Environment</span></TableHeaderCell>
                <TableHeaderCell><span>Usage mode</span></TableHeaderCell>
                <TableHeaderCell><span>Identified usage</span></TableHeaderCell>
                <TableHeaderCell><span>Activation root path</span></TableHeaderCell>
                <TableHeaderCell><span></span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {systems.map((s) => {
              const draft = drafts[s.ID] || systemSettingsDraft(s);
              const patch = systemSettingsPatch(s, draft);
              return (
                <TableRow key={s.ID}>
                  <TableCell>
                    <span style={{ fontWeight: 600 }}>{s.displayName}</span>
                    {s.systemId ? <span style={{ marginLeft: 'var(--adops-space-xs)', color: 'var(--sapNeutralTextColor, #6a6d70)' }}>{s.systemId}{s.client ? `/${s.client}` : ''}</span> : null}
                  </TableCell>
                  <TableCell><span>{s.environment || '—'}</span></TableCell>
                  <TableCell>
                    <Tag design={s.identifiedUsageAllowed ? 'Critical' : 'Positive'}>{usageModeLabel(s.identifiedUsageAllowed)}</Tag>
                  </TableCell>
                  <TableCell>
                    <Switch
                      key={`${s.ID}:${switchNonce}`}
                      checked={draft.identifiedUsageAllowed}
                      accessibleName={`Identified usage for ${s.displayName}`}
                      disabled={saving === s.ID}
                      onChange={(e) => toggleIdentified(s, Boolean(e.target.checked))}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={draft.activationRootPath}
                      placeholder="ZADO default"
                      accessibleName={`Activation root path for ${s.displayName}`}
                      disabled={saving === s.ID}
                      style={{ width: '18rem' }}
                      onInput={(e) => setDraft(s, { activationRootPath: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Button design="Emphasized" disabled={!patch || saving === s.ID} onClick={() => save(s)}>Save</Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </Table>
        </div>
      )}

      <Panel headerText={`Recent identified-usage changes${events ? ` (${events.length})` : ''}`} style={{ marginTop: 'var(--adops-space-md)' }}>
        {!events ? (
          <BusyIndicator active delay={200} style={{ display: 'block' }} />
        ) : events.length === 0 ? (
          <Text>No identified-usage change has been recorded yet. Every toggle lands in the audit chain.</Text>
        ) : (
          <Table
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell><span>When</span></TableHeaderCell>
                <TableHeaderCell><span>System</span></TableHeaderCell>
                <TableHeaderCell><span>Change</span></TableHeaderCell>
                <TableHeaderCell><span>By</span></TableHeaderCell>
                <TableHeaderCell><span>Message</span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {events.map((ev) => (
              <TableRow key={ev.ID}>
                <TableCell><span>{formatTimestamp(ev.Timestamp || ev.createdAt)}</span></TableCell>
                <TableCell><span style={{ fontWeight: 600 }}>{ev.ObjectName}{ev.TargetSystem ? ` (${ev.TargetSystem})` : ''}</span></TableCell>
                <TableCell><Tag design={ev.AfterValue === 'IDENTIFIED' ? 'Critical' : 'Positive'}>{auditChangeLabel(ev)}</Tag></TableCell>
                <TableCell><span>{ev.UserId || '—'}</span></TableCell>
                <TableCell><span>{ev.Message}</span></TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </Panel>

      <Dialog open={Boolean(confirm)} headerText="Enable identified usage" onClose={declineIdentified}>
        {confirm ? (
          <div style={{ padding: 'var(--adops-space-sm)', minWidth: '24rem', maxWidth: '32rem' }}>
            <Text>
              Usage extracted from {confirm.displayName} will carry real SAP user IDs instead of pseudonyms.
              The change is written to the audit chain with your user ID; it can be reverted later.
            </Text>
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={declineIdentified}>Keep pseudonymised</Button>
          <Button design="Emphasized" onClick={() => { setDraft(confirm, { identifiedUsageAllowed: true }); setConfirm(null); }}>Enable</Button>
        </div>
      </Dialog>
    </div>
  );
}

// --- Telemetry tab -------------------------------------------------------------

function TelemetrySettings({ notify }) {
  const [original, setOriginal] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTelemetrySettings()
      .then((result) => {
        if (cancelled) return;
        const next = telemetryFormFrom(result);
        setOriginal(next);
        setForm(next);
        setError('');
      })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e, 'Telemetry settings could not be read.')); });
    return () => { cancelled = true; };
  }, []);

  const errors = form ? validateTelemetryForm(form) : {};
  const dirty = telemetryChanged(form, original);
  const valid = Object.keys(errors).length === 0;

  const save = async () => {
    if (!dirty || !valid) return;
    try {
      setSaving(true);
      const result = await updateTelemetrySettings(telemetryPayload(form));
      const next = telemetryFormFrom(result);
      setOriginal(next);
      setForm(next);
      notify({ design: 'Positive', text: 'Telemetry settings saved.' });
    } catch (e) {
      setError(getServiceErrorMessage(e, 'Telemetry settings could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const field = (f) => {
    const value = form[f.key];
    const message = errors[f.key];
    if (f.kind === 'boolean') {
      return (
        <Switch checked={Boolean(value)} accessibleName={f.label} disabled={saving} onChange={(e) => setForm({ ...form, [f.key]: Boolean(e.target.checked) })} />
      );
    }
    if (f.kind === 'mode') {
      return (
        <Select accessibleName={f.label} disabled={saving} valueState={message ? 'Negative' : 'None'} onChange={(e) => setForm({ ...form, [f.key]: e.detail.selectedOption.dataset.value })}>
          {IDENTIFICATION_MODES.map((mode) => (
            <Option key={mode.id} data-value={mode.id} selected={value === mode.id}>{mode.label}</Option>
          ))}
        </Select>
      );
    }
    return (
      <Input
        type="Number"
        value={value}
        accessibleName={f.label}
        disabled={saving}
        valueState={message ? 'Negative' : 'None'}
        valueStateMessage={message ? <span>{message}</span> : undefined}
        style={{ width: '10rem' }}
        onInput={(e) => setForm({ ...form, [f.key]: e.target.value })}
      />
    );
  };

  return (
    <div>
      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip>
      ) : null}
      {!form ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '4vh' }} />
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--adops-space-xs)', marginTop: 'var(--adops-space-md)' }}>
            <Button design="Transparent" disabled={!dirty || saving} onClick={() => setForm(original)}>Discard changes</Button>
            <Button design="Emphasized" disabled={!dirty || !valid || saving} onClick={save}>Save</Button>
          </div>
          {TELEMETRY_GROUPS.map((group) => (
            <Panel key={group} headerText={group} style={{ marginTop: 'var(--adops-space-sm)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(14rem, 22rem) auto', rowGap: 'var(--adops-space-sm)', columnGap: 'var(--adops-space-md)', alignItems: 'center' }}>
                {TELEMETRY_FIELDS.filter((f) => f.group === group).map((f) => (
                  <div key={f.key} style={{ display: 'contents' }}>
                    <Label>{f.label}</Label>
                    <div>{field(f)}</div>
                  </div>
                ))}
              </div>
            </Panel>
          ))}
        </>
      )}
    </div>
  );
}

// --- Page ------------------------------------------------------------------

export function SettingsPage() {
  const { view } = useParams();
  const navigate = useNavigate();
  const [userInfo, setUserInfo] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loadError, setLoadError] = useState('');
  const activeTabId = resolveSettingsView(view);

  useEffect(() => {
    let cancelled = false;
    fetchUserInfo()
      .then((info) => { if (!cancelled) setUserInfo(info); })
      .catch((e) => { if (!cancelled) setLoadError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, []);

  const admin = hasAdminAccess(userInfo);

  if (userInfo && !admin) {
    return (
      <div>
        <Title level="H2">Settings</Title>
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <RestrictedState
            area="settings"
            title="Administrator access required"
            text="Target-system privacy settings and telemetry configuration are available to AdoptOps administrators only."
            userInfo={userInfo}
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <Title level="H2">Settings</Title>
      {loadError ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setLoadError('')}>{loadError}</MessageStrip>
      ) : null}
      {notice ? (
        <MessageStrip design={notice.design} style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setNotice(null)}>{notice.text}</MessageStrip>
      ) : null}
      <div style={{ marginTop: 'var(--adops-space-md)' }}>
        <AdopsPageTabs
          tabs={SETTINGS_VIEWS}
          activeTabId={activeTabId}
          ariaLabel="Settings sections"
          onSelect={(id) => navigate(getSettingsViewPath(id))}
        />
      </div>
      {!userInfo ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '4vh' }} />
      ) : activeTabId === 'telemetry' ? (
        <TelemetrySettings notify={setNotice} />
      ) : (
        <TargetSystemsSettings notify={setNotice} />
      )}
    </div>
  );
}

export default SettingsPage;
