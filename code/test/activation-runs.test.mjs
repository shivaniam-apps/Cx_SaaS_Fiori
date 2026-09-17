import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  runBucket,
  summarizeRunStatuses,
  parseRunOutcome,
  runDurationMs,
  decorateRun,
  ACTIVE_TASK_STATES,
  TERMINAL_TASK_STATES
} = require('../srv/srv/utils/activation-runs.js');

describe('activation runs (monitor shaping)', () => {
  it('buckets every runner status so the KPI partition is complete', () => {
    for (const status of ACTIVE_TASK_STATES) expect(runBucket(status)).to.equal('ACTIVE');
    expect(runBucket('SUCCEEDED')).to.equal('SUCCEEDED');
    expect(runBucket('FAILED')).to.equal('FAILED');
    expect(runBucket('TIMED_OUT')).to.equal('FAILED');
    expect(runBucket('CANCELLED')).to.equal('CANCELLED');
    expect(runBucket('SOMETHING_NEW')).to.equal('OTHER');
    for (const status of TERMINAL_TASK_STATES) expect(runBucket(status)).to.not.equal('ACTIVE');
  });

  it('summarizes grouped status counts into cards that sum to the total', () => {
    const summary = summarizeRunStatuses([
      { Status: 'RUNNING', cnt: 1 },
      { Status: 'QUEUED', cnt: 2 },
      { Status: 'SUCCEEDED', cnt: 5 },
      { Status: 'FAILED', cnt: 1 },
      { Status: 'TIMED_OUT', cnt: 1 },
      { Status: 'CANCELLED', cnt: 3 }
    ]);
    expect(summary).to.deep.equal({ Total: 13, Active: 3, Succeeded: 5, Failed: 2, Cancelled: 3, Other: 0 });
    expect(summary.Active + summary.Succeeded + summary.Failed + summary.Cancelled + summary.Other).to.equal(summary.Total);
    expect(summarizeRunStatuses([])).to.deep.equal({ Total: 0, Active: 0, Succeeded: 0, Failed: 0, Cancelled: 0, Other: 0 });
  });

  it('parses the engine summary from ResultJson and ignores the enqueue payload', () => {
    // Before finishTask the column carries only the payload.
    expect(parseRunOutcome(JSON.stringify({ payload: { planId: 'p1' } }))).to.equal(null);
    expect(parseRunOutcome(null)).to.equal(null);
    expect(parseRunOutcome('not json')).to.equal(null);

    const outcome = parseRunOutcome(JSON.stringify({
      result: { planId: 'p1', status: 'PARTIAL', executedSteps: 4, cancelled: false, SucceededCount: 3, WarningCount: 1, FailedCount: 1, SkippedCount: 2 }
    }));
    expect(outcome).to.deep.equal({
      Status: 'PARTIAL', ExecutedSteps: 4, Cancelled: false,
      SucceededCount: 3, WarningCount: 1, FailedCount: 1, SkippedCount: 2
    });
  });

  it('measures duration from claim to completion and stays null while open', () => {
    expect(runDurationMs({ QueuedAt: '2026-09-15T10:00:00Z', ClaimedAt: '2026-09-15T10:00:05Z', CompletedAt: '2026-09-15T10:01:05Z' })).to.equal(60000);
    // Never claimed (failed at claim) -> falls back to the queue time.
    expect(runDurationMs({ QueuedAt: '2026-09-15T10:00:00Z', CompletedAt: '2026-09-15T10:00:30Z' })).to.equal(30000);
    expect(runDurationMs({ QueuedAt: '2026-09-15T10:00:00Z', ClaimedAt: '2026-09-15T10:00:05Z' })).to.equal(null);
    expect(runDurationMs({ ClaimedAt: 'garbage', CompletedAt: '2026-09-15T10:00:30Z' })).to.equal(null);
  });

  it('decorates a task with labels and never leaks ResultJson', () => {
    const task = {
      ID: 't1', targetSystem_ID: 's1', ObjectId: 'p1', Status: 'SUCCEEDED', Phase: 'Finished: COMPLETED',
      ProgressPercent: 100, ProcessedItems: 6, TotalItems: 6,
      QueuedAt: '2026-09-15T10:00:00Z', ClaimedAt: '2026-09-15T10:00:01Z', CompletedAt: '2026-09-15T10:00:21Z',
      RequestedBy: 'alice', AttemptCount: 1, CancelRequested: false, ErrorText: null,
      ResultJson: JSON.stringify({ payload: { planId: 'p1' }, result: { status: 'COMPLETED', executedSteps: 6, SucceededCount: 5, WarningCount: 1, FailedCount: 0, SkippedCount: 0 } })
    };
    const row = decorateRun(task, {
      plan: { ID: 'p1', Name: 'Activation of Wave 1', Status: 'COMPLETED', StepCount: 6, wave_ID: 'w1', targetSystem_ID: 's1', transportRequest_ID: 'tr1' },
      wave: { ID: 'w1', Name: 'Wave 1' },
      system: { ID: 's1', displayName: 'RD1 DEV', environment: 'DEV' },
      transport: { ID: 'tr1', TransportRequestId: 'RD1K912345' }
    });
    expect(row).to.not.have.property('ResultJson');
    expect(row.Outcome.Status).to.equal('COMPLETED');
    expect(row.Outcome.SucceededCount).to.equal(5);
    expect(row.DurationMs).to.equal(20000);
    expect(row.PlanName).to.equal('Activation of Wave 1');
    expect(row.PlanStatus).to.equal('COMPLETED');
    expect(row.WaveId).to.equal('w1');
    expect(row.WaveName).to.equal('Wave 1');
    expect(row.TargetSystemName).to.equal('RD1 DEV (DEV)');
    expect(row.TransportRequestId).to.equal('RD1K912345');
  });

  it('decorates a run whose plan was deleted without throwing', () => {
    const row = decorateRun({ ID: 't2', ObjectId: 'gone', Status: 'FAILED', ErrorText: 'Activation plan not found.', ResultJson: null }, {});
    expect(row.PlanId).to.equal('gone');
    expect(row.PlanName).to.equal('');
    expect(row.Outcome).to.equal(null);
    expect(row.TargetSystemName).to.equal('');
    expect(row.ErrorText).to.equal('Activation plan not found.');
  });
});
