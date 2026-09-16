# Admin & Operations — tracker

Worktree `Cx_SaaS_Fiori.worktrees/admin` · CAP 4134 · client 5303 · owns A and T items
(deploy, security, audit, tenancy, CI, docs). Format: see [program-tracker.md](../program-tracker.md).

## In progress

- [~] A4 Hash-chained append-only audit log; AuditEvents Sequence/PrevHash/Hash, @insertonly, verifyAuditChain, audit identifiedUsageAllowed changes — branch feat/audit-hash-chain, started 2026-09-16

## To-do (milestone order)

- [ ] A1 PostgreSQL schema deployment: db-deployer module, cds deploy --to postgres, migration strategy — deploy/cf/mta.yaml, code/package.json
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

- [x] A3 Read-only PublicService projections, writes via role-gated actions, Admin-only target-system edits, cds.test auth suite — PR #9, 2026-09-16
- [x] Road to Production roadmap checked in as plan of record — PR #8, 2026-09-16
- [x] Parallel worktrees: per-workstream checkouts, port slots, worktree.mjs, with-env `?=` defaults, db:init:sqlite — PR #10, 2026-09-16
- [x] Program tracker, tracker board script, git-workflow rule update, worktree one-pager — PR #11, 2026-09-16

## Daily log

### 2026-09-16
- Roadmap approved (single-tenant RD1 pilot first). Surveys found: no Postgres schema deployment, two security blockers (writable projections, no audit chain), live activation stops at ABAP step 2.
- A3 landed. Lesson: cds keeps the [development] profile active under NODE_ENV=test; API tests must pin `cds.env.requires.db` to in-memory and assert it, or they write into the developer's db.sqlite (happened once, two fixture rows removed).
- Worktrees created for admin / scheduling / overview. Lesson: `cds serve --watch` children on this machine stop serving HTTP after a reload; all launch configs use the no-watch script.
