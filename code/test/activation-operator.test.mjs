import { expect } from 'chai';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const cds = require('@sap/cds');
const { SELECT, INSERT } = cds.ql;
const { executePlanSteps, mockStepExecutor } = require('../srv/srv/utils/activation-execution.js');
const { deriveActivationSteps } = require('../srv/srv/utils/activation-plan.js');
const {
  skipStepAllowed,
  rollbackStepAllowed,
  dependentsOf,
  rollbackStepFor,
  applyOperatorSkip,
  applyOperatorRollback
} = require('../srv/srv/utils/activation-operator.js');

// ---------------------------------------------------------------------------
// S5: operator skip and rollback on single steps.
// ---------------------------------------------------------------------------

const PROPOSALS = [
  { ID: randomUUID(), FioriId: 'F3893', BusinessRoleId: 'SAP_BR_INTERNAL_SALES_REP' },
  { ID: randomUUID(), FioriId: 'F0842A', BusinessRoleId: 'SAP_BR_PURCHASER' }
];
const noProgress = async () => {};
const notCancelled = async () => false;
const runArgs = (plan, steps, executor = mockStepExecutor) => ({
  plan, steps, executor, systemId: 'RD1', executedBy: 'tester', reportProgress: noProgress, isCancelRequested: notCancelled
});

async function seedPlan({ stopOnError = true } = {}) {
  const planId = randomUUID();
  const { steps } = deriveActivationSteps({ proposals: PROPOSALS, waveName: 'Wave O' });
  await INSERT.into('adops.db.ActivationPlans').entries({
    ID: planId, TenantId: 'T', Name: 'Operator plan', Status: 'SIMULATED', StopOnError: stopOnError, StepCount: steps.length
  });
  await INSERT.into('adops.db.ActivationSteps').entries(steps.map((s) => ({ ...s, plan_ID: planId, TenantId: 'T' })));
  return reload(planId);
}

async function reload(planId) {
  const plan = await SELECT.one.from('adops.db.ActivationPlans').where({ ID: planId });
  const steps = await SELECT.from('adops.db.ActivationSteps').where({ plan_ID: planId }).orderBy('SequenceNo asc');
  return { plan, steps };
}

const byType = (steps, type) => steps.find((s) => s.StepType === type);

