# Parallel worktrees

The roadmap (`docu/00-overview/road-to-production.md`) is organised in three
workstreams that can build, test and preview at the same time. Each
workstream gets its own git worktree: a separate folder with its own branch,
its own `code/db.sqlite`, its own dev-server ports and its own
`.claude/launch.json`. Nothing is shared except the git object store, so one
Claude Code session (or developer) per worktree never blocks another.

## Slots

| Workstream | Owns | Folder | CAP | Client |
|---|---|---|---|---|
| main checkout | integration, PR review, `main` only | `Cx_SaaS_Fiori/` | 4104 | 5273 |
| `overview` | journey pages in `code/app/adops-client` (O items) | `Cx_SaaS_Fiori.worktrees/overview/` | 4114 | 5283 |
| `scheduling` | tasks, S/4 adapters, ABAP mirror (S items) | `Cx_SaaS_Fiori.worktrees/scheduling/` | 4124 | 5293 |
| `admin` | deploy, security, audit, CI, docs (A and T items) | `Cx_SaaS_Fiori.worktrees/admin/` | 4134 | 5303 |
| `spare` | ad-hoc reviews, hot fixes | `Cx_SaaS_Fiori.worktrees/spare/` | 4144 | 5313 |

ChronoPilot owns 4004 on the same machine; no AdoptOps slot uses it.

## Create a worktree

Run from the main checkout, on branch `main`:

```bash
node scripts/worktree.mjs add admin feat/audit-hash-chain
```

This fetches `origin`, creates the worktree from a fresh `origin/main`,
creates the branch, writes the slot's `.claude/launch.json`, writes the
session brief `CLAUDE.local.md` (gitignored; Claude Code reads it at session
start, so no prompt has to be pasted), installs `node_modules` for the CAP
project and the client (log in `.worktree-setup.log` inside the worktree),
and creates the worktree's own sqlite database with `npm run db:init:sqlite`.

`node scripts/worktree.mjs sync [<workstream>]` regenerates the session
brief(s), for example after the In progress item in the tracker changed.

`--link-modules` junctions `node_modules` to the main checkout instead of
installing (seconds instead of minutes). Only do this while the branch does
not change dependencies; run `npm ci` in the worktree as soon as it does.

## Work inside a worktree

Open a Claude Code session in the worktree folder (or `code .` there). The
launch config already points `preview_start` at the slot's ports:

- `adops-cap` runs the no-watch CAP script on the slot's CAP port. Restart it
  by hand after backend changes: `cds serve --watch` children on this
  machine stop serving HTTP after a reload.
- `adops-client` runs Vite on the slot's client port with its proxy aimed at
  the slot's CAP port.

Tests run per worktree as usual (`cd code && npm test`,
`cd code/app/adops-client && npm test && npm run lint`).

The rules in `.claude/rules/git-workflow.md` apply unchanged: one item, one
branch, one squash-merged PR. State the workstream and the item ID (for
example `A4`) in the PR body so reviewers can see the merge order.

## Move to the next item

After the PR merged:

```bash
node scripts/worktree.mjs next admin feat/tenant-scope-gaps
```

`next` refuses to run with uncommitted changes, re-points the worktree at
the fresh `origin/main` on the new branch, and refreshes the sqlite views
(`db:refresh:sqlite`), which also heals additive schema drift. Merged
branches are deleted the normal way from the main checkout
(`git branch -d`).

## Shared contracts and merge order

Parallel work is only fast when the branches do not fight over the same
lines. Land shared-contract items on `main` first and let the other worktrees
pick them up with `git merge --no-edit origin/main`:

- CDS service surface and entity shapes (A3 read-only projections, A4
  `AuditEvents` chain columns, A5 `tenantScoped` aspect)
- the planner and ABAP `ObjectKeyJson` contract (S2)
- shared React components (`Kpi`, `RestrictedState`, `AdopsPageTabs`) and
  `fioriService.js`

When two worktrees must touch such a file in the same week, the owner of
the contract lands it first and the other rebases. Each PR body lists the
shared contracts it changes and the affected workstreams, as the git
workflow rule already requires.

## Remove a worktree

```bash
node scripts/worktree.mjs remove spare
```

Refuses while the worktree has uncommitted changes. `list` prints every
slot with its branch.

## Seed the journey in a fresh worktree

A new worktree database is empty. `scripts/seed-dev.mjs` drives the whole
Activate journey through the public actions against the worktree's CAP
port, exactly as a user would (target system -> usage extraction with the
USR02/AGR inventory -> proposals -> wave -> approvals -> plan -> simulate ->
execute), so every page has data to show:

```bash
node scripts/seed-dev.mjs --port 4114              # overview slot
node scripts/seed-dev.mjs --port 4124 --approve 8  # scheduling slot, more approvals
node scripts/seed-dev.mjs --port 4134 --no-activate
```

It refuses a server that is not in mock mode (`ADOPTOPS_MOCK_S4=true`, which
the sqlite dev-server scripts set): the journey ends in an activation
execute that must never reach a real S/4HANA. Re-running reuses the target
system on the seed destination (`MOCK_RD1_DEV`, override with
`--destination`) and adds another extraction, proposal set, wave and plan.
The script prints deep links into the client for every object it created.

## Manual equivalent

The script only wraps standard git commands:

```bash
git fetch --prune origin
git worktree add --detach ../Cx_SaaS_Fiori.worktrees/admin origin/main
git -C ../Cx_SaaS_Fiori.worktrees/admin checkout -b feat/audit-hash-chain
```

then write `.claude/launch.json` with the slot's ports (see the script for
the exact shape), `npm ci` in `code/` and `code/app/adops-client/`, and
`npm run db:init:sqlite` in `code/`.
