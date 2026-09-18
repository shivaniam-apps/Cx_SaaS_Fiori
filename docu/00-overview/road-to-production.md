# AdoptOps: Road to Production

## Context

AdoptOps has its core journey built on `main`: Dashboard, Target Systems, Extractions, Usage Insight, Proposals, Adoption Waves, Transports, Activation Runs and Access Requests are live pages; the ABAP add-on mirror (`abap/src`) is byte-identical to `a4h_2023_zado`; the CAP layer runs end-to-end in mock-S/4 mode. Three read-only surveys (deployment, mock-vs-live gaps, quality/security/docs) found that the product is **not deployable to BTP today** (no PostgreSQL schema deployment), has **two security blockers**, and that the live S/4 activation path **stops at step 2** because most ABAP step types return `not_implemented` and the planner/ABAP key contracts disagree.

Target agreed with the product owner: **single-tenant pilot first** on the RD1 landscape (activation writes to RD1 DEV client 100, usage read from PROD), multi-tenant GA as a second milestone.

Sizes: S <1 day, M 1-3 days, L 1-2 weeks, XL >2 weeks. Workstreams per `.claude/rules/git-workflow.md`: **O** Overview (client pages), **S** Scheduling (tasks, adapters, ABAP), **A** Admin & Operations (deploy, security, audit, CI, docs). Every item is its own branch from fresh `main`, squash-merged via PR; shared-contract items (A3, A4, S2) land first.

---

## Milestone 0: Deployable and safe foundation (about 2 weeks, workstream A)

| ID | Item | Where | Size | Acceptance |
|---|---|---|---|---|
| A1 | **PostgreSQL schema deployment.** Add a db-deployer module (`cds deploy --to postgres` via `@cap-js/postgres`) and a migration strategy. Today `deploy/cf/mta.yaml` has no db module and `code/package.json` `cds.build.tasks` has only the `nodejs` task. | `deploy/cf/mta.yaml`, `code/package.json`, new `code/db/package.json` | M | `mbt build && cf deploy` on an empty space creates all tables; `/healthz` 200 |
| A2 | **Environment separation.** Fill `deploy/cf/mtaext/` (dev/qa/prod), remove hardcoded `S4_DESTINATION: S4H_2023` (`mta.yaml:103`), set `CORS_ORIGINS`, space-suffix the saas-registry `appName`, bump `version`, align `@sap/html5-app-deployer` ^7 and Node 22 in `code/router/package.json` and `code/app/html5-deployer/package.json`. | `deploy/cf/*` | S | No environment-specific IDs in `mta.yaml`; deploy with `-e dev.mtaext` succeeds |
| A3 | **Security blocker: write authorization.** 21 of 23 PublicService projections are writable by any Member (only `AppMappingOverlay`, `AuditEvents` are `@readonly`; one `before DELETE AdoptionWaves` guard). A Member can `PATCH /fiori/AppProposals` to set `ReviewStatus`, bypassing the Approver-gated actions. Mark projections `@readonly`, route every write through the existing actions, `@restrict` where direct writes remain (TargetSystems create/update by Admin). | `code/srv/srv/public-service.cds`, `public-service.js`, new `code/test/public-service-auth.test.js` (cds.test) | M | Member PATCH on AppProposals -> 403; Approver/Activator actions still pass; all consumers in `code/app/adops-client/src/services/*.js` still work |
| A4 | **Security blocker: append-only, hash-chained audit** (required by `.claude/rules/sap-backend.md`). `AuditEvents` has no hash/sequence column; `admin-service.cds` exposes it unrestricted; `admin-audit.js` swallows write failures. Add `Sequence`, `PrevHash`, `Hash`; chain in one writer used by `admin-audit.js` and `activation-execution.js`; `@insertonly`/`@readonly` on the projections; `verifyAuditChain()` function; audit `identifiedUsageAllowed` changes. | `code/db/data-model.cds`, `code/srv/srv/utils/admin-audit.js`, `activation-execution.js`, `admin-service.cds/.js` | M | UPDATE/DELETE on AuditEvents rejected; `verifyAuditChain` ok; toggling identified mode emits an event |
| A5 | **Tenant scoping gaps.** `AccessRequests`, `ClientErrorReports`, `UsageEvents`, `PerformanceEvents`, `TelemetrySettings`, `Roles`, `Users` lack the `tenantScoped` aspect (`tenant-scope.js` only scopes entities with `TenantId`). | `code/db/data-model.cds`, `code/srv/srv/utils/tenant-scope.js`, new `code/test/tenant-scope.test.js` | M | Two-tenant cds.test: cross-tenant reads return 0 rows |
| A6 | **CI gate.** No `.github/`; no hook runs tests. Add workflow: server mocha, client `node --test`, client Linux build (rolldown lock check from `frontend-dependencies.md`), client lint; add a server lint script; fix `MODULE_TYPELESS_PACKAGE_JSON` (rename tests to `.mjs` or `.mocharc`); fix the one lint error `AdopsShell.jsx:56`. | new `.github/workflows/ci.yml`, `code/package.json`, `code/app/adops-client/package.json` | M | A red test blocks the PR |
| A7 | **Safety defaults.** `S4_DIRECT_INSECURE_TLS` defaults to `on` (`s4-http-client.js:147`); undefined `body` in `s4-activate-adapter.js:152` would throw instead of returning FAILED. | `code/srv/srv/utils/s4-http-client.js`, `s4-activate-adapter.js`, `code/test/s4-activate-adapter.test.js` | S | Unit tests cover both |
| A8 | **Dead provisioning path.** `provisioning.js` requires missing `tenant-automator.js`; `alert-notification.js` and `cloud-foundry.js` require undeclared packages. Remove or declare; confirm `basic-subscription.js` is the only live path. | `code/srv/srv/provisioning.js`, `utils/alert-notification.js`, `utils/cloud-foundry.js`, `server.js` | S | Every module under `code/srv/srv` requires cleanly |

