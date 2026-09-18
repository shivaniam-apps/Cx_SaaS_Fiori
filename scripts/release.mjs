#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Release version: one number for the whole product (roadmap T5).
//
//   node scripts/release.mjs current            print the version and where it is read from
//   node scripts/release.mjs check [--tag vX]   every file carries the same semver (exit 1 otherwise);
//                                               with --tag the git tag must match too
//   node scripts/release.mjs set <version>      write <version> into every file
//
// The MTA version names the archive (adops-basic_<version>.mtar) and every
// extension descriptor must repeat it; the client bakes its package version
// into telemetry (__APP_VERSION__); the server reports its package version on
// /readyz. This script keeps them identical so "which version is running" has
// one answer. Line endings of each file are preserved.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

// kind 'mta': the top-level `version:` line of a YAML descriptor.
// kind 'package': the "version" field of a package.json.
export const VERSION_FILES = [
  { path: 'deploy/cf/mta.yaml', kind: 'mta' },
  { path: 'deploy/cf/mtaext/dev.mtaext', kind: 'mta' },
  { path: 'deploy/cf/mtaext/qa.mtaext', kind: 'mta' },
  { path: 'deploy/cf/mtaext/prod.mtaext', kind: 'mta' },
  { path: 'code/package.json', kind: 'package' },
  { path: 'code/db/package.json', kind: 'package' },
  { path: 'code/app/adops-client/package.json', kind: 'package' },
  { path: 'deploy/cf/package.json', kind: 'package' }
];

const MTA_VERSION_LINE = /^(version:\s*)(['"]?)([^'"\r\n]*)\2(\s*)$/m;
const PACKAGE_VERSION_FIELD = /("version"\s*:\s*")([^"]*)(")/;

export function readVersion(text, kind) {
  const match = kind === 'mta' ? text.match(MTA_VERSION_LINE) : text.match(PACKAGE_VERSION_FIELD);
  if (!match) return null;
  return kind === 'mta' ? match[3].trim() : match[2];
}

export function writeVersion(text, kind, version) {
  if (kind === 'mta') {
    if (!MTA_VERSION_LINE.test(text)) throw new Error('no top-level version line');
    return text.replace(MTA_VERSION_LINE, (_, key, quote, _old, tail) => `${key}${quote}${version}${quote}${tail}`);
  }
  if (!PACKAGE_VERSION_FIELD.test(text)) throw new Error('no "version" field');
  return text.replace(PACKAGE_VERSION_FIELD, `$1${version}$3`);
}

export function readVersions(root) {
  return VERSION_FILES.map((file) => {
    const text = readFileSync(join(root, file.path), 'utf8');
    return { ...file, version: readVersion(text, file.kind) };
  });
}

// Returns { ok, version, problems[] } for the files under root.
export function checkVersions(root, { tag } = {}) {
  const entries = readVersions(root);
  const problems = [];
  const first = entries[0].version;
  for (const entry of entries) {
    if (!entry.version) problems.push(`${entry.path}: no version found`);
    else if (!SEMVER.test(entry.version)) problems.push(`${entry.path}: "${entry.version}" is not a semver`);
    else if (entry.version !== first) problems.push(`${entry.path}: ${entry.version} differs from ${entries[0].path} (${first})`);
  }
  if (tag !== undefined) {
    const expected = `v${first}`;
    if (tag !== expected) problems.push(`tag ${tag} does not match the version (${expected})`);
  }
  return { ok: problems.length === 0, version: first, problems, entries };
}

export function setVersions(root, version) {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a semver (MAJOR.MINOR.PATCH[-prerelease])`);
  const changed = [];
  for (const file of VERSION_FILES) {
    const path = join(root, file.path);
    const before = readFileSync(path, 'utf8');
    const after = writeVersion(before, file.kind, version);
    if (after !== before) {
      writeFileSync(path, after);
      changed.push(file.path);
    }
  }
  return changed;
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const [command, ...rest] = argv;
  if (command === 'current' || command === undefined) {
    for (const entry of readVersions(root)) console.log(`${entry.version ?? '<none>'}\t${entry.path}`);
    return 0;
  }
  if (command === 'check') {
    const tagIndex = rest.indexOf('--tag');
    const tag = tagIndex >= 0 ? rest[tagIndex + 1] : undefined;
    const result = checkVersions(root, { tag });
    if (result.ok) {
      console.log(`version ${result.version} is consistent across ${result.entries.length} files${tag ? ` and matches ${tag}` : ''}`);
      return 0;
    }
    for (const problem of result.problems) console.error(problem);
    console.error('\nAlign with: node scripts/release.mjs set <version>');
    return 1;
  }
  if (command === 'set') {
    const version = rest[0];
    if (!version) {
      console.error('usage: node scripts/release.mjs set <version>');
      return 1;
    }
    const changed = setVersions(root, version);
    console.log(changed.length ? `set ${version} in:\n  ${changed.join('\n  ')}` : `every file already carries ${version}`);
    console.log('\nNext: commit, open the PR, and after the squash merge tag main with v' + version + ' (docu/05-deployment-tiers/release-process.md).');
    return 0;
  }
  console.error('usage: node scripts/release.mjs current | check [--tag vX.Y.Z] | set <version>');
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
