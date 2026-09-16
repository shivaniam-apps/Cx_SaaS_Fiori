import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  planBucket,
  summarizePlanStatuses,
  latestRunByPlan,
  decoratePlanRow
} = require('../srv/srv/utils/activation-plans.js');

describe('activation plans (list shaping)', () => {
  it('buckets every plan status so the KPI partition is complete', () => {
    expect(planBucket('DRAFT')).to.equal('DRAFT');
    for (const status of ['SIMULATING', 'SIMULATED', 'READY']) expect(planBucket(status)).to.equal('SIMULATED');
    expect(planBucket('EXECUTING')).to.equal('EXECUTING');
    expect(planBucket('COMPLETED')).to.equal('COMPLETED');
    for (const status of ['PARTIAL', 'FAILED', 'ROLLED_BACK']) expect(planBucket(status)).to.equal('ATTENTION');
    expect(planBucket('SOMETHING_NEW')).to.equal('OTHER');
  });

  it('summarizes grouped status counts into cards that sum to the total', () => {
    const summary = summarizePlanStatuses([
      { Status: 'DRAFT', cnt: 2 },
      { Status: 'SIMULATED', cnt: 3 },
      { Status: 'READY', cnt: 1 },
      { Status: 'EXECUTING', cnt: 1 },
      { Status: 'COMPLETED', cnt: 4 },
      { Status: 'PARTIAL', cnt: 1 },
      { Status: 'FAILED', cnt: 1 },
      { Status: 'WEIRD', count: 1 }
    ]);
    expect(summary).to.deep.equal({ Total: 14, Draft: 2, Simulated: 4, Executing: 1, Completed: 4, Attention: 2, Other: 1 });
    expect(summary.Draft + summary.Simulated + summary.Executing + summary.Completed + summary.Attention + summary.Other)
      .to.equal(summary.Total);
    expect(summarizePlanStatuses([])).to.deep.equal({ Total: 0, Draft: 0, Simulated: 0, Executing: 0, Completed: 0, Attention: 0, Other: 0 });
  });

  it('picks the latest run per plan and lets an active run outrank a finished one', () => {
    const runs = latestRunByPlan([
      { ID: 'r1', ObjectId: 'p1', Status: 'FAILED', QueuedAt: '2026-09-15T10:00:00Z' },
      { ID: 'r2', ObjectId: 'p1', Status: 'SUCCEEDED', QueuedAt: '2026-09-15T11:00:00Z' },
      { ID: 'r3', ObjectId: 'p2', Status: 'FAILED', QueuedAt: '2026-09-15T12:00:00Z' },
      { ID: 'r4', ObjectId: 'p2', Status: 'QUEUED', QueuedAt: '2026-09-15T09:00:00Z' },
      { ID: 'r5', ObjectId: null, Status: 'QUEUED', QueuedAt: '2026-09-15T13:00:00Z' }
    ]);
    expect(runs.get('p1')?.ID).to.equal('r2');
    expect(runs.get('p2')?.ID).to.equal('r4');
    expect(runs.size).to.equal(2);
    expect(latestRunByPlan([]).size).to.equal(0);
  });

  it('decorates a plan with labels and never leaks step rows or keys', () => {
    const row = decoratePlanRow(
      {
        ID: 'p1', Name: 'Activation of Wave 1', Status: 'SIMULATED', StepCount: 9,
        SucceededCount: 8, WarningCount: 1, FailedCount: 0, SkippedCount: 0,
        SimulatedAt: '2026-09-15T10:00:00Z', SimulatedBy: 'alice', createdAt: '2026-09-15T09:00:00Z', createdBy: 'alice',
        wave_ID: 'w1', targetSystem_ID: 's1', transportRequest_ID: 't1', steps: [{ ObjectKeyJson: '{}' }]
      },
      {
        wave: { ID: 'w1', Name: 'Wave 1' },
        system: { ID: 's1', displayName: 'RD1 Development', environment: 'DEV' },
        transport: { ID: 't1', TransportRequestId: 'RD1K900123' },
        run: { ID: 'r1', Status: 'SUCCEEDED', QueuedAt: '2026-09-15T11:00:00Z' }
      }
    );
    expect(row).to.deep.equal({
      ID: 'p1', Name: 'Activation of Wave 1', Description: '', Status: 'SIMULATED', StepCount: 9,
      SucceededCount: 8, WarningCount: 1, FailedCount: 0, SkippedCount: 0,
      SimulatedAt: '2026-09-15T10:00:00Z', SimulatedBy: 'alice', ExecutedAt: null, ExecutedBy: '',
      CreatedAt: '2026-09-15T09:00:00Z', CreatedBy: 'alice',
      WaveId: 'w1', WaveName: 'Wave 1', TargetSystemId: 's1', TargetSystemName: 'RD1 Development (DEV)',
      TransportRequestId: 'RD1K900123', LastRunId: 'r1', LastRunStatus: 'SUCCEEDED', LastRunQueuedAt: '2026-09-15T11:00:00Z'
    });
    expect(row).to.not.have.property('steps');
  });

  it('decorates a plan whose wave was deleted without throwing', () => {
    const row = decoratePlanRow({ ID: 'p1', Name: 'Orphan', Status: 'DRAFT', wave_ID: null, targetSystem_ID: 's1' }, { system: null });
    expect(row.WaveId).to.equal(null);
    expect(row.WaveName).to.equal('');
    expect(row.TargetSystemId).to.equal('s1');
    expect(row.TargetSystemName).to.equal('');
    expect(row.LastRunId).to.equal(null);
    expect(row.StepCount).to.equal(0);
  });
});
