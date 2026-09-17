// Per-tenant pseudonymisation secret (roadmap A9): the CAP-side salt is a
// random secret per tenant, created once, never the tenant id.
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cds = require('@sap/cds');
const { pseudonymSaltFor, resetTenantSecretCache } = require('../srv/srv/utils/tenant-secrets.js');
const { pseudonymiseUser } = require('../srv/srv/utils/usage-extraction.js');

const { SELECT } = cds.ql;

describe('tenant pseudonymisation secrets (A9)', function () {
  this.timeout(20000);

  before(async () => {
    const model = await cds.load(fileURLToPath(new URL('../db', import.meta.url)));
    await cds.deploy(model).to('sqlite::memory:');
    resetTenantSecretCache();
  });

  it('creates a 64-hex secret per tenant once and returns the same value afterwards', async () => {
    const first = await pseudonymSaltFor('tenant-a');
    expect(first).to.match(/^[0-9a-f]{64}$/);
    expect(await pseudonymSaltFor('tenant-a')).to.equal(first);
    resetTenantSecretCache();
    expect(await pseudonymSaltFor('tenant-a'), 'survives the cache').to.equal(first);
    const rows = await SELECT.from('adops.db.TenantSecrets').where({ TenantId: 'tenant-a' });
    expect(rows.length).to.equal(1);
  });

  it('never derives the secret from the tenant id and keeps tenants apart', async () => {
    const a = await pseudonymSaltFor('tenant-a');
    const b = await pseudonymSaltFor('tenant-b');
    expect(a).to.not.equal(b);
    expect(a).to.not.contain('tenant-a');
    // Acceptance: the same user in two tenants -> different pseudonyms.
    expect(pseudonymiseUser('JSMITH', a)).to.not.equal(pseudonymiseUser('JSMITH', b));
    expect(pseudonymiseUser('JSMITH', a)).to.equal(pseudonymiseUser('jsmith', a));
  });

  it('falls back to the GLOBAL tenant without a request context', async () => {
    const salt = await pseudonymSaltFor();
    const row = await SELECT.one.from('adops.db.TenantSecrets').where({ TenantId: 'GLOBAL' });
    expect(row.PseudonymSalt).to.equal(salt);
  });
});