---

## Milestone 1: Single-tenant pilot on RD1 DEV (about +6 weeks)

### Workstream S (ABAP and adapters)

| ID | Item | Where | Size | Acceptance |
|---|---|---|---|---|
| S1 | **Connection check covers activation.** `probeActivateService` (`s4-activate-adapter.js:178-201`) is never called; the check probes only `UsagePeriods`. Add per-endpoint verdicts (usage, activate, later catalog) to `checkTargetSystemConnection` / `getBackendCapabilities`. | `code/srv/srv/utils/s4-fiori-adapter.js`, `public-service.js`, Target Systems page | S | Per-endpoint status shown for RD1 DEV and PROD |
| S2 | **ObjectKeyJson contract alignment (highest-value small fix).** Planner keys disagree with ABAP: ICF `{fioriId, api, stateColumn}` vs `{url, icfName}`; role `{role, api, referenceRoles}` vs `{role, text, users}`; transport `{apis, simulation:'IV_SIMULATION'}` vs `{text, trkorr, simulation}`. Fix in the planner (single source), add a shared JSON fixture consumed by `code/test/activation-plan.test.js` and `zado_activate_smoke.prog.abap`; document in `docu/09`. Change in `a4h_2023_zado` first, mirror here. | `code/srv/srv/utils/activation-plan.js:72-140`, `abap/src/activate/zcl_ado_activate.clas.abap:36-60` | M | Smoke report consumes planner JSON unchanged; ICF step reaches `HTTP_ACTIVATE_NODE` with a real URL |
| S3 | **Implement the missing ABAP step types.** `zcl_ado_activate.clas.abap:134-147` returns `not_implemented` for `ACTIVATE_ODATA_SERVICE`, `CREATE_SPACE`, `CREATE_PAGE`, `ASSIGN_PAGE_TO_SPACE`, `ADD_SPACE_TO_ROLE`, `ASSIGN_BUSINESS_CATALOG`, `ADD_CATALOG_TO_ROLE`; the planner emits all of them, so a live run stops at step 2. Also add a transport-append step (`ZCL_ADO_ACT_CTS=>append_objects` exists but no step type uses it). Verify-first / verify-after / one commit per step as per `sap-backend.md`; API names from `docu/06-s4-integration/api-matrix.md`. Develop in `a4h_2023_zado`, smoke on RD1 DEV/100, mirror here. | `abap/src/activate/*` (new `zcl_ado_act_odata`, `_space`, `_page`, `_catalog`), `activation-plan.js`, `activation-execution.js` | XL | One approved app activates end-to-end on RD1 DEV; every step verify-after; one transport request captures all transportable objects |
| S4 | **Live simulation.** In live mode `simulateActivationPlan` runs the mock probe with `existsAlready=false` and an "[offline]" suffix (`public-service.js:624-639`). Add a ZADO read-side state probe (ICF active?, role exists?, space/page exist?) so blast-radius reporting is real. | `public-service.js`, `activation-plan.js`, new ABAP read entity/function | L | Simulating on DEV reports `existsAlready=true` for pre-existing objects |
| S5 | **Operator skip and rollback.** Rules require skip/rollback; code has resume + dependency-skip only. Add `skipActivationStep` and `rollbackActivationStep` actions (role delete, space/page removal; ICF stays audit-only). | `activation-execution.js`, `public-service.cds/.js`, ABAP role/ICF classes, Activation Runs page | M | Skipped step -> run resumes past it; role rollback verified on DEV |
| S6 | **Pass extraction parameters.** `topUsersPerTcode` / `minExecutions` are discarded (`s4-fiori-adapter.js:277-278`). Add CDS parameters on the ABAP side and forward them. | `s4-fiori-adapter.js`, `abap/src/usage/zcl_ado_q_user_tx.clas.abap`, `zado_c_user_tx_usage.ddls.asddls` | S/M | Parameters change the PROD result set |

