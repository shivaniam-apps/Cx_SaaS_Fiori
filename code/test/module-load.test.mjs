// Every module under srv/srv must load (roadmap A8).
//
// A module that requires a package outside package.json, or a sibling file
// that does not exist, only fails when its code path first runs - in the
// deployed instance, on a customer's subscription callback. Loading each
// file here turns that into a red test. The dead provisioning path
// (provisioning.js, alert-notification.js, cloud-foundry.js) failed exactly
// this way before it was removed.
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.NODE_ENV ??= 'test';

const require = createRequire(import.meta.url);
const srvDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'srv', 'srv');
const packageJson = JSON.parse(readFileSync(path.join(srvDir, '..', '..', 'package.json'), 'utf8'));
const declared = new Set([...Object.keys(packageJson.dependencies || {}), ...Object.keys(packageJson.devDependencies || {})]);

function listModules(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listModules(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files.sort();
}

// Bare package names required by a file: "@scope/name" or "name", ignoring
// relative paths and node: builtins.
function requiredPackages(file) {
  const source = readFileSync(file, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = match[1];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
    const parts = spec.split('/');
    names.add(spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
  }
  return [...names];
}

const BUILTINS = new Set(['crypto', 'fs', 'path', 'http', 'https', 'url', 'os', 'util', 'events', 'stream', 'zlib', 'querystring', 'child_process', 'assert', 'buffer', 'net', 'tls', 'dns']);

describe('server modules load cleanly (A8)', function () {
  this.timeout(30000);
  const modules = listModules(srvDir);

  it('finds the server modules', () => {
    expect(modules.length).to.be.greaterThan(20);
    expect(modules.some((f) => f.endsWith('basic-subscription.js'))).to.equal(true);
  });

  it('declares every package a module requires', () => {
    const undeclared = [];
    for (const file of modules) {
      for (const name of requiredPackages(file)) {
        if (BUILTINS.has(name) || declared.has(name)) continue;
        undeclared.push(`${path.relative(srvDir, file)} -> ${name}`);
      }
    }
    expect(undeclared, 'packages required but not declared in package.json').to.deep.equal([]);
  });

  for (const file of modules) {
    it(`requires ${path.relative(srvDir, file).replace(/\\/g, '/')}`, () => {
      expect(() => require(file)).to.not.throw();
    });
  }
});
