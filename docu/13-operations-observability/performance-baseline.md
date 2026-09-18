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
requests, three rounds. Seeding took 20 s at scale 20. "Indexes" are the
secondary indexes of `code/db/indexes.js` (idea I46) that the deployer,
the local refresh and the load test now apply; the "without" column is the
same run before they existed. Numbers on a shared workstation vary by
about a fifth between runs; read the ratios, not the last digit.

| Read | Rows | p95 ms, scale 1 | p95 ms, scale 20 without indexes | p95 ms, scale 20 with indexes |
|---|---|---|---|---|
| Dashboard summary, one system | 10 | 73 | 88 | 87 |
| Dashboard summary, all systems | 10 | 45 | 72 | 66 |
| Usage: first page with summary (top 200) | 200 | 75 | 93 | 92 |
| Usage: middle page (skip half) | 200 | 60 | 108 | 120 |
| Usage: search with summary | 200 | 65 | 82 | 93 |
| Usage: custom only, sorted by code | 200 | 44 | 84 | 90 |
| Usage: overview | 8 | 24 | 21 | 23 |
| Usage: users of a transaction (client filter, transaction only) | 50 | 46 | 347 | 48 |
| Usage: users of a transaction (run-scoped) | 50 | 39 | 434 | 41 |
| Landscape: users, most transactions (top 100) | 100 | 59 | 193 | 216 |
| Landscape: users, page 3 (skip 200) | 100 | 72 | 217 | 248 |
| Landscape: users, search + active filter | 100 | 61 | 204 | 243 |
| Landscape: user groups by type | 2 | 54 | 409 | 617 |
| Landscape: user groups by user group | 40 | 51 | 471 | 638 |
| Landscape: roles of one user | 2 | 23 | 157 | 24 |
| Landscape: roles, most users (top 100) | 100 | 43 | 61 | 61 |
| Landscape: roles, custom + search | 100 | 47 | 60 | 61 |
| Landscape: role groups by type | 2 | 28 | 54 | 66 |
| Landscape: members of one role | 26 | 25 | 162 | 25 |
| Landscape: transactions of one role | 13 | 24 | 72 | 23 |

Reading the table:

- The Dashboard and the transaction-level Usage Insight reads are flat
  across a 20x volume increase: grouped counts and a paged table of 8,000
  rows behave as the performance rules intend, with or without indexes.
- The keyed lookups into the big tables are the ones the indexes fix: users
  of one transaction (200,000 rows) 347 to 48 ms, roles of one user
  (120,000 assignments) 157 to 24 ms, members of one role 162 to 25 ms,
  transactions of one role 72 to 23 ms. These are the reads a user
  triggers by clicking a row, so they are the ones felt as latency.
- The user inventory reads (50,000 rows of one run) are bounded by the sort
  or the `groupby` over the whole run, not by the filter: an index on
  the run id cannot shorten a sort of 50,000 rows by transaction count, and
  on SQLite the planner sometimes prefers the index and then sorts, which
  is why those rows read slightly slower with indexes. They stay under
  a quarter of a second for pages and under two thirds for the KPI groups
  at this volume; a covering index per sort order would be the next step
  if a customer's user base is several times larger.
- The client's user drill-down filters by transaction code only, without
  the run: the load test measures both the client's request and a
  run-scoped variant. Scoping does not cost more and is what the page
  means; the change belongs to the overview workstream (idea I44).

## What to expect on PostgreSQL

The production database is PostgreSQL with network latency and shared
resources, so absolute numbers differ; the shape does not. The indexes are
created by the deployer on every deployment
([postgres-schema-deployment.md](../05-deployment-tiers/postgres-schema-deployment.md)),
so the keyed lookups keep their index plans there; the sorts and groups
over one run's inventory are sequential scans of that run's rows on both
databases, which PostgreSQL handles well into the hundreds of thousands
of rows. Re-run `npm run test:load` against a PostgreSQL binding (hybrid
profile) once a space carries real extractions and record the numbers
here; the budgets below are the gate until then.

## Budgets as a gate

The budgets are deliberately loose (10x the measured values) so the suite
catches a page that starts downloading whole tables or an N+1 pattern, not
a slow laptop. Tighten them once the PostgreSQL numbers exist.
