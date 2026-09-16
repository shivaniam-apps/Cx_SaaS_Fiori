import { test } from 'node:test';
import assert from 'node:assert/strict';
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
} from './planModel.js';

test('canSimulatePlan mirrors the server rule: DRAFT or SIMULATED only', () => {
  assert.equal(canSimulatePlan({ Status: 'DRAFT' }), true);
  assert.equal(canSimulatePlan({ Status: 'SIMULATED' }), true);
  for (const Status of ['SIMULATING', 'READY', 'EXECUTING', 'COMPLETED', 'PARTIAL', 'FAILED', 'ROLLED_BACK']) {
    assert.equal(canSimulatePlan({ Status }), false, Status);
  }
  assert.equal(canSimulatePlan(null), false);
});

test('simulateActionLabel says Re-simulate once a simulation ran', () => {
  assert.equal(simulateActionLabel({ Status: 'DRAFT' }), 'Simulate');
  assert.equal(simulateActionLabel({ Status: 'SIMULATED', SimulatedAt: '2026-09-16T08:00:00Z' }), 'Re-simulate');
  assert.equal(simulateActionLabel(null), 'Simulate');
});

test('canShowManifest hides the replay runbook for drafts', () => {
  assert.equal(canShowManifest({ Status: 'DRAFT' }), false);
  assert.equal(canShowManifest({ Status: 'SIMULATED' }), true);
  assert.equal(canShowManifest({ Status: 'COMPLETED' }), true);
  assert.equal(canShowManifest(undefined), false);
});

test('activeRun / latestRun prefer an active run, else the newest, else null', () => {
  const finished = { ID: 'r-new', Status: 'SUCCEEDED' };
  const older = { ID: 'r-old', Status: 'FAILED' };
  const queued = { ID: 'r-q', Status: 'QUEUED' };
  assert.equal(activeRun([finished, older]), null);
  assert.equal(latestRun([finished, older])?.ID, 'r-new');
  assert.equal(activeRun([finished, queued])?.ID, 'r-q');
  assert.equal(latestRun([finished, queued])?.ID, 'r-q');
  assert.equal(latestRun([]), null);
  assert.equal(latestRun(undefined), null);
});

test('runRowLabel shows phase, error or duration from raw task columns', () => {
  assert.equal(runRowLabel({ Status: 'RUNNING', Phase: 'Step 2/9' }), 'Step 2/9');
  assert.equal(runRowLabel({ Status: 'QUEUED' }), '');
  assert.equal(runRowLabel({ Status: 'FAILED', ErrorText: 'Worker died' }), 'Worker died');
  assert.equal(runRowLabel({ Status: 'SUCCEEDED', ClaimedAt: '2026-09-16T10:00:00Z', CompletedAt: '2026-09-16T10:01:30Z' }), '1 min 30 s');
  assert.equal(runRowLabel({ Status: 'CANCELLED', ClaimedAt: null, CompletedAt: '2026-09-16T10:01:30Z' }), '—');
  assert.equal(runRowLabel(null), '');
});

test('hasActiveRun drives the polling terminal check', () => {
  assert.equal(hasActiveRun({ Runs: [{ Status: 'RUNNING' }] }), true);
  assert.equal(hasActiveRun({ Runs: [{ Status: 'SUCCEEDED' }] }), false);
  assert.equal(hasActiveRun({}), false);
  assert.equal(hasActiveRun(null), false);
});

test('wavesEligibleForPlan keeps only waves with approved proposals', () => {
  const waves = [
    { ID: 'w1', Rollup: { appCount: 3, approved: 2 } },
    { ID: 'w2', Rollup: { appCount: 3, approved: 0 } },
    { ID: 'w3', Rollup: null },
    { ID: 'w4' }
  ];
  assert.deepEqual(wavesEligibleForPlan(waves).map((w) => w.ID), ['w1']);
  assert.deepEqual(wavesEligibleForPlan(undefined), []);
});

