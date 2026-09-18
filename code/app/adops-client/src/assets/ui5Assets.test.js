import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Icon registration guard (O9 / I14): UI5 icons load on demand, so an
// `icon="x"` whose module is not imported in ui5Assets.js renders empty and
// logs "No loader registered". This test lists every icon literal used in
// src and fails on the ones ui5Assets.js does not import - add the import
// there, never the full icon set.

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..');
const assetsFile = join(here, 'ui5Assets.js');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(jsx?|tsx?)$/.test(name) && !/\.test\.jsx?$/.test(name)) out.push(full);
  }
  return out;
}

function registeredIcons(source) {
  return new Set([...source.matchAll(/@ui5\/webcomponents-icons\/dist\/([a-z0-9-]+)\.js/g)].map((m) => m[1]));
}

function registeredIllustrations(source) {
  return new Set([...source.matchAll(/illustrations\/([A-Za-z0-9]+)\.js/g)].map((m) => m[1]));
}

// Icon literals: icon="x", icon: 'x', and every quoted literal inside an
// icon={...} expression (conditionals). Illustrations: IllustratedMessage
// name="X" / name={'X'}.
export function usedIcons(source) {
  const icons = new Set();
  for (const m of source.matchAll(/\bicon="([a-z0-9-]+)"/g)) icons.add(m[1]);
  for (const m of source.matchAll(/\bicon:\s*'([a-z0-9-]+)'/g)) icons.add(m[1]);
  for (const m of source.matchAll(/\bicon=\{([^}]*)\}/g)) {
    for (const lit of m[1].matchAll(/'([a-z0-9-]+)'/g)) icons.add(lit[1]);
  }
  return icons;
}

export function usedIllustrations(source) {
  const names = new Set();
  for (const m of source.matchAll(/<IllustratedMessage[^>]*\bname=(?:"([A-Za-z0-9]+)"|\{'([A-Za-z0-9]+)'\})/g)) names.add(m[1] || m[2]);
  return names;
}

test('every icon and illustration used in src is registered in ui5Assets.js', () => {
  const assets = readFileSync(assetsFile, 'utf8');
  const icons = registeredIcons(assets);
  const illustrations = registeredIllustrations(assets);
  const missing = [];
  for (const file of walk(srcDir)) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(srcDir, file);
    for (const icon of usedIcons(source)) if (!icons.has(icon)) missing.push(`${rel}: icon "${icon}"`);
    for (const name of usedIllustrations(source)) if (!illustrations.has(name)) missing.push(`${rel}: illustration "${name}"`);
  }
  assert.deepEqual(missing, [], `Register these in src/assets/ui5Assets.js:\n${missing.join('\n')}`);
  assert.ok(icons.size > 10, 'ui5Assets.js should register the icons the screens use');
});

test('the scanners see the literal forms the codebase uses', () => {
  const sample = `
    <Button icon="refresh" />
    const views = [{ icon: 'employee' }];
    <Button icon={busy ? 'stop' : 'play'} />
    <IllustratedMessage name="NoData" />
    <IllustratedMessage name={'UnableToLoad'} />
  `;
  assert.deepEqual([...usedIcons(sample)].sort(), ['employee', 'play', 'refresh', 'stop']);
  assert.deepEqual([...usedIllustrations(sample)].sort(), ['NoData', 'UnableToLoad']);
});
