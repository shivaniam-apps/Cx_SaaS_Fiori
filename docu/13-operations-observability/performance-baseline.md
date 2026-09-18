# Performance baseline: enterprise-volume load test

Roadmap item T7. The three pages the performance rules name first
(Dashboard, Usage Insight, User & Role Landscape) are measured against an
enterprise-sized data set by `code/test/load-volume.test.mjs`. The test
proves two properties and records the numbers below:

1. **Bounded payloads.** Every read the client issues returns at most its
   page size (200 transactions, 100 inventory rows, 50 users of a
   transaction, a handful of grouped counts), whatever the volume behind
   it. A page that downloaded "everything" would fail the suite.
2. **Latency budget.** The p95 of six concurrent requests, three rounds per
   read, stays under the budget (1,000 ms at the CI scale, 3,000 ms at the
   enterprise reference).

## Running it

The suite is part of `npm test` at scale 1 (a few seconds, one extraction
run with 400 transactions and 2,500 users) so a regression shows up in CI.
The enterprise reference is one command:

```bash
cd code && npm run test:load
```

`ADOPTOPS_LOAD_SCALE` multiplies the base volumes (`test:load` sets 20),
`ADOPTOPS_LOAD_BUDGET_MS` overrides the budget, `ADOPTOPS_LOAD_REPORT=<file>`
writes the results table to a file. The data is generated in the process
and inserted straight into the database (no S/4 round trips), then removed
again, so the run leaves nothing behind.

Volumes at the enterprise reference (scale 20):

| Entity | Rows |
|---|---|
| Transactions (`TransactionUsage`) | 8,000 |
| Users (`UserInventory`) | 50,000 |
| User x transaction rows (`UserTransactionUsage`, top users per transaction) | 200,000 |
| Roles (`RoleInventory`) | 5,000 |
| Role assignments (`RoleUsers`) | 120,000 |
| Role transactions (`RoleTransactions`) | 50,000 |
| Proposals (`AppProposals`) of one completed analysis | 6,000 |

These are the orders of magnitude of a large S/4HANA installation after one
extraction; several runs multiply the user x transaction and inventory
tables accordingly.

## Results on the development machine, 2026-09-18

In-memory SQLite (the test database), Windows workstation, six concurrent
requests, three rounds. Seeding took 20 s at scale 20.

| Read | Rows | p95 ms (scale 1) | p95 ms (scale 20) |
|---|---|---|---|
| Dashboard summary, one system | 10 | 71 | 88 |
| Dashboard summary, all systems | 10 | 47 | 72 |
| Usage: first page with summary (top 200) | 200 | 75 | 93 |
| Usage: middle page (skip half) | 200 | 28 | 108 |
| Usage: search with summary | 200 | 35 | 82 |
| Usage: custom only, sorted by code | 200 | 44 | 84 |
| Usage: overview | 8 | 22 | 21 |
| Usage: users of a transaction (client filter, transaction only) | 50 | 55 | 347 |
| Usage: users of a transaction (run-scoped) | 50 | 59 | 434 |
| Landscape: users, most transactions (top 100) | 100 | 63 | 193 |
| Landscape: users, page 3 (skip 200) | 100 | 64 | 217 |
| Landscape: users, search + active filter | 100 | 60 | 204 |
| Landscape: user groups by type | 2 | 48 | 409 |
| Landscape: user groups by user group | 40 | 44 | 471 |
| Landscape: roles of one user | 2 | 29 | 157 |
| Landscape: roles, most users (top 100) | 100 | 45 | 61 |
| Landscape: roles, custom + search | 100 | 44 | 60 |
| Landscape: role groups by type | 2 | 27 | 54 |
| Landscape: members of one role | 26 | 29 | 162 |
| Landscape: transactions of one role | 13 | 23 | 72 |

Reading the table:

- The Dashboard and the transaction-level Usage Insight reads are flat
  across a 20x volume increase: grouped counts and a paged, indexed-by-key
  table behave as the performance rules intend.
- The reads that grow with volume are the ones that scan a large table for
  a filter the database has no index for: the user x transaction drill-down
  (200,000 rows by `TransactionCode`), the user inventory (50,000 rows by
  run, with `$count` and `groupby`) and the role assignments (120,000 rows
  by run and user or role). They stay well under half a second on SQLite,
  and under the budget, but their cost is linear in the table size.
- The client's user drill-down filters by transaction code only, without
  the run: the load test measures both the client's request and a
  run-scoped variant. Scoping does not cost more and is what the page
  means; the change belongs to the overview workstream (idea I44).

## What to expect on PostgreSQL

The production database is PostgreSQL with network latency and shared
resources, so absolute numbers differ; the shape does not. Without indexes
the linear reads above become sequential scans over the same tables, which
PostgreSQL handles well into the hundreds of thousands of rows but not into
the tens of millions that several enterprise runs accumulate. CAP creates
no secondary indexes for associations, so the deployer needs an index step
for `UserTransactionUsage (snapshot_ID, TransactionCode)`, `UserInventory
(extractionRun_ID)`, `RoleUsers (extractionRun_ID, RoleName)` and
`(extractionRun_ID, UserKey)`, `RoleTransactions (extractionRun_ID,
RoleName)` and `TransactionUsage (snapshot_ID)` before the second or third
enterprise extraction (idea I46). Re-run `npm run test:load` against a
PostgreSQL binding (hybrid profile) after that step and record the numbers
here.

## Budgets as a gate

The budgets are deliberately loose (10x the measured values) so the suite
catches a page that starts downloading whole tables or an N+1 pattern, not
a slow laptop. Tighten them once the PostgreSQL numbers exist.
