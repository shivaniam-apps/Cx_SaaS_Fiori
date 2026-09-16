# Overview — tracker

Worktree `Cx_SaaS_Fiori.worktrees/overview` · CAP 4114 · client 5283 · owns O items
(journey pages in `code/app/adops-client`). Pure logic goes to `src/features/<area>/`
with node --test coverage registered in the package test script.
Format: see [program-tracker.md](../program-tracker.md).

## In progress

- [~] O1 Activation Plans page: cross-wave list + detail, create / simulate / execute, open run; reuse groupSteps, STEP_STATUS_DESIGN, Kpi, Activation Runs patterns — branch feat/activation-plans-page, started 2026-09-16

## To-do (milestone order)

- [ ] O4 Replace hardcoded newRolesNeeded / activationStepCount in fiori-candidate-query.js with values derived from the plan template
- [ ] O5 Client crash reporting: features/telemetry/correlation.js, componentDidCatch -> recordClientError
- [ ] O2 Settings page on shared AdopsPageTabs (/settings/:view?): per-system identifiedUsageAllowed and activationRootPath, telemetry settings — after A4 (audit event on toggle)
- [ ] O3 Audit Log page: bounded, server-filtered AuditEvents read with chain-verification status — after A4
- [ ] O7 Product Insights page on AdopsPageTabs (backend complete)
- [ ] O6 User & Role Landscape page with server-side paging — after S8

## Accomplished

- [x] Access Requests triage page + Request Access flow on the Member gate, AdminService summary function — PR #7, 2026-09-15
- [x] Activation Runs monitor page, queryActivationRuns / readActivationRun, shared Kpi tile — PR #6, 2026-09-15

## Daily log

### 2026-09-16
- Placeholder pages left: Activation Plans, Settings, Audit Log, Product Insights, User & Role Landscape. Settings and Audit Log wait for A4's AuditEvents shape; Landscape waits for S8 data.
