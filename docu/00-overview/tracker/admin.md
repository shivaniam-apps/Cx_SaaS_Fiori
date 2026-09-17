# Admin & Operations — tracker

Worktree `Cx_SaaS_Fiori.worktrees/admin` · CAP 4134 · client 5303 · owns A and T items
(deploy, security, audit, tenancy, CI, docs). Format: see [program-tracker.md](../program-tracker.md).

## In progress

(none)

## To-do (milestone order)

- [ ] A9 Per-tenant pseudonymisation salt (ZADO_CFG + CAP) and docu/11 GDPR / works-council note
- [ ] A10 Pilot documentation: docu/05 deploy runbook, docu/13 operations, docu/15 target-system onboarding
- [ ] A11 /readyz with DB check; startup console.log -> cds.log
- [ ] A12 cds.test API coverage: public-service handlers, s4-http-client, admin-service, access-request handlers
- [ ] A13 Telemetry rate limiting; accessibility pass on pages
- [ ] T2 Subscription lifecycle: tenant row on subscribe, purge on unsubscribe, dependencies callback (after PO-3)
- [ ] T3 BTP Audit Log service binding (after PO-2)
- [ ] T4 Cloud Logging + Alert Notification, task-failure alerts
- [ ] T5 Release process: semver, prod.mtaext, blue-green, migration safety
- [ ] T6 Security review, secret rotation runbook, docu/10, 12, 16
- [ ] T7 Enterprise-volume load test

## Accomplished

- [x] A8 Dead provisioning path removed: provisioning.js, utils/alert-notification.js, utils/cloud-foundry.js (undeclared cfenv / alert-notification-client, missing tenant-automator.js), orphaned isTenantAutomationEnabled and ADOPTOPS_TENANT_AUTOMATION dropped, basic-subscription.js confirmed as the only subscription path, module-load test requires every srv module and checks declared packages — this PR, 2026-09-17
- [x] A7 Safety defaults: direct S/4 HTTPS calls verify certificates by default (S4_DIRECT_INSECURE_TLS is an explicit, logged opt-in), directTlsOptions unit tests, OData-branch tests proving a payload without ResultJson yields FAILED / SIMULATED_BLOCKED instead of a thrown error, docu/06 direct-access chapter — this PR, 2026-09-17
- [x] A6 CI gate: .github/workflows/ci.yml (server lint + mocha + production build, client rolldown lock check + lint + node --test + Linux build, tracker check), server eslint config and lint script, server suites renamed to .mjs (module-type warning gone), lock:check script, docu/14 ci-gate chapter — this PR, 2026-09-17
- [x] A5 Tenant scoping gaps: tenantScoped aspect on the seven remaining entities, tenant-scope helper now recognises service projections (it never matched one before) and filters UPDATE/DELETE too, tenantFilter/stampTenant for direct CQN in access-request, telemetry and settings handlers, per-tenant TelemetrySettings, NULL-tenant backfill on boot, two-tenant cds.test, docu/04 chapter — this PR, 2026-09-17
- [x] A2 Environment separation: mtaext dev/qa/prod (sizing, plans, CORS origins), mta.yaml free of environment identifiers (S4_DESTINATION removed, CORS_ORIGINS from the approuter URL, saas-registry appName adoptops-${space}), MTA version 0.1.0, router and html5-deployer on Node 22 / html5-app-deployer ^7, docu/05 environments chapter — PR #21, 2026-09-17
- [x] A1 PostgreSQL schema deployment: adops-basic-db-deployer MTA module (gen/pg, cds-deploy CF task, srv ordered after it), postgres cds build task, code/db/package.json, build-time deployer/runtime CSN check, db:ddl/db:deploy:postgres scripts, docu/05 chapter with the verified additive-only migration strategy — PR #18, 2026-09-17
- [x] Integration housekeeping after the first parallel round: A4 tracker line carries PR #13, client lint fixed (unused `userInfo` prop in AdopsShell, idea I13) so the lint gate can go red only for real problems — PR #16, 2026-09-17
- [x] A4 Hash-chained append-only audit log: AuditEvents Sequence/PrevHash/Hash, per-tenant AuditChainHeads lock, one writer (audit-chain.js) for every audit row, @readonly projections + database-level UPDATE/DELETE guard, AdminService verifyAuditChain, IDENTIFIED_USAGE_CHANGED event, docu/10 chapter — PR #13, 2026-09-16
- [x] A3 Read-only PublicService projections, writes via role-gated actions, Admin-only target-system edits, cds.test auth suite — PR #9, 2026-09-16
- [x] Road to Production roadmap checked in as plan of record — PR #8, 2026-09-16
- [x] Parallel worktrees: per-workstream checkouts, port slots, worktree.mjs, with-env `?=` defaults, db:init:sqlite — PR #10, 2026-09-16
- [x] Program tracker, tracker board script, git-workflow rule update, worktree one-pager — PR #11, 2026-09-16
- [x] Worktree session brief: generated CLAUDE.local.md per worktree (add/next/sync), CLAUDE.md worktree section — PR #12, 2026-09-16