test('defaultPlanName mirrors the server default', () => {
  assert.equal(defaultPlanName({ Name: 'Finance wave 1' }), 'Activation of Finance wave 1');
  assert.equal(defaultPlanName(null), '');
});

test('planPhaseLabel reports the run phase while active, else the lifecycle verdict', () => {
  const simulated = { Status: 'SIMULATED', SimulatedAt: 'x', SucceededCount: 8, WarningCount: 1, FailedCount: 0, SkippedCount: 0 };
  assert.equal(planPhaseLabel(simulated, null), 'Simulated: 8 OK, 1 warning');
  assert.equal(planPhaseLabel(simulated, { Status: 'QUEUED' }), 'Queued - waiting for a worker');
  assert.equal(planPhaseLabel(simulated, { Status: 'RUNNING', Phase: 'Step 3/9', CancelRequested: true }), 'Cancel requested · Step 3/9');
  assert.equal(planPhaseLabel(simulated, { Status: 'SUCCEEDED', Phase: 'Done' }), 'Simulated: 8 OK, 1 warning');
  assert.match(planPhaseLabel({ Status: 'DRAFT' }), /^Draft/);
  assert.equal(planPhaseLabel({ Status: 'SIMULATED' }), 'Simulated');
  assert.equal(planPhaseLabel({ Status: 'COMPLETED', SimulatedAt: 'x', SucceededCount: 9 }), 'Completed: 9 OK');
  assert.equal(planPhaseLabel({ Status: 'PARTIAL', SimulatedAt: 'x', SucceededCount: 4, FailedCount: 1 }), 'Partially executed: 4 OK, 1 blocked - Resume skips completed steps');
  assert.equal(planPhaseLabel({ Status: 'FAILED' }), 'Failed - Resume skips completed steps');
  assert.equal(planPhaseLabel({ Status: 'ROLLED_BACK' }), 'Rolled back');
  assert.equal(planPhaseLabel({ Status: 'WEIRD' }), 'WEIRD');
  assert.equal(planPhaseLabel(null), '');
});

test('planStripDesign colours the phase line by outcome', () => {
  assert.equal(planStripDesign({ Status: 'FAILED' }, null), 'Negative');
  assert.equal(planStripDesign({ Status: 'ROLLED_BACK' }, null), 'Negative');
  assert.equal(planStripDesign({ Status: 'PARTIAL' }, null), 'Critical');
  assert.equal(planStripDesign({ Status: 'EXECUTING' }, null), 'Critical');
  assert.equal(planStripDesign({ Status: 'COMPLETED' }, null), 'Positive');
  assert.equal(planStripDesign({ Status: 'SIMULATED', FailedCount: 0 }, null), 'Positive');
  assert.equal(planStripDesign({ Status: 'SIMULATED', FailedCount: 2 }, null), 'Critical');
  assert.equal(planStripDesign({ Status: 'DRAFT' }, null), 'Information');
  assert.equal(planStripDesign({ Status: 'FAILED' }, { Status: 'RUNNING' }), 'Information');
  assert.equal(planStripDesign(null, null), 'Information');
});

test('summaryCards partition the total and only add Other when needed', () => {
  const cards = summaryCards({ Total: 10, Draft: 2, Simulated: 3, Executing: 1, Completed: 3, Attention: 1, Other: 0 });
  assert.deepEqual(cards.map((c) => c.key), ['DRAFT', 'SIMULATED', 'EXECUTING', 'COMPLETED', 'ATTENTION']);
  assert.equal(cards.reduce((sum, c) => sum + c.value, 0), 10);
  const withOther = summaryCards({ Total: 1, Other: 1 });
  assert.equal(withOther.at(-1).key, 'OTHER');
  assert.equal(withOther.reduce((sum, c) => sum + c.value, 0), 1);
  assert.equal(summaryCards(undefined).reduce((sum, c) => sum + c.value, 0), 0);
});
