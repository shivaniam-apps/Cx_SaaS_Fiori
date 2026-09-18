// Subscription lifecycle (T2): tenant row on subscribe, retention on
// unsubscribe, explicit audited purge, dependencies callback.
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { test, cds, as, json, expectInMemoryDb } from './helpers/cds-http-test.mjs';

const require = createRequire(import.meta.url);
const { tenantScopedEntities, TENANT_STATUS } = require('../srv/srv/utils/subscription-lifecycle.js');

const TENANT = 't2-tenant-a';
const PATH = `/-/basic/saas-provisioning/tenant/${TENANT}`;
const registry = () => json('saas-registry');
const readTenant = async () => (await test.axios.get(`/catalog/AdminService/Tenants('${TENANT}')`, as('alice'))).data;
const countScoped = async (entity) => Number((await SELECT.one.from(entity).columns('count(*) as cnt').where({ TenantId: TENANT }))?.cnt || 0);

describe('subscription lifecycle (T2)', function () {
  this.timeout(30000);

  before(() => { expectInMemoryDb(); });

  it('tenantScopedEntities lists every persisted scoped entity and no registry table', () => {
    const names = tenantScopedEntities(cds.model);
    expect(names).to.include.members(['adops.db.TargetSystems', 'adops.db.ExtractionRuns', 'adops.db.PilotFeedback', 'adops.db.AppProposals']);
    expect(names).to.not.include('adops.db.AuditEvents');
    expect(names).to.not.include('adops.db.AuditChainHeads');
    expect(names).to.not.include('adops.db.TenantSecrets');
    expect(names).to.not.include('adops.db.Tenants');
  });

  it('subscribe registers the tenant (idempotently) and audits it', async () => {
    const first = await test.axios.put(PATH, { subscribedSubdomain: 'customer-a', subscriptionParams: { plan: 'basic' } }, registry());
    expect(first.status, JSON.stringify(first.data)).to.equal(200);
    const again = await test.axios.put(PATH, { subscribedSubdomain: 'customer-a' }, registry());
    expect(again.status).to.equal(200);

    const tenant = await readTenant();
    expect(tenant).to.include({ ID: TENANT, Subdomain: 'customer-a', Plan: 'basic', Status: TENANT_STATUS.ACTIVE });
    expect(tenant.SubscribedAt).to.be.a('string');
    const rows = await test.axios.get('/catalog/AdminService/Tenants', as('alice'));
    expect(rows.data.value.filter((t) => t.ID === TENANT)).to.have.length(1);

    const events = await SELECT.from('adops.db.AuditEvents').where({ TenantId: TENANT, EventType: 'TENANT_SUBSCRIBED' });
    expect(events.length).to.be.greaterThan(0);
    expect(events[0].Source).to.equal('saas-provisioning');
  });

  it('purge is refused while the tenant is subscribed', async () => {
    const refused = await test.axios.post('/catalog/AdminService/purgeTenant', { tenantId: TENANT, confirm: TENANT }, json('alice'));
    expect(refused.status).to.equal(400);
    expect(refused.data?.error?.message).to.match(/still subscribed/);
  });

  it('unsubscribe marks the tenant and retains its data', async () => {
    // Data of the tenant, written the way the scoped services would stamp it.
    await INSERT.into('adops.db.TargetSystems').entries({ TenantId: TENANT, displayName: 'Tenant A DEV', destinationName: 'T2_DEV_100', environment: 'DEV' });
    await INSERT.into('adops.db.ExtractionRuns').entries({ TenantId: TENANT, Title: 'Tenant A run', Status: 'COMPLETED' });
    await INSERT.into('adops.db.PilotFeedback').entries({ TenantId: TENANT, Title: 'Tenant A feedback', Category: 'GENERAL' });
    // The secret's column set belongs to A9; a shape mismatch here must not fail the lifecycle checks.
    try { await INSERT.into('adops.db.TenantSecrets').entries({ TenantId: TENANT, Secret: 'x'.repeat(16) }); } catch { /* optional fixture */ }

    const response = await test.axios.delete(PATH, { ...registry(), data: { subscribedSubdomain: 'customer-a' } });
    expect(response.status, JSON.stringify(response.data)).to.equal(200);
    const tenant = await readTenant();
    expect(tenant.Status).to.equal(TENANT_STATUS.UNSUBSCRIBED);
    expect(tenant.UnsubscribedAt).to.be.a('string');
    expect(await countScoped('adops.db.TargetSystems')).to.equal(1);
    expect(await countScoped('adops.db.PilotFeedback')).to.equal(1);
    const events = await SELECT.from('adops.db.AuditEvents').where({ TenantId: TENANT, EventType: 'TENANT_UNSUBSCRIBED' });
    expect(events.length).to.equal(1);
    expect(events[0].Severity).to.equal('WARNING');
  });

  it('purge needs Admin and the confirmation, deletes scoped rows, keeps the audit trail', async () => {
    const member = await test.axios.post('/catalog/AdminService/purgeTenant', { tenantId: TENANT, confirm: TENANT }, json('carol'));
    expect([401, 403]).to.include(member.status);
    const unconfirmed = await test.axios.post('/catalog/AdminService/purgeTenant', { tenantId: TENANT, confirm: 'nope' }, json('alice'));
    expect(unconfirmed.status).to.equal(400);
    const globalPurge = await test.axios.post('/catalog/AdminService/purgeTenant', { tenantId: 'GLOBAL', confirm: 'GLOBAL' }, json('alice'));
    expect(globalPurge.status).to.equal(400);
    const unknown = await test.axios.post('/catalog/AdminService/purgeTenant', { tenantId: 'never-registered', confirm: 'never-registered' }, json('alice'));
    expect(unknown.status).to.equal(404);

    const auditBefore = await countScoped('adops.db.AuditEvents');
    const purged = await test.axios.post('/catalog/AdminService/purgeTenant', { tenantId: TENANT, confirm: TENANT }, json('alice'));
    expect(purged.status, JSON.stringify(purged.data)).to.equal(200);
    const result = JSON.parse(purged.data.value);
    expect(result.Status).to.equal(TENANT_STATUS.PURGED);
    expect(result.Deleted).to.include({ TargetSystems: 1, ExtractionRuns: 1, PilotFeedback: 1 });
    expect(await countScoped('adops.db.TargetSystems')).to.equal(0);
    expect(await countScoped('adops.db.ExtractionRuns')).to.equal(0);
    expect(await countScoped('adops.db.PilotFeedback')).to.equal(0);
    // The audit trail is retained and grew by the purge event itself.
    expect(await countScoped('adops.db.AuditEvents')).to.equal(auditBefore + 1);
    expect(result.RetainedAuditEvents).to.be.greaterThan(0);
    const tenant = await readTenant();
    expect(tenant).to.include({ Status: TENANT_STATUS.PURGED, PurgedBy: 'alice' });

    // Idempotent: a second purge deletes nothing more and stays PURGED.
    const again = await test.axios.post('/catalog/AdminService/purgeTenant', { tenantId: TENANT, confirm: TENANT }, json('alice'));
    expect(again.status).to.equal(200);
    expect(JSON.parse(again.data.value).Deleted).to.deep.equal({});
  });

  it('a purged tenant can subscribe again', async () => {
    const back = await test.axios.put(PATH, { subscribedSubdomain: 'customer-a' }, registry());
    expect(back.status).to.equal(200);
    const tenant = await readTenant();
    expect(tenant.Status).to.equal(TENANT_STATUS.ACTIVE);
    expect(tenant.UnsubscribedAt).to.equal(null);
    await test.axios.delete(PATH, { ...registry(), data: {} });
  });

  it('the dependencies callback answers an array (no bound services locally)', async () => {
    const dependencies = await test.axios.get('/-/basic/saas-provisioning/dependencies', as('saas-registry'));
    expect(dependencies.status).to.equal(200);
    expect(dependencies.data).to.be.an('array');
  });
});
