# Multitenancy and Partner Reference Application alignment

Roadmap item T6 (chapter), decisions PO-3 and T1/T2. How AdoptOps
implements the SAP BTP multitenant SaaS pattern that the Partner Reference
Application (PRA) describes, where it deliberately differs, and what the
end state looks like. The pilot runs single-tenant by deployment, not by
design: everything below is already in place with the tenant id `GLOBAL`.

## What the pattern asks for and what AdoptOps does

| PRA element | AdoptOps today | Notes |
|---|---|---|
| Provider subaccount runs the application, consumer subaccounts subscribe | one MTA per space in the provider subaccount; `saas-registry` instance `adoptops-${space}`; plans `basic`, `standard`, `enterprise` | `deploy/cf/mta.yaml` |
| Tenant-aware approuter with a host pattern | `TENANT_HOST_PATTERN ^(.*)-adops-basic-<space>.<domain>`; tenant URL returned by the subscription callback | the route per subscriber is mapped by hand (idea I34, T2) |
| XSUAA in shared tenant mode | `tenant-mode: shared`, one XSUAA instance per space, role collections per space | `deploy/cf/config/xs-security.json` |
| Subscription callbacks secured for the provisioning service | `mtcallback` scope granted to `sap-provisioning`, enforced on the callbacks | T6 |
| Tenant onboarding creates tenant resources | callbacks return the URL only; no tenant row, no purge | T2 (after PO-3) |
| Dependencies callback lists reused services | returns the xsappnames of the HTML5 runtime and the destination service | `basic-subscription.js` |
| Destinations belong to the consumer | every target system's destination is resolved in the subscriber subaccount with a tenant-scoped token; nothing in the provider subaccount addresses a customer system | `s4-http-client.js`, docu/15 |
| Data isolation | shared PostgreSQL schema with a `TenantId` discriminator on every business entity, stamped on writes and filtered on reads at the service layer; `GLOBAL` rows (shipped content, single-tenant operation) visible to all | `tenant-scope.js` (A5); see the open item below |
| Per-tenant configuration and secrets | `TelemetrySettings` and `TenantSecrets` per tenant; pseudonyms salted per tenant | A5, A9 |
| Audit per tenant | one hash chain per tenant with its own head row | A4 |
| Tenant-aware operations | background tasks keyed by target system (tenant-scoped); alerts carry the tenant tag | S2, T4 |

## Where AdoptOps differs on purpose

- **No CAP MTX, no schema per tenant.** The PRA's HANA variant deploys one
  HDI container per tenant through the MTX sidecar. AdoptOps keeps one
  PostgreSQL schema with a discriminator. Reasons: the Basic and Standard
  tiers run on PostgreSQL, where MTX is not available; a schema per tenant
  multiplies the additive-only migration work per release; and the
  tenant-scoping helper already gives row-level isolation at the service
  layer. The `enterprise` plan that half-declares HANA and MTX has no
  sidecar in the MTA; PO-3 decides whether to drop or fund it.
- **Subscription without provisioning work.** Because the schema is
  shared, subscribing needs no deployment step; the callback is
  synchronous and instant. T2 adds the tenant row (settings, salt, audit
  head) and the purge on unsubscribe.
- **Customer systems are never reached from the provider subaccount.**
  The PRA allows provider-side destinations for shared services; AdoptOps
  forbids them for S/4HANA systems because each customer's Cloud Connector
  and technical users belong to that customer.

## End state (GA, milestone 3)

1. `cds.requires.multitenancy` stays off; tenants are the XSUAA zone id
   carried by the token (`ctx.tenant`), which the discriminator already
   uses.
2. T2: tenant row on subscribe (settings defaults, tenant secret, audit
   head), purge on unsubscribe with the legal-hold decision for audit rows
   (idea I9), automatic route mapping (I34), callbacks for every
   non-enterprise plan (I27/I39).
3. Tenant isolation enforced below the service layer as well: the security
   review found that handlers addressing rows by key with direct queries
   do not add the tenant filter (idea I43). Before a second tenant shares a
   space, either a database-level filter for `tenantScoped` entities or
   `tenantFilter()` on every key lookup is required, and the two-tenant
   `cds.test` suite becomes the gate.
4. PO-3: keep the shared-schema model (recommended) and drop the enterprise
   HANA tier, or fund MTX as a separate deployment variant.

## Checklist for every new feature

- Every new entity carries the `tenantScoped` aspect; a table without it is
  a review blocker.
- Every new read goes through the service (filtered) or adds
  `tenantFilter()`; no raw SQL.
- No tenant, subaccount, destination or system id in code or descriptors.
- Shipped content is written as `GLOBAL`; customer curation as tenant rows.
- Secrets and salts are per tenant from day one.
