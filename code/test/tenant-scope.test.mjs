// Logical tenant scoping on the shared-database tiers (roadmap A5).
//
// Two mocked users carry different tenants; what one writes, the other must
// not read, count or alter, while GLOBAL rows (written without a tenant)
// stay visible to both. Covers the generic OData path (projections on all
// three services) and the handlers that issue CQN against adops.db.*
// directly: access requests, telemetry ingestion and summaries, settings.
import { expect } from 'chai';
import { cds, test, as, json, expectInMemoryDb } from './helpers/cds-http-test.mjs';

// Tenant users must exist before the shared server starts (root hook).
// Mocked users drop their `tenant` attribute while cds.requires.multitenancy
// is off (mocked-users.js), so the tenant is assigned the way the XSUAA
// strategy does it in production (ctx.tenant = zone id): a middleware
// after auth, keyed by user id. Test-process only.
const TENANT_OF = { 'ta-admin': 'tenant-a', 'ta-member': 'tenant-a', 'tb-admin': 'tenant-b' };
Object.assign(cds.env.requires.auth.users, {
  'ta-admin': { roles: ['Admin', 'Approver', 'Activator', 'Member'] },
  'tb-admin': { roles: ['Admin', 'Approver', 'Activator', 'Member'] },
  'ta-member': { roles: ['Member'] }
});
cds.middlewares.add((req, _res, next) => {
  const tenant = TENANT_OF[cds.context?.user?.id];
  if (tenant) cds.context.tenant = tenant;
  next();
}, { after: 'auth' });

const ADMIN = '/catalog/AdminService';
const CORE = '/core';

async function rows(user, url) {
  const response = await test.axios.get(url, as(user));
  expect(response.status, `${user} GET ${url}: ${JSON.stringify(response.data)}`).to.equal(200);
  return response.data.value;
}

