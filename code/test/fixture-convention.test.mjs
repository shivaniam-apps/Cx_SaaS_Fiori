// Fixture convention guard (O15): the HTTP suites share one in-memory db per
// mocha process (helpers/cds-http-test.mjs), and a destination name is
// unique per tenant (O11), so two suites registering the same destination
// break each other depending on run order. This scan fails the build when a
// destination literal appears in more than one HTTP suite, or is a bare
// landscape name without a suite tag.
import { expect } from 'chai';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtures } from './helpers/cds-http-test.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Suites that drive the shared CAP server over HTTP.
function httpSuites() {
  return readdirSync(here)
    .filter((name) => name.endsWith('.test.mjs') && name !== 'fixture-convention.test.mjs')
    .map((name) => ({ name, source: readFileSync(join(here, name), 'utf8') }))
    .filter((file) => file.source.includes('helpers/cds-http-test.mjs'));
}

// destinationName literals of REGISTRATIONS: POST fixtures and INSERT rows
// carry displayName on the same line as destinationName. Adapter-level calls
// that only pass { destinationName } to a function register nothing and are
// ignored.
export function destinationLiterals(source) {
  const found = [];
  for (const line of source.split(/\r?\n/)) {
    if (!/displayName\s*:/.test(line)) continue;
    for (const m of line.matchAll(/destinationName:\s*'([^']*)'/g)) {
      const dest = m[1].trim();
      if (dest) found.push(dest);
    }
  }
  return found;
}

// A tag is any prefix that is not a plain landscape/system name.
const BARE = /^(RD1|S4H|SAP|DEV|QAS|PRD|PROD|SANDBOX)(_|$)/i;

describe('HTTP suite fixture convention', () => {
  it('fixtures() derives suite-tagged identities', () => {
    const f = fixtures('audit chain');
    expect(f.tag).to.equal('AUDIT_CHAIN');
    expect(f.destination('dev 100')).to.equal('AUDIT_CHAIN_DEV_100');
    expect(f.name('RD1 Development')).to.equal('RD1 Development (AUDIT_CHAIN)');
    expect(() => fixtures('')).to.throw(/suite tag/);
  });

  it('the scan sees registrations only, not adapter-level destination arguments', () => {
    const sample = [
      "  await test.axios.post('/fiori/TargetSystems', { displayName: 'X', destinationName: 'AUD_DEV_100', environment: 'DEV' }, json('alice'));",
      "  await INSERT.into('adops.db.TargetSystems').entries({ ID: id, displayName: 'Y', destinationName: 'DASH_A_100' });",
      "  const status = await fetchTransportStatus({ targetSystem: { destinationName: 'RD1_QAS' }, trkorr: 'RD1K900001' });",
      "  const empty = await test.axios.post('/fiori/TargetSystems', { displayName: 'No destination', destinationName: '   ' }, json('alice'));"
    ].join('\n');
    expect(destinationLiterals(sample)).to.deep.equal(['AUD_DEV_100', 'DASH_A_100']);
  });

  it('no destination is registered by two HTTP suites', () => {
    const owners = new Map();
    for (const file of httpSuites()) {
      for (const dest of new Set(destinationLiterals(file.source))) {
        const list = owners.get(dest) || [];
        list.push(file.name);
        owners.set(dest, list);
      }
    }
    const shared = [...owners].filter(([, files]) => files.length > 1).map(([dest, files]) => `${dest}: ${files.join(', ')}`);
    expect(shared, `destinations used by more than one HTTP suite:\n${shared.join('\n')}`).to.deep.equal([]);
  });

  it('every HTTP suite tags its destinations (no bare landscape names)', () => {
    const bare = [];
    for (const file of httpSuites()) {
      for (const dest of new Set(destinationLiterals(file.source))) {
        if (BARE.test(dest)) bare.push(`${file.name}: ${dest}`);
      }
    }
    expect(bare, `untagged fixture destinations (use fixtures(<tag>).destination(...)):\n${bare.join('\n')}`).to.deep.equal([]);
  });
});
