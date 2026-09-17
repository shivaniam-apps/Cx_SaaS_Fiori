import { useEffect, useRef, useState } from 'react';
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
import { Label } from '@ui5/webcomponents-react/Label';
import { Input } from '@ui5/webcomponents-react/Input';
import { ProgressIndicator } from '@ui5/webcomponents-react/ProgressIndicator';
import { fetchUserInfo } from '../services/coreService.js';
import { hasActivatorAccess } from '../features/auth/memberAccess.js';
import {
  listTargetSystems,
  queryAdoptionWaves,
  queryActivationPlans,
  readActivationPlan,
  createActivationPlan,
  simulateActivationPlan,
  executeActivationPlan,
  readActivationStepMessages,
  readActivationManifest,
  getServiceErrorMessage
} from '../services/fioriService.js';
import useRunPolling from '../hooks/useRunPolling.js';
import { trackUsage } from '../services/telemetryService.js';
import Kpi from '../components/Kpi.jsx';
import {
  PLAN_STATUS_DESIGN,
  STEP_STATUS_DESIGN,
  groupSteps,
  canExecutePlan,
  executeActionLabel,
  simulationLabel,
  isActivationTargetAllowed,
  defaultActivationTarget
} from '../features/waves/waveModel.js';
import {
  RUN_STATUS_DESIGN,
  isRunActive,
  progressLabel,
  formatTimestamp,
  shouldRefetchStepMessages
} from '../features/activation-runs/runModel.js';
import {
  canSimulatePlan,
  runRowLabel,
  simulateActionLabel,
  canShowManifest,
  activeRun,
  latestRun,
  hasActiveRun,
  wavesEligibleForPlan,
  defaultPlanName,
  planPhaseLabel,
  planStripDesign,
  summaryCards
} from '../features/activation-plans/planModel.js';

const POLL_KEY_SEPARATOR = '|';

function Meta({ label, value }) {
  return (
    <div style={{ minWidth: '9rem' }}>
      <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)', fontSize: '0.8rem' }}>{label}</Text>
      <br />
      <Text>{value || '—'}</Text>
    </div>
  );
}

function systemOptionLabel(s) {
  return `${s.displayName}${s.environment ? ` (${s.environment})` : ''}${s.client ? ` · client ${s.client}` : ''}`;
}

