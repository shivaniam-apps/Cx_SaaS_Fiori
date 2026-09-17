const cds = require('@sap/cds');
const { objectKey } = require('./activation-plan.js');
const {
  isSatisfied,
  planRollup,
  planFinalStatus,
  writeStepMessages,
  writeAudit
} = require('./activation-execution.js');

const { SELECT, UPDATE } = cds.ql;

// ---------------------------------------------------------------------------
// Operator decisions on single activation steps (S5, sap-backend.md "step
// retry, skip and rollback semantics").
//
// - SKIP parks a step the operator will not execute. The step becomes
//   SKIPPED with OperatorAction SKIPPED, which SATISFIES its dependents
//   (activation-execution.isSatisfied), so a resume runs past it. Nothing
//   is written to the target system.
// - ROLLBACK undoes an executed step through the write unit with the step
//   type ROLLBACK_<StepType> and the step's own key; on SUCCESS/SKIPPED the
//   step becomes ROLLED_BACK and every step that depended on it (transitively)
//   goes back to PENDING, so a resume re-runs the chain verify-first.
// - Irreversible steps (Reversible = false: ICF activation, task lists) are
//   AUDIT-ONLY: the request is recorded on the step and in the audit chain,
//   the object stays as executed, the status does not change.
//
// Both actions refuse while the plan is EXECUTING/SIMULATING; the predicates
// are pure so the client can gate its buttons with the same rules.
// ---------------------------------------------------------------------------

const OPERATOR_SKIPPED = 'SKIPPED';
const OPERATOR_ROLLED_BACK = 'ROLLED_BACK';
const OPERATOR_ROLLBACK_REQUESTED = 'ROLLBACK_REQUESTED';
const BUSY_PLAN_STATES = ['EXECUTING', 'SIMULATING'];
const EXECUTED_STATES = ['SUCCESS', 'WARNING'];
const ROLLBACK_DONE_STATES = ['SUCCESS', 'WARNING', 'SKIPPED'];
const EXECUTED_PLAN_STATES = ['COMPLETED', 'PARTIAL', 'FAILED'];

function busyReason(plan) {
  return BUSY_PLAN_STATES.includes(plan?.Status) ? `Plan is ${plan.Status} - wait for the run to finish.` : '';
}

function skipStepAllowed(step, plan) {
  const busy = busyReason(plan);
  if (busy) return { ok: false, reason: busy };
  if (!step) return { ok: false, reason: 'Step not found.' };
  if (step.Status === 'RUNNING') return { ok: false, reason: `Step ${step.SequenceNo} is running.` };
  if (step.OperatorAction === OPERATOR_SKIPPED) return { ok: false, reason: `Step ${step.SequenceNo} is already skipped by an operator.` };
  if (isSatisfied(step)) return { ok: false, reason: `Step ${step.SequenceNo} is ${step.Status}${step.ExistsAlready ? ' (exists)' : ''} - nothing to skip.` };
  return { ok: true, reason: '' };
}

// EXECUTE for reversible steps, AUDIT_ONLY for irreversible ones.
function rollbackMode(step) {
  return step?.Reversible === false ? 'AUDIT_ONLY' : 'EXECUTE';
}

function rollbackStepAllowed(step, plan) {
  const busy = busyReason(plan);
  if (busy) return { ok: false, reason: busy, mode: null };
  if (!step) return { ok: false, reason: 'Step not found.', mode: null };
  if (!EXECUTED_STATES.includes(step.Status)) {
    return { ok: false, reason: `Step ${step.SequenceNo} is ${step.Status} - only executed steps (SUCCESS/WARNING) can be rolled back.`, mode: null };
  }
  return { ok: true, reason: '', mode: rollbackMode(step) };
}

// Steps whose dependsOn chain reaches stepId (transitive), in sequence order.
function dependentsOf(steps, stepId) {
  const result = [];
  const seen = new Set();
  const frontier = [stepId];
  while (frontier.length) {
    const id = frontier.pop();
    for (const step of steps) {
      if (step.dependsOn_ID === id && !seen.has(step.ID)) {
        seen.add(step.ID);
        result.push(step);
        frontier.push(step.ID);
      }
    }
  }
  return result.sort((a, b) => a.SequenceNo - b.SequenceNo);
}

// The write-unit step that undoes this one: ROLLBACK_<type> with a dedicated
// key builder when the contract defines one, else the step's own key.
function rollbackStepFor(step) {
  const StepType = `ROLLBACK_${step.StepType}`;
  let key = {};
  try {
    key = step.ObjectKeyJson ? JSON.parse(step.ObjectKeyJson) : {};
  } catch {
    key = {};
  }
  let rollbackKey = key;
  try {
    rollbackKey = objectKey(StepType, key);
  } catch {
    rollbackKey = key; // no dedicated builder - the original key travels
  }
  return { ...step, StepType, ObjectKeyJson: JSON.stringify(rollbackKey) };
}

