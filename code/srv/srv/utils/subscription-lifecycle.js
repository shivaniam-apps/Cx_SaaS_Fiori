// ---------------------------------------------------------------------------
// SaaS subscription lifecycle (T2) on the shared-schema tiers (PO-3's
// recommended model: one database, tenantScoped discriminator).
//
//   subscribe    -> Tenants row ACTIVE (idempotent), TENANT_SUBSCRIBED audit
//   unsubscribe  -> Tenants row UNSUBSCRIBED, data RETAINED (legal hold by
//                   default: nothing of a customer is deleted by a callback)
//   purge        -> explicit Admin action on an UNSUBSCRIBED tenant: every
//                   tenantScoped row of that tenant is deleted; AuditEvents
//                   and the chain head are retained (append-only, I9), the
//                   per-tenant pseudonymisation secret is deleted with the
//                   data it protected; TENANT_PURGED audit row; Tenants PURGED
//   dependencies -> xsappnames of the bound destination / connectivity /
//                   HTML5 runtime services for the SaaS registry
// ---------------------------------------------------------------------------

const cds = require('@sap/cds');
const xsenv = require('@sap/xsenv');
const { appendAuditEvent } = require('./audit-chain.js');

const LOG = cds.log('subscription-lifecycle');
const TENANTS = 'adops.db.Tenants';
const GLOBAL_TENANT = 'GLOBAL';
const DB_NAMESPACE = 'adops.db.';

// Never purged: the audit trail (append-only, hash-chained) and its head.
const RETAINED_ON_PURGE = new Set(['adops.db.AuditEvents', 'adops.db.AuditChainHeads']);
// Purged although keyed rather than scoped: the tenant's pseudonymisation secret.
const KEYED_TENANT_TABLES = ['adops.db.TenantSecrets'];

const TENANT_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', UNSUBSCRIBED: 'UNSUBSCRIBED', PURGED: 'PURGED' });

const clean = (v) => String(v ?? '').trim();
const now = () => new Date().toISOString();

function tenantUrl(subdomain) {
  const separator = process.env.tenantSeparator || '-';
  const appDomain = process.env.appDomain;
  if (!subdomain || !appDomain) return process.env.approuterUrl || '';
  return `https://${subdomain}${separator}${appDomain}`;
}

// Persisted entities that carry the tenantScoped discriminator (not views,
// not the registry tables), from the loaded model - a new entity joins the
// purge automatically once it declares the aspect.
function tenantScopedEntities(model = cds.model) {
  const names = [];
  for (const [name, def] of Object.entries(model?.definitions || {})) {
    if (def.kind !== 'entity' || !name.startsWith(DB_NAMESPACE)) continue;
    if (def.query || def.projection) continue;
    const element = def.elements?.TenantId;
    if (!element || element.key) continue;
    if (RETAINED_ON_PURGE.has(name)) continue;
    names.push(name);
  }
  return names.sort();
}

async function audit(tenantId, eventType, message, { severity = 'INFO', userId = 'saas-registry', objectName = '', before = '', after = '' } = {}) {
  await appendAuditEvent({
    TenantId: tenantId,
    EventType: eventType,
    Severity: severity,
    ObjectType: 'Tenants',
    ObjectName: objectName || tenantId,
    ObjectId: tenantId,
    UserId: userId,
    Source: 'saas-provisioning',
    Message: message,
    BeforeValue: before,
    AfterValue: after
  });
}

async function recordSubscription({ tenantId, subdomain, plan }) {
  const id = clean(tenantId);
  if (!id) throw Object.assign(new Error('tenantId is required.'), { status: 400 });
  const url = tenantUrl(clean(subdomain));
  const existing = await SELECT.one.from(TENANTS).where({ ID: id });
  const stamp = now();
  const fields = {
    Subdomain: clean(subdomain) || existing?.Subdomain || '',
    Plan: clean(plan) || existing?.Plan || '',
    Status: TENANT_STATUS.ACTIVE,
    TenantUrl: url,
    UnsubscribedAt: null,
    LastEvent: `Subscribed at ${stamp}${existing ? ` (previous status ${existing.Status})` : ''}`
  };
  if (existing) await UPDATE(TENANTS).set(fields).where({ ID: id });
  else await INSERT.into(TENANTS).entries({ ID: id, SubscribedAt: stamp, ...fields });
  await audit(id, 'TENANT_SUBSCRIBED', `Tenant ${id} subscribed (subdomain ${fields.Subdomain || '?'}, plan ${fields.Plan || '?'}).`,
    { objectName: fields.Subdomain, before: existing?.Status || '', after: TENANT_STATUS.ACTIVE });
  LOG.info(`Tenant ${id} subscribed (subdomain ${fields.Subdomain || '<unknown>'}).`);
  return { tenantId: id, tenantUrl: url, status: TENANT_STATUS.ACTIVE, created: !existing };
}

