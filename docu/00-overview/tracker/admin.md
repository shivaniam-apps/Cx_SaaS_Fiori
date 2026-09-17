# Admin & Operations — tracker

Worktree `Cx_SaaS_Fiori.worktrees/admin` · CAP 4134 · client 5303 · owns A and T items
(deploy, security, audit, tenancy, CI, docs). Format: see [program-tracker.md](../program-tracker.md).

## In progress

(none)

## To-do (milestone order)

- [ ] A2 Environment separation: mtaext dev/qa/prod, remove hardcoded S4H_2023, CORS_ORIGINS, space-suffixed saas-registry name, version bump, html5-deployer ^7 / Node 22 alignment
- [ ] A5 tenantScoped aspect on AccessRequests, ClientErrorReports, UsageEvents, PerformanceEvents, TelemetrySettings, Roles, Users + two-tenant cds.test
- [ ] A6 CI gate: GitHub workflow (server mocha, client node --test, Linux client build with rolldown lock check, lint), server lint script, mocha ESM warning, AdopsShell.jsx unused variable
- [ ] A7 Safety defaults: S4_DIRECT_INSECURE_TLS default off; undefined `body` in s4-activate-adapter.js OData branch
- [ ] A8 Remove dead provisioning path (provisioning.js, undeclared cfenv / alert-notification-client); confirm basic-subscription.js is the live path
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

- [x] A1 PostgreSQL schema deployment: adops-basic-db-deployer MTA module (gen/pg, cds-deploy CF task, srv ordered after it), postgres cds build task, code/db/package.json, build-time deployer/runtime CSN check, db:ddl/db:deploy:postgres scripts, docu/05 chapter with the verified additive-only migration strategy — this PR, 2026-09-17
- [x] Integration housekeeping after the first parallel round: A4 tracker line carries PR #13, client lint fixed (unused `userInfo` prop in AdopsShell, idea I13) so the lint gate can go red only for real problems — PR #16, 2026-09-17
- [x] A4 Hash-chained append-only audit log: AuditEvents Sequence/PrevHash/Hash, per-tenant AuditChainHeads lock, one writer (audit-chain.js) for every audit row, @readonly projections + database-level UPDATE/DELETE guard, AdminService verifyAuditChain, IDENTIFIED_USAGE_CHANGED event, docu/10 chapter — PR #13, 2026-09-16
- [x] A3 Read-only PublicService projections, writes via role-gated actions, Admin-only target-system edits, cds.test auth suite — PR #9, 2026-09-16
- [x] Road to Production roadmap checked in as plan of record — PR #8, 2026-09-16
- [x] Parallel worktrees: per-workstream checkouts, port slots, worktree.mjs, with-env `?=` defaults, db:init:sqlite — PR #10, 2026-09-16
- [x] Program tracker, tracker board script, git-workflow rule update, worktree one-pager — PR #11, 2026-09-16
- [x] Worktree session brief: generated CLAUDE.local.md per worktree (add/next/sync), CLAUDE.md worktree section — PR #12, 2026-09-16

## Daily log

### 2026-09-17
- A1 landed. Verified with `cds deploy --dry --delta-from`: schema evolution adds tables, columns and views and widens types, but the compiler refuses dropped elements, dropped tables and length reductions outright ("not supported"), so the deployer cannot lose data and destructive changes need the manual path in docu/05. `mbt build` cannot run in a worktree whose client node_modules is a junction (its `npm ci` would empty the primary checkout's modules); `mbt mtad-gen` and `mbt module-build -m adops-basic-db-deployer` cover the packaging check instead.

### 2026-09-16
- Roadmap approved (single-tenant RD1 pilot first). Surveys found: no Postgres schema deployment, two security blockers (writable projections, no audit chain), live activation stops at ABAP step 2.
- A3 landed. Lesson: cds keeps the [development] profile active under NODE_ENV=test; API tests must pin `cds.env.requires.db` to in-memory and assert it, or they write into the developer's db.sqlite (happened once, two fixture rows removed).
- Worktrees created for admin / scheduling / overview. Lesson: `cds serve --watch` children on this machine stop serving HTTP after a reload; all launch configs use the no-watch script.
- Session start automated: each worktree gets a generated CLAUDE.local.md brief (Claude Code reads it with CLAUDE.md), so no start prompt has to be pasted and a forgotten prompt cannot cause a wrong-worktree session.
- A4 landed. Design notes: a table-level UNIQUE via `@sql.append` compiles to invalid DDL (lands after the closing parenthesis) on sqlite and Postgres, so the sequence is serialised through a per-tenant head row read FOR UPDATE plus an in-process mutex instead. `writeAdminAuditEvent` no longer swallows failures: the audited change and its audit row now commit or roll back together. Pre-A4 rows in dev databases stay as "unchained" legacy events.

### 2026-09-17
- First parallel round merged: #13 A4 (admin), #14 S2 (scheduling), #15 O1 (overview); all suites green on main (111 server, 49 client); ABAP mirror has zero drift against a4h_2023_zado after its PR #18. Worktrees re-pointed to A1 / S1 / O4.