## Daily log

### 2026-09-17
- A8 landed. Nothing referenced the three modules; the new module-load suite would have flagged them (three of 38 modules failed to require). Noticed while confirming the live path: server.js registers the SaaS subscription callbacks only for the basic tier, so a standard-tier instance answers 404 to the registry (idea I27, belongs to T2).
- A7 landed. The undefined `body` half of the item had already been removed by S4 (#26); A7 adds the tests that pin that path (OData root, mocked transport, step and probe) and flips the TLS default. Local scripts use a plain-http override for the A4H lab box, so nothing local needed the opt-in.
- A6 landed. Branch protection stays unavailable, so "a red check blocks the PR" is a reviewer rule, not a GitHub setting. Server lint surfaced 17 findings: one was the A7 `body` reference in s4-activate-adapter.js, which S4 (#26) replaced on main before this PR merged (A7 still owns the test and the TLS default), six sit in the dead provisioning path (excluded until A8 removes it), the rest were dead assignments. `npm install` for the new dev dependencies replaced this worktree's node_modules junction with a real directory; the primary checkout was untouched. First CI run caught a peer-dependency clash a local `npm install` tolerates but a clean `npm ci` refuses: @sap/cds 8.9 pins @eslint/js ^9, so the server lint stays on eslint 9.
- A5 landed. Two findings: (1) registerTenantScope checked `target.name.startsWith('adops.db.')`, but an OData request targets the service projection, so no read had ever been filtered; the helper now follows projections to their source. (2) cds deletes the `tenant` attribute of mocked users while multitenancy is off, while the XSUAA strategy always sets `ctx.tenant` from the zone id; the two-tenant test assigns tenants in a post-auth middleware instead of enabling MTX.
- A2 landed (stacked on A1; merge A1 first, then rebase). Per-space values live in mtaext files applied with `cf deploy -e`; `mbt mtad-gen -e` validated all three merged descriptors. No destination name appears in any descriptor: TargetSystems rows own their destinations. The CF login token had expired, so the dev space's current instances were not inspected; the saas-registry rename is only safe because nothing had been deployed there yet (confirm before the first deploy).
- A1 landed. Verified with `cds deploy --dry --delta-from`: schema evolution adds tables, columns and views and widens types, but the compiler refuses dropped elements, dropped tables and length reductions outright ("not supported"), so the deployer cannot lose data and destructive changes need the manual path in docu/05. `mbt build` cannot run in a worktree whose client node_modules is a junction (its `npm ci` would empty the primary checkout's modules); `mbt mtad-gen` and `mbt module-build -m adops-basic-db-deployer` cover the packaging check instead.

### 2026-09-16
- Roadmap approved (single-tenant RD1 pilot first). Surveys found: no Postgres schema deployment, two security blockers (writable projections, no audit chain), live activation stops at ABAP step 2.
- A3 landed. Lesson: cds keeps the [development] profile active under NODE_ENV=test; API tests must pin `cds.env.requires.db` to in-memory and assert it, or they write into the developer's db.sqlite (happened once, two fixture rows removed).
- Worktrees created for admin / scheduling / overview. Lesson: `cds serve --watch` children on this machine stop serving HTTP after a reload; all launch configs use the no-watch script.
- Session start automated: each worktree gets a generated CLAUDE.local.md brief (Claude Code reads it with CLAUDE.md), so no start prompt has to be pasted and a forgotten prompt cannot cause a wrong-worktree session.
- A4 landed. Design notes: a table-level UNIQUE via `@sql.append` compiles to invalid DDL (lands after the closing parenthesis) on sqlite and Postgres, so the sequence is serialised through a per-tenant head row read FOR UPDATE plus an in-process mutex instead. `writeAdminAuditEvent` no longer swallows failures: the audited change and its audit row now commit or roll back together. Pre-A4 rows in dev databases stay as "unchained" legacy events.

### 2026-09-17
- First parallel round merged: #13 A4 (admin), #14 S2 (scheduling), #15 O1 (overview); all suites green on main (111 server, 49 client); ABAP mirror has zero drift against a4h_2023_zado after its PR #18. Worktrees re-pointed to A1 / S1 / O4.
