// One cds.test server per mocha process, shared by every HTTP-level suite.
//
// cds.test() starts a CAP server in root-level before/after hooks. Two suites
// each calling it start two servers in one process; only the last one is shut
// down and mocha never exits (observed with public-service-auth + audit-chain).
// Import `test` from here instead.
//
// Database discipline: NODE_ENV=test makes shouldMockSap() short-circuit every
// S/4 call, but cds keeps the [development] profile active outside production,
// whose db points at the shared ../db.sqlite. The db is forced in-memory here
// and must be asserted in every suite's before() (expectInMemoryDb) before the
// first write - the one time this slipped, two fixture rows vanished from a
// developer's db.sqlite.
process.env.NODE_ENV = 'test';
process.env.CDS_REQUIRES_DB_KIND = 'sqlite';
process.env.CDS_REQUIRES_DB_CREDENTIALS_URL = ':memory:';

import { expect } from 'chai';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const cds = require('@sap/cds');

// Load-order independent: when another module has already resolved cds.env,
// the process.env overrides above are ignored, so pin the db here as well.
cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };

export const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'srv');

globalThis.__adopsCdsTest ??= cds.test(projectDir);
export const test = globalThis.__adopsCdsTest;

export function expectInMemoryDb() {
  const url = String(cds.db?.options?.credentials?.url || '');
  expect(url, `database must be in-memory, got "${url}"`).to.match(/memory/);
}

// Mocked users from package.json: alice = all roles, bob = Approver+Member,
// dave = Activator+Member, carol = Member, eve = none.
export const as = (user) => ({ auth: { username: user, password: '' }, validateStatus: () => true });
export const json = (user) => ({ ...as(user), headers: { 'content-type': 'application/json' } });

// @readonly answers 405 (method not allowed) in CAP 8; a role-based @restrict
// denial answers 403. Both mean "the write did not happen".
export const REFUSED = [403, 405];

// Fixture convention (O15): every HTTP suite shares this ONE in-memory db,
// so fixtures collide across suites unless their identities are suite-
// specific. Rules, guarded by test/fixture-convention.test.mjs:
// - destination names (unique per tenant since O11) carry a suite tag:
//   `fixtures('AUD').destination('DEV')` -> 'AUD_DEV'; never a bare RD1_DEV.
// - never assert absolute counts on an unscoped read (other suites' rows
//   are in the same tables): scope by your own ids, or diff against a
//   baseline read taken in before() (see dashboard-summary.test.mjs).
// - a suite that needs true isolation runs under its own tenant through
//   the tenant-scope middleware pattern in tenant-scope.test.mjs.
export function fixtures(suiteTag) {
  const tag = String(suiteTag || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (!tag) throw new Error('fixtures(suiteTag): a suite tag is required');
  return {
    tag,
    destination: (name) => `${tag}_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
    name: (label) => `${label} (${tag})`
  };
}
