const cds = require('@sap/cds');

// Logical tenancy for the shared-database tiers. Entities carrying the
// tenantScoped aspect (db/data-types.cds) get their TenantId stamped on
// writes and filtered on reads. Single-tenant operation uses 'GLOBAL', so
// switching multitenancy on later is a profile flag, not a data migration:
// real tenant ids simply start appearing next to the GLOBAL rows.
//
// Two layers (roadmap A5):
//   1. registerTenantScope(service): generic OData CRUD on a service. The
//      request target is the service projection (AdminService.X), so the
//      check follows the projection to its adops.db source instead of
//      looking at the projection name - the original name check never
//      matched a projection and left every OData read unscoped.
//   2. tenantFilter() / stampTenant(): for handlers that issue CQN against
//      adops.db.* directly (access requests, telemetry, settings). Generic
//      handlers never see those queries, so each direct read and write
//      applies the scope itself.
//
// The enterprise tier (CAP MTX + HDI containers) isolates physically and
// this layer becomes a no-op stamp.

const GLOBAL_TENANT = 'GLOBAL';
const DB_NAMESPACE = 'adops.db.';

function currentTenant() {
    return cds.context?.tenant || GLOBAL_TENANT;
}

// Follows projections / views down to their source entity name.
function persistedSourceName(target, depth = 0) {
    if (!target || depth > 5) return '';
    if (typeof target.name === 'string' && target.name.startsWith(DB_NAMESPACE)) return target.name;
    const from = target.query?.SELECT?.from?.ref?.[0] || target.projection?.from?.ref?.[0];
    if (!from) return '';
    const source = cds.model?.definitions?.[from];
    if (!source) return typeof from === 'string' && from.startsWith(DB_NAMESPACE) ? from : '';
    return persistedSourceName(source, depth + 1);
}

function isTenantScoped(target) {
    return Boolean(target?.elements?.TenantId) && Boolean(persistedSourceName(target));
}

// Where fragment for direct CQN: GLOBAL rows stay visible to every tenant
// (shipped content, single-tenant operation); tenant rows only to their
// owner. Spread it into an existing where object.
function tenantFilter(tenant = currentTenant()) {
    return { TenantId: { in: tenant === GLOBAL_TENANT ? [GLOBAL_TENANT] : [GLOBAL_TENANT, tenant] } };
}

// Stamps TenantId on a row (or rows) about to be inserted directly.
function stampTenant(rows, tenant = currentTenant()) {
    const list = Array.isArray(rows) ? rows : [rows];
    for (const row of list) {
        if (row && (row.TenantId === undefined || row.TenantId === null || row.TenantId === '')) row.TenantId = tenant;
    }
    return rows;
}

// Registers the scope handlers on a CAP service. Call once per service impl.
function registerTenantScope(service) {
    service.before(['CREATE', 'UPSERT'], '*', (req) => {
        if (!isTenantScoped(req.target)) return;
        stampTenant(req.data);
    });

    // Reads and direct writes alike: a tenant can neither see nor PATCH /
    // DELETE another tenant's rows by guessing an ID. Scoped queries on a
    // key answer 404 / 0 rows affected for foreign rows.
    service.before(['READ', 'UPDATE', 'DELETE'], '*', (req) => {
        if (!isTenantScoped(req.target)) return;
        req.query.where(tenantFilter());
    });
}

// One-time normalisation, run on 'served': rows written before A5 by the
// handlers that stamped `req.user.tenant || null` carry a NULL TenantId and
// would vanish behind the strict filter. They belong to the single tenant
// that wrote them, i.e. GLOBAL. Idempotent (only NULL rows change); entities
// whose UPDATE is refused (AuditEvents) are skipped by the guard's error.
async function backfillTenantIds({ log = cds.log('tenant-scope') } = {}) {
    const defs = cds.model?.definitions || {};
    let touched = 0;
    for (const [name, def] of Object.entries(defs)) {
        if (def.kind !== 'entity' || !name.startsWith(DB_NAMESPACE) || def.query || def.projection) continue;
        if (!def.elements?.TenantId || def.elements.TenantId.key) continue;
        try {
            const changed = await UPDATE(name).set({ TenantId: GLOBAL_TENANT }).where({ TenantId: null });
            if (changed > 0) {
                touched += changed;
                log.info(`assigned ${changed} legacy row(s) of ${name} to tenant ${GLOBAL_TENANT}`);
            }
        } catch (error) {
            log.debug?.(`backfill skipped for ${name}: ${error.message}`);
        }
    }
    return touched;
}

module.exports = {
    registerTenantScope,
    backfillTenantIds,
    isTenantScoped,
    persistedSourceName,
    tenantFilter,
    stampTenant,
    currentTenant,
    GLOBAL_TENANT
};
