import { expect } from 'chai';
import { createRequire } from 'node:module';
import { test, cds, as, expectInMemoryDb } from './helpers/cds-http-test.mjs';

const require = createRequire(import.meta.url);
const { PARTITIONS, partition, bucketStatuses, shapeDashboardSummary } = require('../srv/srv/utils/dashboard-summary.js');
const { statusesForRunBucket } = require('../srv/srv/utils/activation-runs.js');

describe('dashboard summary (shaping)', () => {
  it('partitions grouped counts into buckets that sum to the total', () => {
    const p = partition('proposals', [
      { ReviewStatus: 'NEW', cnt: 4 },
      { ReviewStatus: 'IN_REVIEW', cnt: 1 },
      { ReviewStatus: 'APPROVED', cnt: 3 },
      { ReviewStatus: 'SUPERSEDED', cnt: 2 },
      { ReviewStatus: 'WEIRD', cnt: 1 },
      { ReviewStatus: 'REJECTED', cnt: 0 }
    ]);
    expect(p).to.deep.equal({ Total: 11, Open: 5, Approved: 3, Rejected: 0, Deferred: 0, NoPath: 2, Other: 1 });
    expect(Object.keys(p).filter((k) => k !== 'Total').reduce((sum, k) => sum + p[k], 0)).to.equal(p.Total);
  });

  it('puts never-checked systems into Unchecked and is case-insensitive', () => {
    const p = partition('systems', [{ lastCheckStatus: null, cnt: 2 }, { lastCheckStatus: 'ok', cnt: 1 }, { lastCheckStatus: 'SERVICE', cnt: 1 }]);
    expect(p).to.deep.equal({ Total: 4, Healthy: 1, Attention: 1, Unchecked: 2, Other: 0 });
    expect(partition('systems', [])).to.deep.equal({ Total: 0, Healthy: 0, Attention: 0, Unchecked: 0, Other: 0 });
    expect(() => partition('nope', [])).to.throw(/Unknown dashboard partition/);
  });

  it('every partition covers its status vocabulary without overlap', () => {
    for (const [kind, spec] of Object.entries(PARTITIONS)) {
      const all = Object.values(spec.buckets).flat();
      expect(new Set(all).size, `${kind} buckets overlap`).to.equal(all.length);
    }
  });

  it('bucketStatuses is the shared expression behind a card and its list slice', () => {
    expect(bucketStatuses('transports', 'open')).to.deep.equal(['MODIFIABLE', 'RELEASING']);
    expect(bucketStatuses('proposals', 'OPEN')).to.deep.equal(['NEW', 'IN_REVIEW']);
    expect(bucketStatuses('proposals', 'NoPath')).to.deep.equal(['SUPERSEDED']);
    expect(bucketStatuses('transports', 'bogus')).to.equal(null);
    expect(bucketStatuses('nope', 'Open')).to.equal(null);
    // Run buckets live with the monitor; the dashboard reuses them.
    expect(statusesForRunBucket('FAILED')).to.deep.equal(['FAILED', 'TIMED_OUT']);
    expect(statusesForRunBucket('active')).to.include('RUNNING');
    expect(statusesForRunBucket('other')).to.equal(null);
  });

  it('shapes the full summary with scope and timestamp', () => {
    const summary = shapeDashboardSummary(
      { systems: [], extractions: [{ Status: 'COMPLETED', cnt: 2 }], analyses: [], proposals: [], waves: [], plans: [], runs: [{ Status: 'FAILED', cnt: 1 }], transports: [] },
      { targetSystemId: 'sys-1', analysisRunIds: ['run-1'] }
    );
    expect(summary.Scope).to.deep.equal({ TargetSystemId: 'sys-1', AnalysisRunIds: ['run-1'] });
    expect(summary.Extractions.Completed).to.equal(2);
    expect(summary.Runs.Failed).to.equal(1);
    expect(summary.GeneratedAt).to.match(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('queryDashboardSummary (HTTP)', () => {
  const SYS_A = '11111111-1111-4111-8111-111111111111';
  const SYS_B = '22222222-2222-4222-8222-222222222222';
  const RUN_A_OLD = '33333333-3333-4333-8333-333333333331';
  const RUN_A_NEW = '33333333-3333-4333-8333-333333333332';
  const RUN_B = '33333333-3333-4333-8333-333333333333';

  // The in-memory db is shared with every other HTTP suite in the process,
  // so the unscoped read is asserted as deltas against a baseline taken
  // before this suite's fixtures land.
  let baseline;
  const read = async (args = '') => JSON.parse((await test.get(`/fiori/queryDashboardSummary(${args})`, as('carol'))).data.value);
  const delta = (after, before, section) => Object.fromEntries(Object.keys(after[section]).map((k) => [k, after[section][k] - (before[section]?.[k] || 0)]));

  before(async () => {
    expectInMemoryDb();
    baseline = await read();
    const db = cds.db;
    await db.run(INSERT.into('adops.db.TargetSystems').entries([
      { ID: SYS_A, displayName: 'A', destinationName: 'DASH_A_100', environment: 'DEV', lastCheckStatus: 'OK', TenantId: 'GLOBAL' },
      { ID: SYS_B, displayName: 'B', destinationName: 'DASH_B_200', environment: 'QAS', TenantId: 'GLOBAL' }
    ]));
    await db.run(INSERT.into('adops.db.AnalysisRuns').entries([
      { ID: RUN_A_OLD, targetSystem_ID: SYS_A, Status: 'COMPLETED', CompletedAt: '2026-09-01T00:00:00Z', TenantId: 'GLOBAL' },
      { ID: RUN_A_NEW, targetSystem_ID: SYS_A, Status: 'COMPLETED', CompletedAt: '2026-09-10T00:00:00Z', TenantId: 'GLOBAL' },
      { ID: RUN_B, targetSystem_ID: SYS_B, Status: 'FAILED', TenantId: 'GLOBAL' }
    ]));
    await db.run(INSERT.into('adops.db.AppProposals').entries([
      { analysisRun_ID: RUN_A_OLD, targetSystem_ID: SYS_A, FioriId: 'F0001', ReviewStatus: 'NEW', TenantId: 'GLOBAL' },
      { analysisRun_ID: RUN_A_NEW, targetSystem_ID: SYS_A, FioriId: 'F0002', ReviewStatus: 'NEW', TenantId: 'GLOBAL' },
      { analysisRun_ID: RUN_A_NEW, targetSystem_ID: SYS_A, FioriId: 'F0003', ReviewStatus: 'APPROVED', TenantId: 'GLOBAL' }
    ]));
    await db.run(INSERT.into('adops.db.TransportRequests').entries([
      { targetSystem_ID: SYS_A, TransportRequestId: 'A4HK900001', Status: 'MODIFIABLE', TenantId: 'GLOBAL' },
      { targetSystem_ID: SYS_A, TransportRequestId: 'A4HK900002', Status: 'RELEASED', TenantId: 'GLOBAL' },
      { targetSystem_ID: SYS_B, TransportRequestId: 'B4HK900001', Status: 'RELEASE_FAILED', TenantId: 'GLOBAL' }
    ]));
    await db.run(INSERT.into('adops.db.BackgroundTasks').entries([
      { targetSystem_ID: SYS_A, TaskType: 'ACTIVATION_EXECUTION', Status: 'FAILED', TenantId: 'GLOBAL' },
      { targetSystem_ID: SYS_A, TaskType: 'USAGE_EXTRACTION', Status: 'FAILED', TenantId: 'GLOBAL' }
    ]));
  });

  it('counts every stage at the database and scopes proposals to the current analysis run', async () => {
    const { status, data } = await test.get('/fiori/queryDashboardSummary()', as('carol'));
    expect(status).to.equal(200);
    const summary = JSON.parse(data.value);
    expect(delta(summary, baseline, 'Systems')).to.include({ Total: 2, Healthy: 1, Unchecked: 1 });
    expect(delta(summary, baseline, 'Analyses')).to.include({ Total: 3, Completed: 2, Failed: 1 });
    // Only RUN_A_NEW is current for system A (system B has no completed run).
    expect(summary.Scope.AnalysisRunIds).to.include(RUN_A_NEW);
    expect(summary.Scope.AnalysisRunIds).to.not.include(RUN_A_OLD);
    expect(delta(summary, baseline, 'Proposals')).to.include({ Total: 2, Open: 1, Approved: 1 });
    expect(delta(summary, baseline, 'Transports')).to.include({ Total: 3, Open: 1, Released: 1, Failed: 1 });
    // Only activation executions count as runs.
    expect(delta(summary, baseline, 'Runs')).to.include({ Total: 1, Failed: 1 });
  });

  it('honours the target-system scope', async () => {
    const { status, data } = await test.get(`/fiori/queryDashboardSummary(targetSystemId=${SYS_B})`, as('carol'));
    expect(status).to.equal(200);
    const summary = JSON.parse(data.value);
    expect(summary.Scope.TargetSystemId).to.equal(SYS_B);
    expect(summary.Systems).to.include({ Total: 1, Unchecked: 1 });
    expect(summary.Scope.AnalysisRunIds).to.deep.equal([]);
    expect(summary.Proposals.Total).to.equal(0);
    expect(summary.Transports).to.include({ Total: 1, Failed: 1 });
  });

  it('slices the list reads by the same buckets', async () => {
    const open = JSON.parse((await test.get(`/fiori/queryTransportRequests(targetSystemId=${SYS_A},status='open')`, as('carol'))).data.value);
    expect(open.Items.map((t) => t.TransportRequestId)).to.deep.equal(['A4HK900001']);
    const failedRuns = JSON.parse((await test.get(`/fiori/queryActivationRuns(targetSystemId=${SYS_A},status='FAILED')`, as('carol'))).data.value);
    expect(failedRuns.Items).to.have.length(1);
    expect(failedRuns.Summary).to.include({ Total: 1, Failed: 1 });
    const bogus = await test.get(`/fiori/queryTransportRequests(status='bogus')`, as('carol'));
    expect(bogus.status).to.equal(400);
  });
});