describe('operator predicates (pure)', () => {
  const idle = { Status: 'PARTIAL' };

  it('skip: only unsatisfied, non-running steps of an idle plan', () => {
    expect(skipStepAllowed({ SequenceNo: 1, Status: 'FAILED' }, idle).ok).to.equal(true);
    expect(skipStepAllowed({ SequenceNo: 1, Status: 'PENDING' }, idle).ok).to.equal(true);
    expect(skipStepAllowed({ SequenceNo: 1, Status: 'SKIPPED', ExistsAlready: false }, idle).ok).to.equal(true);
    expect(skipStepAllowed({ SequenceNo: 1, Status: 'SKIPPED', ExistsAlready: true }, idle).ok).to.equal(false);
    expect(skipStepAllowed({ SequenceNo: 1, Status: 'SUCCESS' }, idle).ok).to.equal(false);
    expect(skipStepAllowed({ SequenceNo: 1, Status: 'RUNNING' }, idle).ok).to.equal(false);
    expect(skipStepAllowed({ SequenceNo: 1, Status: 'FAILED' }, { Status: 'EXECUTING' }).reason).to.match(/EXECUTING/);
  });

  it('rollback: executed steps only; irreversible ones are audit-only', () => {
    expect(rollbackStepAllowed({ SequenceNo: 1, Status: 'SUCCESS', Reversible: true }, idle)).to.include({ ok: true, mode: 'EXECUTE' });
    expect(rollbackStepAllowed({ SequenceNo: 1, Status: 'WARNING', Reversible: false }, idle)).to.include({ ok: true, mode: 'AUDIT_ONLY' });
    expect(rollbackStepAllowed({ SequenceNo: 1, Status: 'FAILED' }, idle).ok).to.equal(false);
    expect(rollbackStepAllowed({ SequenceNo: 1, Status: 'SUCCESS' }, { Status: 'SIMULATING' }).ok).to.equal(false);
  });

  it('dependentsOf walks the dependsOn chain transitively', () => {
    const { steps } = deriveActivationSteps({ proposals: PROPOSALS, waveName: 'Wave O' });
    const role = byType(steps, 'CREATE_PFCG_ROLE');
    const types = dependentsOf(steps, role.ID).map((s) => s.StepType);
    expect(types).to.deep.equal(['ADD_SPACE_TO_ROLE', 'GENERATE_PROFILE', 'APPEND_TO_TRANSPORT']);
    const transport = byType(steps, 'ADD_TO_TRANSPORT');
    expect(dependentsOf(steps, transport.ID).map((s) => s.StepType)).to.include.members(['CREATE_SPACE', 'CREATE_PFCG_ROLE', 'APPEND_TO_TRANSPORT']);
  });

  it('rollbackStepFor uses the dedicated key builder when the contract has one', () => {
    const { steps } = deriveActivationSteps({ proposals: PROPOSALS, waveName: 'Wave O' });
    const role = rollbackStepFor(byType(steps, 'CREATE_PFCG_ROLE'));
    expect(role.StepType).to.equal('ROLLBACK_CREATE_PFCG_ROLE');
    expect(JSON.parse(role.ObjectKeyJson)).to.deep.equal({ role: 'Z_ADO_WO' });
    const space = rollbackStepFor(byType(steps, 'CREATE_SPACE'));
    expect(space.StepType).to.equal('ROLLBACK_CREATE_SPACE');
    expect(JSON.parse(space.ObjectKeyJson)).to.deep.equal({ spaceId: 'ZADO_WO', title: 'Wave O', trkorr: '' });
  });
});

