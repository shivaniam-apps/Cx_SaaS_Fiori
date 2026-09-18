import { expect } from 'chai';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const cds = require('@sap/cds');
const { SELECT, INSERT } = cds.ql;
const { runCatalogDerivation, availabilityOf, mockCatalogRows, AVAILABILITY } = require('../srv/srv/utils/catalog-derivation.js');
const { mapCatalogApp, mapLaunchpadContent, catalogRoot, probeCatalogEndpoint } = require('../srv/srv/utils/s4-fiori-adapter.js');
const { seedShippedOverlay } = require('../srv/srv/utils/shipped-overlay-catalog.js');
const { buildCandidates } = require('../srv/srv/utils/fiori-candidate-query.js');

// ---------------------------------------------------------------------------
// S9 part 1: backend catalog derivation - the CAP pipeline, the mock
// derivation from the shipped overlay, the catalog endpoint verdict.
// ---------------------------------------------------------------------------

describe('catalog derivation: availability rule (pure)', () => {
  it('judges the three backend states the same way for mock and live rows', () => {
    expect(availabilityOf({ UiComponentState: 'INSTALLED', IcfNodeState: 'ACTIVE', ServiceActivationState: 'ACTIVE' })).to.equal(AVAILABILITY.AVAILABLE);
    expect(availabilityOf({ UiComponentState: 'INSTALLED', IcfNodeState: 'ACTIVE' })).to.equal(AVAILABILITY.AVAILABLE);
    expect(availabilityOf({ UiComponentState: 'MISSING', IcfNodeState: 'ACTIVE', ServiceActivationState: 'ACTIVE' })).to.equal(AVAILABILITY.NOT_INSTALLED);
    expect(availabilityOf({ UiComponentState: 'INSTALLED', IcfNodeState: 'INACTIVE', ServiceActivationState: 'ACTIVE' })).to.equal(AVAILABILITY.MISSING_SERVICE);
    expect(availabilityOf({ UiComponentState: 'INSTALLED', IcfNodeState: 'ACTIVE', ServiceActivationState: 'MISSING' })).to.equal(AVAILABILITY.MISSING_SERVICE);
    expect(availabilityOf({})).to.equal(AVAILABILITY.UNKNOWN);
    expect(availabilityOf({ UiComponentState: 'WEIRD', IcfNodeState: 'ACTIVE' })).to.equal(AVAILABILITY.UNKNOWN);
  });
});

describe('catalog derivation: adapter contract', () => {
  it('maps the CatalogApps and LaunchpadContent rows with defaults', () => {
    const app = mapCatalogApp({ FioriId: 'F3893', AppTitle: 'Manage Sales Orders', BspApplication: 'SD_SO_MANAGES1', UiComponentState: 'INSTALLED', IcfNodeState: 'ACTIVE' });
    expect(app).to.include({ FioriId: 'F3893', AppType: 'SAPUI5', BspApplication: 'SD_SO_MANAGES1', ODataServicesJson: '[]', Availability: '' });
    expect(mapCatalogApp({ ApplId: 'F0842A', Title: 'X' })).to.include({ FioriId: 'F0842A', AppTitle: 'X' });
    const content = mapLaunchpadContent({ ContentType: 'SPACE', ContentId: 'SAP_SD_SPC', Title: 'Sales', ItemCount: '3', IsSapDelivered: 'X' });
    expect(content).to.include({ ContentType: 'SPACE', ContentId: 'SAP_SD_SPC', ItemCount: 3, IsSapDelivered: true, ParentId: '' });
  });

  it('resolves the catalog root from the target system or the default', () => {
    // Same read unit as the usage entities unless a system says otherwise.
    expect(catalogRoot({})).to.match(/zado_usage_srv/);
    expect(catalogRoot({ serviceRootPath: '/sap/opu/odata4/x/usage/0001/' })).to.equal('/sap/opu/odata4/x/usage/0001');
    expect(catalogRoot({ catalogRootPath: '/custom/root/' })).to.equal('/custom/root');
  });

  it('answers OK for the catalog endpoint in mock mode', async () => {
    process.env.ADOPTOPS_MOCK_S4 = 'true';
    try {
      const verdict = await probeCatalogEndpoint({ targetSystem: { destinationName: 'MOCK' } });
      expect(verdict).to.include({ Endpoint: 'CATALOG', Ok: true, Stage: 'OK' });
    } finally {
      delete process.env.ADOPTOPS_MOCK_S4;
    }
  });
});

