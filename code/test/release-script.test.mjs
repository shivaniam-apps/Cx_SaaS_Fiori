// scripts/release.mjs (roadmap T5): one version across the MTA descriptors
// and the package files. The file parsers run on copies in a temp folder;
// the consistency check also runs against the real repository.
import { expect } from 'chai';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersion, writeVersion, checkVersions, setVersions, VERSION_FILES, SEMVER } from '../../scripts/release.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fixtureRoot(version = '1.2.3', { eol = '\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adops-release-'));
  for (const file of VERSION_FILES) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    const text = file.kind === 'mta'
      ? ['_schema-version: \'3.2\'', 'ID: adops-basic', `version: ${version}`, '', 'modules:', '  - name: x', '    parameters:', '      version: 9.9.9', ''].join(eol)
      : ['{', '  "name": "x",', `  "version": "${version}",`, '  "dependencies": { "@sap/cds": "^8.9.4" }', '}', ''].join(eol);
    writeFileSync(join(root, file.path), text);
  }
  return root;
}

describe('release script', () => {
  describe('parsers', () => {
    it('reads and rewrites the top-level MTA version only, leaving nested version keys alone', () => {
      const text = "_schema-version: '3.2'\nID: adops-basic\nversion: 0.1.0\nresources:\n  - name: r\n    parameters:\n      config:\n        version: 1.0.0\n";
      expect(readVersion(text, 'mta')).to.equal('0.1.0');
      const out = writeVersion(text, 'mta', '0.2.0');
      expect(out).to.include('\nversion: 0.2.0\n');
      expect(out).to.include('        version: 1.0.0\n');
      expect(readVersion(writeVersion("version: '0.1.0'\n", 'mta', '0.3.0'), 'mta')).to.equal('0.3.0');
      expect(writeVersion("version: '0.1.0'\n", 'mta', '0.3.0')).to.equal("version: '0.3.0'\n");
    });

    it('reads and rewrites the package.json version field', () => {
      const text = '{\n  "name": "adops",\n  "version": "0.0.1",\n  "dependencies": { "x": "1.0.0" }\n}\n';
      expect(readVersion(text, 'package')).to.equal('0.0.1');
      const out = writeVersion(text, 'package', '0.1.0');
      expect(out).to.include('"version": "0.1.0"');
      expect(out).to.include('"x": "1.0.0"');
      expect(readVersion('{}', 'package')).to.equal(null);
      expect(() => writeVersion('{}', 'package', '1.0.0')).to.throw(/no "version" field/);
      expect(() => writeVersion('ID: x\n', 'mta', '1.0.0')).to.throw(/no top-level version/);
    });

    it('accepts semver with a prerelease and rejects the rest', () => {
      for (const ok of ['0.1.0', '1.2.3', '10.0.0-rc.1']) expect(SEMVER.test(ok), ok).to.equal(true);
      for (const bad of ['1.2', 'v1.2.3', '01.2.3', '1.2.3.4', '']) expect(SEMVER.test(bad), bad).to.equal(false);
    });
  });

  describe('check and set on a fixture tree', () => {
    let root;
    afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

    it('passes when every file agrees and the tag matches', () => {
      root = fixtureRoot('1.2.3');
      const result = checkVersions(root, { tag: 'v1.2.3' });
      expect(result.ok, result.problems.join('; ')).to.equal(true);
      expect(result.version).to.equal('1.2.3');
      expect(result.entries).to.have.length(VERSION_FILES.length);
    });

    it('names every file that drifts, a non-semver value and a tag mismatch', () => {
      root = fixtureRoot('1.2.3');
      writeFileSync(join(root, 'deploy/cf/mtaext/qa.mtaext'), 'ID: adops-basic.qa\nversion: 1.2.4\n');
      writeFileSync(join(root, 'code/db/package.json'), '{ "version": "next" }\n');
      const result = checkVersions(root, { tag: 'v9.9.9' });
      expect(result.ok).to.equal(false);
      expect(result.problems.some((p) => p.startsWith('deploy/cf/mtaext/qa.mtaext: 1.2.4 differs'))).to.equal(true);
      expect(result.problems.some((p) => p.includes('code/db/package.json: "next" is not a semver'))).to.equal(true);
      expect(result.problems.some((p) => p.includes('tag v9.9.9 does not match'))).to.equal(true);
    });

    it('sets one version everywhere, preserves CRLF, and is idempotent', () => {
      root = fixtureRoot('1.2.3', { eol: '\r\n' });
      const changed = setVersions(root, '2.0.0');
      expect(changed).to.have.length(VERSION_FILES.length);
      const check = checkVersions(root, { tag: 'v2.0.0' });
      expect(check.ok, check.problems.join('; ')).to.equal(true);
      const mta = readFileSync(join(root, 'deploy/cf/mta.yaml'), 'utf8');
      expect(mta).to.include('version: 2.0.0\r\n');
      expect(mta).to.include('      version: 9.9.9\r\n', 'nested version untouched');
      expect(mta.split('\n').every((line, i, all) => i === all.length - 1 || line.endsWith('\r'))).to.equal(true, 'CRLF preserved');
      expect(setVersions(root, '2.0.0')).to.deep.equal([]);
      expect(() => setVersions(root, '2.0')).to.throw(/not a semver/);
    });
  });

  it('the repository itself carries one consistent version', () => {
    const result = checkVersions(REPO_ROOT);
    expect(result.ok, result.problems.join('; ')).to.equal(true);
    expect(SEMVER.test(result.version)).to.equal(true);
  });
});
