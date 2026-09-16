# Program tracker

The single place where progress on the [Road to Production](road-to-production.md)
is tracked. It exists so nothing falls through the cracks while three
workstreams move in parallel: every item, every idea and every day's work is
written down here, in the repository, and travels with the branches.

## How it works

- **One file per workstream** under [`tracker/`](tracker/): [admin](tracker/admin.md),
  [scheduling](tracker/scheduling.md), [overview](tracker/overview.md). A branch edits
  only its own workstream's file, so parallel PRs never conflict on the tracker.
- **Ideas and parking lot** in [tracker/ideas.md](tracker/ideas.md): anyone appends,
  nobody deletes; an idea that becomes work moves to a workstream To-do with an ID.
- **Decisions** waiting on the product owner live in [tracker/decisions.md](tracker/decisions.md).
- **Combined board**: `node scripts/tracker.mjs` prints every workstream's In progress,
  To-do and Accomplished lists with counts; `node scripts/tracker.mjs --check` validates
  the format (every item has an ID, every accomplished item names its PR).

## Item lifecycle

```
To-do  ->  In progress (branch, start date)  ->  Accomplished (PR #, merge date)
```

1. Before starting: move the line from **To-do** to **In progress**, add the branch name
   and date. Commit it on the item's branch.
2. While working: add a dated line to **Daily log** for anything worth remembering
   (what was done, what was learned, what was left out). Discoveries that are not part
   of the item go to `tracker/ideas.md` right away.
3. In the PR: move the line to **Accomplished** with `PR #n, yyyy-mm-dd`. The line keeps
   its ID and a one-line outcome so the accomplished list reads as a changelog.
4. Never delete a To-do without a note in **Accomplished** (done) or `ideas.md`
   (parked, with the reason).

## Line format

```
- [ ] A4 Hash-chained append-only audit log — data-model, admin-audit.js, AdminService
- [~] A4 Hash-chained append-only audit log — branch feat/audit-hash-chain, started 2026-09-16
- [x] A3 Read-only PublicService projections, writes via actions — PR #9, 2026-09-16
```

`[ ]` to-do, `[~]` in progress, `[x]` accomplished. IDs come from the roadmap
(A/S/O/T for items, PO for decisions, I for ideas that got promoted).

## Daily rhythm

- Start of a session: `node scripts/tracker.mjs` to see the board; pick the top open
  item of your workstream unless the roadmap's merge order says otherwise.
- End of a session: Daily log line written, In progress line accurate, ideas parked.
- The primary checkout on `main` is never edited directly; the tracker changes ride
  on the item's branch and reach `main` with its PR.
