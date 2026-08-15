import { useCallback, useEffect, useState } from 'react';
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
import { Input } from '@ui5/webcomponents-react/Input';
import { Select } from '@ui5/webcomponents-react/Select';
import { Option } from '@ui5/webcomponents-react/Option';
import { TextArea } from '@ui5/webcomponents-react/TextArea';
import { DatePicker } from '@ui5/webcomponents-react/DatePicker';
import { CheckBox } from '@ui5/webcomponents-react/CheckBox';
import { Label } from '@ui5/webcomponents-react/Label';
import { fetchUserInfo } from '../services/coreService.js';
import { hasApproverAccess, hasActivatorAccess } from '../features/auth/memberAccess.js';
import {
  listTargetSystems,
  queryAdoptionWaves,
  readAdoptionWave,
  createAdoptionWave,
  deleteAdoptionWave,
  createActivationPlan,
  simulateActivationPlan,
  readActivationPlan,
  executeActivationPlan,
  getTaskStatus,
  getServiceErrorMessage,
  TERMINAL_TASK_STATES
} from '../services/fioriService.js';
import useRunPolling from '../hooks/useRunPolling.js';
import {
  WAVE_STATUS_DESIGN,
  PLAN_STATUS_DESIGN,
  STEP_STATUS_DESIGN,
  canBuildPlan,
  canExecutePlan,
  executeActionLabel,
  membershipLabel,
  simulationLabel,
  groupSteps,
  isActivationTargetAllowed,
  defaultActivationTarget
} from '../features/waves/waveModel.js';

const PROPOSAL_STATUS_DESIGN = { NEW: 'Information', APPROVED: 'Positive', REJECTED: 'Negative', DEFERRED: 'Neutral' };

function Kpi({ label, value }) {
  return (
    <div style={{
      flex: '1 1 8rem', minWidth: '8rem', padding: 'var(--adops-card-padding)',
      border: 'var(--adops-card-border)', borderRadius: 'var(--adops-card-radius)',
      background: 'var(--adops-card-background)'
    }}>
      <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)', fontSize: '0.8rem' }}>{label}</Text>
      <br />
      <Text style={{ fontSize: '1.4rem', fontWeight: 700 }}>{value}</Text>
    </div>
  );
}