// Rollup always; the status only when the plan has been executed (a
// SIMULATED plan stays SIMULATED after an operator skip).
async function refreshPlan(plan) {
  const steps = await SELECT.from('adops.db.ActivationSteps').where({ plan_ID: plan.ID });
  const patch = planRollup(steps);
  if (EXECUTED_PLAN_STATES.includes(plan.Status)) patch.Status = planFinalStatus(steps);
  await UPDATE('adops.db.ActivationPlans').set(patch).where({ ID: plan.ID });
  return patch.Status || plan.Status;
}

const noteOf = (reason) => String(reason || '').trim().slice(0, 500);
const withNote = (note) => (note ? `: ${note}` : '');

async function applyOperatorSkip({ step, plan, reason, user }) {
  const now = new Date().toISOString();
  const note = noteOf(reason);
  const message = `Skipped by operator ${user || ''}${withNote(note)} - the object was not written; dependents may run.`;
  await UPDATE('adops.db.ActivationSteps').set({
    Status: 'SKIPPED',
    ExistsAlready: false,
    OperatorAction: OPERATOR_SKIPPED,
    OperatorNote: note,
    OperatorAt: now,
    OperatorBy: user || '',
    CompletedAt: now,
    SimulationMessage: `Skipped by operator${withNote(note)}.`
  }).where({ ID: step.ID });
  await writeStepMessages(step, [{ type: 'W', message }], plan.TenantId);
  await writeAudit({ plan, step, status: 'SKIPPED_BY_OPERATOR', executedBy: user, tenantId: plan.TenantId });
  const planStatus = await refreshPlan(plan);
  return {
    StepId: step.ID, StepStatus: 'SKIPPED', OperatorAction: OPERATOR_SKIPPED, PlanStatus: planStatus,
    Result: { status: 'SKIPPED', messages: [{ type: 'W', message }] }
  };
}

async function applyOperatorRollback({ step, plan, reason, user, executor, systemId }) {
  const now = new Date().toISOString();
  const note = noteOf(reason);
  const tenantId = plan.TenantId;

  if (rollbackMode(step) === 'AUDIT_ONLY') {
    const message = `Rollback requested by ${user || ''}${withNote(note)}: ${step.StepType} ${step.ObjectName} is irreversible on this release - recorded, the object stays as executed.`;
    await UPDATE('adops.db.ActivationSteps').set({
      OperatorAction: OPERATOR_ROLLBACK_REQUESTED, OperatorNote: note, OperatorAt: now, OperatorBy: user || ''
    }).where({ ID: step.ID });
    await writeStepMessages(step, [{ type: 'W', message }], tenantId);
    await writeAudit({ plan, step, status: 'ROLLBACK_AUDIT_ONLY', executedBy: user, tenantId });
    return {
      StepId: step.ID, StepStatus: step.Status, OperatorAction: OPERATOR_ROLLBACK_REQUESTED, PlanStatus: plan.Status,
      Result: { status: 'SKIPPED', messages: [{ type: 'W', message }] }
    };
  }

  const rollbackStep = rollbackStepFor(step);
  let result;
  try {
    result = await executor({ step: rollbackStep, plan, systemId });
  } catch (error) {
    result = { status: 'FAILED', messages: [{ type: 'E', message: `Executor error: ${error.message}` }] };
  }
  await writeStepMessages(step, result.messages, tenantId);

  if (!ROLLBACK_DONE_STATES.includes(result.status)) {
    await writeAudit({ plan, step, status: 'ROLLBACK_FAILED', executedBy: user, tenantId });
    return { StepId: step.ID, StepStatus: step.Status, OperatorAction: null, PlanStatus: plan.Status, Result: result };
  }

  await UPDATE('adops.db.ActivationSteps').set({
    Status: 'ROLLED_BACK',
    ExistsAlready: false,
    OperatorAction: OPERATOR_ROLLED_BACK,
    OperatorNote: note,
    OperatorAt: now,
    OperatorBy: user || '',
    CompletedAt: now,
    SimulationMessage: `Rolled back by operator${withNote(note)}.`
  }).where({ ID: step.ID });

  // Whatever ran on the rolled-back object must run again (verify-first
  // makes the re-run safe for anything that survived).
  const all = await SELECT.from('adops.db.ActivationSteps').where({ plan_ID: plan.ID });
  const reopened = dependentsOf(all, step.ID).filter((s) => isSatisfied(s) || s.Status === 'FAILED');
  for (const dependent of reopened) {
    await UPDATE('adops.db.ActivationSteps').set({
      Status: 'PENDING',
      ExistsAlready: false,
      OperatorAction: null,
      CompletedAt: null,
      SimulationMessage: `Re-run required: step ${step.SequenceNo} (${step.StepType} ${step.ObjectName}) was rolled back.`
    }).where({ ID: dependent.ID });
  }
  await writeAudit({ plan, step, status: 'ROLLED_BACK', executedBy: user, tenantId });
  const planStatus = await refreshPlan(plan);
  return {
    StepId: step.ID, StepStatus: 'ROLLED_BACK', OperatorAction: OPERATOR_ROLLED_BACK, PlanStatus: planStatus,
    ReopenedStepIds: reopened.map((s) => s.ID), Result: result
  };
}

module.exports = {
  skipStepAllowed,
  rollbackStepAllowed,
  rollbackMode,
  dependentsOf,
  rollbackStepFor,
  applyOperatorSkip,
  applyOperatorRollback
};
