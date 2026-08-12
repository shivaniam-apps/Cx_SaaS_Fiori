---
paths:
  - "code/app/**"
  - "code/srv/**"
  - "code/api/**"
---
# AdoptOps Performance Rules

AdoptOps must be designed for enterprise SAP data volumes.

Never optimise only for the current small development dataset.

## Performance-Sensitive Areas

Highest priority:
- Dashboard (adoption cockpit)
- Usage Insight
- User & Role Landscape
- Proposals
- Activation run monitor

## Query Principles

Prefer:
- server-side filtering
- server-side sorting
- server-side aggregation
- pagination
- lazy loading
- $select
- $filter
- $top
- $skip or equivalent paging mechanisms
- bounded date ranges
- request deduplication
- safe caching

Avoid:
- retrieving all records and filtering in React
- repeated API calls for identical information
- N+1 network request patterns
- loading historical data that is irrelevant to the current view
- unnecessary SAP round trips

## Dashboard

Dashboard should consume purpose-built analytical data.

Do not download the full transaction-usage or proposal datasets merely to
calculate dashboard counts or trends.

Prefer one or a small number of optimised dashboard endpoints.

## Usage Insight

Use server-side paging, filtering, sorting and aggregation. Default to a
bounded top-N by executions with explicit load-more; never ship "everything"
to the browser. Cumulative-%/Pareto figures come from a server summary over
the full filter scope.

## Proposals

Use server-side paging and filtering; evidence rollups live on the proposal
row so the list never needs child reads. Scope adjustments recompute from the
already-delivered payload — no refetch for arithmetic.

## Activation run monitor

Poll one purpose-built run read (status + steps + counts in a single
response). Fetch per-step logs only when a step row is expanded, and re-fetch
them only while that step is RUNNING.

## React

Check useEffect dependencies and request lifecycle carefully.

Prevent:
- duplicate calls
- stale requests overwriting newer results
- unnecessary rerenders
- repeated reference-data retrieval

## AnalyticalTable Selection

Keep row selection uncontrolled: mirror it into page state via onRowSelect
and use a tableInstance dispatch only for programmatic clears.

Nothing selection-derived may appear in the table's props (tableProps,
reactTableOptions, getRowId must be stable/memoized) — otherwise every
checkbox click re-renders the entire table and multi-select feels slow.

KPI/summary figures on paged lists must come from a server summary over the
full filter scope, never from counting the rows currently loaded.

A KPI card and its click-through slice must be produced by the same
server-side expression. Never derive a card by subtracting other counts:
mixed read vintages or mismatched read scopes make the card disagree with
its own table (Monitor Jobs "Other" showed 50 over a 27-row slice this way).
Cards that partition the total must sum to it exactly; a cross-cutting card
(health/attention over status buckets) must not sit in the strip as if it
were a partition member - sharpen it to what the other cards do not already
say, or present it as a distinct indicator.
