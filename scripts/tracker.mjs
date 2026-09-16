#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Program tracker board.
//
//   node scripts/tracker.mjs            print the combined board
//   node scripts/tracker.mjs --check    validate the tracker files (exit 1 on problems)
//
// Reads docu/00-overview/tracker/{admin,scheduling,overview}.md. Item lines:
//   - [ ] <ID> text                to-do
//   - [~] <ID> text                in progress
//   - [x] <ID> text — PR #n, date  accomplished (PR reference required by --check)
// IDs: A/S/O/T + number (roadmap items), or I + number (promoted ideas).
// Non-ID accomplished lines (e.g. docs-only PRs) are allowed when they carry a
// PR reference.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trackerDir = path.join(root, 'docu', '00-overview', 'tracker');
const WORKSTREAMS = ['admin', 'scheduling', 'overview'];
const SECTIONS = { 'in progress': 'inProgress', 'to-do': 'todo', 'accomplished': 'done' };
const ITEM = /^- \[( |~|x)\] (.*)$/;
const ID = /^(?:[ASOT]\d+|I\d+)\b/;
const PR = /PR #\d+|this PR/i;

function parse(file) {
  const result = { inProgress: [], todo: [], done: [], problems: [] };
  let section = null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      const key = Object.keys(SECTIONS).find((name) => heading[1].toLowerCase().startsWith(name));
      section = key ? SECTIONS[key] : null;
      return;
    }
    const item = line.match(ITEM);
    if (!item || !section) return;
    const [, state, text] = item;
    const where = `${path.basename(file)}:${index + 1}`;
    const expected = { ' ': 'todo', '~': 'inProgress', x: 'done' }[state];
    if (expected !== section) result.problems.push(`${where}: "[${state}]" item sits under the ${section} section`);
    if (section !== 'done' && !ID.test(text)) result.problems.push(`${where}: item has no roadmap ID: ${text.slice(0, 60)}`);
    if (section === 'done' && !PR.test(text)) result.problems.push(`${where}: accomplished item has no PR reference: ${text.slice(0, 60)}`);
    if (section === 'inProgress' && !/branch\s+\S+/.test(text)) result.problems.push(`${where}: in-progress item names no branch: ${text.slice(0, 60)}`);
    result[section].push(text);
  });
  return result;
}

const check = process.argv.includes('--check');
let problems = 0;
const totals = { inProgress: 0, todo: 0, done: 0 };

for (const workstream of WORKSTREAMS) {
  const file = path.join(trackerDir, `${workstream}.md`);
  if (!fs.existsSync(file)) { console.error(`missing ${file}`); problems += 1; continue; }
  const board = parse(file);
  totals.inProgress += board.inProgress.length;
  totals.todo += board.todo.length;
  totals.done += board.done.length;
  console.log(`\n== ${workstream.toUpperCase()}  (in progress ${board.inProgress.length} · to-do ${board.todo.length} · done ${board.done.length})`);
  for (const text of board.inProgress) console.log(`  [~] ${text}`);
  for (const text of board.todo) console.log(`  [ ] ${text.length > 110 ? `${text.slice(0, 107)}...` : text}`);
  if (!check) for (const text of board.done.slice(0, 3)) console.log(`  [x] ${text.length > 110 ? `${text.slice(0, 107)}...` : text}`);
  if (!check && board.done.length > 3) console.log(`  [x] ... ${board.done.length - 3} more accomplished`);
  for (const problem of board.problems) { console.error(`  ! ${problem}`); problems += 1; }
}

const ideas = path.join(trackerDir, 'ideas.md');
const decisions = path.join(trackerDir, 'decisions.md');
const openIdeas = fs.existsSync(ideas) ? (fs.readFileSync(ideas, 'utf8').match(/^- I\d+ /gm) || []).length : 0;
const openDecisions = fs.existsSync(decisions) ? (fs.readFileSync(decisions, 'utf8').match(/^- \[ \] PO-\d+/gm) || []).length : 0;

console.log(`\nTOTAL  in progress ${totals.inProgress} · to-do ${totals.todo} · done ${totals.done} · open ideas ${openIdeas} · open PO decisions ${openDecisions}`);
if (check) {
  if (problems) { console.error(`\n${problems} problem(s) found.`); process.exit(1); }
  console.log('tracker files are consistent.');
}