### Workstream O (client)

| ID | Item | Where | Size | Acceptance |
|---|---|---|---|---|
| O1 | **Activation Plans page** (backend complete: `createActivationPlan`, `simulateActivationPlan`, `readActivationPlan`, `executeActivationPlan`). Cross-wave list + detail; reuse `groupSteps`/`STEP_STATUS_DESIGN` from `features/waves/waveModel.js`, `Kpi.jsx`, and the Activation Runs page pattern. | new `src/pages/ActivationPlansPage.jsx`, `src/features/activation-plans/planModel.js` + test (register in package.json), `App.jsx` | M | Create, simulate, execute, open run from the page |
| O2 | **Settings page** with the shared `AdopsPageTabs` (referenced by `fiori-ux.md`, not yet in the tree): per-system `identifiedUsageAllowed` and `activationRootPath`, telemetry settings (backend exists in `admin-service.cds`). Route `/settings/:view?`. Depends on A4 for the audit event. | new `src/components/AdopsPageTabs.jsx`, `src/pages/SettingsPage.jsx`, `src/features/settings/settingsViews.js` + test | M | Toggle identified mode -> audit event visible |
| O3 | **Audit Log page**: bounded, server-filtered read of `AuditEvents` (AdminService) with chain-verification status. Depends on A4. | new `src/pages/AuditLogPage.jsx`, `features/audit/auditModel.js` + test | M | Filters by type/object/user; shows chain verdict |
| O4 | Replace hardcoded `newRolesNeeded: 1`, `activationStepCount: 4` (`fiori-candidate-query.js:154-155`) with values derived from the plan template. | `code/srv/srv/utils/fiori-candidate-query.js` | S | Values match `deriveActivationSteps` |
| O5 | **Client crash reporting.** `server.js:10` references a non-existent `features/telemetry/correlation.js`; `recordClientError` is never called; `AppErrorBoundary` lacks `componentDidCatch`. | `src/components/AppErrorBoundary.jsx`, new `src/features/telemetry/correlation.js`, `src/services/coreService.js` | S | A thrown render error lands in `ClientErrorReports` |

### Workstream A (pilot readiness)

| ID | Item | Where | Size | Acceptance |
|---|---|---|---|---|
| A9 | **Per-tenant pseudonymisation salt.** ABAP salt is system-derived (`zcl_ado_pseudonym.clas.abap:15-16`); CAP salt is the tenant id. Move the salt to `ZADO_CFG` (ABAP, part of S7 tables or a minimal table now), stop deriving from tenant id in `usage-extraction.js`. Write `docu/11` (GDPR / works-council note). | ABAP usage package, `code/srv/srv/utils/usage-extraction.js`, `docu/11-privacy-pseudonymisation/` | M | Same user in two tenants -> different pseudonyms; PO signs the note |
| A10 | **Pilot documentation**: `docu/05` deploy runbook, `docu/13` operations, `docu/15` target-system onboarding (Cloud Connector, destination in consumer subaccount, role collections, ZADO transport install, DEV-only write binding). | `docu/05-*`, `docu/13-*`, `docu/15-*` | M | Pilot admin onboards RD1 without help |
| A11 | `/readyz` with DB check; replace startup `console.log` with `cds.log`. | `code/srv/srv/server.js` | S | Readiness fails when DB is down |

