import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotCoverageFrom, coverageBadge } from './snapshotCoverage.js';

const FULL = { AddOnVersion: '0.2.0', SnapshotFrom: '2026-01-01', SnapshotTo: '2026-12-31', SnapshotMonths: 12, SnapshotCollectedOn: '2026-09-18', SnapshotCollectedAt: '02:15:00', CollectorJobScheduled: 'X' };

test('coverage is derived from the SystemInfo fields and detects an old add-on', () => {
  const c = snapshotCoverageFrom(FULL);
  assert.equal(c.reported, true);
  assert.equal(c.available, true);
  assert.equal(c.months, 12);
  assert.equal(c.jobScheduled, true);
  assert.equal(c.addOnVersion, '0.2.0');
  const old = snapshotCoverageFrom({ AddOnVersion: '0.1.0', CollectorRunning: true });
  assert.equal(old.reported, false);
  assert.equal(old.available, false);
  assert.equal(snapshotCoverageFrom(null).reported, false);
  assert.equal(snapshotCoverageFrom({ SnapshotMonths: 0, CollectorJobScheduled: true }).jobScheduled, true);
});

test('the badge tells the four states apart', () => {
  assert.equal(coverageBadge(null).design, 'Information');
  assert.equal(coverageBadge(snapshotCoverageFrom({ AddOnVersion: '0.1.0' })).label, 'Live usage reads');
  assert.equal(coverageBadge(snapshotCoverageFrom({ SnapshotMonths: 0, CollectorJobScheduled: 'X' })).label, 'Snapshots pending');
  const none = coverageBadge(snapshotCoverageFrom({ SnapshotMonths: 0 }));
  assert.equal(none.label, 'No snapshots');
  assert.match(none.detail, /ZADO_COLLECT_USAGE/);
  const ok = coverageBadge(snapshotCoverageFrom(FULL));
  assert.deepEqual([ok.label, ok.design], ['Snapshots 12 mo', 'Positive']);
  assert.match(ok.detail, /2026-01-01 to 2026-12-31 \(12 months\), last collected 2026-09-18 02:15:00/);
  const stale = coverageBadge(snapshotCoverageFrom({ ...FULL, CollectorJobScheduled: '' }));
  assert.equal(stale.design, 'Critical');
  assert.match(stale.label, /job missing/);
  assert.equal(coverageBadge(snapshotCoverageFrom({ ...FULL, SnapshotMonths: 1 })).label, 'Snapshots 1 mo');
});
