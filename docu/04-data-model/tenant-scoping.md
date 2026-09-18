# Tenant scoping on the shared-database tiers

Roadmap item A5. Basic and Standard run every subscriber on one PostgreSQL
schema. Isolation is logical: every persisted entity that holds subscriber
data carries the `tenantScoped` aspect (`db/data-types.cds`), and
`srv/srv/utils/tenant-scope.js` stamps and filters `TenantId`.

## Where the tenant comes from

`currentTenant()` returns `cds.context.tenant`, or `GLOBAL` when there is
none. In production the XSUAA strategy sets the context tenant to the
token's zone id for every authenticated request, with or without CAP
multitenancy. Background work (task runner, retention scheduler) has no
request context and runs as `GLOBAL`. Single-tenant operation therefore
writes `GLOBAL` everywhere, and switching multitenancy on later is a
configuration change, not a data migration.

Mocked users lose their `tenant` attribute while `cds.requires.multitenancy`
is off, so the two-tenant test (`test/tenant-scope.test.mjs`) assigns tenants
in a post-auth middleware keyed by user id, mirroring what XSUAA does.

## Rules

- **Stamping**: generic OData `CREATE`/`UPSERT` on a scoped projection sets
  `TenantId` when the payload has none. Handlers that `INSERT` into
  `adops.db.*` directly set `TenantId: currentTenant()` (or use
  `stampTenant(rows)`).
- **Filtering**: generic `READ`, `UPDATE` and `DELETE` on a scoped
  projection get `TenantId in (GLOBAL, <tenant>)` appended. A foreign row
  read by key answers 404; a foreign `PATCH`/`DELETE` matches nothing.
  Handlers that `SELECT`, `UPDATE` or aggregate directly spread
  `...tenantFilter()` into their `where`.
- **GLOBAL rows are visible to every tenant**: shipped content (overlay
  catalog), operator defaults (telemetry settings) and everything written in
  single-tenant operation. Tenant rows are visible only to their tenant.
- **Projections are recognised by their source**, not their name: the
  helper follows `AdminService.X` down to `adops.db.X`. The original name
  check only matched `adops.db.*` and therefore never applied to an OData
  request; A5 fixed that.

## Entities

All 33 persisted entities with subscriber data carry the aspect. A5 added it
to `AccessRequests`, `ClientErrorReports`, `UsageEvents`,
`PerformanceEvents`, `TelemetrySettings`, `Roles` and `Users`; the first
four had a plain `TenantId` column before, which schema evolution converts
in place (`ALTER COLUMN ... SET DEFAULT 'GLOBAL'`). Not scoped by design:
`AppMappingOverlay` shipped rows (`Origin = SHIPPED`), `AuditChainHeads`
(keyed by tenant) and the telemetry retention deletes, which run across
tenants as a system job.

`TelemetrySettings` is one singleton row per tenant: a tenant reads its own
row, falls back to the `GLOBAL` row, then to the defaults, and its first
save creates its own row instead of editing `GLOBAL`. The 30 s settings cache
is keyed by tenant.

## Legacy rows

Before A5 the access-request and telemetry handlers stored
`req.user.tenant || null`, so existing rows carry `NULL`. `backfillTenantIds()`
runs once per boot (server.js, on `served`) and assigns them to `GLOBAL`;
it is idempotent and skips entities whose `UPDATE` is refused (the audit
log). Nothing else reads `NULL` as a tenant.

## Subscription lifecycle (T2)

`Tenants` (not scoped: the provider's registry, keyed by the tenant id) is
written by the SaaS provisioning callbacks: `ACTIVE` on subscribe,
`UNSUBSCRIBED` on unsubscribe, `PURGED` by the explicit Admin action
`purgeTenant`. Unsubscribing deletes nothing. The purge walks the model for
every persisted entity that carries the aspect (a new entity joins
automatically) and deletes that tenant's rows, plus the tenant's row in
`TenantSecrets`; `AuditEvents` and `AuditChainHeads` are retained and the
purge appends its own `TENANT_PURGED` event (`srv/utils/subscription-lifecycle.js`,
runbook in docu/05 section 7).

## Enterprise tier

CAP MTX with HDI containers isolates physically; the aspect and the helper
stay in place and simply see one tenant per container.