describe('tenant scoping', function () {
  this.timeout(30000);

  const ids = {};

  before(async () => {
    expectInMemoryDb();

    // tenant-a writes one row of everything; alice (no tenant) writes GLOBAL rows.
    const system = await test.axios.post('/fiori/TargetSystems', {
      displayName: 'Tenant A system', destinationName: 'TA_DEV', systemId: 'TAA', client: '100', environment: 'DEV'
    }, json('ta-admin'));
    expect(system.status, JSON.stringify(system.data)).to.equal(201);
    ids.systemA = system.data.ID;

    const globalSystem = await test.axios.post('/fiori/TargetSystems', {
      displayName: 'Shared system', destinationName: 'SHARED', systemId: 'SHR', client: '100', environment: 'DEV'
    }, json('alice'));
    expect(globalSystem.status).to.equal(201);
    ids.systemGlobal = globalSystem.data.ID;

    const request = await test.axios.post(`${CORE}/submitAccessRequest`, {
      requestedArea: 'settings', requestedRole: 'Admin', justification: 'tenant a needs settings', urgency: 'NORMAL'
    }, json('ta-member'));
    expect(request.status, JSON.stringify(request.data)).to.equal(200);
    ids.requestA = request.data.ID;

    const error = await test.axios.post(`${CORE}/recordClientError`, {
      errorType: 'RENDER_ERROR', errorMessage: 'tenant a crashed', route: '/settings', severity: 'ERROR'
    }, json('ta-member'));
    expect(error.status, JSON.stringify(error.data)).to.equal(200);
    expect(error.data.received).to.equal(true);

    const batch = await test.axios.post(`${CORE}/recordTelemetryBatch`, {
      sessionId: 'sess-a', appVersion: '0.1.0',
      usageEvents: [{ timestamp: new Date().toISOString(), eventName: 'page_view', eventCategory: 'nav', route: '/settings', feature: 'settings', action: 'open', outcome: 'ok' }],
      performanceEvents: [{ timestamp: new Date().toISOString(), source: 'CLIENT', operationName: 'route:/settings', routeOrEndpoint: '/settings', durationMs: 900, thresholdMs: 500, outcome: 'SLOW' }]
    }, json('ta-member'));
    expect(batch.status, JSON.stringify(batch.data)).to.equal(200);
    expect(batch.data.acceptedUsage).to.equal(1);
    expect(batch.data.acceptedPerformance).to.equal(1);

    const settings = await test.axios.post(`${ADMIN}/updateTelemetrySettings`, { samplingPercent: 42 }, json('ta-admin'));
    expect(settings.status, JSON.stringify(settings.data)).to.equal(200);
  });

  it('stamps the writer tenant on every scoped row', async () => {
    const system = await SELECT.one.from('adops.db.TargetSystems').where({ ID: ids.systemA });
    expect(system.TenantId).to.equal('tenant-a');
    const request = await SELECT.one.from('adops.db.AccessRequests').where({ ID: ids.requestA });
    expect(request.TenantId).to.equal('tenant-a');
    const report = await SELECT.one.from('adops.db.ClientErrorReports').where({ ErrorMessage: 'tenant a crashed' });
    expect(report.TenantId).to.equal('tenant-a');
    const usage = await SELECT.one.from('adops.db.UsageEvents').where({ SessionId: 'sess-a' });
    expect(usage.TenantId).to.equal('tenant-a');
    const perf = await SELECT.one.from('adops.db.PerformanceEvents').where({ SessionId: 'sess-a' });
    expect(perf.TenantId).to.equal('tenant-a');
    const settings = await SELECT.one.from('adops.db.TelemetrySettings').where({ TenantId: 'tenant-a' });
    expect(settings?.SamplingPercent).to.equal(42);
    const global = await SELECT.one.from('adops.db.TargetSystems').where({ ID: ids.systemGlobal });
    expect(global.TenantId).to.equal('GLOBAL');
  });

  it('hides tenant-a rows from tenant-b on every projection, GLOBAL rows stay visible', async () => {
    const systemsB = await rows('tb-admin', '/fiori/TargetSystems');
    expect(systemsB.map((s) => s.ID)).to.not.include(ids.systemA);
    expect(systemsB.map((s) => s.ID)).to.include(ids.systemGlobal);

    const systemsA = await rows('ta-admin', '/fiori/TargetSystems');
    expect(systemsA.map((s) => s.ID)).to.include(ids.systemA);
    expect(systemsA.map((s) => s.ID)).to.include(ids.systemGlobal);

    for (const entity of ['AccessRequests', 'ClientErrorReports', 'UsageEvents', 'PerformanceEvents']) {
      const b = await rows('tb-admin', `${ADMIN}/${entity}`);
      expect(b.filter((r) => r.TenantId === 'tenant-a').length, `${entity} leaked to tenant-b`).to.equal(0);
      const a = await rows('ta-admin', `${ADMIN}/${entity}`);
      expect(a.filter((r) => r.TenantId === 'tenant-a').length, `${entity} missing for tenant-a`).to.be.at.least(1);
    }
  });

  it('answers 404 when a tenant reads or patches a foreign row by key', async () => {
    const read = await test.axios.get(`/fiori/TargetSystems(${ids.systemA})`, as('tb-admin'));
    expect(read.status).to.equal(404);
    // The scoped UPDATE matches no row; whatever status CAP reports for
    // that (404, or 204 "nothing to do"), the stored row must be untouched
    // and must not have been re-created under tenant-b.
    const patch = await test.axios.patch(`/fiori/TargetSystems(${ids.systemA})`, { timeZone: 'UTC' }, json('tb-admin'));
    expect([404, 400, 204], `PATCH status ${patch.status}: ${JSON.stringify(patch.data)}`).to.include(patch.status);
    const own = await test.axios.get(`/fiori/TargetSystems(${ids.systemA})`, as('ta-admin'));
    expect(own.status).to.equal(200);
    const stored = await SELECT.from('adops.db.TargetSystems').where({ ID: ids.systemA });
    expect(stored.length).to.equal(1);
    expect(stored[0].TenantId).to.equal('tenant-a');
    expect(stored[0].timeZone).to.not.equal('UTC');

    const del = await test.axios.delete(`/fiori/AdoptionWaves(${cds.utils.uuid()})`, as('tb-admin'));
    expect([404, 204]).to.include(del.status);
  });

  it('keeps access-request handlers inside the tenant', async () => {
    const mineB = await test.axios.get(`${CORE}/getMyAccessRequests()`, as('tb-admin'));
    expect(mineB.status).to.equal(200);
    expect(mineB.data.value.length).to.equal(0);

    const summaryB = await test.axios.get(`${ADMIN}/queryAccessRequestSummary()`, as('tb-admin'));
    expect(summaryB.status).to.equal(200);
    expect(summaryB.data.Total).to.equal(0);
    const summaryA = await test.axios.get(`${ADMIN}/queryAccessRequestSummary()`, as('ta-admin'));
    expect(summaryA.data.Pending).to.be.at.least(1);

    const decideB = await test.axios.post(`${ADMIN}/decideAccessRequest`, { ID: ids.requestA, decision: 'APPROVE' }, json('tb-admin'));
    expect(decideB.status).to.equal(404);
    const still = await SELECT.one.from('adops.db.AccessRequests').where({ ID: ids.requestA });
    expect(still.Status).to.equal('PENDING');
  });

  it('keeps telemetry summaries, error triage and settings per tenant', async () => {
    const usageB = await test.axios.get(`${ADMIN}/queryUsageSummary(days=30)`, as('tb-admin'));
    expect(usageB.status, JSON.stringify(usageB.data)).to.equal(200);
    expect(usageB.data.totalEvents).to.equal(0);
    const usageA = await test.axios.get(`${ADMIN}/queryUsageSummary(days=30)`, as('ta-admin'));
    expect(usageA.data.totalEvents).to.be.at.least(1);

    const perfB = await test.axios.get(`${ADMIN}/queryPerformanceSummary(days=30)`, as('tb-admin'));
    expect(perfB.data.totalEvents).to.equal(0);
    const perfA = await test.axios.get(`${ADMIN}/queryPerformanceSummary(days=30)`, as('ta-admin'));
    expect(perfA.data.totalEvents).to.be.at.least(1);

    const report = await SELECT.one.from('adops.db.ClientErrorReports').where({ ErrorMessage: 'tenant a crashed' });
    const triageB = await test.axios.post(`${ADMIN}/updateClientErrorStatus`, { ID: report.ID, status: 'RESOLVED' }, json('tb-admin'));
    expect(triageB.status).to.equal(404);
    expect((await SELECT.one.from('adops.db.ClientErrorReports').where({ ID: report.ID })).Status).to.equal('NEW');

    const settingsB = await test.axios.get(`${ADMIN}/getTelemetrySettingsAdmin()`, as('tb-admin'));
    expect(settingsB.status).to.equal(200);
    expect(settingsB.data.SamplingPercent).to.not.equal(42);
    const settingsA = await test.axios.get(`${ADMIN}/getTelemetrySettingsAdmin()`, as('ta-admin'));
    expect(settingsA.data.SamplingPercent).to.equal(42);

    // The same fingerprint from another tenant is a separate report, not an
    // occurrence bump on tenant-a's row.
    const again = await test.axios.post(`${CORE}/recordClientError`, {
      errorType: 'RENDER_ERROR', errorMessage: 'tenant a crashed', route: '/settings', severity: 'ERROR'
    }, json('tb-admin'));
    expect(again.status).to.equal(200);
    expect(again.data.occurrenceCount).to.equal(1);
    expect((await SELECT.one.from('adops.db.ClientErrorReports').where({ ID: report.ID })).OccurrenceCount).to.equal(1);
  });

  it('backfills legacy NULL tenants to GLOBAL', async () => {
    const { backfillTenantIds } = (await import('node:module')).createRequire(import.meta.url)('../srv/srv/utils/tenant-scope.js');
    await INSERT.into('adops.db.AccessRequests').entries({
      ID: cds.utils.uuid(), RequesterId: 'legacy', RequestedArea: 'application', RequestedRole: 'Member', Status: 'PENDING', TenantId: null
    });
    const touched = await backfillTenantIds();
    expect(touched).to.be.at.least(1);
    const legacy = await SELECT.one.from('adops.db.AccessRequests').where({ RequesterId: 'legacy' });
    expect(legacy.TenantId).to.equal('GLOBAL');
    expect(await backfillTenantIds()).to.equal(0);
  });
});
