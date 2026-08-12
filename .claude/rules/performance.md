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
- Dashboard
- My Schedules
- Monitor Jobs
- Calendar

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

Do not download full My Schedules or Monitor Jobs datasets merely to calculate
dashboard counts or trends.

Prefer one or a small number of optimised dashboard endpoints.

## My Schedules

Use server-side paging and filtering.

Completed historical schedules should not dominate normal interactive queries.

## Monitor Jobs

Use bounded queries and server-side filtering.

Do not load thousands of completed SAP jobs when the user needs recent or
actionable operational data.

## Calendar

Query only the period required for the visible calendar view plus a small
justified buffer where appropriate.

Navigation between weeks/months should load the newly required period rather
than loading all schedule history up front.

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