describe('catalog derivation: mock run fills the backend catalog', function () {
  this.timeout(60000);
  const logs = [];
  const log = async (severity, phase, message) => { logs.push({ severity, phase, message }); };
  const noProgress = async () => {};
  const notCancelled = async () => false;

  before(async () => {
    process.env.ADOPTOPS_MOCK_S4 = 'true';
    const model = await cds.load(fileURLToPath(new URL('../db', import.meta.url)));
    await cds.deploy(model).to('sqlite::memory:');
    await seedShippedOverlay();
  });
  after(() => { delete process.env.ADOPTOPS_MOCK_S4; });

  it('derives one row per overlay app, launchpad content, and replaces the previous catalog', async () => {
    const targetSystemId = randomUUID();
    await INSERT.into('adops.db.TargetSystems').entries({ ID: targetSystemId, TenantId: 'T', displayName: 'Mock DEV', destinationName: 'MOCK', environment: 'DEV' });
    const mocked = await mockCatalogRows();
    expect(mocked.apps.length).to.be.greaterThan(10);
    expect(new Set(mocked.apps.map((a) => a.FioriId)).size).to.equal(mocked.apps.length);
    for (const app of mocked.apps) expect(app.Availability).to.equal('AVAILABLE');

    const runFor = async () => {
      const runId = randomUUID();
      await INSERT.into('adops.db.ExtractionRuns').entries({ ID: runId, TenantId: 'T', targetSystem_ID: targetSystemId, Title: 'Catalog', Status: 'QUEUED', SourcesJson: '["CATALOG"]' });
      const summary = await runCatalogDerivation({ task: { ID: randomUUID() }, payload: { targetSystemId, runId }, reportProgress: noProgress, log, isCancelRequested: notCancelled });
      return { runId, summary };
    };

    const first = await runFor();
    expect(first.summary).to.include({ status: 'COMPLETED', supported: true, apps: mocked.apps.length, content: mocked.content.length });
    const run = await SELECT.one.from('adops.db.ExtractionRuns').where({ ID: first.runId });
    expect(run).to.include({ Status: 'COMPLETED', FioriRowCount: mocked.apps.length });
    const apps = await SELECT.from('adops.db.BackendCatalogApps').where({ targetSystem_ID: targetSystemId });
    expect(apps.length).to.equal(mocked.apps.length);
    expect(apps.every((a) => a.derivationRun_ID === first.runId && a.BspApplication.startsWith('zmock_'))).to.equal(true);
    const content = await SELECT.from('adops.db.BackendLaunchpadContent').where({ targetSystem_ID: targetSystemId });
    expect(content.map((c) => c.ContentType)).to.include.members(['SPACE', 'PAGE', 'CATALOG']);

    // A second derivation replaces, never duplicates.
    const second = await runFor();
    const after = await SELECT.from('adops.db.BackendCatalogApps').where({ targetSystem_ID: targetSystemId });
    expect(after.length).to.equal(mocked.apps.length);
    expect(after.every((a) => a.derivationRun_ID === second.runId)).to.equal(true);
    expect(logs.some((l) => /Previous catalog replaced/.test(l.message))).to.equal(true);
  });

  it('lets the proposal engine answer availability instead of UNKNOWN', async () => {
    const targetSystemId = randomUUID();
    await INSERT.into('adops.db.TargetSystems').entries({ ID: targetSystemId, TenantId: 'T', displayName: 'Mock DEV 2', destinationName: 'MOCK', environment: 'DEV' });
    const runId = randomUUID();
    await INSERT.into('adops.db.ExtractionRuns').entries({ ID: runId, TenantId: 'T', targetSystem_ID: targetSystemId, Title: 'Catalog', Status: 'QUEUED', SourcesJson: '["CATALOG"]' });
    await runCatalogDerivation({ task: { ID: randomUUID() }, payload: { targetSystemId, runId }, reportProgress: noProgress, log, isCancelRequested: notCancelled });

    // A usage run with one VA01 snapshot row: the candidate F3893 is AVAILABLE.
    const usageRunId = randomUUID();
    const snapshotId = randomUUID();
    await INSERT.into('adops.db.ExtractionRuns').entries({ ID: usageRunId, TenantId: 'T', targetSystem_ID: targetSystemId, Title: 'Usage', Status: 'COMPLETED', SourcesJson: '["ST03N"]' });
    await INSERT.into('adops.db.UsageSnapshots').entries({ ID: snapshotId, TenantId: 'T', extractionRun_ID: usageRunId, targetSystem_ID: targetSystemId, Source: 'ST03N', PeriodFrom: '2026-01-01', PeriodTo: '2026-06-30' });
    await INSERT.into('adops.db.TransactionUsage').entries({ ID: randomUUID(), TenantId: 'T', snapshot_ID: snapshotId, targetSystem_ID: targetSystemId, TransactionCode: 'VA01', ExecutionCount: 120, DistinctUserCount: 4, LineOfBusiness: 'SD', PeriodFrom: '2026-01-01', PeriodTo: '2026-06-30' });

    const { candidates } = await buildCandidates({ runId: usageRunId });
    const candidate = candidates.find((c) => c.fioriId === 'F3893');
    expect(candidate, candidates.map((c) => c.fioriId).join(',')).to.exist;
    expect(candidate.availability).to.equal('AVAILABLE');
  });
});
