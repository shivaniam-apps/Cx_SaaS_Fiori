# Security model and review

Roadmap item T6. Who may do what in AdoptOps, which controls protect the
customer's S/4HANA systems and data, and what the security review of
2026-09-18 found. The audit chain has its own chapter
([audit-log-chain.md](audit-log-chain.md)); secrets and their rotation are
in [secret-rotation.md](secret-rotation.md); privacy of user identities is
[docu/11](../11-privacy-pseudonymisation/pseudonymisation.md).

## Roles

Four application roles, declared as XSUAA scopes and role templates in
`deploy/cf/config/xs-security.json` and bundled into one role collection
each per space by `deploy/cf/mta.yaml`. Every collection includes the ones
below it, so a user holds exactly one collection.

| Collection | Scope(s) | May |
|---|---|---|
| AdoptOps Member | `Member` | read every PublicService projection; run and cancel extractions; import offline extracts; query usage, proposals, waves, plans, runs, transports; comment on proposals; check a target system's connection; submit feedback, crash reports, telemetry and access requests |
| AdoptOps Approver | `Approver` + Member | approve, reject, defer proposals (single and bulk); create adoption waves, assign and remove proposals, delete waves |
| AdoptOps Activator | `Activator` + Approver + Member | create, simulate and execute activation plans; skip and roll back steps; release transports and record their imports |
| AdoptOps Administrator | `Admin` + Member (+ `SaaSAdmin`, user-management scopes) | register and edit target systems; Settings (identified usage, activation root, telemetry); AdminService: overlay curation, purge extraction runs, telemetry triage and cleanup, access-request decisions, audit chain verification, BTP destination listing and the lax S/4 proxy |

Where the gates sit:

- `PublicService` (`/fiori`) requires one of the four roles; its projections
  are `@readonly` except `TargetSystems` (Admin create/update) and
  `AdoptionWaves` (Approver/Activator delete). Every state change goes
  through an action annotated with the role it needs (`@requires:
  'Approver'` on decisions, `'Activator'` on plan execution and transports).
- `AdminService` (`/catalog/AdminService`) requires `Admin` as a whole.
- `CoreService` (`/core`) requires any authenticated user: it carries the
  self-service actions a user without a role still needs (user info,
  access request, feedback, telemetry).
- The SaaS provisioning callbacks (`/-/basic/saas-provisioning/*`) require
  the `mtcallback` scope, which `xs-security.json` grants to the SAP
  provisioning application only.
- Users without a collection see the "Request Access" screen; the grant
  flow is described in the deploy runbook.

A `cds.test` suite pins the matrix (`code/test/public-service-auth.test.mjs`,
`api-journey.test.mjs`, `security-hardening.test.mjs`).

## Trust boundaries

```text
Browser ──(XSUAA login, approuter)──▶ adops-basic-srv ──(destination + Cloud Connector)──▶ S/4HANA ZADO services
                                          │
                                          ├── PostgreSQL (service binding)
                                          ├── Alert Notification, Cloud Logging (bindings)
                                          └── SaaS registry callbacks (mtcallback scope)
```

- The browser never reaches the server directly in Cloud Foundry: the
  approuter authenticates and forwards the token. `CORS_ORIGINS` allows
  the approuter origin only (plus local client ports in the dev space).
- The server talks to S/4HANA only through BTP destinations of the
  subscriber subaccount, resolved with a tenant-scoped token; the
  destination carries the technical user's credentials and the server
  never stores them. Direct URL overrides and insecure TLS are development
  switches refused in Cloud Foundry (S11).
- The write unit in S/4HANA (`ZADO_ACTIVATE`) is published in DEV only;
  the connection check reports a reachable write unit on QAS or PRD as
  `EXPOSED` ([docu/15](../15-target-system-configuration/onboarding-a-target-system.md)).

## Controls

