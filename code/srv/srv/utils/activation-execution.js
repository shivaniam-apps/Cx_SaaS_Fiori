const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');
const { shouldMockSap } = require('./s4-http-client.js');

const { SELECT, INSERT, UPDATE } = cds.ql;
const LOG = cds.log('activation-execution');

// ---------------------------------------------------------------------------
// ACTIVATION_EXECUTION task handler (Phase 3).
//
// Walks a simulated plan's steps in SequenceNo order, one at a time, through
// a step executor that implements the ZIF_ADO_ACT_STEP contract:
//   { status: SUCCESS|WARNING|FAILED|SKIPPED, existsAlready, trkorr,
//     messages: [{ type: 'S'|'W'|'E'|'I', message }] }
//
// Semantics (sap-backend.md):
// - RESUME, never retry: steps already SUCCESS/WARNING/SKIPPED are passed
//   over; re-executing a PARTIAL/FAILED plan continues where it stopped.
// - A step whose dependsOn ended FAILED is marked SKIPPED (dependency not
//   met), it is never attempted.
// - StopOnError stops the walk at the first FAILED step.
// - The first step that yields a TRKORR creates the TransportRequests row
//   and pins it to the plan.
// - Every step outcome is recorded (ActivationStepMessages + AuditEvents).
//
// The executor is injected: mock (deterministic, ADOPTOPS_MOCK_S4) today;
// the live executor arrives with the ZADO activation service binding and
// calls ZCL_ADO_ACTIVATE=>EXECUTE_STEP with the same contract.
// ---------------------------------------------------------------------------

const DONE_STATES = ['SUCCESS', 'WARNING', 'SKIPPED'];
const EXECUTABLE_PLAN_STATES = ['SIMULATED', 'READY', 'PARTIAL', 'FAILED'];

// SKIPPED is two different things: a verify-first "already exists" skip
// SATISFIES dependents; a "dependency not met" skip does NOT (and is
// re-attempted on resume once its dependency is fixed). ExistsAlready is
// the discriminator.
function isSatisfied(step) {
  return step.Status === 'SUCCESS'
    || step.Status === 'WARNING'
    || (step.Status === 'SKIPPED' && Boolean(step.ExistsAlready));
}

function planRollup(steps) {
  const count = (predicate) => steps.filter(predicate).length;
  return {
    SucceededCount: count((s) => s.Status === 'SUCCESS'),
    WarningCount: count((s) => s.Status === 'WARNING'),
    FailedCount: count((s) => s.Status === 'FAILED'),
    SkippedCount: count((s) => s.Status === 'SKIPPED')
  };
}

// COMPLETED only when every step SATISFIES its dependents; FAILED when
// nothing was achieved at all; PARTIAL otherwise (some satisfied, some
// failed/dependency-skipped/pending).
function planFinalStatus(steps) {
  const satisfied = steps.filter((s) => isSatisfied(s)).length;
  const failed = steps.filter((s) => s.Status === 'FAILED').length;
  if (satisfied === steps.length) return 'COMPLETED';
  if (failed > 0 && satisfied === 0) return 'FAILED';
  return 'PARTIAL';
}

// Deterministic mock TRKORR: stable per plan so resumed runs reuse it.
function mockTrkorr(plan, systemId) {
  const digits = [...String(plan.ID)].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 90000, 7);
  return `${(systemId || 'MCK').slice(0, 3).toUpperCase()}K9${String(10000 + digits).slice(-5)}`;
}

// Deterministic executor for ADOPTOPS_MOCK_S4: mirrors what the ABAP
// dispatcher reports per step type (see zcl_ado_activate / zcl_ado_act_*).
function mockStepExecutor({ step, plan, systemId }) {
  switch (step.StepType) {
    case 'RUN_TASK_LIST':
      return {
        status: 'SKIPPED', existsAlready: true,
        messages: [{ type: 'S', message: `Task list ${step.ObjectName} already executed on the target (mock) - skipped.` }]
      };
    case 'ACTIVATE_ODATA_SERVICE':
      return {
        status: 'SUCCESS', existsAlready: false,
        messages: [{ type: 'S', message: `OData service ${step.ObjectName}_SRV activated (mock).` }]
      };
    case 'ACTIVATE_ICF_NODE':
      return {
        status: 'WARNING', existsAlready: false,
        messages: [
          { type: 'S', message: `ICF node for ${step.ObjectName} activated and verified (mock).` },
          { type: 'W', message: 'Irreversible: ICF deactivation is not available on this release; rollback is audit-only.' }
        ]
      };
    case 'ADD_TO_TRANSPORT': {
      const trkorr = mockTrkorr(plan, systemId);
      return {
        status: 'SUCCESS', existsAlready: false, trkorr,
        messages: [{ type: 'S', message: `Transport request ${trkorr} created; transportable objects appended (mock).` }]
      };
    }
    default:
      return {
        status: 'SUCCESS', existsAlready: false,
        messages: [{ type: 'S', message: `${step.StepType} ${step.ObjectName} executed and verified (mock).` }]
      };
  }
}

