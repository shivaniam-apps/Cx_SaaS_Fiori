const cds = require('@sap/cds');

// Logical tenancy for the shared-database tiers. Entities carrying the
// tenantScoped aspect (db/data-types.cds) get their TenantId stamped on
// writes and filtered on reads. Single-tenant operation uses 'GLOBAL', so
// switching multitenancy on later is a profile flag, not a data migration:
// real tenant ids simply start appearing next to the GLOBAL rows.
//
// The enterprise tier (CAP MTX + HDI containers) isolates physically and
// this layer becomes a no-op stamp.

const GLOBAL_TENANT = 'GLOBAL';

function currentTenant() {
    return cds.context?.tenant || GLOBAL_TENANT;
}

function isTenantScoped(target) {
    return Boolean(target?.elements?.TenantId) && target.name?.startsWith('adops.db.');
}

// Registers the scope handlers on a CAP service. Call once per service impl.
function registerTenantScope(service) {
    service.before(['CREATE', 'UPSERT'], '*', (req) => {
        if (!isTenantScoped(req.target)) return;
        const tenant = currentTenant();
        const rows = Array.isArray(req.data) ? req.data : [req.data];
        for (const row of rows) {
            if (row && row.TenantId === undefined) row.TenantId = tenant;
        }
    });

    service.before('READ', '*', (req) => {
        if (!isTenantScoped(req.target)) return;
        const tenant = currentTenant();
        // GLOBAL rows stay visible to every tenant (shipped content);
        // tenant rows are visible only to their owner.
        req.query.where({ TenantId: { in: [GLOBAL_TENANT, tenant] } });
    });
}

module.exports = { registerTenantScope, currentTenant, GLOBAL_TENANT };
