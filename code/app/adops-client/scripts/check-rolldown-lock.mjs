// Guards the lockfile against the npm bug described in
// .claude/rules/frontend-dependencies.md: regenerating package-lock.json
// while node_modules exists records only the current platform's rolldown
// binary, and the client then builds on Windows but not on the Linux
// runner. Run by `npm run lock:check` and by the CI client job before
// `npm ci`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REQUIRED = [
  'node_modules/@rolldown/binding-linux-x64-gnu',
  'node_modules/@rolldown/binding-win32-x64-msvc',
  'node_modules/@rolldown/binding-darwin-arm64'
];

const lockPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const packages = Object.keys(lock.packages || {});
const bindings = packages.filter((name) => name.includes('@rolldown/binding'));
const missing = REQUIRED.filter((name) => !packages.includes(name));

if (missing.length) {
  console.error(`[lock:check] package-lock.json lacks rolldown platform binaries: ${missing.join(', ')}`);
  console.error(`[lock:check] present: ${bindings.join(', ') || '(none)'}`);
  console.error('[lock:check] regenerate cleanly: delete node_modules AND package-lock.json, then npm install (see .claude/rules/frontend-dependencies.md).');
  process.exit(1);
}
console.log(`[lock:check] rolldown binaries present for ${bindings.length} platforms (linux-x64-gnu included).`);