**Pilot exit criteria:** A1-A11, S1-S4, O1-O2 merged; on RD1: usage extract (live from PROD or file import) -> proposals -> approval -> plan simulated with real backend state -> executed on DEV/100 -> transport released -> every step audited in a verifiable chain.

---

## Milestone 2: Pilot hardening and Analyse depth (parallel from pilot start)

| ID | Item | Where | Size |
|---|---|---|---|
| S7 | **ABAP snapshot collector**: `ZADO_CFG`, `ZADO_RUN`, `ZADO_AUDIT`, snapshot tables + background job; CAP reads snapshots instead of live ST03N (rule in `sap-backend.md`, ABAP README "Phase 2+"). Needed for PROD-scale windows. | `abap/src/usage/`, `usage-extraction.js`, `s4-fiori-adapter.js` | XL |
| S8 | **Roles and users readers** (AGR_*, USR02) filling `UserInventory`, `RoleInventory`, `RoleUsers`, `RoleTransactions` (declared in `data-model.cds:152-240`, never written); roles/Fiori rollups in `usage-extraction.js:55,150`. | ABAP usage package, `usage-extraction.js` | L |
| O6 | **User & Role Landscape page** with server-side paging (performance-critical per `performance.md`). Depends on S8. | new `src/pages/LandscapePage.jsx` + feature module | L |
| S9 | **Catalog derivation**: `ZADO_CATALOG` package + `CATALOG_DERIVATION` task handler (referenced in `task-runner.js:32`, never registered in `server.js:99-101`) writing `BackendCatalogApps` / `BackendLaunchpadContent` so `fiori-candidate-query.js:78-81` stops answering `UNKNOWN`. Blocked by PO-1. | new `abap/src/catalog/`, new `utils/catalog-derivation.js`, `server.js` | L + L |
| S10 | **Transport QA/PROD verification**: verification reads behind the manifest (`activation-manifest.js`) and import status tracking on `TransportRequests`. | `activation-manifest.js`, `public-service.js`, `TransportsPage.jsx` | M/L |
| O7 | **Product Insights page** (backend complete in `telemetry-admin-handlers.js`). | new page on `AdopsPageTabs` | M |
| A12 | **API test coverage** with `cds.test`: public-service handlers, s4-http-client, admin-service, access-request handlers. | `code/test/*.test.js` | L |
| A13 | Telemetry rate limiting; accessibility pass (no `accessibleName`/aria attributes on any page today). | `feedback-telemetry-handlers.js`, `src/pages/*` | S + M |

---

## Milestone 3: Multi-tenant SaaS GA (about +8-10 weeks after pilot)

| ID | Item | Size |
|---|---|---|
| T1 | **PO-3** Tenancy model: keep shared-schema `tenantScoped` discriminator (current design, recommended) vs CAP MTX schema-per-tenant; drop or fund the `[enterprise]` HANA/MTX profile that has no sidecar/resources in `mta.yaml`. | Decision |
| T2 | Subscription lifecycle in `basic-subscription.js`: tenant row on subscribe, purge on unsubscribe, dependencies callback for destination/connectivity. | M |
| T3 | **PO-2** BTP Audit Log service (`@cap-js/audit-logging`) binding, or ship with the in-app hash chain only. | M |
| T4 | Cloud Logging + Alert Notification, task-failure alerts (replaces `application-logs` lite). | M |
| T5 | Release process: semver, `prod.mtaext`, blue-green, migration safety, `docu/05`. | M |
| T6 | Security review (`/security-review`), secret rotation runbook, `docu/10`, `12`, `16`. | M |
| T7 | Enterprise-volume load test (Dashboard, Usage Insight, Landscape). | M |
| T8 | **PO-4** Service broker: README claims one; none exists. Drop the claim or build. | Decision |

---

## Multitenancy without rework: guardrails for the pilot

The pilot is single-tenant by deployment, not by design. What already exists and is kept as-is:

- **Tenant discriminator on every business row** (`tenantScoped` aspect, `code/srv/srv/utils/tenant-scope.js`): writes stamp `TenantId`, reads filter to `[GLOBAL, tenant]`. Single tenant runs with the value `GLOBAL`; multi-tenant is the same code with real tenant ids.
- **Shared-tenant XSUAA and SaaS registry** already bound (`deploy/cf/mta.yaml`, `xs-security.json` `tenant-mode: shared`); subscription callbacks exist in `basic-subscription.js`.
- **Subscriber-subaccount destinations** via a tenant-scoped destination token (`s4-http-client.js:469-478`), so each customer's S/4 systems are resolved from their own subaccount.
- **Shipped content is tenant-neutral** (`TenantId: 'GLOBAL'` in `shipped-overlay-catalog.js`).

