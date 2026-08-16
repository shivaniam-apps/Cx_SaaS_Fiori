import { expect } from 'chai';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const cds = require('@sap/cds');
const {
  executePlanSteps,
  mockStepExecutor,
  planRollup,
  planFinalStatus,
  mockTrkorr
} = require('../srv/srv/utils/activation-execution.js');
const { deriveActivationSteps } = require('../srv/srv/utils/activation-plan.js');

const { SELECT, INSERT } = cds.ql;

const PROPOSALS = [
  { ID: randomUUID(), FioriId: 'F3893', BusinessRoleId: 'SAP_BR_INTERNAL_SALES_REP' },
  { ID: randomUUID(), FioriId: 'F0842A', BusinessRoleId: 'SAP_BR_PURCHASER' }
];

const noProgress = async () => {};
const notCancelled = async () => false;

async function seedPlan({ stopOnError = true } = {}) {
  const planId = randomUUID();
  const { steps } = deriveActivationSteps({ proposals: PROPOSALS, waveName: 'Wave T' });
  await INSERT.into('adops.db.ActivationPlans').entries({
    ID: planId, TenantId: 'T', Name: 'Test plan', Status: 'SIMULATED',
    StopOnError: stopOnError, StepCount: steps.length
  });
  await INSERT.into('adops.db.ActivationSteps').entries(steps.map((s) => ({ ...s, plan_ID: planId, TenantId: 'T' })));
  const plan = await SELECT.one.from('adops.db.ActivationPlans').where({ ID: planId });
  const rows = await SELECT.from('adops.db.ActivationSteps').where({ plan_ID: planId }).orderBy('SequenceNo asc');
  return { plan, steps: rows };
}

