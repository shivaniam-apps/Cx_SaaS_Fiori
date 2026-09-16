#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AdoptOps parallel worktrees.
//
// One git worktree per workstream (git-workflow.md), each with its own
// branch, its own sqlite database, its own dev-server ports and its own
// .claude/launch.json, so several Claude Code sessions (or people) build,
// test and preview in parallel without stepping on each other.
//
//   node scripts/worktree.mjs add <workstream> <branch> [--link-modules] [--no-install]
//   node scripts/worktree.mjs next <workstream> <branch>      # re-point an existing worktree at a fresh branch from origin/main
//   node scripts/worktree.mjs list
//   node scripts/worktree.mjs remove <workstream>
//
// Workstreams and their port slots (main checkout keeps 4104 / 5273):
//
//   overview    CAP 4114  client 5283   (journey pages, React)
//   scheduling  CAP 4124  client 5293   (tasks, adapters, ABAP mirror)
//   admin       CAP 4134  client 5303   (deploy, security, audit, CI, docs)
//   spare       CAP 4144  client 5313   (ad-hoc / review)
//
// Worktrees live beside the repository: <repo>.worktrees/<workstream>.
// Run this from the MAIN checkout (the one whose branch is `main`).
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SLOTS = {
  overview: { cap: 4114, client: 5283 },
  scheduling: { cap: 4124, client: 5293 },
  admin: { cap: 4134, client: 5303 },
  spare: { cap: 4144, client: 5313 }
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worktreesRoot = `${repoRoot}.worktrees`;
const TAG = '[worktree]';

function log(message) { console.log(`${TAG} ${message}`); }
function fail(message) { console.error(`${TAG} ${message}`); process.exit(1); }

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: options.cwd || repoRoot, encoding: 'utf8', stdio: options.inherit ? 'inherit' : 'pipe' });
  if (result.status !== 0 && !options.allowFailure) {
    fail(`git ${args.join(' ')} failed${result.stderr ? `:\n${result.stderr}` : ''}`);
  }
  return (result.stdout || '').trim();
}