| Concern | Control | Where |
|---|---|---|
| Write authorization | read-only projections, role-gated actions, Admin-only target systems | `public-service.cds`, `admin-service.cds` (A3) |
| Tamper-evident history | append-only, hash-chained audit log with a per-tenant head lock and a database-level UPDATE/DELETE guard; verification function | `audit-chain.js` (A4) |
| Tenant isolation | `tenantScoped` aspect on every business entity; writes stamped and reads filtered at the service layer; `tenantFilter` on direct queries of the tenant-aware handlers | `tenant-scope.js` (A5); see finding 1 below |
| Transport security to S/4 | TLS verification on direct calls by default; production routing through destinations only | `s4-http-client.js` (A7, S11) |
| Request paths to S/4 | paths are relative to the destination; protocol-relative, absolute and backslash paths are refused and the resolved origin is compared with the destination's | `s4-http-client.js` `safeDestinationPath` (T6) |
| Secrets in messages and logs | secret-shaped fields and bearer/basic tokens are masked in S/4 responses, telemetry text and crash reports; destination dumps are redacted; endpoint query strings dropped | `s4-http-client.js` `safeResponseData`, `telemetry-sanitize.js` |
| Abuse of ingestion endpoints | per-user and per-tenant rate limits on feedback, crash reports and telemetry batches; per-batch row caps; text clamps | `telemetry-rate-limit.js`, `feedback-telemetry-handlers.js` (A13) |
| Pseudonymous usage data | SHA-256 pseudonyms built inside S/4 with a secret that never leaves the system plus the tenant id; identified mode is an audited opt-in | ZADO add-on, `TenantSecrets` (A9, docu/11) |
| SaaS callbacks | `mtcallback` scope enforced on the express routes | `basic-subscription.js` (T6) |
| Server fingerprint | `X-Powered-By` removed | `server.js` (T6) |
| Correlation | every request carries `x-correlation-id`, echoed and logged, stored with feedback and crash rows | `server.js` |
| Operational visibility | JSON logs in Cloud Logging, task-failure alerts | T4 |

## S/4HANA side

- Two technical users per landscape at most: one read-only per system
  (usage service), one for DEV with the write unit's authorizations
  (docu/15 step 3). The add-on ships the RFC authorization
  `Z_ADO_ACT_EXEC_STEP` (`abap/src/activate/*.sush.xml`) for the dispatcher;
  the confirmed object list per user is derived from an ST01 trace during
  onboarding and recorded here once RD1 has run it (open, see finding 4).
- `ZADO_USAGE` never depends on `ZADO_ACTIVATE`, so the PROD install carries
  no write capability.
- Every activation step is one commit, verify-first, with the initiating
  user in the audit chain; execution resumes, never replays.

## Security review 2026-09-18

Scope: the CAP server (`code/srv`), the deployment descriptors, the client
sources and the ABAP mirror, read for injection, authorization gaps,
secret handling, SSRF, tenant isolation and information disclosure. CQN is
parameterised throughout (no raw SQL beyond the readiness probe); the
client renders no raw HTML; no shell execution; no credentials in the
repository (bindings via VCAP, secrets in S/4 and the database).

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Tenant isolation is enforced at the service layer only. Handlers that address rows by key with direct CQN (`readProposal`, `approveProposal`, `readActivationPlan`, `releaseTransport`, ...) do not add `tenantFilter`, so a user of tenant B who knows an id of tenant A can read or act on that row once several tenants share a space. | High at GA, none in the single-tenant pilot | Open; gate for T2 (idea I43). Fix: a database-level filter for `tenantScoped` entities when `cds.context.tenant` is set, or `tenantFilter()` on every key lookup |
| 2 | S/4 request paths were resolved with `new URL(path, destination)`: a path such as `//evil.example/x` or `https://evil.example` left the destination host, and the call would have carried the technical user's credentials to that host. Reachable by any Member through `checkTargetSystemConnection` (its `path` parameter). | High | Fixed: `safeDestinationPath` and an origin comparison; unit-tested |
| 3 | The SaaS provisioning callbacks were plain express routes without authentication; anyone reaching the server route could call subscribe and unsubscribe (today only URL resolution, with T2 tenant creation and purge). | Medium | Fixed: CAP authentication plus the `mtcallback` scope on the route; tested with a mocked registry user |
| 4 | `safeResponseData` masked only the first word of a secret value, so `Bearer <token>` kept the token in connection-check messages and logs (idea I35). | Medium | Fixed: whole values are masked, quoted or bare |
| 5 | `X-Powered-By: Express` on every response. | Low | Fixed |
| 6 | The technical users' authorization objects on S/4HANA are not yet recorded; onboarding derives them from a trace. | Low | Open until the RD1 trace is available (docu/15) |
| 7 | The audit chain proves internal consistency, not completeness (a database administrator can truncate the tail). | Medium | Open; external anchor is T3 (PO-2) |

`/security-review` was run on the change set of this item (the fixes above)
after the manual pass: no finding above its confidence bar; it probed the
callback guard order and bypasses, the mocked registry user in the
production profile, encoded and unicode variants of the path guard, and the
redaction regex against the old one.

Re-run this review with `/security-review` on every change that touches
authentication, tenant scoping, the S/4 transport layer or the ingestion
endpoints.
