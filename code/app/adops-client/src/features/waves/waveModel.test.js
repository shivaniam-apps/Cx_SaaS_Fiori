import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canBuildPlan,
  membershipLabel,
  simulationLabel,
  groupSteps,
  canExecutePlan,
  executeActionLabel,
  isActivationTargetAllowed,
  defaultActivationTarget
} from './waveModel.js';

test('isActivationTargetAllowed blocks QA/PROD-like environments only', () => {
  for (const environment of ['QAS', 'qa', 'PRD', 'prod', 'Production', 'PREPROD', 'pre-prod']) {
    assert.equal(isActivationTargetAllowed({ environment }), false, environment);
  }
  for (const environment of ['DEV', 'SANDBOX', '', undefined, 'TRAINING']) {
    assert.equal(isActivationTargetAllowed({ environment }), true, String(environment));
  }
  assert.equal(isActivationTargetAllowed(null), true);
});

test('defaultActivationTarget prefers the wave system, then DEV/SANDBOX, then any allowed', () => {
  const dev = { ID: 'dev', environment: 'DEV' };
  const sandbox = { ID: 'sbx', environment: 'SANDBOX' };
  const prod = { ID: 'prd', environment: 'PRD' };
  const unclassified = { ID: 'unk', environment: '' };

  assert.equal(defaultActivationTarget([prod, dev, unclassified], 'unk')?.ID, 'unk');
  assert.equal(defaultActivationTarget([prod, unclassified, dev], 'prd')?.ID, 'dev');
  assert.equal(defaultActivationTarget([prod, unclassified], 'prd')?.ID, 'unk');
  assert.equal(defaultActivationTarget([prod], 'prd'), null);
  assert.equal(defaultActivationTarget([sandbox], undefined)?.ID, 'sbx');
  assert.equal(defaultActivationTarget([], 'x'), null);
});

test('canExecutePlan gates on simulated/ready/resumable states only', () => {
  assert.equal(canExecutePlan(null), false);
  assert.equal(canExecutePlan({ Status: 'DRAFT' }), false);
  assert.equal(canExecutePlan({ Status: 'EXECUTING' }), false);
  assert.equal(canExecutePlan({ Status: 'COMPLETED' }), false);
  for (const Status of ['SIMULATED', 'READY', 'PARTIAL', 'FAILED']) {
    assert.equal(canExecutePlan({ Status }), true, Status);
  }
});

test('executeActionLabel says Resume for partial/failed plans', () => {
  assert.equal(executeActionLabel({ Status: 'SIMULATED' }), 'Execute');
  assert.equal(executeActionLabel({ Status: 'PARTIAL' }), 'Resume');
  assert.equal(executeActionLabel({ Status: 'FAILED' }), 'Resume');
});

test('canBuildPlan requires at least one approved member', () => {
  assert.equal(canBuildPlan(null), false);
  assert.equal(canBuildPlan({ appCount: 3, approved: 0 }), false);
  assert.equal(canBuildPlan({ appCount: 3, approved: 1 }), true);
});

test('membershipLabel reads naturally and omits empty buckets', () => {
  assert.equal(membershipLabel(null), 'No proposals assigned');
  assert.equal(membershipLabel({ appCount: 0 }), 'No proposals assigned');
  assert.equal(membershipLabel({ appCount: 4, approved: 4, open: 0, deferred: 0, rejected: 0 }), '4 apps · 4 approved');
  assert.equal(
    membershipLabel({ appCount: 3, approved: 1, open: 1, deferred: 1, rejected: 0 }),
    '3 apps · 1 approved · 1 open · 1 deferred'
  );
  assert.equal(membershipLabel({ appCount: 1, approved: 0, open: 1 }), '1 app · 0 approved · 1 open');
});

test('simulationLabel is empty before simulation and compact after', () => {
  assert.equal(simulationLabel(null), '');
  assert.equal(simulationLabel({ Status: 'DRAFT' }), '');
  assert.equal(
    simulationLabel({ SimulatedAt: 'x', SucceededCount: 12, WarningCount: 4, FailedCount: 0, SkippedCount: 1 }),
    '12 OK, 4 warnings, 1 skippable'
  );
  assert.equal(
    simulationLabel({ SimulatedAt: 'x', SucceededCount: 5, WarningCount: 1, FailedCount: 2, SkippedCount: 0 }),
    '5 OK, 1 warning, 2 blocked'
  );
});

test('groupSteps preserves first-seen group order and step order within groups', () => {
  const steps = [
    { StepGroup: 'FOUNDATION', SequenceNo: 1 },
    { StepGroup: 'SERVICE', SequenceNo: 2 },
    { StepGroup: 'SERVICE', SequenceNo: 3 },
    { StepGroup: 'CONTENT', SequenceNo: 4 },
    { StepGroup: 'ROLE', SequenceNo: 5 },
    { StepGroup: 'TRANSPORT', SequenceNo: 6 }
  ];
  const groups = groupSteps(steps);
  assert.deepEqual(groups.map((g) => g.group), ['FOUNDATION', 'SERVICE', 'CONTENT', 'ROLE', 'TRANSPORT']);
  assert.deepEqual(groups[1].steps.map((s) => s.SequenceNo), [2, 3]);
  assert.deepEqual(groupSteps([]), []);
  assert.deepEqual(groupSteps(null), []);
});