describe('operator skip and rollback against the engine', function () {
  this.timeout(20000);

  before(async () => {
    const model = await cds.load(fileURLToPath(new URL('../db', import.meta.url)));
    await cds.deploy(model).to('sqlite::memory:');
  });

  it('a skipped failed step satisfies its dependents; the resume completes the plan', async () => {
    const seeded = await seedPlan({ stopOnError: false });
    const failing = (args) => (args.step.StepType === 'CREATE_PFCG_ROLE'
      ? { status: 'FAILED', messages: [{ type: 'E', message: 'induced' }] }
      : mockStepExecutor(args));
    await executePlanSteps(runArgs(seeded.plan, seeded.steps, failing));

    let { plan, steps } = await reload(seeded.plan.ID);
    expect(plan.Status).to.equal('PARTIAL');
    const outcome = await applyOperatorSkip({ step: byType(steps, 'CREATE_PFCG_ROLE'), plan, reason: 'role exists elsewhere', user: 'ops' });
    expect(outcome).to.include({ StepStatus: 'SKIPPED', OperatorAction: 'SKIPPED' });

    ({ plan, steps } = await reload(plan.ID));
    const role = byType(steps, 'CREATE_PFCG_ROLE');
    expect(role).to.include({ Status: 'SKIPPED', OperatorAction: 'SKIPPED', OperatorNote: 'role exists elsewhere', OperatorBy: 'ops' });
    expect(role.ExistsAlready).to.equal(false);

    const summary = await executePlanSteps(runArgs(plan, steps));
    expect(summary.status).to.equal('COMPLETED');
    ({ steps } = await reload(plan.ID));
    expect(byType(steps, 'ADD_SPACE_TO_ROLE').Status).to.equal('SUCCESS');
    expect(byType(steps, 'APPEND_TO_TRANSPORT').Status).to.equal('SUCCESS');
    expect(byType(steps, 'CREATE_PFCG_ROLE').Status).to.equal('SKIPPED', 'the operator skip is never re-attempted');
  });

  it('rolling back an executed step re-opens its dependents and the plan becomes resumable', async () => {
    const seeded = await seedPlan();
    await executePlanSteps(runArgs(seeded.plan, seeded.steps));
    let { plan, steps } = await reload(seeded.plan.ID);
    expect(plan.Status).to.equal('COMPLETED');

    const seen = [];
    const executor = (args) => { seen.push(args.step); return mockStepExecutor(args); };
    const outcome = await applyOperatorRollback({ step: byType(steps, 'CREATE_PFCG_ROLE'), plan, reason: 'wrong wave', user: 'ops', executor, systemId: 'RD1' });
    expect(outcome).to.include({ StepStatus: 'ROLLED_BACK', OperatorAction: 'ROLLED_BACK', PlanStatus: 'PARTIAL' });
    expect(seen).to.have.length(1);
    expect(seen[0].StepType).to.equal('ROLLBACK_CREATE_PFCG_ROLE');
    expect(JSON.parse(seen[0].ObjectKeyJson)).to.deep.equal({ role: 'Z_ADO_WO' });

    ({ plan, steps } = await reload(plan.ID));
    expect(plan.Status).to.equal('PARTIAL');
    expect(byType(steps, 'CREATE_PFCG_ROLE').Status).to.equal('ROLLED_BACK');
    for (const type of ['ADD_SPACE_TO_ROLE', 'GENERATE_PROFILE', 'APPEND_TO_TRANSPORT']) {
      expect(byType(steps, type).Status, type).to.equal('PENDING');
      expect(byType(steps, type).SimulationMessage).to.match(/rolled back/);
    }
    expect(byType(steps, 'CREATE_SPACE').Status).to.equal('SUCCESS', 'unrelated steps keep their state');

    const resumed = await executePlanSteps(runArgs(plan, steps));
    expect(resumed.status).to.equal('COMPLETED');
    expect(resumed.executedSteps).to.equal(4, 'role + its three dependents');
  });

  it('an irreversible step is recorded, never rolled back, and keeps its status', async () => {
    const seeded = await seedPlan();
    await executePlanSteps(runArgs(seeded.plan, seeded.steps));
    let { plan, steps } = await reload(seeded.plan.ID);

    let called = 0;
    const executor = (args) => { called += 1; return mockStepExecutor(args); };
    const icf = steps.find((s) => s.StepType === 'ACTIVATE_ICF_NODE');
    const outcome = await applyOperatorRollback({ step: icf, plan, reason: 'oops', user: 'ops', executor, systemId: 'RD1' });
    expect(called).to.equal(0);
    expect(outcome).to.include({ StepStatus: 'WARNING', OperatorAction: 'ROLLBACK_REQUESTED', PlanStatus: 'COMPLETED' });

    ({ plan, steps } = await reload(plan.ID));
    expect(plan.Status).to.equal('COMPLETED');
    expect(steps.find((s) => s.ID === icf.ID)).to.include({ Status: 'WARNING', OperatorAction: 'ROLLBACK_REQUESTED' });
    const messages = await SELECT.from('adops.db.ActivationStepMessages').where({ step_ID: icf.ID });
    expect(messages.some((m) => /irreversible/.test(m.MessageText))).to.equal(true);
  });

  it('a failed rollback leaves the step untouched and reports the write-unit messages', async () => {
    const seeded = await seedPlan();
    await executePlanSteps(runArgs(seeded.plan, seeded.steps));
    const { plan, steps } = await reload(seeded.plan.ID);
    const failing = () => ({ status: 'FAILED', messages: [{ type: 'E', message: 'PRGN refused' }] });
    const outcome = await applyOperatorRollback({ step: byType(steps, 'CREATE_PFCG_ROLE'), plan, reason: '', user: 'ops', executor: failing, systemId: 'RD1' });
    expect(outcome.OperatorAction).to.equal(null);
    expect(outcome.Result.status).to.equal('FAILED');
    const { steps: after } = await reload(plan.ID);
    expect(byType(after, 'CREATE_PFCG_ROLE').Status).to.equal('SUCCESS');
    expect(byType(after, 'GENERATE_PROFILE').Status).to.equal('SUCCESS');
  });
});
