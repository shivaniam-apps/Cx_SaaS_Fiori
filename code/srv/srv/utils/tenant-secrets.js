const { randomBytes } = require('node:crypto');
const { currentTenant, GLOBAL_TENANT } = require('./tenant-scope.js');

// Per-tenant secrets that must never be derived from anything a caller can
// guess (roadmap A9). Today one secret: the salt behind the CAP-side user
// pseudonymisation. Live reads are pseudonymised in the ZADO add-on with
// its own ZADO_CFG secret; this one covers what CAP hashes itself - mock
// extraction runs and file imports - and previously was the tenant id,
// which anyone who knows the tenant could reproduce.
//
// The row is created on first use with 32 random bytes and cached for the
// process lifetime; TenantSecrets is not exposed by any service.

const TENANT_SECRETS = 'adops.db.TenantSecrets';
const cache = new Map();

async function pseudonymSaltFor(tenantId = currentTenant()) {
    const tenant = tenantId || GLOBAL_TENANT;
    if (cache.has(tenant)) return cache.get(tenant);

    let row = await SELECT.one.from(TENANT_SECRETS).where({ TenantId: tenant });
    if (!row) {
        const fresh = { TenantId: tenant, PseudonymSalt: randomBytes(32).toString('hex'), CreatedAt: new Date().toISOString() };
        try {
            await INSERT.into(TENANT_SECRETS).entries(fresh);
            row = fresh;
        } catch (error) {
            // Another instance created the row first: take theirs.
            row = await SELECT.one.from(TENANT_SECRETS).where({ TenantId: tenant });
            if (!row) throw error;
        }
    }
    cache.set(tenant, row.PseudonymSalt);
    return row.PseudonymSalt;
}

// Tests and secret rotation tooling.
function resetTenantSecretCache() {
    cache.clear();
}

module.exports = { pseudonymSaltFor, resetTenantSecretCache, TENANT_SECRETS };
