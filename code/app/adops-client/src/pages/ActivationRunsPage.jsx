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
  queryActivationRuns,
  readActivationRun,
  executeActivationPlan,
  cancelTask,
  readActivationStepMessages,
  skipActivationStep,
  rollbackActivationStep,
  getServiceErrorMessage
} from '../services/fioriService.js';
import useRunPolling from '../hooks/useRunPolling.js';
import Kpi from '../components/Kpi.jsx';
import { PLAN_STATUS_DESIGN, STEP_STATUS_DESIGN, groupSteps } from '../features/waves/waveModel.js';
import {
  RUN_STATUS_DESIGN,
  LOG_SEVERITY_DESIGN,
  isRunActive,
  runPhaseLabel,
  outcomeLabel,
  progressLabel,
  durationLabel,
  stepDurationLabel,
  formatTimestamp,
  canResumeRun,
  canCancelRun,
  summaryCards,
  shouldRefetchStepMessages,
  stepOperatorActions,
  operatorLabel
} from '../features/activation-runs/runModel.js';

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

export function ActivationRunsPage() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const [userInfo, setUserInfo] = useState(null);
  const [systems, setSystems] = useState([]);
  const [list, setList] = useState(null);           // { Items, Summary }
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);       // { design, text }
  const [stepAction, setStepAction] = useState(null); // { kind: 'skip' | 'rollback', step, auditOnly }
  const [stepReason, setStepReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [detailReload, setDetailReload] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [stepMessages, setStepMessages] = useState(null); // { step, Messages }

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
    queryActivationRuns(appliedSystemId || undefined)
      .then((result) => { if (!cancelled) { setList(result); setError(''); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [appliedSystemId, reloadToken]);

  // ONE poll drives the detail: readActivationRun returns task status, plan,
  // steps and task logs together; the hook stops itself once the run is
  // terminal. The key carries a reload counter so Refresh/Cancel can force a
  // re-read of a run the hook already considers finished.
  const pollKey = runId ? `${runId}${POLL_KEY_SEPARATOR}${detailReload}` : null;
  const detail = useRunPolling({
    id: pollKey,
    fetchStatus: (key) => readActivationRun(String(key).split(POLL_KEY_SEPARATOR)[0]),
    isTerminal: (payload) => !isRunActive(payload?.Run)
  });
  const run = detail.status?.Run || null;
  const steps = detail.status?.Steps || [];
  const logs = detail.status?.Logs || [];

  // When a watched run goes active -> terminal, the list row changed too.
  const activeSeenRef = useRef(false);
  useEffect(() => { activeSeenRef.current = false; setStepMessages(null); }, [pollKey]);
  useEffect(() => {
    if (!run) return;
    if (isRunActive(run)) { activeSeenRef.current = true; return; }
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

  const openStepMessages = async (step) => {
    if (stepMessages?.step?.ID === step.ID) { setStepMessages(null); return; }
    try {
      const result = await readActivationStepMessages(step.ID);
      setStepMessages({ step, Messages: result.Messages || [] });
    } catch (e) {
      setError(getServiceErrorMessage(e));
    }
  };

  const resume = async () => {
    if (!canResumeRun(run)) return;
    try {
      setBusy(true);
      const handle = await executeActivationPlan(run.PlanId);
      setNotice({ design: 'Information', text: `Resume requested for "${run.PlanName}" - completed steps are skipped, the run continues where it stopped.` });
      setReloadToken((t) => t + 1);
      navigate(`/activation-runs/${handle.taskId}`);
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!canCancelRun(run)) { setConfirmCancel(false); return; }
    try {
      setBusy(true);
      await cancelTask(run.ID);
      setNotice({ design: 'Information', text: `Cancel requested for "${run.PlanName}" - the run stops at the next step boundary; the step in flight completes.` });
      setDetailReload((d) => d + 1);
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setBusy(false);
      setConfirmCancel(false);
    }
  };

  // Operator decision on one step (confirmed in the dialog below). The
  // server applies the same predicate; the page re-reads the run afterwards.
  const runStepAction = async () => {
    if (!stepAction) return;
    const { kind, step } = stepAction;
    try {
      setBusy(true);
      const outcome = kind === 'skip'
        ? await skipActivationStep(step.ID, stepReason)
        : await rollbackActivationStep(step.ID, stepReason);
      const failed = outcome?.Result && !['SUCCESS', 'WARNING', 'SKIPPED'].includes(outcome.Result.status);
      const detail = (outcome?.Result?.messages || []).map((m) => m.message).join(' ');
      setNotice({
        design: failed ? 'Negative' : 'Information',
        text: failed
          ? `Rollback of step ${step.SequenceNo} failed: ${detail}`
          : `Step ${step.SequenceNo} ${step.StepType} ${step.ObjectName}: ${outcome?.OperatorAction === 'ROLLBACK_REQUESTED' ? 'rollback recorded (irreversible step)' : outcome?.StepStatus || 'updated'}. ${detail}`
      });
      setDetailReload((d) => d + 1);
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setBusy(false);
      setStepAction(null);
      setStepReason('');
    }
  };

  const activator = hasActivatorAccess(userInfo);
  const items = list?.Items || null;
  const cards = summaryCards(list?.Summary);
  const active = isRunActive(run);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
        <Title level="H2">Activation Runs</Title>
        <Button
          design="Transparent"
          icon="refresh"
          onClick={() => { setReloadToken((t) => t + 1); if (runId) setDetailReload((d) => d + 1); }}
        >
          Refresh
        </Button>
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
          <Kpi label="Runs" value={Number(list.Summary?.Total || 0).toLocaleString()} />
          {cards.map((card) => <Kpi key={card.key} label={card.label} value={Number(card.value).toLocaleString()} />)}
        </div>
      ) : null}

      {!items ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : items.length === 0 ? (
        <IllustratedMessage
          name="NoData"
          titleText={appliedSystemId ? 'No activation runs for this target system' : 'No activation runs yet'}
          subtitleText="Execute a simulated activation plan from its adoption wave to start the first run."
        />
      ) : (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <Table
            headerRow={
              <TableHeaderRow sticky>
                <TableHeaderCell><span>Started</span></TableHeaderCell>
                <TableHeaderCell><span>Plan</span></TableHeaderCell>
                <TableHeaderCell><span>Wave</span></TableHeaderCell>
                <TableHeaderCell><span>System</span></TableHeaderCell>
                <TableHeaderCell><span>Run</span></TableHeaderCell>
                <TableHeaderCell><span>Outcome</span></TableHeaderCell>
                <TableHeaderCell><span>Duration</span></TableHeaderCell>
                <TableHeaderCell><span>Requested by</span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {items.map((row) => (
              <TableRow key={row.ID} interactive onClick={() => navigate(`/activation-runs/${row.ID}`)}>
                <TableCell><span>{formatTimestamp(row.QueuedAt) || '—'}</span></TableCell>
                <TableCell><span style={{ fontWeight: row.ID === runId ? 700 : 600 }}>{row.PlanName || '(plan removed)'}</span></TableCell>
                <TableCell><span>{row.WaveName || '—'}</span></TableCell>
                <TableCell><span>{row.TargetSystemName || '—'}</span></TableCell>
                <TableCell>
                  <Tag design={RUN_STATUS_DESIGN[row.Status] || 'Neutral'}>{row.Status}</Tag>
                  {isRunActive(row) && progressLabel(row) ? <span style={{ marginLeft: 'var(--adops-space-xs)' }}>{progressLabel(row)}</span> : null}
                </TableCell>
                <TableCell><span>{outcomeLabel(row)}</span></TableCell>
                <TableCell><span>{durationLabel(row.DurationMs)}</span></TableCell>
                <TableCell><span>{row.RequestedBy || '—'}</span></TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      )}

      {runId ? (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          {!detail.status && !detail.error ? <BusyIndicator active delay={100} style={{ display: 'block' }} /> : null}
          {detail.error && !detail.status ? (
            <MessageStrip design="Negative" hideCloseButton>{getServiceErrorMessage(detail.error, 'The run could not be read.')}</MessageStrip>
          ) : null}

          {run ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--adops-space-sm)', flexWrap: 'wrap' }}>
                  <Title level="H3">{run.PlanName || 'Activation run'}</Title>
                  <Tag design={RUN_STATUS_DESIGN[run.Status] || 'Neutral'}>{run.Status}</Tag>
                  {run.PlanStatus ? <Tag design={PLAN_STATUS_DESIGN[run.PlanStatus] || 'Neutral'}>Plan {run.PlanStatus}</Tag> : null}
                </span>
                <span style={{ display: 'inline-flex', gap: 'var(--adops-space-xs)', flexWrap: 'wrap' }}>
                  {run.WaveId ? (
                    <Button design="Transparent" icon="activities" onClick={() => navigate(`/waves/${run.WaveId}`)}>Open wave</Button>
                  ) : null}
                  {activator && canCancelRun(run) ? (
                    <Button design="Negative" icon="stop" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel run</Button>
                  ) : null}
                  {activator && canResumeRun(run) ? (
                    <Button design="Emphasized" icon="restart" disabled={busy} onClick={resume}>Resume</Button>
                  ) : null}
                </span>
              </div>

              {active ? (
                <div style={{
                  marginTop: 'var(--adops-space-sm)', padding: 'var(--adops-card-padding)',
                  border: 'var(--adops-card-border)', borderRadius: 'var(--adops-card-radius)',
                  background: 'var(--adops-card-background)'
                }}>
                  <Label>{runPhaseLabel(run)}{detail.isStale ? ' (connection lost — showing last known state)' : ''}</Label>
                  <ProgressIndicator
                    value={run.ProgressPercent || 0}
                    displayValue={progressLabel(run) || `${run.ProgressPercent || 0}%`}
                    style={{ marginTop: 'var(--adops-space-xs)' }}
                  />
                </div>
              ) : run.ErrorText ? (
                <MessageStrip design="Negative" hideCloseButton style={{ marginTop: 'var(--adops-space-sm)' }}>{run.ErrorText}</MessageStrip>
              ) : (
                <MessageStrip
                  design={run.Outcome?.FailedCount ? 'Critical' : run.Status === 'SUCCEEDED' ? 'Positive' : 'Information'}
                  hideCloseButton
                  style={{ marginTop: 'var(--adops-space-sm)' }}
                >
                  {runPhaseLabel(run) || run.Status}{run.Outcome ? ` · ${outcomeLabel(run)}` : ''}
                </MessageStrip>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-md)', marginTop: 'var(--adops-space-sm)' }}>
                <Meta label="Target system" value={run.TargetSystemName} />
                <Meta label="Wave" value={run.WaveName} />
                <Meta label="Requested by" value={run.RequestedBy} />
                <Meta label="Queued" value={formatTimestamp(run.QueuedAt)} />
                <Meta label="Started" value={formatTimestamp(run.ClaimedAt)} />
                <Meta label="Finished" value={formatTimestamp(run.CompletedAt)} />
                <Meta label="Duration" value={durationLabel(run.DurationMs)} />
                <Meta label="Transport" value={run.TransportRequestId} />
                <Meta label="Attempt" value={run.AttemptCount ? String(run.AttemptCount) : ''} />
              </div>

              <Panel headerText={`Steps${run.StepCount ? ` (${run.StepCount})` : ''}`} style={{ marginTop: 'var(--adops-space-md)' }}>
                {steps.length === 0 ? (
                  <Text>The plan behind this run is no longer available.</Text>
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
                          <TableHeaderCell><span>Completed</span></TableHeaderCell>
                          <TableHeaderCell><span>Duration</span></TableHeaderCell>
                          {activator ? <TableHeaderCell><span>Actions</span></TableHeaderCell> : null}
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
                              {s.Status}{s.ExistsAlready ? ' · EXISTS' : ''}{operatorLabel(s) ? ` · ${operatorLabel(s)}` : ''}
                            </Tag>
                          </TableCell>
                          <TableCell><span>{formatTimestamp(s.CompletedAt) || '—'}</span></TableCell>
                          <TableCell><span>{stepDurationLabel(s)}</span></TableCell>
                          {activator ? (
                            <TableCell>
                              {(() => {
                                const actions = stepOperatorActions(s, run);
                                if (!actions.canSkip && !actions.canRollback) return <span>—</span>;
                                return (
                                  <div style={{ display: 'flex', gap: 'var(--adops-space-xs)' }} onClick={(e) => e.stopPropagation()}>
                                    {actions.canSkip ? (
                                      <Button design="Transparent" disabled={busy} onClick={() => setStepAction({ kind: 'skip', step: s, auditOnly: false })}>
                                        Skip
                                      </Button>
                                    ) : null}
                                    {actions.canRollback ? (
                                      <Button design="Transparent" disabled={busy} onClick={() => setStepAction({ kind: 'rollback', step: s, auditOnly: actions.rollbackAuditOnly })}>
                                        {actions.rollbackAuditOnly ? 'Record rollback' : 'Roll back'}
                                      </Button>
                                    ) : null}
                                  </div>
                                );
                              })()}
                            </TableCell>
                          ) : null}
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

              <Panel headerText={`Run log (${logs.length})`} collapsed={logs.length === 0} style={{ marginTop: 'var(--adops-space-md)' }}>
                {logs.length === 0 ? (
                  <Text>No log lines yet.</Text>
                ) : (
                  <Table
                    headerRow={
                      <TableHeaderRow>
                        <TableHeaderCell><span>Time</span></TableHeaderCell>
                        <TableHeaderCell><span>Severity</span></TableHeaderCell>
                        <TableHeaderCell><span>Phase</span></TableHeaderCell>
                        <TableHeaderCell><span>Message</span></TableHeaderCell>
                      </TableHeaderRow>
                    }
                  >
                    {logs.map((line) => (
                      <TableRow key={line.ID}>
                        <TableCell><span>{formatTimestamp(line.LoggedAt)}</span></TableCell>
                        <TableCell><Tag design={LOG_SEVERITY_DESIGN[line.Severity] || 'Neutral'}>{line.Severity}</Tag></TableCell>
                        <TableCell><span>{line.Phase || ''}</span></TableCell>
                        <TableCell><span>{line.Message}</span></TableCell>
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
        open={Boolean(stepAction)}
        headerText={stepAction?.kind === 'skip' ? 'Skip Step' : stepAction?.auditOnly ? 'Record Rollback' : 'Roll Back Step'}
        onClose={() => { setStepAction(null); setStepReason(''); }}
      >
        {stepAction ? (
          <div style={{ padding: 'var(--adops-space-sm)', minWidth: '24rem', display: 'flex', flexDirection: 'column', gap: 'var(--adops-space-sm)' }}>
            <Text>
              {stepAction.kind === 'skip'
                ? `Skip step ${stepAction.step.SequenceNo} ${stepAction.step.StepType} ${stepAction.step.ObjectName}? Nothing is written to ${run?.TargetSystemName || 'the target system'}; steps that depend on it run on the next resume as if it had succeeded.`
                : stepAction.auditOnly
                  ? `${stepAction.step.StepType} ${stepAction.step.ObjectName} is irreversible on this release. The rollback request is recorded in the audit trail; the object stays as executed.`
                  : `Roll back step ${stepAction.step.SequenceNo} ${stepAction.step.StepType} ${stepAction.step.ObjectName} on ${run?.TargetSystemName || 'the target system'}? The object is removed through the write unit and every step that depended on it is re-opened for the next resume.`}
            </Text>
            <Label for="adops-step-reason">Reason (recorded with the decision)</Label>
            <Input id="adops-step-reason" value={stepReason} onInput={(e) => setStepReason(e.target.value)} style={{ width: '100%' }} />
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => { setStepAction(null); setStepReason(''); }}>Cancel</Button>
          <Button design={stepAction?.kind === 'skip' ? 'Emphasized' : 'Negative'} disabled={busy} onClick={runStepAction}>
            {stepAction?.kind === 'skip' ? 'Skip step' : stepAction?.auditOnly ? 'Record' : 'Roll back'}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={confirmCancel}
        headerText="Cancel Activation Run"
        onClose={() => setConfirmCancel(false)}
      >
        {run ? (
          <div style={{ padding: 'var(--adops-space-sm)', minWidth: '22rem' }}>
            <Text>
              Stop the run of "{run.PlanName}" on {run.TargetSystemName || 'the target system'}? The run halts at the
              next step boundary - the step currently in flight completes and is never rolled back. Steps already
              written stay in the system; the plan can be resumed later.
            </Text>
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setConfirmCancel(false)}>Keep running</Button>
          <Button design="Negative" disabled={busy} onClick={cancel}>Cancel run</Button>
        </div>
      </Dialog>
    </div>
  );
}

export default ActivationRunsPage;