Rules for every pilot item so nothing has to be redone at GA:

1. Never hardcode a tenant, subaccount, destination or system id in code or `mta.yaml` (A2 removes the existing `S4H_2023` and the non-suffixed saas-registry name).
2. Every new entity gets the `tenantScoped` aspect; A5 backfills the seven that lack it. A new table without it is a review blocker.
3. Every new CAP read goes through the tenant filter; do not bypass `tenant-scope.js` with raw SQL.
4. Secrets and salts are per tenant from day one: A9 moves the pseudonymisation salt to per-tenant configuration during the pilot, not after.
5. Background tasks stay keyed by `targetSystem_ID` (already tenant-scoped); no process-wide state per system.
6. Boot upserts and seeds remain `GLOBAL`; tenant-specific curation is written as `CUSTOMER` rows (existing overlay pattern).

What GA then adds (Milestone 3): flipping `multitenancy` on for the profile, tenant row creation/purge in the subscription callbacks (T2), the dependencies callback, per-tenant isolation tests (A5's two-tenant cds.test becomes the gate), and the PO-3 decision to stay on the shared-schema discriminator model. The alternative, CAP MTX schema-per-tenant on HANA, is the only path that would mean structural rework and is **not recommended**; the `[enterprise]` profile that half-declares it should be dropped or explicitly funded.

## Critical path and parallelism

- **Critical path to pilot:** A1 -> A2 -> S1 -> S2 -> **S3 (XL)** -> S4 -> end-to-end on RD1. A3, A4, A9 are pilot gates that run in parallel with S-work.
- **Weeks 1-2:** A alone on A1-A8; S starts S2 (no infra dependency); O does O4, O5.
- **Week 3+:** S on S3/S4; O on O1-O3 after A3/A4 reach `main`; A on A9-A11.
- **Shared contracts to land on `main` first:** A3 (CDS restrictions change what the client may write), A4 (AuditEvents shape), S2 (ObjectKeyJson). Consumers listed in `.claude/rules/architecture.md` must be checked before each.
- ABAP changes start and are merged in `a4h_2023_zado` and are smoke-tested on RD1 DEV/100. `abap/src` is a reference copy, not a delivery path (the add-on reaches a system only through abapGit from the ABAP repository): update the two files the contract test reads (`zcl_ado_activate.clas.abap`, `zado_activate_smoke.prog.abap`) in the same PR that changes a step type or key shape, and re-sync wholesale only at milestones (release, pilot hand-over). (Until 2026-09-18 every ABAP change was mirrored wholesale; nine mirror PRs later the only consumer turned out to be that one test.)

## Product-owner decisions needed

| # | Decision | Blocks |
|---|---|---|
| PO-1 | Legal basis for deriving the app catalog from the SAP Fiori Apps Reference Library vs verifying/licensing the 42-row shipped overlay | S9, proposal quality |
| PO-2 | Buy the BTP Audit Log service or rely on the in-app hash chain (A4) | T3 (pilot proceeds on A4) |
| PO-3 | Multitenancy timing and model; fate of the enterprise HANA tier | T1, T2 |
| PO-4 | Service broker: keep the claim or drop it | T8 |

## Verification approach

- **Per item:** the acceptance column; every PR runs server mocha (`cd code && npm test`), client tests and lint (`cd code/app/adops-client && npm test && npm run lint`), and after A6 the CI workflow enforces them.
- **Milestone 0:** `mbt build` + `cf deploy -e dev.mtaext` into an empty BTP space; `/healthz` and `/readyz` 200; cds.test auth suite proves the Member PATCH is rejected; `verifyAuditChain` ok.
- **Milestone 1:** scripted pilot run on RD1 documented in `docu/09` and `docu/16`: extraction -> proposals -> wave -> plan -> simulate (real state) -> execute -> Activation Runs monitor shows every step SUCCESS/WARNING with messages -> transport released -> audit chain verified -> manifest handed to basis for QA.
- **Milestone 2/3:** load test against PROD-scale snapshot data; two-tenant cds.test isolation; subscription/unsubscription against a second consumer subaccount.
