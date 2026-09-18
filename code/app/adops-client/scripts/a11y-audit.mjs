// Static accessibility audit over the client sources (roadmap A13).
// Prints one line per unlabeled control and exits 1 when any is found; the
// same rules run in src/features/a11y/staticAudit.test.js as the gate.
//   node scripts/a11y-audit.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSource, formatFindings } from '../src/features/a11y/staticAudit.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
export const AUDITED_DIRS = ['pages', 'layouts', 'components', 'app'];

export function auditClientSources() {
  const findings = [];
  for (const dir of AUDITED_DIRS) {
    let files = [];
    try { files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.jsx')); } catch { continue; }
    for (const file of files) {
      findings.push(...auditSource(readFileSync(join(root, dir, file), 'utf8'), { file: `src/${dir}/${file}` }));
    }
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const findings = auditClientSources();
  if (findings.length) {
    console.log(formatFindings(findings));
    console.log(`\n${findings.length} unlabeled control(s).`);
    process.exit(1);
  }
  console.log('No unlabeled controls found.');
}