function run(command, args, cwd, logFile, env = {}) {
  log(`${command} ${args.join(' ')}  (in ${path.relative(worktreesRoot, cwd) || cwd}, log: ${path.basename(logFile)})`);
  const out = fs.openSync(logFile, 'a');
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', out, out], shell: true, env: { ...process.env, ...env } });
  fs.closeSync(out);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed - see ${logFile}`);
}

function slotFor(workstream) {
  const slot = SLOTS[workstream];
  if (!slot) fail(`Unknown workstream "${workstream}". Use one of: ${Object.keys(SLOTS).join(', ')}`);
  return slot;
}

function worktreePath(workstream) {
  return path.join(worktreesRoot, workstream);
}

// .claude/launch.json is per-checkout (untracked). The with-env wrapper sets
// the slot's ports before npm runs the shared scripts, whose PORT?= defaults
// then yield. The CAP entry uses the no-watch script: `cds serve --watch`
// children on this machine stop serving HTTP after a reload (observed
// 2026-09-15), so restart the CAP preview by hand after backend changes.
function launchJson(slot) {
  return `${JSON.stringify({
    version: '0.0.1',
    configurations: [
      {
        name: 'adops-cap',
        runtimeExecutable: 'node',
        runtimeArgs: ['code/scripts/with-env.mjs', `PORT=${slot.cap}`, '--', 'npm', 'run', 'srv:sqlite:nowatch', '--prefix', 'code'],
        port: slot.cap
      },
      {
        name: 'adops-client',
        runtimeExecutable: 'node',
        runtimeArgs: ['code/scripts/with-env.mjs', `PORT=${slot.client}`, `VITE_ADOPS_CAP_SERVER=http://localhost:${slot.cap}`, '--', 'npm', 'run', 'dev', '--prefix', 'code/app/adops-client'],
        port: slot.client
      }
    ]
  }, null, 2)}\n`;
}

// Worktrees are always created from origin/main (fetched fresh), so the
// primary checkout may sit on any branch - it must only be the primary one,
// not itself a linked worktree.
function ensureMainCheckout() {
  const gitDir = git(['rev-parse', '--git-dir']);
  if (gitDir !== '.git' && !gitDir.endsWith(`${path.sep}.git`) && !gitDir.endsWith('/.git')) {
    fail(`Run this from the primary checkout (${repoRoot}), not from a linked worktree.`);
  }
}

function freshMain() {
  git(['fetch', '--prune', 'origin']);
  return git(['rev-parse', '--short', 'origin/main']);
}

function checkoutFreshBranch(dir, branch) {
  git(['checkout', '--detach', 'origin/main'], { cwd: dir });
  git(['checkout', '-b', branch], { cwd: dir });
}

function linkOrInstall(dir, { linkModules, install }) {
  const logFile = path.join(dir, '.worktree-setup.log');
  const targets = [
    { rel: 'code', src: path.join(repoRoot, 'code', 'node_modules') },
    { rel: path.join('code', 'app', 'adops-client'), src: path.join(repoRoot, 'code', 'app', 'adops-client', 'node_modules') }
  ];
  for (const target of targets) {
    const pkgDir = path.join(dir, target.rel);
    const modules = path.join(pkgDir, 'node_modules');
    if (fs.existsSync(modules)) continue;
    if (linkModules) {
      if (!fs.existsSync(target.src)) fail(`--link-modules: ${target.src} does not exist; run npm install in the main checkout first.`);
      fs.symlinkSync(target.src, modules, 'junction');
      log(`linked ${path.relative(dir, modules)} -> main checkout (same lockfile assumed; run npm ci here if this branch changes dependencies)`);
    } else if (install) {
      run('npm', ['ci', '--no-audit', '--no-fund'], pkgDir, logFile);
    }
  }
  return logFile;
}

// Same command as `npm run db:init:sqlite`, invoked directly so a worktree
// cut from an older main (without that script) still gets its database.
function initDatabase(dir, logFile) {
  const dbFile = path.join(dir, 'code', 'db.sqlite');
  if (fs.existsSync(dbFile)) return;
  run('npx', ['cds', 'deploy', '--profile', 'development'], path.join(dir, 'code', 'srv'), logFile,
    { NODE_ENV: 'development', CDS_ENV: 'development' });
}

function add(workstream, branch, flags) {
  ensureMainCheckout();
  if (!branch) fail('Usage: add <workstream> <branch>');
  const slot = slotFor(workstream);
  const dir = worktreePath(workstream);
  if (fs.existsSync(dir)) fail(`${dir} already exists - use "next" to re-point it or "remove" first.`);
  const head = freshMain();
  fs.mkdirSync(worktreesRoot, { recursive: true });
  log(`adding worktree ${dir} from origin/main (${head}) on branch ${branch}`);
  git(['worktree', 'add', '--detach', dir, 'origin/main']);
  git(['checkout', '-b', branch], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'launch.json'), launchJson(slot));
  const logFile = linkOrInstall(dir, flags);
  if (flags.install || flags.linkModules) initDatabase(dir, logFile);
  summary(workstream, dir, branch, slot);
}

function next(workstream, branch) {
  ensureMainCheckout();
  if (!branch) fail('Usage: next <workstream> <branch>');
  const dir = worktreePath(workstream);
  if (!fs.existsSync(dir)) fail(`${dir} does not exist - use "add".`);
  const status = git(['status', '--porcelain'], { cwd: dir });
  const dirty = status.split('\n').filter((line) => line && !line.includes('.claude/launch.json'));
  if (dirty.length) fail(`worktree has uncommitted changes:\n${dirty.join('\n')}\nCommit or stash them first.`);
  const head = freshMain();
  log(`re-pointing ${dir} at origin/main (${head}) on new branch ${branch}`);
  checkoutFreshBranch(dir, branch);
  const logFile = path.join(dir, '.worktree-setup.log');
  run('npm', ['run', 'db:refresh:sqlite'], path.join(dir, 'code'), logFile);
  summary(workstream, dir, branch, slotFor(workstream));
}

function list() {
  console.log(git(['worktree', 'list']));
  console.log('');
  console.log('slot        CAP    client  path');
  for (const [name, slot] of Object.entries(SLOTS)) {
    const dir = worktreePath(name);
    const branch = fs.existsSync(dir) ? git(['branch', '--show-current'], { cwd: dir, allowFailure: true }) || '(detached)' : '-';
    console.log(`${name.padEnd(11)} ${String(slot.cap).padEnd(6)} ${String(slot.client).padEnd(7)} ${fs.existsSync(dir) ? `${dir}  [${branch}]` : '(not created)'}`);
  }
}

function remove(workstream) {
  ensureMainCheckout();
  const dir = worktreePath(workstream);
  if (!fs.existsSync(dir)) fail(`${dir} does not exist.`);
  const status = git(['status', '--porcelain'], { cwd: dir });
  const dirty = status.split('\n').filter((line) => line && !line.includes('.claude/launch.json') && !line.includes('.worktree-setup.log'));
  if (dirty.length) fail(`worktree has uncommitted changes:\n${dirty.join('\n')}\nCommit, push or discard them first (git worktree remove --force to discard).`);
  git(['worktree', 'remove', '--force', dir]);
  git(['worktree', 'prune']);
  log(`removed ${dir}. Branches are kept; delete merged ones with git branch -d.`);
}

function summary(workstream, dir, branch, slot) {
  console.log('');
  log(`ready: ${workstream}`);
  console.log(`  path     ${dir}`);
  console.log(`  branch   ${branch}`);
  console.log(`  CAP      http://localhost:${slot.cap}   (preview_start "adops-cap" in this worktree)`);
  console.log(`  client   http://localhost:${slot.client}   (preview_start "adops-client")`);
  console.log('  next     open a Claude Code session in that folder, or: cd there && code .');
  console.log('  finish   push, open the PR, then: node scripts/worktree.mjs next <workstream> <next-branch>');
}

const [command, workstream, branch, ...rest] = process.argv.slice(2);
const flags = {
  linkModules: rest.includes('--link-modules') || branch === '--link-modules',
  install: !rest.includes('--no-install')
};

switch (command) {
  case 'add': add(workstream, branch, flags); break;
  case 'next': next(workstream, branch); break;
  case 'list': list(); break;
  case 'remove': remove(workstream); break;
  default:
    console.log('Usage:');
    console.log('  node scripts/worktree.mjs add <workstream> <branch> [--link-modules] [--no-install]');
    console.log('  node scripts/worktree.mjs next <workstream> <branch>');
    console.log('  node scripts/worktree.mjs list');
    console.log('  node scripts/worktree.mjs remove <workstream>');
    console.log(`Workstreams: ${Object.keys(SLOTS).join(', ')}`);
    process.exit(command ? 1 : 0);
}