export function ActivationPlansPage() {
  const { planId } = useParams();
  const navigate = useNavigate();
  const [userInfo, setUserInfo] = useState(null);
  const [systems, setSystems] = useState([]);
  const [list, setList] = useState(null);           // { Items, Summary }
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);       // { design, text }
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [detailReload, setDetailReload] = useState(0);
  const [stepMessages, setStepMessages] = useState(null); // { step, Messages }
  const [manifest, setManifest] = useState(null);         // { planName, Markdown }
  const [creating, setCreating] = useState(null);         // { waves, waveId, name, targetSystemId }

  // Filter bar contract: the Select edits a DRAFT, Go commits it, Clear
  // resets and applies, Refresh re-reads at unchanged scope.
  const [draftSystemId, setDraftSystemId] = useState('');
  const [appliedSystemId, setAppliedSystemId] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchUserInfo(), listTargetSystems()])
      .then(([info, targetSystems]) => { if (!cancelled) { setUserInfo(info); setSystems(targetSystems); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    queryActivationPlans(appliedSystemId || undefined)
      .then((result) => { if (!cancelled) { setList(result); setError(''); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [appliedSystemId, reloadToken]);

  // ONE poll drives the detail: readActivationPlan returns plan, steps,
  // labels and the plan's recent runs together; the hook stops itself once
  // no run is active. The key carries a reload counter so Simulate/Execute/
  // Refresh can force a re-read of a plan the hook already considers idle.
  const pollKey = planId ? `${planId}${POLL_KEY_SEPARATOR}${detailReload}` : null;
  const detail = useRunPolling({
    id: pollKey,
    fetchStatus: (key) => readActivationPlan(String(key).split(POLL_KEY_SEPARATOR)[0]),
    isTerminal: (payload) => !hasActiveRun(payload)
  });
  const plan = detail.status?.Plan || null;
  const steps = detail.status?.Steps || [];
  const runs = detail.status?.Runs || [];
  const targetSystem = detail.status?.TargetSystem || null;
  const wave = detail.status?.Wave || null;
  const transport = detail.status?.Transport || null;
  const running = activeRun(runs);
  const newestRun = latestRun(runs);

  // When a watched run goes active -> idle, the list row changed too.
  const activeSeenRef = useRef(false);
  useEffect(() => { activeSeenRef.current = false; setStepMessages(null); }, [pollKey]);
  useEffect(() => {
    if (!detail.status) return;
    if (running) { activeSeenRef.current = true; return; }
    if (activeSeenRef.current) {
      activeSeenRef.current = false;
      setReloadToken((t) => t + 1);
    }
  }, [detail.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Step messages: fetched on row click, re-fetched only while that step is
  // RUNNING (plus once when it leaves RUNNING) - monitor read discipline.
  useEffect(() => {
    if (!stepMessages) return undefined;
    const current = steps.find((s) => s.ID === stepMessages.step.ID);
    if (!shouldRefetchStepMessages(stepMessages.step, current)) return undefined;
    let cancelled = false;
    readActivationStepMessages(current.ID)
      .then((result) => { if (!cancelled) setStepMessages({ step: current, Messages: result.Messages || [] }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [detail.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshAll = () => {
    setReloadToken((t) => t + 1);
    if (planId) setDetailReload((d) => d + 1);
  };

  const openStepMessages = async (step) => {
    if (stepMessages?.step?.ID === step.ID) { setStepMessages(null); return; }
    try {
      const result = await readActivationStepMessages(step.ID);
      setStepMessages({ step, Messages: result.Messages || [] });
    } catch (e) {
      setError(getServiceErrorMessage(e));
    }
  };

  // Create: the wave picker lists only waves with approved proposals; the
  // target preset follows the wave's system when it is a permissible write
  // target (source != target rule, waveModel.defaultActivationTarget).
  const openCreateDialog = async () => {
    try {
      setBusy(true);
      const result = await queryAdoptionWaves();
      const waves = wavesEligibleForPlan(result.Items);
      const first = waves[0] || null;
      setCreating({
        waves,
        waveId: first?.ID || '',
        name: '',
        targetSystemId: defaultActivationTarget(systems, first?.targetSystem_ID)?.ID || ''
      });
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const pickWave = (waveId) => {
    const picked = creating.waves.find((w) => w.ID === waveId) || null;
    setCreating({
      ...creating,
      waveId,
      targetSystemId: defaultActivationTarget(systems, picked?.targetSystem_ID)?.ID || creating.targetSystemId
    });
  };

  const submitCreate = async () => {
    if (!creating?.waveId || !creating?.targetSystemId) return;
    try {
      setBusy(true);
      const result = await createActivationPlan(creating.waveId, creating.name.trim() || null, creating.targetSystemId);
      setCreating(null);
      setNotice({ design: 'Positive', text: `Plan "${result.Plan?.Name}" created with ${result.Plan?.StepCount ?? 0} steps - simulate it to get the blast-radius verdicts.` });
      trackUsage('PLAN_CREATED', { eventCategory: 'ACTIVATION', action: 'create', outcome: 'OK', targetSystem: result.TargetSystem?.displayName });
      setReloadToken((t) => t + 1);
      navigate(`/activation/${result.Plan.ID}`);
    } catch (e) {
      setError(getServiceErrorMessage(e));
      setCreating(null);
    } finally {
      setBusy(false);
    }
  };

  const simulate = async () => {
    if (!canSimulatePlan(plan)) return;
    try {
      setBusy(true);
      const result = await simulateActivationPlan(plan.ID);
      const verdict = simulationLabel(result.Plan);
      setNotice({ design: result.Plan?.FailedCount ? 'Critical' : 'Positive', text: `Simulation of "${result.Plan?.Name}" finished${verdict ? `: ${verdict}` : ''}.` });
      trackUsage('PLAN_SIMULATED', { eventCategory: 'ACTIVATION', action: 'simulate', outcome: result.Plan?.FailedCount ? 'BLOCKED' : 'OK', targetSystem: result.TargetSystem?.displayName });
      setDetailReload((d) => d + 1);
      setReloadToken((t) => t + 1);
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!canExecutePlan(plan) || running) return;
    try {
      setBusy(true);
      const handle = await executeActivationPlan(plan.ID);
      const resumed = executeActionLabel(plan) === 'Resume';
      setNotice({
        design: 'Information',
        text: resumed
          ? `Resume requested for "${plan.Name}" - completed steps are skipped, the run continues where it stopped.`
          : `Execution of "${plan.Name}" queued (run ${String(handle.taskId).slice(0, 8)}) - steps update here while it runs.`
      });
      trackUsage(resumed ? 'PLAN_RESUMED' : 'PLAN_EXECUTED', { eventCategory: 'ACTIVATION', action: 'execute', outcome: 'QUEUED', targetSystem: targetSystem?.displayName });
      setDetailReload((d) => d + 1);
      setReloadToken((t) => t + 1);
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // The QA/PROD replay runbook: fetched on demand, shown as markdown text
  // with a file download for handing to a basis admin.
  const openManifest = async () => {
    if (!canShowManifest(plan)) return;
    try {
      const result = await readActivationManifest(plan.ID);
      setManifest({ planName: plan.Name, Markdown: result.Markdown });
    } catch (e) {
      setError(getServiceErrorMessage(e));
    }
  };

  const downloadManifest = () => {
    const blob = new Blob([manifest.Markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `replay-manifest-${manifest.planName.replace(/[^A-Za-z0-9-]+/g, '_')}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const activator = hasActivatorAccess(userInfo);
  const items = list?.Items || null;
  const cards = summaryCards(list?.Summary);
  const creatingWave = creating?.waves.find((w) => w.ID === creating.waveId) || null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
        <Title level="H2">Activation Plans</Title>
        <span style={{ display: 'inline-flex', gap: 'var(--adops-space-xs)', flexWrap: 'wrap' }}>
          {activator ? (
            <Button design="Emphasized" icon="add" disabled={busy} onClick={openCreateDialog}>New Plan</Button>
          ) : null}
          <Button design="Transparent" icon="refresh" onClick={refreshAll}>Refresh</Button>
        </span>
      </div>

      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip>
      ) : null}
      {notice ? (
        <MessageStrip design={notice.design} style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setNotice(null)}>{notice.text}</MessageStrip>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
        <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '16rem' }}>
          <Label>Target system</Label>
          <Select onChange={(e) => setDraftSystemId(e.detail.selectedOption.dataset.value || '')}>
            <Option data-value="" selected={draftSystemId === ''}>All target systems</Option>
            {systems.map((s) => (
              <Option key={s.ID} data-value={s.ID} selected={draftSystemId === s.ID}>
                {s.displayName}{s.environment ? ` (${s.environment})` : ''}
              </Option>
            ))}
          </Select>
        </div>
        <Button design="Emphasized" onClick={() => setAppliedSystemId(draftSystemId)}>Go</Button>
        <Button design="Transparent" onClick={() => { setDraftSystemId(''); setAppliedSystemId(''); }}>Clear</Button>
      </div>

      {list ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)' }}>
          <Kpi label="Plans" value={Number(list.Summary?.Total || 0).toLocaleString()} />
          {cards.map((card) => <Kpi key={card.key} label={card.label} value={Number(card.value).toLocaleString()} />)}
        </div>
      ) : null}

      {!items ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : items.length === 0 ? (
        <IllustratedMessage
          name="NoData"
          titleText={appliedSystemId ? 'No activation plans for this target system' : 'No activation plans yet'}
          subtitleText="Create a plan from an adoption wave with approved proposals, then simulate and execute it here."
        />
      ) : (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <Table
            headerRow={
              <TableHeaderRow sticky>
                <TableHeaderCell><span>Created</span></TableHeaderCell>
                <TableHeaderCell><span>Plan</span></TableHeaderCell>
                <TableHeaderCell><span>Wave</span></TableHeaderCell>
                <TableHeaderCell><span>Target</span></TableHeaderCell>
                <TableHeaderCell><span>Status</span></TableHeaderCell>
                <TableHeaderCell><span>Steps</span></TableHeaderCell>
                <TableHeaderCell><span>Simulation</span></TableHeaderCell>
                <TableHeaderCell><span>Last run</span></TableHeaderCell>
                <TableHeaderCell><span>Transport</span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {items.map((row) => (
              <TableRow key={row.ID} interactive onClick={() => navigate(`/activation/${row.ID}`)}>
                <TableCell><span>{formatTimestamp(row.CreatedAt) || '—'}</span></TableCell>
                <TableCell><span style={{ fontWeight: row.ID === planId ? 700 : 600 }}>{row.Name}</span></TableCell>
                <TableCell><span>{row.WaveName || '(wave removed)'}</span></TableCell>
                <TableCell><span>{row.TargetSystemName || '—'}</span></TableCell>
                <TableCell><Tag design={PLAN_STATUS_DESIGN[row.Status] || 'Neutral'}>{row.Status}</Tag></TableCell>
                <TableCell><span>{row.StepCount}</span></TableCell>
                <TableCell><span>{simulationLabel(row) || '—'}</span></TableCell>
                <TableCell>
                  {row.LastRunId ? (
                    <Tag design={RUN_STATUS_DESIGN[row.LastRunStatus] || 'Neutral'}>{row.LastRunStatus}</Tag>
                  ) : <span>—</span>}
                </TableCell>
                <TableCell><span>{row.TransportRequestId || '—'}</span></TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      )}

      {planId ? (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          {!detail.status && !detail.error ? <BusyIndicator active delay={100} style={{ display: 'block' }} /> : null}
          {detail.error && !detail.status ? (
            <MessageStrip design="Negative" hideCloseButton>{getServiceErrorMessage(detail.error, 'The plan could not be read.')}</MessageStrip>
          ) : null}

          {plan ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--adops-space-sm)', flexWrap: 'wrap' }}>
                  <Title level="H3">{plan.Name}</Title>
                  <Tag design={PLAN_STATUS_DESIGN[plan.Status] || 'Neutral'}>{plan.Status}</Tag>
                  {running ? <Tag design={RUN_STATUS_DESIGN[running.Status] || 'Neutral'}>Run {running.Status}</Tag> : null}
                </span>
                <span style={{ display: 'inline-flex', gap: 'var(--adops-space-xs)', flexWrap: 'wrap' }}>
                  {wave ? (
                    <Button design="Transparent" icon="activities" onClick={() => navigate(`/waves/${wave.ID}`)}>Open wave</Button>
                  ) : null}
                  {newestRun ? (
                    <Button design="Transparent" icon="sys-monitor" onClick={() => navigate(`/activation-runs/${newestRun.ID}`)}>
                      {running ? 'Open active run' : 'Open last run'}
                    </Button>
                  ) : null}
                  {canShowManifest(plan) ? (
                    <Button design="Transparent" icon="checklist" disabled={busy} onClick={openManifest}>Manifest</Button>
                  ) : null}
                  {activator && canSimulatePlan(plan) ? (
                    <Button design={plan.Status === 'DRAFT' ? 'Emphasized' : 'Default'} icon="simulate" disabled={busy || Boolean(running)} onClick={simulate}>
                      {simulateActionLabel(plan)}
                    </Button>
                  ) : null}
                  {activator && canExecutePlan(plan) ? (
                    <Button design="Emphasized" icon="play" disabled={busy || Boolean(running)} onClick={execute}>
                      {executeActionLabel(plan)}
                    </Button>
                  ) : null}
                </span>
              </div>

              {running ? (
                <div style={{
                  marginTop: 'var(--adops-space-sm)', padding: 'var(--adops-card-padding)',
                  border: 'var(--adops-card-border)', borderRadius: 'var(--adops-card-radius)',
                  background: 'var(--adops-card-background)'
                }}>
                  <Label>{planPhaseLabel(plan, running)}{detail.isStale ? ' (connection lost — showing last known state)' : ''}</Label>
                  <ProgressIndicator
                    value={running.ProgressPercent || 0}
                    displayValue={progressLabel(running) || `${running.ProgressPercent || 0}%`}
                    style={{ marginTop: 'var(--adops-space-xs)' }}
                  />
                </div>
              ) : (
                <MessageStrip design={planStripDesign(plan, null)} hideCloseButton style={{ marginTop: 'var(--adops-space-sm)' }}>
                  {planPhaseLabel(plan, null)}
                </MessageStrip>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-md)', marginTop: 'var(--adops-space-sm)' }}>
                <Meta label="Target system (write)" value={targetSystem ? systemOptionLabel(targetSystem) : ''} />
                <Meta label="Wave" value={wave?.Name} />
                <Meta label="Created" value={`${formatTimestamp(plan.createdAt)}${plan.createdBy ? ` · ${plan.createdBy}` : ''}`.trim()} />
                <Meta label="Simulated" value={plan.SimulatedAt ? `${formatTimestamp(plan.SimulatedAt)}${plan.SimulatedBy ? ` · ${plan.SimulatedBy}` : ''}` : ''} />
                <Meta label="Executed" value={plan.ExecutedAt ? `${formatTimestamp(plan.ExecutedAt)}${plan.ExecutedBy ? ` · ${plan.ExecutedBy}` : ''}` : ''} />
                <Meta label="Transport" value={transport ? `${transport.TransportRequestId}${transport.Status ? ` (${transport.Status})` : ''}` : ''} />
                <Meta label="Space" value={plan.SpaceId} />
                <Meta label="Role pattern" value={plan.RoleNamePattern} />
              </div>
              {plan.Description ? (
                <Text style={{ display: 'block', marginTop: 'var(--adops-space-xs)', color: 'var(--sapNeutralTextColor, #6a6d70)' }}>{plan.Description}</Text>
              ) : null}

              <Panel headerText={`Steps${plan.StepCount ? ` (${plan.StepCount})` : ''}`} style={{ marginTop: 'var(--adops-space-md)' }}>
                {steps.length === 0 ? (
                  <Text>This plan has no steps.</Text>
                ) : groupSteps(steps).map(({ group, steps: groupRows }) => (
                  <div key={group} style={{ marginBottom: 'var(--adops-space-sm)' }}>
                    <Label style={{ fontWeight: 700 }}>{group}</Label>
                    <Table
                      headerRow={
                        <TableHeaderRow>
                          <TableHeaderCell><span>#</span></TableHeaderCell>
                          <TableHeaderCell><span>Step</span></TableHeaderCell>
                          <TableHeaderCell><span>Object</span></TableHeaderCell>
                          <TableHeaderCell><span>Scope</span></TableHeaderCell>
                          <TableHeaderCell><span>Status</span></TableHeaderCell>
                          <TableHeaderCell><span>Simulation message</span></TableHeaderCell>
                        </TableHeaderRow>
                      }
                    >
                      {groupRows.map((s) => (
                        <TableRow key={s.ID} interactive onClick={() => openStepMessages(s)}>
                          <TableCell><span>{s.SequenceNo}</span></TableCell>
                          <TableCell><span>{s.StepType}</span></TableCell>
                          <TableCell><span style={{ fontWeight: 600 }}>{s.ObjectName}</span></TableCell>
                          <TableCell><span>{s.Transportable ? 'Transport' : 'Per system'}</span></TableCell>
                          <TableCell>
                            <Tag design={STEP_STATUS_DESIGN[s.Status] || 'Neutral'}>
                              {s.Status}{s.ExistsAlready ? ' · EXISTS' : ''}
                            </Tag>
                          </TableCell>
                          <TableCell><span>{s.SimulationMessage || ''}</span></TableCell>
                        </TableRow>
                      ))}
                    </Table>
                  </div>
                ))}
                {stepMessages ? (
                  <MessageStrip design="Information" onClose={() => setStepMessages(null)} style={{ marginTop: 'var(--adops-space-xs)' }}>
                    Step {stepMessages.step.SequenceNo} {stepMessages.step.StepType} {stepMessages.step.ObjectName}:{' '}
                    {stepMessages.Messages.length
                      ? stepMessages.Messages.map((m) => `[${m.MessageType}] ${m.MessageText}`).join(' · ')
                      : 'No execution messages yet - the step has not run.'}
                  </MessageStrip>
                ) : null}
              </Panel>

              <Panel headerText={`Runs (${runs.length})`} collapsed={runs.length === 0} style={{ marginTop: 'var(--adops-space-md)' }}>
                {runs.length === 0 ? (
                  <Text>No runs yet. Execute the simulated plan to start the first run.</Text>
                ) : (
                  <Table
                    headerRow={
                      <TableHeaderRow>
                        <TableHeaderCell><span>Queued</span></TableHeaderCell>
                        <TableHeaderCell><span>Run</span></TableHeaderCell>
                        <TableHeaderCell><span>Phase</span></TableHeaderCell>
                        <TableHeaderCell><span>Finished</span></TableHeaderCell>
                        <TableHeaderCell><span>Requested by</span></TableHeaderCell>
                      </TableHeaderRow>
                    }
                  >
                    {runs.map((r) => (
                      <TableRow key={r.ID} interactive onClick={() => navigate(`/activation-runs/${r.ID}`)}>
                        <TableCell><span>{formatTimestamp(r.QueuedAt) || '—'}</span></TableCell>
                        <TableCell>
                          <Tag design={RUN_STATUS_DESIGN[r.Status] || 'Neutral'}>{r.Status}</Tag>
                          {isRunActive(r) && progressLabel(r) ? <span style={{ marginLeft: 'var(--adops-space-xs)' }}>{progressLabel(r)}</span> : null}
                        </TableCell>
                        <TableCell><span>{runRowLabel(r)}</span></TableCell>
                        <TableCell><span>{formatTimestamp(r.CompletedAt) || '—'}</span></TableCell>
                        <TableCell><span>{r.RequestedBy || '—'}</span></TableCell>
                      </TableRow>
                    ))}
                  </Table>
                )}
              </Panel>
            </>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={Boolean(creating)}
        headerText="New Activation Plan"
        onClose={() => setCreating(null)}
      >
        {creating ? (
          <div style={{ display: 'grid', gap: 'var(--adops-space-sm)', padding: 'var(--adops-space-sm)', minWidth: '24rem' }}>
            {creating.waves.length === 0 ? (
              <Text>No adoption wave has approved proposals yet. Approve apps in a wave before planning activation.</Text>
            ) : (
              <>
                <Text>
                  Derives activation steps from the wave's approved apps. The plan writes into the
                  selected development system; QA/PROD receive the content via transport.
                </Text>
                <Label required>Adoption wave</Label>
                <Select onChange={(e) => pickWave(e.detail.selectedOption.dataset.value)}>
                  {creating.waves.map((w) => (
                    <Option key={w.ID} data-value={w.ID} selected={creating.waveId === w.ID}>
                      {w.Name} · {w.Rollup.approved} approved
                    </Option>
                  ))}
                </Select>
                <Label>Plan name</Label>
                <Input
                  value={creating.name}
                  placeholder={defaultPlanName(creatingWave)}
                  onInput={(e) => setCreating({ ...creating, name: e.target.value })}
                />
                <Label required>Target system (write)</Label>
                <Select onChange={(e) => setCreating({ ...creating, targetSystemId: e.detail.selectedOption.dataset.value })}>
                  {systems.filter(isActivationTargetAllowed).map((s) => (
                    <Option key={s.ID} data-value={s.ID} selected={creating.targetSystemId === s.ID}>
                      {systemOptionLabel(s)}
                    </Option>
                  ))}
                </Select>
              </>
            )}
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setCreating(null)}>Cancel</Button>
          <Button design="Emphasized" disabled={busy || !creating?.waveId || !creating?.targetSystemId} onClick={submitCreate}>Create Plan</Button>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(manifest)}
        headerText={`Replay manifest — ${manifest?.planName || ''}`}
        onClose={() => setManifest(null)}
      >
        {manifest ? (
          <pre style={{
            margin: 0, padding: 'var(--adops-space-sm)', maxWidth: '46rem', maxHeight: '60vh',
            overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '0.8rem',
            fontFamily: 'var(--sapFontFamily-monospaced, monospace)'
          }}>
            {manifest.Markdown}
          </pre>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setManifest(null)}>Close</Button>
          <Button design="Emphasized" icon="download" onClick={downloadManifest}>Download .md</Button>
        </div>
      </Dialog>
    </div>
  );
}

export default ActivationPlansPage;
