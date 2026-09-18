import { expect } from 'chai';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const cds = require('@sap/cds');
const { SELECT, INSERT } = cds.ql;
const {
  DATA_SOURCE,
  normalizeDataSource,
  snapshotCoverageFrom,
  monthStartOf,
  windowCoveredBySnapshots,
  coverageLabel,
  dataSourceLogLine
} = require('../srv/srv/utils/snapshot-coverage.js');
const {
  mapTransactionUsage,
  mapUserTransactionUsage,
  dataSourceFilter,
  getBackendCapabilities
} = require('../srv/srv/utils/s4-fiori-adapter.js');
const { runUsageExtraction } = require('../srv/srv/utils/usage-extraction.js');

// ---------------------------------------------------------------------------
// S7: ABAP snapshot collector - the CAP side reads what served a window and
// says so; coverage comes from SystemInfo.
// ---------------------------------------------------------------------------

describe('snapshot coverage (pure)', () => {
  it('normalises the data source and treats an older add-on as LIVE', () => {
    expect(normalizeDataSource('snapshot')).to.equal(DATA_SOURCE.SNAPSHOT);
    expect(normalizeDataSource('LIVE')).to.equal(DATA_SOURCE.LIVE);
    expect(normalizeDataSource('MOCK')).to.equal(DATA_SOURCE.MOCK);
    expect(normalizeDataSource(undefined)).to.equal(DATA_SOURCE.LIVE);
    expect(normalizeDataSource('weird')).to.equal(DATA_SOURCE.LIVE);
  });

  it('reads the coverage from a SystemInfo row, absent fields included', () => {
    const older = snapshotCoverageFrom({ SystemId: 'RD1', AddOnVersion: '0.1.0' });
    expect(older).to.include({ reported: false, available: false, months: 0, jobScheduled: false });

    const none = snapshotCoverageFrom({ SnapshotMonths: 0, SnapshotFrom: null, SnapshotTo: null, CollectorJobScheduled: 'X' });
    expect(none).to.include({ reported: true, available: false, jobScheduled: true });

    const covered = snapshotCoverageFrom({ SnapshotFrom: '2026-01-01', SnapshotTo: '2026-08-31', SnapshotMonths: 8, SnapshotCollectedOn: '2026-09-02', SnapshotCollectedAt: '02:15:00', CollectorJobScheduled: '' });
    expect(covered).to.include({ reported: true, available: true, from: '2026-01-01', to: '2026-08-31', months: 8, collectedOn: '2026-09-02', jobScheduled: false });
  });

  it('decides per month whether a window is served from snapshots', () => {
    const coverage = snapshotCoverageFrom({ SnapshotFrom: '2026-01-01', SnapshotTo: '2026-08-31', SnapshotMonths: 8 });
    expect(monthStartOf('2026-03-17')).to.equal('2026-03-01');
    expect(monthStartOf('20260317')).to.equal('2026-03-01');
    expect(monthStartOf('bad')).to.equal(null);
    expect(windowCoveredBySnapshots(coverage, '2026-02-01', '2026-07-31')).to.equal(true);
    expect(windowCoveredBySnapshots(coverage, '2026-01-15', '2026-08-31')).to.equal(true);
    expect(windowCoveredBySnapshots(coverage, '2025-12-01', '2026-03-31')).to.equal(false);
    expect(windowCoveredBySnapshots(coverage, '2026-06-01', '2026-09-30')).to.equal(false);
    expect(windowCoveredBySnapshots({ available: false }, '2026-02-01', '2026-03-31')).to.equal(false);
  });

  it('labels the coverage and the run-log line per source', () => {
    expect(coverageLabel(snapshotCoverageFrom({}))).to.match(/older than S7/);
    expect(coverageLabel(snapshotCoverageFrom({ SnapshotMonths: 0 }))).to.match(/schedule ZADO_COLLECT_USAGE/);
    expect(coverageLabel(snapshotCoverageFrom({ SnapshotMonths: 0, CollectorJobScheduled: 'X' }))).to.match(/collector job scheduled/);
    const full = coverageLabel(snapshotCoverageFrom({ SnapshotFrom: '2026-01-01', SnapshotTo: '2026-01-31', SnapshotMonths: 1, SnapshotCollectedOn: '2026-02-02', CollectorJobScheduled: 'X' }));
    expect(full).to.equal('Snapshots: 2026-01-01 to 2026-01-31 (1 month) last collected 2026-02-02.');
    expect(coverageLabel(snapshotCoverageFrom({ SnapshotFrom: '2026-01-01', SnapshotTo: '2026-02-28', SnapshotMonths: 2 }))).to.match(/2 months.*collector job NOT scheduled/);

    expect(dataSourceLogLine('SNAPSHOT', { periodFrom: '2026-01-01', periodTo: '2026-06-30' })).to.deep.equal({ level: 'INFO', message: 'Data source: ZADO snapshots (collector tables) for 2026-01-01 to 2026-06-30.' });
    expect(dataSourceLogLine('MOCK').level).to.equal('INFO');
    const live = dataSourceLogLine(undefined, { periodFrom: '2026-01-01', periodTo: '2026-06-30' });
    expect(live.level).to.equal('WARN');
    expect(live.message).to.match(/live ST03N.*ZADO_COLLECT_USAGE/);
  });
});

