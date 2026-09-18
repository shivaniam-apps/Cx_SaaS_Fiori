# Usage snapshot collector (S7)

Usage facts must come from snapshot tables persisted in the customer's
system by a background collector, not from live ST03N calls in the request
path (`.claude/rules/sap-backend.md`, "Usage Data Source"). Live reads stay
for bounded ad-hoc drill-down. This chapter describes the collector, the
tables, how a read picks its source and what an operator has to schedule.

## Why

`SWNC_COLLECTOR_GET_AGGREGATES` returns whole internal tables per month. A
13-month window on a productive system is thirteen of those calls, in the
request path of every OData page an extraction reads. The collector runs
that work once per month, in a background job, and the SaaS reads the
result with plain SQL: the transaction rollup is one `GROUP BY` at the
database, the user rows one grouped read with the execution threshold as a
`HAVING` clause.

## ABAP objects (`abap/src/usage/`, mirrored from `a4h_2023_zado`)

| Object | Role |
|---|---|
| `ZADO_SNAP_USER` | user × transaction × ST03N month: real user id (as ST03N holds it), executions, steps, response / CPU / DB time, `COLLECTED_AT`, `RUN_ID`. Client-dependent application data, never transported. |
| `ZADO_SNAP_TX` | transaction × month with the month's distinct users; the coverage marker. |
| `ZADO_RUN` | one row per collector run: window, status RUNNING / DONE / FAILED, months done / skipped, rows written, message. |
| `ZADO_AUDIT` | append-only add-on events: `COLLECT_STARTED` / `_DONE` / `_FAILED`, `RETENTION_APPLIED`, `CFG_CHANGED`. |
| `ZCL_ADO_COLLECTOR` | `collect_window`: month by month, **one LUW per month** (delete + insert + commit) so a re-run is idempotent and an aborted run leaves complete months only. Closed months already snapshotted are skipped; the current and the previous month are always re-collected (the ST03N monthly aggregate grows until the month closed). `apply_retention` deletes months older than the retention. |
| `ZCL_ADO_ST03_READER` | unchanged contract; `read_month_raw` and `rollup` are now public so the collector uses the same SWNC call and the same rollup semantics as the live path. |
| `ZCL_ADO_SNAP_READER` | `covers(from, to)`, `coverage()`, `get_window(...)` with the same output as the live reader, computed at the database. |
| `ZADO_COLLECT_USAGE` | the report to schedule (below). Defaults from `ZADO_CFG`: `COLLECT_MONTHS` (13), `SNAPSHOT_RETENTION_MONTHS` (report default 36). |
| `ZADO_C_TX_USAGE`, `ZADO_C_USER_TX_USAGE` | gain `DataSource`: `SNAPSHOT` or `LIVE`, what served the request. `$filter=DataSource eq 'LIVE'` forces a live read (drill-down), `'SNAPSHOT'` forces the tables. |
| `ZADO_C_SYSTEM_INFO` | gains `SnapshotFrom` / `SnapshotTo` / `SnapshotMonths` / `SnapshotCollectedOn` / `SnapshotCollectedAt` / `CollectorJobScheduled`. |

Source selection per request: the provider asks `covers(from, to)`; when
every month of the window has snapshot rows it serves `SNAPSHOT`, otherwise
`LIVE`. Nothing changes for an add-on installation that never ran the
collector: it keeps reading live, and the SaaS run log says so.

## Privacy

The snapshot tables hold the real user id exactly as `SWNCMONI` does, inside
the customer's system. Pseudonymisation happens at read time with the
tenant salt (`ZCL_ADO_PSEUDONYM`, docu/11), identical for the live and the
snapshot path, so a secret rotation still changes every pseudonym and the
SaaS never sees an identifier. Retention bounds how long the tables keep
history.

## Operator steps (per system and client the SaaS reads from)

1. After installing the add-on: run `ZADO_COLLECT_USAGE` once by hand
   (SE38) with the defaults to backfill the retention window. The spool
   lists every month with its row counts and the resulting coverage.
2. Schedule it: SM36, job `ZADO_COLLECT_USAGE`, step = the report with a
   variant of the defaults, monthly on the 2nd (the previous month is final
   by then). `SystemInfo.CollectorJobScheduled` tells the SaaS whether such
   a released or scheduled job exists.
3. Optional `ZADO_CFG` keys (SM30 on `ZADO_CFG` or a future config report):
   `COLLECT_MONTHS` (default 13), `SNAPSHOT_RETENTION_MONTHS` (0 = keep all).

## CAP side

- `s4-fiori-adapter.js`: the usage mappers carry `DataSource` (an older
  add-on sends none → `LIVE`); `fetchTransactionUsagePage` /
  `fetchUserTransactionUsagePage` accept `dataSource` to force a source;
  `getBackendCapabilities` passes the coverage fields through.
- `usage-extraction.js`: the first page of each ST03N read writes a run-log
  line ("Data source: ZADO snapshots ..." as INFO, "live ST03N ..." as WARN
  with the scheduling hint) and stores the source on `UsageSnapshots.DataSource`.
- `utils/snapshot-coverage.js` (pure): coverage from a `SystemInfo` row,
  window-covered check, the log and label texts.
- Target Systems page (O17): **Test Connection** also reads
  `getBackendCapabilities` once the usage service answered and shows a
  snapshot badge next to the endpoint badges ("Snapshots 12 mo", "Snapshots
  pending", "No snapshots", "Live usage reads" for an add-on older than S7;
  hover for the window, the last run and the job state). Nothing is read on
  page load; the mirror model is `features/systems/snapshotCoverage.js`.

## RD1 acceptance

1. Syntax check the new tables, classes and the report; activate; republish
   `ZADO_USAGE_O4` (new fields).
2. `ZADO_COLLECT_USAGE` by hand for the last three months: `ZADO_RUN` shows
   DONE with the month counts, `ZADO_SNAP_TX` has one `PERIOD_START` per
   month, the spool reports the coverage.
3. `TransactionUsage?$filter=PeriodFrom ge <first month> and PeriodTo le <today>&$top=5`
   answers `DataSource` = SNAPSHOT with the same top transactions as the
   same read with `and DataSource eq 'LIVE'` (counts equal, distinct users
   equal); a window before the coverage answers LIVE.
4. One extraction from the SaaS: the run log carries the "Data source:
   ZADO snapshots" line, the row counts match the earlier live extraction.
5. Re-run the report: closed months skipped, current and previous month
   re-collected, a second `ZADO_RUN` row.