export function AdoptionWavesPage() {
  const { waveId } = useParams();
  const navigate = useNavigate();
  const [userInfo, setUserInfo] = useState(null);
  const [waves, setWaves] = useState(null);
  const [detail, setDetail] = useState(null);
  const [plan, setPlan] = useState(null);       // expanded plan {Plan, Steps}
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(null); // draft for New Wave dialog
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [systems, setSystems] = useState([]);
  const [reloadToken, setReloadToken] = useState(0);
  const [executing, setExecuting] = useState(null); // { taskId, planId }

  // One poll drives everything while a plan executes: task status for the
  // progress line, and a plan re-read (steps + counts in one response) so
  // the step table updates live. Terminal -> stop and refresh the detail.
  const execPolling = useRunPolling({
    id: executing?.taskId,
    fetchStatus: getTaskStatus,
    isTerminal: (status) => TERMINAL_TASK_STATES.includes(status?.status)
  });
  useEffect(() => {
    if (!executing || !execPolling.status) return;
    let cancelled = false;
    readActivationPlan(executing.planId)
      .then((result) => { if (!cancelled) setPlan(result); })
      .catch(() => {});
    if (TERMINAL_TASK_STATES.includes(execPolling.status.status)) {
      setExecuting(null);
      setReloadToken((t) => t + 1);
    }
    return () => { cancelled = true; };
  }, [execPolling.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchUserInfo(), listTargetSystems()])
      .then(([info, targetSystems]) => { if (!cancelled) { setUserInfo(info); setSystems(targetSystems); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    queryAdoptionWaves()
      .then((result) => { if (!cancelled) setWaves(result.Items); })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [reloadToken]);

  useEffect(() => {
    if (!waveId) { setDetail(null); setPlan(null); return undefined; }
    let cancelled = false;
    setDetail({ loading: true });
    readAdoptionWave(waveId)
      .then((result) => { if (!cancelled) setDetail({ loading: false, ...result }); })
      .catch((e) => { if (!cancelled) setDetail({ loading: false, error: getServiceErrorMessage(e) }); });
    return () => { cancelled = true; };
  }, [waveId, reloadToken]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

  const submitCreate = async () => {
    try {
      setBusy(true);
      const wave = await createAdoptionWave({
        targetSystemId: creating.targetSystemId || systems[0]?.ID,
        name: creating.name.trim(),
        description: creating.description || '',
        targetDate: creating.targetDate || null,
        adoptLabelled: creating.adoptLabelled
      });
      setCreating(null);
      refresh();
      navigate(`/waves/${wave.ID}`);
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async () => {
    try {
      setBusy(true);
      await deleteAdoptionWave(confirmDelete.ID);
      setConfirmDelete(null);
      setPlan(null);
      refresh();
      navigate('/waves');
    } catch (e) {
      setError(getServiceErrorMessage(e));
      setConfirmDelete(null);
    } finally {
      setBusy(false);
    }
  };

  // Source != target: the wave's proposals may be scored from another
  // system's usage; the dialog picks the DEV system the plan writes to.
  const [buildingPlan, setBuildingPlan] = useState(null); // { targetSystemId }

  const openBuildDialog = () => {
    const preset = defaultActivationTarget(systems, wave?.targetSystem_ID);
    setBuildingPlan({ targetSystemId: preset?.ID || '' });
  };

  const submitBuildPlan = async () => {
    try {
      setBusy(true);
      const result = await createActivationPlan(waveId, null, buildingPlan.targetSystemId);
      setBuildingPlan(null);
      setPlan(result);
      refresh();
    } catch (e) {
      setError(getServiceErrorMessage(e));
      setBuildingPlan(null);
    } finally {
      setBusy(false);
    }
  };

  const simulate = async (planId) => {
    try {
      setBusy(true);
      const result = await simulateActivationPlan(planId);
      setPlan(result);
      refresh();
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const execute = async (planId) => {
    try {
      setBusy(true);
      const handle = await executeActivationPlan(planId);
      setExecuting({ taskId: handle.taskId, planId });
    } catch (e) {
      setError(getServiceErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const openPlan = async (planId) => {
    try {
      setPlan(await readActivationPlan(planId));
    } catch (e) {
      setError(getServiceErrorMessage(e));
    }
  };

  const approver = hasApproverAccess(userInfo);
  const activator = hasActivatorAccess(userInfo);
  const wave = detail?.Wave;
  const rollup = detail?.Rollup;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
        <Title level="H2">Adoption Waves</Title>
        {approver ? (
          <Button
            design="Emphasized"
            icon="add"
            disabled={!systems.length}
            onClick={() => setCreating({ name: '', description: '', targetDate: '', adoptLabelled: true, targetSystemId: systems[0]?.ID })}
          >
            New Wave
          </Button>
        ) : null}
      </div>

      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip>
      ) : null}

      {!waves ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : waves.length === 0 ? (
        <IllustratedMessage
          name="NoData"
          titleText="No adoption waves yet"
          subtitleText="Group approved proposals into waves to plan activation in slices."
        />
      ) : (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <Table
            headerRow={
              <TableHeaderRow sticky>
                <TableHeaderCell><span>Wave</span></TableHeaderCell>
                <TableHeaderCell><span>Status</span></TableHeaderCell>
                <TableHeaderCell><span>Target date</span></TableHeaderCell>
                <TableHeaderCell><span>Membership</span></TableHeaderCell>
                <TableHeaderCell><span>Approved executions</span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {waves.map((row) => (
              <TableRow key={row.ID} interactive onClick={() => navigate(`/waves/${row.ID}`)}>
                <TableCell><span style={{ fontWeight: row.ID === waveId ? 700 : 600 }}>{row.Name}</span></TableCell>
                <TableCell><Tag design={WAVE_STATUS_DESIGN[row.Status] || 'Neutral'}>{row.Status}</Tag></TableCell>
                <TableCell><span>{row.TargetDate || '—'}</span></TableCell>
                <TableCell><span>{membershipLabel(row.Rollup)}</span></TableCell>
                <TableCell><span>{Number(row.Rollup?.approvedExecutions || 0).toLocaleString()}</span></TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      )}

      {detail ? (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          {detail.loading ? <BusyIndicator active delay={100} style={{ display: 'block' }} /> : null}
          {detail.error ? <MessageStrip design="Negative" hideCloseButton>{detail.error}</MessageStrip> : null}
          {wave ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--adops-space-xs)' }}>
                  <Title level="H3">{wave.Name}</Title>
                  <Tag design={WAVE_STATUS_DESIGN[wave.Status] || 'Neutral'}>{wave.Status}</Tag>
                  {wave.TargetDate ? <Text style={{ color: 'var(--sapNeutralTextColor)' }}>target {wave.TargetDate}</Text> : null}
                </div>
                <div style={{ display: 'flex', gap: 'var(--adops-space-xs)' }}>
                  {activator ? (
                    <Button design="Emphasized" icon="play" disabled={busy || !canBuildPlan(rollup)} onClick={openBuildDialog}>
                      Build Activation Plan
                    </Button>
                  ) : null}
                  {approver ? (
                    <Button design="Transparent" icon="delete" disabled={busy} onClick={() => setConfirmDelete(wave)}>Delete</Button>
                  ) : null}
                </div>
              </div>
              {wave.Description ? <Text style={{ display: 'block', marginTop: 'var(--adops-space-xs)' }}>{wave.Description}</Text> : null}

              {rollup ? (
                <div style={{ display: 'flex', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)', flexWrap: 'wrap' }}>
                  <Kpi label="Apps" value={rollup.appCount} />
                  <Kpi label="Approved" value={rollup.approved} />
                  <Kpi label="Open" value={rollup.open} />
                  <Kpi label="Approved executions" value={Number(rollup.approvedExecutions).toLocaleString()} />
                </div>
              ) : null}

              <Panel headerText={`Proposals (${detail.Proposals?.length || 0})`} style={{ marginTop: 'var(--adops-space-md)' }}>
                {(detail.Proposals || []).length === 0 ? (
                  <Text>No proposals assigned. Approve proposals into this wave from the Proposals page.</Text>
                ) : (
                  <Table
                    headerRow={
                      <TableHeaderRow>
                        <TableHeaderCell><span>#</span></TableHeaderCell>
                        <TableHeaderCell><span>App</span></TableHeaderCell>
                        <TableHeaderCell><span>LoB</span></TableHeaderCell>
                        <TableHeaderCell><span>Executions</span></TableHeaderCell>
                        <TableHeaderCell><span>Users</span></TableHeaderCell>
                        <TableHeaderCell><span>Status</span></TableHeaderCell>
                      </TableHeaderRow>
                    }
                  >
                    {detail.Proposals.map((p) => (
                      <TableRow key={p.ID}>
                        <TableCell><span>{p.Rank}</span></TableCell>
                        <TableCell>
                          <span style={{ fontWeight: 600 }}>
                            {p.AppTitle}
                            {p.FioriId ? <span style={{ color: 'var(--sapNeutralTextColor)', fontWeight: 400 }}> {p.FioriId}</span> : null}
                          </span>
                        </TableCell>
                        <TableCell><span>{p.LineOfBusiness}</span></TableCell>
                        <TableCell><span>{Number(p.TotalExecutions).toLocaleString()}</span></TableCell>
                        <TableCell><span>{p.DistinctUserCount}</span></TableCell>
                        <TableCell><Tag design={PROPOSAL_STATUS_DESIGN[p.ReviewStatus] || 'Neutral'}>{p.ReviewStatus}</Tag></TableCell>
                      </TableRow>
                    ))}
                  </Table>
                )}
              </Panel>

              <Panel headerText={`Activation plans (${detail.Plans?.length || 0})`} style={{ marginTop: 'var(--adops-space-md)' }}>
                {(detail.Plans || []).length === 0 ? (
                  <Text>No plans yet. Build one from the approved proposals of this wave.</Text>
                ) : (
                  <Table
                    headerRow={
                      <TableHeaderRow>
                        <TableHeaderCell><span>Plan</span></TableHeaderCell>
                        <TableHeaderCell><span>Target</span></TableHeaderCell>
                        <TableHeaderCell><span>Status</span></TableHeaderCell>
                        <TableHeaderCell><span>Steps</span></TableHeaderCell>
                        <TableHeaderCell><span>Simulation</span></TableHeaderCell>
                        <TableHeaderCell><span></span></TableHeaderCell>
                      </TableHeaderRow>
                    }
                  >
                    {detail.Plans.map((p) => (
                      <TableRow key={p.ID} interactive onClick={() => openPlan(p.ID)}>
                        <TableCell><span style={{ fontWeight: 600 }}>{p.Name}</span></TableCell>
                        <TableCell><span>{p.TargetSystemName || '—'}</span></TableCell>
                        <TableCell><Tag design={PLAN_STATUS_DESIGN[p.Status] || 'Neutral'}>{p.Status}</Tag></TableCell>
                        <TableCell><span>{p.StepCount}</span></TableCell>
                        <TableCell><span>{simulationLabel(p) || '—'}</span></TableCell>
                        <TableCell>
                          <span style={{ display: 'inline-flex', gap: 'var(--adops-space-xs)' }}>
                            {activator && ['DRAFT', 'SIMULATED'].includes(p.Status) ? (
                              <Button
                                design="Transparent"
                                icon="simulate"
                                disabled={busy || Boolean(executing)}
                                onClick={(e) => { e.stopPropagation(); simulate(p.ID); }}
                              >
                                Simulate
                              </Button>
                            ) : null}
                            {activator && canExecutePlan(p) ? (
                              <Button
                                design="Emphasized"
                                icon="play"
                                disabled={busy || Boolean(executing)}
                                onClick={(e) => { e.stopPropagation(); execute(p.ID); }}
                              >
                                {executeActionLabel(p)}
                              </Button>
                            ) : null}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </Table>
                )}
              </Panel>

              {executing && execPolling.status ? (
                <MessageStrip design="Information" hideCloseButton style={{ marginTop: 'var(--adops-space-sm)' }}>
                  {execPolling.status.phase || 'Executing…'}
                  {execPolling.isStale ? ' (connection lost — showing last known state)' : ''}
                </MessageStrip>
              ) : null}

              {plan?.Plan ? (
                <Panel headerText={`${plan.Plan.Name} — steps`} style={{ marginTop: 'var(--adops-space-md)' }}>
                  {groupSteps(plan.Steps).map(({ group, steps }) => (
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
                        {steps.map((s) => (
                          <TableRow key={s.ID}>
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
                </Panel>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={Boolean(creating)}
        headerText="New Adoption Wave"
        onClose={() => setCreating(null)}
      >
        {creating ? (
          <div style={{ display: 'grid', gap: 'var(--adops-space-sm)', padding: 'var(--adops-space-sm)', minWidth: '22rem' }}>
            <Label required>Name</Label>
            <Input value={creating.name} onInput={(e) => setCreating({ ...creating, name: e.target.value })} />
            <Label>Description</Label>
            <TextArea rows={3} value={creating.description} onInput={(e) => setCreating({ ...creating, description: e.target.value })} />
            <Label>Target date</Label>
            <DatePicker
              formatPattern="yyyy-MM-dd"
              value={creating.targetDate}
              onChange={(e) => setCreating({ ...creating, targetDate: e.detail.value })}
            />
            <CheckBox
              checked={creating.adoptLabelled}
              text="Adopt proposals already labelled with this wave name"
              onChange={(e) => setCreating({ ...creating, adoptLabelled: e.target.checked })}
            />
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setCreating(null)}>Cancel</Button>
          <Button design="Emphasized" disabled={busy || !creating?.name?.trim()} onClick={submitCreate}>Create</Button>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(buildingPlan)}
        headerText="Build Activation Plan"
        onClose={() => setBuildingPlan(null)}
      >
        {buildingPlan ? (
          <div style={{ display: 'grid', gap: 'var(--adops-space-sm)', padding: 'var(--adops-space-sm)', minWidth: '22rem' }}>
            <Text>
              Derives activation steps from this wave's approved apps. The plan writes into the
              selected development system; QA/PROD receive the content via transport.
            </Text>
            <Label required>Target system (write)</Label>
            <Select onChange={(e) => setBuildingPlan({ ...buildingPlan, targetSystemId: e.detail.selectedOption.dataset.value })}>
              {systems.filter(isActivationTargetAllowed).map((s) => (
                <Option key={s.ID} data-value={s.ID} selected={buildingPlan.targetSystemId === s.ID}>
                  {s.displayName}{s.environment ? ` (${s.environment})` : ''}{s.client ? ` · client ${s.client}` : ''}
                </Option>
              ))}
            </Select>
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setBuildingPlan(null)}>Cancel</Button>
          <Button design="Emphasized" disabled={busy || !buildingPlan?.targetSystemId} onClick={submitBuildPlan}>Build Plan</Button>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(confirmDelete)}
        headerText="Delete Adoption Wave"
        onClose={() => setConfirmDelete(null)}
      >
        {confirmDelete ? (
          <div style={{ padding: 'var(--adops-space-sm)', minWidth: '20rem' }}>
            <Text>
              Delete wave "{confirmDelete.Name}"? Its proposals are unlinked (not deleted) and existing
              activation plans lose their wave reference. This cannot be undone.
            </Text>
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button design="Negative" disabled={busy} onClick={submitDelete}>Delete</Button>
        </div>
      </Dialog>
    </div>
  );
}

export default AdoptionWavesPage;