describe('activation execution engine', function () {
  this.timeout(20000);

  before(async () => {
    const model = await cds.load(fileURLToPath(new URL('../db', import.meta.url)));
    await cds.deploy(model).to('sqlite::memory:');
  });

  it('mock executor honours the ZIF_ADO_ACT_STEP contract per step type', () => {
    const plan = { ID: 'plan-1' };
    const tasklist = mockStepExecutor({ step: { StepType: 'RUN_TASK_LIST', ObjectName: 'SAP_FIORI_FOUNDATION_S4' }, plan });
    expect(tasklist.status).to.equal('SKIPPED');
    expect(tasklist.existsAlready).to.equal(true);

    const icf = mockStepExecutor({ step: { StepType: 'ACTIVATE_ICF_NODE', ObjectName: 'F3893' }, plan });
    expect(icf.status).to.equal('WARNING');
    expect(icf.messages.some((m) => m.type === 'W')).to.equal(true);

    const transport = mockStepExecutor({ step: { StepType: 'ADD_TO_TRANSPORT', ObjectName: 'T_TR' }, plan, systemId: 'RD1' });
    expect(transport.status).to.equal('SUCCESS');
    expect(transport.trkorr).to.match(/^RD1K9\d{5}$/);
    expect(transport.trkorr).to.equal(mockTrkorr(plan, 'RD1'), 'trkorr must be stable per plan for resume');
  });

  it('executes a simulated plan to COMPLETED with transport row and audit trail', async () => {
    const { plan, steps } = await seedPlan();
    const summary = await executePlanSteps({
      plan, steps, executor: mockStepExecutor, systemId: 'RD1',
      executedBy: 'tester', reportProgress: noProgress, isCancelRequested: notCancelled
    });

    expect(summary.status).to.equal('COMPLETED');
    expect(summary.FailedCount).to.equal(0);
    expect(summary.SkippedCount).to.equal(1);           // foundation exists already
    expect(summary.WarningCount).to.equal(2);           // one ICF step per app

    const after = await SELECT.one.from('adops.db.ActivationPlans').where({ ID: plan.ID });
    expect(after.Status).to.equal('COMPLETED');
    expect(after.transportRequest_ID).to.be.a('string');

    const transport = await SELECT.one.from('adops.db.TransportRequests').where({ ID: after.transportRequest_ID });
    expect(transport.TransportRequestId).to.match(/^RD1K9\d{5}$/);
    expect(transport.Status).to.equal('MODIFIABLE');

    const audits = await SELECT.from('adops.db.AuditEvents').where({ CorrelationId: plan.ID });
    expect(audits.length).to.equal(steps.length);

    const messages = await SELECT.from('adops.db.ActivationStepMessages').where({ step_ID: steps[0].ID });
    expect(messages.length).to.be.greaterThan(0);
  });

  it('resumes: a second run touches nothing that is already done', async () => {
    const { plan, steps } = await seedPlan();
    await executePlanSteps({
      plan, steps, executor: mockStepExecutor, systemId: 'RD1',
      executedBy: 'tester', reportProgress: noProgress, isCancelRequested: notCancelled
    });

    let calls = 0;
    const countingExecutor = (args) => { calls += 1; return mockStepExecutor(args); };
    const fresh = await SELECT.from('adops.db.ActivationSteps').where({ plan_ID: plan.ID }).orderBy('SequenceNo asc');
    const summary = await executePlanSteps({
      plan, steps: fresh, executor: countingExecutor, systemId: 'RD1',
      executedBy: 'tester', reportProgress: noProgress, isCancelRequested: notCancelled
    });

    expect(calls).to.equal(0, 'no step may re-execute on resume');
    expect(summary.status).to.equal('COMPLETED');
    expect(summary.executedSteps).to.equal(0);
  });

  it('StopOnError halts at the first failure and a later run resumes from it', async () => {
    const { plan, steps } = await seedPlan();
    // Fail the first CONTENT step once; everything after must stay PENDING.
    const failingExecutor = (args) => (args.step.StepType === 'CREATE_SPACE'
      ? { status: 'FAILED', messages: [{ type: 'E', message: 'induced failure' }] }
      : mockStepExecutor(args));

    const first = await executePlanSteps({
      plan, steps, executor: failingExecutor, systemId: 'RD1',
      executedBy: 'tester', reportProgress: noProgress, isCancelRequested: notCancelled
    });
    expect(first.status).to.equal('PARTIAL');
    expect(first.FailedCount).to.equal(1);
    const pendingAfterFirst = await SELECT.from('adops.db.ActivationSteps')
      .where({ plan_ID: plan.ID, Status: 'PENDING' });
    expect(pendingAfterFirst.length).to.be.greaterThan(0, 'steps after the failure stay untouched');

    // Resume with a healthy executor: only the failed + pending steps run.
    // (Compute the expectation BEFORE the run - the engine mutates the rows.)
    const fresh = await SELECT.from('adops.db.ActivationSteps').where({ plan_ID: plan.ID }).orderBy('SequenceNo asc');
    const freshPlan = await SELECT.one.from('adops.db.ActivationPlans').where({ ID: plan.ID });
    const todoBeforeResume = fresh.filter((s) => !(
      ['SUCCESS', 'WARNING'].includes(s.Status) || (s.Status === 'SKIPPED' && s.ExistsAlready)
    )).length;
    const second = await executePlanSteps({
      plan: freshPlan, steps: fresh, executor: mockStepExecutor, systemId: 'RD1',
      executedBy: 'tester', reportProgress: noProgress, isCancelRequested: notCancelled
    });
    expect(second.status).to.equal('COMPLETED');
    expect(second.executedSteps).to.equal(todoBeforeResume);
  });

  it('skips steps whose dependency failed (no StopOnError)', async () => {
    const { plan, steps } = await seedPlan({ stopOnError: false });
    const failingExecutor = (args) => (args.step.StepType === 'CREATE_PFCG_ROLE'
      ? { status: 'FAILED', messages: [{ type: 'E', message: 'induced role failure' }] }
      : mockStepExecutor(args));

    const summary = await executePlanSteps({
      plan, steps, executor: failingExecutor, systemId: 'RD1',
      executedBy: 'tester', reportProgress: noProgress, isCancelRequested: notCancelled
    });

    expect(summary.status).to.equal('PARTIAL');
    const rows = await SELECT.from('adops.db.ActivationSteps').where({ plan_ID: plan.ID });
    const byType = Object.fromEntries(rows.map((r) => [r.StepType, r.Status]));
    expect(byType.CREATE_PFCG_ROLE).to.equal('FAILED');
    // ADD_SPACE_TO_ROLE depends on the failed role; GENERATE_PROFILE depends
    // on ADD_SPACE_TO_ROLE; the transport depends on the profile.
    expect(byType.ADD_SPACE_TO_ROLE).to.equal('SKIPPED');
    expect(byType.GENERATE_PROFILE).to.equal('SKIPPED');
    expect(byType.ADD_TO_TRANSPORT).to.equal('SKIPPED');
  });

  it('rollup and final status are pure and consistent', () => {
    const steps = [
      { Status: 'SUCCESS' }, { Status: 'WARNING' }, { Status: 'SKIPPED', ExistsAlready: true },
      { Status: 'FAILED' }, { Status: 'PENDING' }
    ];
    expect(planRollup(steps)).to.deep.equal({ SucceededCount: 1, WarningCount: 1, FailedCount: 1, SkippedCount: 1 });
    expect(planFinalStatus(steps)).to.equal('PARTIAL');
    // Exists-already skips complete a plan; dependency skips leave it PARTIAL.
    expect(planFinalStatus([{ Status: 'SUCCESS' }, { Status: 'SKIPPED', ExistsAlready: true }])).to.equal('COMPLETED');
    expect(planFinalStatus([{ Status: 'SUCCESS' }, { Status: 'SKIPPED', ExistsAlready: false }])).to.equal('PARTIAL');
    expect(planFinalStatus([{ Status: 'FAILED' }, { Status: 'PENDING' }])).to.equal('FAILED');
  });
});