async function writeStepMessages(step, messages, tenantId) {
  if (!messages?.length) return;
  await INSERT.into('adops.db.ActivationStepMessages').entries(messages.map((m, index) => ({
    ID: randomUUID(),
    step_ID: step.ID,
    TenantId: tenantId,
    Sequence: index + 1,
    MessageType: m.type || 'I',
    MessageText: String(m.message || '').slice(0, 500),
    ObjectName: step.ObjectName
  })));
}

async function writeAudit({ plan, step, status, executedBy, tenantId }) {
  await INSERT.into('adops.db.AuditEvents').entries({
    ID: randomUUID(),
    TenantId: tenantId,
    Timestamp: new Date().toISOString(),
    EventType: `ACTIVATION_STEP_${status}`,
    Severity: status === 'FAILED' ? 'ERROR' : 'INFO',
    ObjectType: 'ActivationSteps',
    ObjectName: `${step.StepType} ${step.ObjectName}`.trim(),
    ObjectId: step.ID,
    UserId: executedBy || '',
    Source: 'activation-execution',
    Message: `Plan ${plan.Name}: step ${step.SequenceNo} -> ${status}`,
    CorrelationId: plan.ID
  });
}

async function ensureTransportRow({ plan, trkorr, executedBy, tenantId }) {
  if (!trkorr || plan.transportRequest_ID) return plan.transportRequest_ID || null;
  const existing = await SELECT.one.from('adops.db.TransportRequests')
    .where({ plan_ID: plan.ID, TransportRequestId: trkorr });
  if (existing) return existing.ID;
  const id = randomUUID();
  await INSERT.into('adops.db.TransportRequests').entries({
    ID: id,
    targetSystem_ID: plan.targetSystem_ID,
    plan_ID: plan.ID,
    TenantId: tenantId,
    TransportRequestId: trkorr,
    RequestType: 'K',
    Description: plan.Name,
    Owner: (executedBy || '').slice(0, 12),
    Status: 'MODIFIABLE',
    CreatedInSapAt: new Date().toISOString()
  });
  await UPDATE('adops.db.ActivationPlans').set({ transportRequest_ID: id }).where({ ID: plan.ID });
  return id;
}

