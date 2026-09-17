# Overview — tracker

Worktree `Cx_SaaS_Fiori.worktrees/overview` · CAP 4114 · client 5283 · owns O items
(journey pages in `code/app/adops-client`). Pure logic goes to `src/features/<area>/`
with node --test coverage registered in the package test script.
Format: see [program-tracker.md](../program-tracker.md).

## In progress


## To-do (milestone order)

- [ ] O6 User & Role Landscape page with server-side paging — after S8

## Accomplished

- [x] I17 Client telemetry emitter: PAGE_VIEWED + activation usage events and APP_LOAD / slow ROUTE_RENDER / slow API performance events batched to recordTelemetryBatch, gated by getTelemetrySettings — this PR, 2026-09-17
- [x] O7 Product Insights page on AdopsPageTabs (/product-insights/:view?): Feedback triage, Crash reports triage, Usage and Performance server summaries — this PR, 2026-09-17
- [x] O3 Audit Log page: bounded, server-filtered AuditEvents read (type / object type / object / user / severity, load more) with the verifyAuditChain verdict and per-event hash detail — this PR, 2026-09-17
- [x] O2 Settings page on shared AdopsPageTabs (/settings/:view?): per-system identifiedUsageAllowed (confirmed, audited, recent changes shown) and activationRootPath, telemetry settings form — PR #22, 2026-09-17
- [x] O5 Client crash reporting: features/telemetry/correlation.js + httpCorrelation interceptors on both axios clients, AppErrorBoundary.componentDidCatch -> recordClientError with a support reference — this PR, 2026-09-17
- [x] O4 Replace hardcoded newRolesNeeded / activationStepCount with deriveActivationEffort from the activation template — this PR, 2026-09-17
- [x] O1 Activation Plans page: cross-wave list + detail, create / simulate / execute, open run; queryActivationPlans + readActivationPlan Wave/Transport/Runs — PR #15, 2026-09-17
- [x] Access Requests triage page + Request Access flow on the Member gate, AdminService summary function — PR #7, 2026-09-15
- [x] Activation Runs monitor page, queryActivationRuns / readActivationRun, shared Kpi tile — PR #6, 2026-09-15

## Daily log

### 2026-09-17
- I17 done on feat/client-telemetry-emitter: features/telemetry queue + performancePolicy (node --test), services/telemetryService (batched flush, backoff, page-hide keepalive flush, settings gate), API timing listener on the shared axios installer, route tracking in App.jsx, plan create/simulate/execute usage events; verified PAGE_VIEWED and APP_LOAD rows and the Usage tab in the browser (O7 merged via PR #28). O6 stays blocked on S8.
- O7 done on feat/product-insights-page: Feedback (bounded server-filtered PilotFeedback + groupby status KPIs + triage dialog), Crash reports (ClientErrorReports + status change + stack detail), Usage / Performance over queryUsageSummary / queryPerformanceSummary with a window select; verified triage, status change and all tabs in the browser (O3 merged via PR #24).
- O3 done on feat/audit-log-page: Audit Log page over AdminService AuditEvents (server $filter/$top/$skip/$count, distinct filter values via $apply groupby) with the chain verdict strip + KPI cards and an event detail panel (hashes, correlation, SAP response); verified filters and verdict in the browser (O2 merged via PR #22).
- O2 done on feat/settings-page: AdopsPageTabs component, Settings page with Target Systems and Telemetry tabs; verified toggle identified mode -> IDENTIFIED_USAGE_CHANGED audit rows visible on the page, telemetry save persists (O5 merged via PR #19). PR #22 opened; merged origin/main (S1, A2) into the branch.
- O5 done on feat/client-crash-reporting: render crashes land in ClientErrorReports (verified: route, feature, correlation/session id, stacks, app version); every request now carries x-correlation-id (O4 merged via PR #17).
- O4 done on fix/proposal-plan-counts: deriveActivationEffort (activation-plan.js) feeds the candidate query and the engine default; effort now counts the 10-step single-app plan instead of the literal 4 (O1 merged via PR #15).

### 2026-09-16
- Placeholder pages left: Activation Plans, Settings, Audit Log, Product Insights, User & Role Landscape. Settings and Audit Log wait for A4's AuditEvents shape; Landscape waits for S8 data.
