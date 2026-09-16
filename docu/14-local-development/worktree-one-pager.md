# Working in the worktrees — one pager

Three worktrees, three Claude Code sessions, one `main`. Details in
[parallel-worktrees.md](parallel-worktrees.md); tracking rules in
[program-tracker.md](../00-overview/program-tracker.md).

## Where things live

| | Folder | Branch style | CAP | Client | Tracker file |
|---|---|---|---|---|---|
| main checkout | `Cx_SaaS_Fiori` | `main` only, never edit here | 4104 | 5273 | — |
| admin | `Cx_SaaS_Fiori.worktrees/admin` | `feat/…`, `chore/…`, `docs/…` | 4134 | 5303 | `tracker/admin.md` |
| scheduling | `Cx_SaaS_Fiori.worktrees/scheduling` | `feat/…`, `fix/…` | 4124 | 5293 | `tracker/scheduling.md` |
| overview | `Cx_SaaS_Fiori.worktrees/overview` | `feat/…` | 4114 | 5283 | `tracker/overview.md` |

## Daily loop (per worktree)

1. **Board**: `node scripts/tracker.mjs` — pick the top open item of your workstream.
2. **Start**: move the item to *In progress* in your tracker file (branch, date). Commit.
3. **Build**: code + tests in the worktree. Servers via `preview_start adops-cap` / `adops-client`
   (ports already set). Restart the CAP server by hand after backend changes.
4. **Verify**: `cd code && npm test` · `cd code/app/adops-client && npm test && npm run lint`.
   Browser check on your slot's client port.
5. **Record**: dated *Daily log* line; new ideas to `tracker/ideas.md`.
6. **Ship**: move the item to *Accomplished* (`PR #n, date`), push, open the PR
   (title, summary, tests, shared contracts, workstream + item ID, merge order).
7. **After merge** (from the main checkout):
   `node scripts/worktree.mjs next <workstream> <next-branch>`

## Session start is automatic

Every worktree carries a generated, gitignored `CLAUDE.local.md` next to `CLAUDE.md`.
Claude Code reads it at session start, so a session opened in a worktree already knows its
workstream, ports, branch and the In progress item from the tracker, and follows the
start-of-session steps without a pasted prompt. `worktree.mjs add` and `next` write it;
`node scripts/worktree.mjs sync` regenerates it (for example after the In progress item
changed). Just open the session in the worktree folder and say what you want, or nothing
at all ("continue") - the brief tells the session to report which item it is on first.

## Rules of the road

- Shared contracts land on `main` first: CDS entity/service shapes, `ObjectKeyJson`,
  shared React components, `fioriService.js`. The other worktrees pick them up with
  `git merge --no-edit origin/main`.
- One item, one branch, one squash-merged PR. Never push to `main`.
- Each worktree has its own `code/db.sqlite`; never point two servers at one file.
- `node_modules` is junction-linked to the main checkout: run `npm ci` in the worktree
  the moment the branch changes dependencies.
- ABAP: change `../a4h_2023_zado` first, smoke on RD1 DEV/100, mirror into `abap/src`.
- Do not write to `.claude/rules/` or `CLAUDE.md` unprompted; propose a diff.

## Commands

```bash
node scripts/worktree.mjs list                              # slots, paths, branches
node scripts/worktree.mjs add spare fix/hotfix-x            # extra worktree
node scripts/worktree.mjs next admin feat/tenant-scope-gaps # re-point after a merge
node scripts/worktree.mjs remove spare                      # tidy up
node scripts/tracker.mjs [--check]                          # board / validation
```
