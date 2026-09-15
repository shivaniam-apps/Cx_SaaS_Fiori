import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRunActive,
  isRunTerminal,
  progressLabel,
  runPhaseLabel,
  outcomeLabel,
  durationLabel,
  stepDurationLabel,
  formatTimestamp,
  canResumeRun,
  canCancelRun,
  summaryCards,
  shouldRefetchStepMessages
} from './runModel.js';

test('isRunActive / isRunTerminal split the runner states', () => {
  for (const Status of ['QUEUED', 'CLAIMED', 'RUNNING']) {
    assert.equal(isRunActive({ Status }), true, Status);
    assert.equal(isRunTerminal({ Status }), false, Status);
  }
  for (const Status of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']) {
    assert.equal(isRunActive({ Status }), false, Status);
    assert.equal(isRunTerminal({ Status }), true, Status);
  }
  assert.equal(isRunActive(null), false);
  assert.equal(isRunTerminal(undefined), false);
});

test('progressLabel prefers item counts, then percent, else empty', () => {
  assert.equal(progressLabel({ ProcessedItems: 3, TotalItems: 9 }), '3/9 steps');
  assert.equal(progressLabel({ TotalItems: 9 }), '0/9 steps');
  assert.equal(progressLabel({ ProgressPercent: 40 }), '40%');
  assert.equal(progressLabel({ ProgressPercent: 0 }), '0%');
  assert.equal(progressLabel({}), '');
  assert.equal(progressLabel(null), '');
});

test('runPhaseLabel shows the phase while active and the verdict afterwards', () => {
  assert.equal(runPhaseLabel({ Status: 'RUNNING', Phase: 'Step 2/6: CREATE_SPACE ZADO_W1' }), 'Step 2/6: CREATE_SPACE ZADO_W1');
  assert.equal(runPhaseLabel({ Status: 'RUNNING', Phase: 'Step 2/6', CancelRequested: true }), 'Cancel requested · Step 2/6');
  assert.equal(runPhaseLabel({ Status: 'QUEUED' }), 'Queued - waiting for a worker');
  assert.equal(runPhaseLabel({ Status: 'CLAIMED' }), 'Starting');
  assert.equal(runPhaseLabel({ Status: 'SUCCEEDED', Outcome: { Status: 'PARTIAL' } }), 'Plan PARTIAL');
  assert.equal(runPhaseLabel({ Status: 'FAILED', ErrorText: 'Activation plan not found.' }), 'Activation plan not found.');
  assert.equal(runPhaseLabel(null), '');
});

test('outcomeLabel renders verdict counts, progress while active, or the pre-engine failure hint', () => {
  assert.equal(
    outcomeLabel({ Status: 'SUCCEEDED', Outcome: { SucceededCount: 5, WarningCount: 1, FailedCount: 1, SkippedCount: 2 } }),
    '5 OK · 1 warning · 1 failed · 2 skipped'
  );
  assert.equal(outcomeLabel({ Status: 'SUCCEEDED', Outcome: { SucceededCount: 6, WarningCount: 2 } }), '6 OK · 2 warnings');
  assert.equal(outcomeLabel({ Status: 'RUNNING', ProcessedItems: 1, TotalItems: 4 }), '1/4 steps');
  assert.equal(outcomeLabel({ Status: 'FAILED', ErrorText: 'boom' }), 'Failed before the first step');
  assert.equal(outcomeLabel({ Status: 'CANCELLED' }), '—');
});

test('durationLabel scales units and treats missing values as a dash', () => {
  assert.equal(durationLabel(null), '—');
  assert.equal(durationLabel(undefined), '—');
  assert.equal(durationLabel(-5), '—');
  assert.equal(durationLabel(400), '<1 s');
  assert.equal(durationLabel(12000), '12 s');
  assert.equal(durationLabel(200000), '3 min 20 s');
  assert.equal(durationLabel(3900000), '1 h 5 min');
});

test('stepDurationLabel shows running, measured duration, or a dash', () => {
  assert.equal(stepDurationLabel({ Status: 'RUNNING' }), 'running');
  assert.equal(stepDurationLabel({ Status: 'SUCCESS', CompletedAt: '2026-09-15T10:00:00Z', DurationMs: 2500 }), '3 s');
  assert.equal(stepDurationLabel({ Status: 'PENDING' }), '—');
  assert.equal(stepDurationLabel(null), '—');
});

test('formatTimestamp trims ISO strings to minute precision', () => {
  assert.equal(formatTimestamp('2026-09-15T10:03:22.123Z'), '2026-09-15 10:03');
  assert.equal(formatTimestamp(''), '');
  assert.equal(formatTimestamp(null), '');
});

test('canResumeRun follows the plan status and never fires while a run is active', () => {
  assert.equal(canResumeRun({ Status: 'SUCCEEDED', PlanStatus: 'PARTIAL' }), true);
  assert.equal(canResumeRun({ Status: 'FAILED', PlanStatus: 'FAILED' }), true);
  assert.equal(canResumeRun({ Status: 'CANCELLED', PlanStatus: 'PARTIAL' }), true);
  assert.equal(canResumeRun({ Status: 'RUNNING', PlanStatus: 'PARTIAL' }), false);
  assert.equal(canResumeRun({ Status: 'SUCCEEDED', PlanStatus: 'COMPLETED' }), false);
  assert.equal(canResumeRun({ Status: 'SUCCEEDED', PlanStatus: '' }), false);
  assert.equal(canResumeRun(null), false);
});

test('canCancelRun only while active and not yet requested', () => {
  assert.equal(canCancelRun({ Status: 'RUNNING', CancelRequested: false }), true);
  assert.equal(canCancelRun({ Status: 'QUEUED', CancelRequested: false }), true);
  assert.equal(canCancelRun({ Status: 'RUNNING', CancelRequested: true }), false);
  assert.equal(canCancelRun({ Status: 'SUCCEEDED', CancelRequested: false }), false);
  assert.equal(canCancelRun(null), false);
});

test('summaryCards partition the total exactly and hide Other when zero', () => {
  const summary = { Total: 11, Active: 2, Succeeded: 6, Failed: 2, Cancelled: 1, Other: 0 };
  const cards = summaryCards(summary);
  assert.deepEqual(cards.map((c) => c.key), ['ACTIVE', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
  assert.equal(cards.reduce((sum, c) => sum + c.value, 0), summary.Total);

  const withOther = summaryCards({ ...summary, Total: 12, Other: 1 });
  assert.equal(withOther.at(-1).key, 'OTHER');
  assert.equal(withOther.reduce((sum, c) => sum + c.value, 0), 12);

  assert.equal(summaryCards(null).reduce((sum, c) => sum + c.value, 0), 0);
});

test('shouldRefetchStepMessages re-fetches while RUNNING and once on leaving RUNNING', () => {
  assert.equal(shouldRefetchStepMessages({ Status: 'PENDING' }, { Status: 'RUNNING' }), true);
  assert.equal(shouldRefetchStepMessages({ Status: 'RUNNING' }, { Status: 'RUNNING' }), true);
  assert.equal(shouldRefetchStepMessages({ Status: 'RUNNING' }, { Status: 'SUCCESS' }), true);
  assert.equal(shouldRefetchStepMessages({ Status: 'SUCCESS' }, { Status: 'SUCCESS' }), false);
  assert.equal(shouldRefetchStepMessages({ Status: 'PENDING' }, { Status: 'PENDING' }), false);
  assert.equal(shouldRefetchStepMessages({ Status: 'RUNNING' }, null), false);
});