async function recordUnsubscription({ tenantId, subdomain }) {
  const id = clean(tenantId);
  if (!id) throw Object.assign(new Error('tenantId is required.'), { status: 400 });
  const existing = await SELECT.one.from(TENANTS).where({ ID: id });
  const stamp = now();
  const fields = { Status: TENANT_STATUS.UNSUBSCRIBED, UnsubscribedAt: stamp, LastEvent: `Unsubscribed at ${stamp}; data retained until an administrator purges it` };
  if (existing) await UPDATE(TENANTS).set(fields).where({ ID: id });
  else await INSERT.into(TENANTS).entries({ ID: id, Subdomain: clean(subdomain), SubscribedAt: null, ...fields });
  await audit(id, 'TENANT_UNSUBSCRIBED', `Tenant ${id} unsubscribed; its data is retained until an administrator purges it.`,
    { severity: 'WARNING', objectName: existing?.Subdomain || clean(subdomain), before: existing?.Status || '', after: TENANT_STATUS.UNSUBSCRIBED });
  LOG.info(`Tenant ${id} unsubscribed; data retained.`);
  return { tenantId: id, status: TENANT_STATUS.UNSUBSCRIBED, retained: true };
}

// Deletes every scoped row of one tenant. Refuses GLOBAL, an unknown or a
// still-subscribed tenant. Idempotent: a second purge deletes nothing more.
async function purgeTenantData({ tenantId, userId, model }) {
  const id = clean(tenantId);
  if (!id) throw Object.assign(new Error('tenantId is required.'), { status: 400 });
  if (id.toUpperCase() === GLOBAL_TENANT) throw Object.assign(new Error('The GLOBAL tenant (shipped content and single-tenant operation) cannot be purged.'), { status: 400 });
  const tenant = await SELECT.one.from(TENANTS).where({ ID: id });
  if (!tenant) throw Object.assign(new Error(`Tenant ${id} is not registered.`), { status: 404 });
  if (tenant.Status === TENANT_STATUS.ACTIVE) throw Object.assign(new Error(`Tenant ${id} is still subscribed; purge is only possible after unsubscription.`), { status: 400 });

  const deleted = {};
  for (const name of tenantScopedEntities(model)) {
    const count = await DELETE.from(name).where({ TenantId: id });
    if (Number(count) > 0) deleted[name.slice(DB_NAMESPACE.length)] = Number(count);
  }
  for (const name of KEYED_TENANT_TABLES) {
    if (!model?.definitions?.[name] && !cds.model?.definitions?.[name]) continue;
    const count = await DELETE.from(name).where({ TenantId: id });
    if (Number(count) > 0) deleted[name.slice(DB_NAMESPACE.length)] = Number(count);
  }
  const retainedAuditEvents = await SELECT.one.from('adops.db.AuditEvents').columns('count(*) as cnt').where({ TenantId: id });
  const stamp = now();
  await UPDATE(TENANTS).set({ Status: TENANT_STATUS.PURGED, PurgedAt: stamp, PurgedBy: userId || '', LastEvent: `Purged at ${stamp} by ${userId || '?'}` }).where({ ID: id });
  const summary = Object.entries(deleted).map(([k, v]) => `${k}: ${v}`).join(', ') || 'nothing left to delete';
  await audit(id, 'TENANT_PURGED', `Tenant ${id} purged by ${userId || '?'} (${summary}); ${Number(retainedAuditEvents?.cnt || 0)} audit events retained.`,
    { severity: 'WARNING', userId, objectName: tenant.Subdomain, before: tenant.Status, after: TENANT_STATUS.PURGED });
  LOG.warn(`Tenant ${id} purged by ${userId || '?'}: ${summary}.`);
  return { TenantId: id, Status: TENANT_STATUS.PURGED, Deleted: deleted, RetainedAuditEvents: Number(retainedAuditEvents?.cnt || 0) };
}

// xsappnames the SaaS registry must grant the subscriber access to: the
// HTML5 runtime (UI), the destination service and the connectivity service
// (customer S/4 systems sit behind the consumer subaccount's Cloud
// Connector). Unbound services are simply absent.
function saasDependencies() {
  const dependencies = [];
  try {
    const services = xsenv.getServices({
      html5Runtime: { tag: 'html5-apps-repo-rt' },
      destination: { tag: 'destination' },
      connectivity: { tag: 'connectivity' }
    });
    const push = (xsappname) => { if (xsappname && !dependencies.some((d) => d.xsappname === xsappname)) dependencies.push({ xsappname }); };
    push(services.html5Runtime?.uaa?.xsappname);
    push(services.destination?.xsappname);
    push(services.connectivity?.xsappname);
  } catch (error) {
    LOG.warn(`Could not resolve optional SaaS dependencies: ${error.message}`);
  }
  return dependencies;
}

module.exports = {
  TENANT_STATUS,
  tenantUrl,
  tenantScopedEntities,
  recordSubscription,
  recordUnsubscription,
  purgeTenantData,
  saasDependencies
};