// The engine, executor-injected for testability. Returns the run summary.
async function executePlanSteps({ plan, steps, executor, systemId, executedBy, reportProgress, isCancelRequested }) {
  const tenantId = plan.TenantId;
  const satisfiedById = new Map(steps.map((s) => [s.ID, isSatisfied(s)]));
  let executed = 0;
  let cancelled = false;

  const total = steps.length;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (await isCancelRequested()) { cancelled = true; break; }

    // Resume semantics: a satisfied step is never touched again. FAILED and
    // dependency-skipped steps are re-attempted.
    if (isSatisfied(step)) continue;

    // Dependency gate: an unsatisfied dependency skips this step (and the
    // skip itself satisfies nothing, so the whole chain parks).
    if (step.dependsOn_ID && satisfiedById.get(step.dependsOn_ID) !== true) {
      await UPDATE('adops.db.ActivationSteps')
        .set({
          Status: 'SKIPPED',
          ExistsAlready: false,
          SimulationMessage: 'Dependency did not complete - step skipped; resumes once the dependency succeeds.',
          CompletedAt: new Date().toISOString()
        })
        .where({ ID: step.ID });
      step.Status = 'SKIPPED';
      step.ExistsAlready = false;
      satisfiedById.set(step.ID, false);
      await writeAudit({ plan, step, status: 'SKIPPED', executedBy, tenantId });
      continue;
    }

    const startedAt = Date.now();
    await UPDATE('adops.db.ActivationSteps')
      .set({ Status: 'RUNNING', StartedAt: new Date(startedAt).toISOString() })
      .where({ ID: step.ID });
    await reportProgress({
      phase: `Step ${step.SequenceNo}/${total}: ${step.StepType} ${step.ObjectName}`,
      processedItems: executed,
      totalItems: total
    });

    let result;
    try {
      result = await executor({ step, plan, systemId });
    } catch (error) {
      result = { status: 'FAILED', messages: [{ type: 'E', message: `Executor error: ${error.message}` }] };
    }

    const status = DONE_STATES.includes(result.status) || result.status === 'FAILED' ? result.status : 'FAILED';
    await UPDATE('adops.db.ActivationSteps').set({
      Status: status,
      ExistsAlready: Boolean(result.existsAlready),
      CompletedAt: new Date().toISOString(),
      DurationMs: Date.now() - startedAt,
      RetryCount: (step.RetryCount || 0) + (step.Status === 'FAILED' ? 1 : 0)
    }).where({ ID: step.ID });
    await writeStepMessages(step, result.messages, tenantId);
    await writeAudit({ plan, step, status, executedBy, tenantId });

    step.Status = status;
    step.ExistsAlready = Boolean(result.existsAlready);
    satisfiedById.set(step.ID, isSatisfied(step));
    executed += 1;

    if (result.trkorr) {
      const transportId = await ensureTransportRow({ plan, trkorr: result.trkorr, executedBy, tenantId });
      plan.transportRequest_ID = transportId;
    }

    if (status === 'FAILED' && plan.StopOnError !== false) {
      LOG.warn(`Plan ${plan.ID}: step ${step.SequenceNo} failed, stopping (StopOnError).`);
      break;
    }
  }

  const finalStatus = cancelled ? 'PARTIAL' : planFinalStatus(steps);
  const rollup = planRollup(steps);
  await UPDATE('adops.db.ActivationPlans').set({
    Status: finalStatus,
    ...rollup
  }).where({ ID: plan.ID });

  return { planId: plan.ID, status: finalStatus, executedSteps: executed, cancelled, ...rollup };
}

async function runActivationExecution({ payload, reportProgress, log, isCancelRequested }) {
  const { planId, executedBy } = payload || {};
  const plan = await SELECT.one.from('adops.db.ActivationPlans').where({ ID: planId });
  if (!plan) throw new Error('Activation plan not found.');
  if (!EXECUTABLE_PLAN_STATES.includes(plan.Status)) {
    throw new Error(`Plan is ${plan.Status}; execution needs one of ${EXECUTABLE_PLAN_STATES.join('/')}.`);
  }

  const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: plan.targetSystem_ID });
  const steps = await SELECT.from('adops.db.ActivationSteps')
    .where({ plan_ID: planId }).orderBy('SequenceNo asc');
  if (!steps.length) throw new Error('The plan has no steps.');

  // Executor selection: deterministic mock under ADOPTOPS_MOCK_S4, otherwise
  // the live adapter against the DEV-only ZADO_ACT ICF node.
  let executor = mockStepExecutor;
  if (!shouldMockSap()) {
    const { liveStepExecutorFor } = require('./s4-activate-adapter.js');
    executor = liveStepExecutorFor(targetSystem); // throws without a destination
  }

  await UPDATE('adops.db.ActivationPlans').set({
    Status: 'EXECUTING',
    ExecutedAt: plan.ExecutedAt || new Date().toISOString(),
    ExecutedBy: executedBy || plan.ExecutedBy || null
  }).where({ ID: planId });
  await log('INFO', 'Execution', `Plan ${plan.Name}: ${steps.length} steps (resume-aware).`);

  const summary = await executePlanSteps({
    plan,
    steps,
    executor,
    systemId: targetSystem?.systemId || targetSystem?.displayName || 'MCK',
    executedBy,
    reportProgress,
    isCancelRequested
  });
  await log('INFO', 'Execution', `Plan ${plan.Name} finished: ${summary.status} (${summary.SucceededCount} ok, ${summary.WarningCount} warn, ${summary.FailedCount} failed, ${summary.SkippedCount} skipped).`);
  await reportProgress({ phase: `Finished: ${summary.status}`, processedItems: steps.length, totalItems: steps.length, progressPercent: 100 });
  return summary;
}

module.exports = {
  runActivationExecution,
  executePlanSteps,
  mockStepExecutor,
  planRollup,
  planFinalStatus,
  isSatisfied,
  mockTrkorr,
  EXECUTABLE_PLAN_STATES
};