describe('snapshot coverage: adapter contract (mock-S4 on)', () => {
  it('carries DataSource on the usage rows, LIVE when the add-on sends none', () => {
    expect(mapTransactionUsage({ TransactionCode: 'VA01', ExecutionCount: 3 }).DataSource).to.equal('LIVE');
    expect(mapTransactionUsage({ TransactionCode: 'VA01', DataSource: 'SNAPSHOT' }).DataSource).to.equal('SNAPSHOT');
    expect(mapUserTransactionUsage({ UserKey: 'x', TransactionCode: 'VA01', DataSource: 'snapshot' }).DataSource).to.equal('SNAPSHOT');
    expect(mapUserTransactionUsage({ UserKey: 'x', TransactionCode: 'VA01' }).DataSource).to.equal('LIVE');
  });

  it('forces a source only for the two known values', () => {
    expect(dataSourceFilter('live')).to.equal("DataSource eq 'LIVE'");
    expect(dataSourceFilter('SNAPSHOT')).to.equal("DataSource eq 'SNAPSHOT'");
    expect(dataSourceFilter('AUTO')).to.equal(null);
    expect(dataSourceFilter(undefined)).to.equal(null);
  });

  it('reports snapshot coverage on the mock capabilities', async () => {
    // Standalone runs of this file have no test profile: force the mock.
    process.env.ADOPTOPS_MOCK_S4 = 'true';
    let caps;
    try {
      caps = await getBackendCapabilities({ targetSystem: { destinationName: 'MOCK', environment: 'DEV' } });
    } finally {
      delete process.env.ADOPTOPS_MOCK_S4;
    }
    const coverage = snapshotCoverageFrom(caps);
    expect(coverage).to.include({ reported: true, available: true, months: 12, jobScheduled: true });
    expect(windowCoveredBySnapshots(coverage, '2026-02-01', '2026-06-30')).to.equal(true);
  });
});

describe('snapshot coverage: extraction run log and CAP snapshot header', function () {
  this.timeout(60000);
  const logs = [];
  const log = async (severity, phase, message) => { logs.push({ severity, phase, message }); };

  before(async () => {
    process.env.ADOPTOPS_MOCK_S4 = 'true';
    const model = await cds.load(fileURLToPath(new URL('../db', import.meta.url)));
    await cds.deploy(model).to('sqlite::memory:');
  });
  after(() => { delete process.env.ADOPTOPS_MOCK_S4; });

  it('says what served each ST03N read and keeps it on UsageSnapshots', async () => {
    const targetSystemId = randomUUID();
    const runId = randomUUID();
    await INSERT.into('adops.db.TargetSystems').entries({ ID: targetSystemId, TenantId: 'T', displayName: 'Mock DEV', destinationName: 'MOCK', environment: 'DEV' });
    await INSERT.into('adops.db.ExtractionRuns').entries({ ID: runId, TenantId: 'T', targetSystem_ID: targetSystemId, Title: 'S7', Status: 'QUEUED', Pseudonymised: true });

    await runUsageExtraction({
      task: { ID: randomUUID() },
      payload: { targetSystemId, sources: ['ST03N'], periodFrom: '2026-01-01', periodTo: '2026-03-31', granularity: 'MONTH', topUsersPerTcode: 5, minExecutions: 1, runId },
      reportProgress: async () => {}, log, isCancelRequested: async () => false
    });

    const sourceLines = logs.filter((l) => /^Data source:/.test(l.message));
    expect(sourceLines.map((l) => l.phase)).to.deep.equal(['ST03N', 'USERTCODE']);
    for (const line of sourceLines) expect(line).to.include({ severity: 'INFO' });
    expect(sourceLines[0].message).to.match(/seeded mock/);

    const snapshots = await SELECT.from('adops.db.UsageSnapshots').where({ extractionRun_ID: runId });
    expect(snapshots.length).to.equal(2);
    for (const snapshot of snapshots) expect(snapshot.DataSource).to.equal('MOCK');
  });
});
