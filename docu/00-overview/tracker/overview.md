# Overview — tracker

Worktree `Cx_SaaS_Fiori.worktrees/overview` · CAP 4114 · client 5283 · owns O items
(journey pages in `code/app/adops-client`). Pure logic goes to `src/features/<area>/`
with node --test coverage registered in the package test script.
Format: see [program-tracker.md](../program-tracker.md).

## In progress


## To-do (milestone order)


## Accomplished

- [x] O10 Activation Runs KPI cards as status filters (promoted I7): the status bucket parameter on queryActivationRuns (landed with O8) is now driven by the cards too - a card click applies its bucket AND writes the draft (nextStatusFilter in runModel), the applied card is highlighted and clicking it again or the total card clears the filter — this PR, 2026-09-18
- [x] O9 UI hygiene (promoted I2, I14, I30): shared AdopsToast + useFeedback hook route Positive / Information notices to a toast and Critical / Negative ones to a strip on Access Requests, Activation Plans, Activation Runs, Transports, Settings and Product Insights; icon registration guard (src/assets/ui5Assets.test.js scans every icon= / illustration literal against ui5Assets.js) with accept / delete / restart / stop registered; AppErrorBoundary keyed on the first path segment so /page/:view tab switches keep page state — PR #46, 2026-09-18
- [x] O8 Adoption Cockpit KPI strip (promoted from I1): queryDashboardSummary (one read, grouped counts per journey stage at the database, proposals scoped to the current analysis run per system), per-stage KPI tiles on the Dashboard with a target-system scope and a next-step prompt, click-through into Proposals / Activation Runs / Transports with the same status bucket pre-applied (new URL filters on those pages, bucket status params on queryProposals / queryActivationRuns / queryTransportRequests) — PR #42, 2026-09-18
- [x] O6 User & Role Landscape page (/landscape/:view?, Users + Roles tabs on AdopsPageTabs): run-scoped, server-filtered/sorted UserInventory + RoleInventory pages with $top/$skip/$count load-more, KPI strips from $apply=filter/groupby over the same filter scope, per-row detail reads (RoleUsers, RoleTransactions), role/user cross-links as URL params — PR #39, 2026-09-18
- [x] I16 Global error reporting: WINDOW_ERROR, UNHANDLED_REJECTION and API_FAILURE (network / 5xx) crash reports through recordClientError, deduped and session-capped client-side — PR #33, 2026-09-17
- [x] I17 Client telemetry emitter: PAGE_VIEWED + activation usage events and APP_LOAD / slow ROUTE_RENDER / slow API performance events batched to recordTelemetryBatch, gated by getTelemetrySettings — PR #29, 2026-09-17
- [x] O7 Product Insights page on AdopsPageTabs (/product-insights/:view?): Feedback triage, Crash reports triage, Usage and Performance server summaries — this PR, 2026-09-17
- [x] O3 Audit Log page: bounded, server-filtered AuditEvents read (type / object type / object / user / severity, load more) with the verifyAuditChain verdict and per-event hash detail — this PR, 2026-09-17
- [x] O2 Settings page on shared AdopsPageTabs (/settings/:view?): per-system identifiedUsageAllowed (confirmed, audited, recent changes shown) and activationRootPath, telemetry settings form — PR #22, 2026-09-17
- [x] O5 Client crash reporting: features/telemetry/correlation.js + httpCorrelation interceptors on both axios clients, AppErrorBoundary.componentDidCatch -> recordClientError with a support reference — this PR, 2026-09-17
- [x] O4 Replace hardcoded newRolesNeeded / activationStepCount with deriveActivationEffort from the activation template — this PR, 2026-09-17
- [x] O1 Activation Plans page: cross-wave list + detail, create / simulate / execute, open run; queryActivationPlans + readActivationPlan Wave/Transport/Runs — PR #15, 2026-09-17
- [x] Access Requests triage page + Request Access flow on the Member gate, AdminService summary function — PR #7, 2026-09-15
- [x] Activation Runs monitor page, queryActivationRuns / readActivationRun, shared Kpi tile — PR #6, 2026-09-15

## Daily log

### 2026-09-18
- O10 done on feat/runs-kpi-filters (stacked on feat/adops-toast / PR #46, both touch ActivationRunsPage): Kpi onClick per card, nextStatusFilter + test in runModel. Verified in the browser on 5283: Succeeded card -> list of 1, Status select shows Succeeded, request carries status=SUCCEEDED; second click clears back to all statuses.
- O9 done on feat/adops-toast: features/ui/feedback.js (routing + release feedback text; node --test), components/AdopsToast.jsx over ui5 Toast, hooks/useFeedback.js, six pages converted (Transports keeps a Negative strip for failed releases), icon audit test found 4 unregistered icons (accept, delete, restart, stop) and now guards them, App.jsx boundary key = page segment. Verified in the browser on 5283: Settings save shows the toast and it auto-closes, Landscape filter draft survives a Users -> Roles -> Users tab switch, Activation Runs logs no icon loader errors. PR #46 opened.
- O8 done on feat/dashboard-kpis: srv/utils/dashboard-summary.js (partitions + bucketStatuses shared with the list reads; mocha shaping + HTTP tests on the in-memory db), queryDashboardSummary handler, status bucket params on queryActivationRuns / queryTransportRequests / queryProposals (additive), client features/dashboard/dashboardModel.js (journey cards, links, next step; node --test), DashboardPage rewrite, Kpi gains design/onClick, Proposals / Activation Runs / Transports read system/status navigation params into their filter bars. Verified in the browser on 5283: tiles, scope select, To review -> Proposals (23 rows, filter shown), Open transports -> Transports, Runs failed -> Activation Runs. PR #42 opened; merged origin/main (A11 #40, S10 #41) into the branch, resolving the client package.json test line and the Transports page filter bar against S10.
- O6 done on feat/landscape-page: features/landscape/landscapeModel.js (views, run filter, $filter/$orderby builders, KPI partitions, deep-link params; node --test) + LandscapePage.jsx, queryInventoryPage / queryInventoryGroups in fioriService, information icon registered, PlaceholderPage removed (last consumer). Verified in the browser on 5283 with a mock USR02+AGR extraction (163 users / 11 roles): cards, filters + Go/Clear, load more ($skip), user -> role and role -> user cross-links, (i) popover. Found that AppErrorBoundary keyed on pathname remounts pages on tab switches (I30).

### 2026-09-17
- I16 done on feat/global-error-reporting: features/telemetry/errorReporting.js (report builder, dedupe/cap gate, API-failure policy, rejection describer; node --test), crash reporting moved into telemetryService with window error / unhandledrejection listeners and failure capture on the shared axios timing listener; verified WINDOW_ERROR and UNHANDLED_REJECTION rows in the browser (I17 merged via PR #29). PR #33 opened; merged origin/main (S5, A7, A8) into the branch.
- I17 done on feat/client-telemetry-emitter: features/telemetry queue + performancePolicy (node --test), services/telemetryService (batched flush, backoff, page-hide keepalive flush, settings gate), API timing listener on the shared axios installer, route tracking in App.jsx, plan create/simulate/execute usage events; verified PAGE_VIEWED and APP_LOAD rows and the Usage tab in the browser (O7 merged via PR #28). PR #29 opened; merged origin/main (A6 CI gate) into the branch. O6 stays blocked on S8.
- O7 done on feat/product-insights-page: Feedback (bounded server-filtered PilotFeedback + groupby status KPIs + triage dialog), Crash reports (ClientErrorReports + status change + stack detail), Usage / Performance over queryUsageSummary / queryPerformanceSummary with a window select; verified triage, status change and all tabs in the browser (O3 merged via PR #24).
- O3 done on feat/audit-log-page: Audit Log page over AdminService AuditEvents (server $filter/$top/$skip/$count, distinct filter values via $apply groupby) with the chain verdict strip + KPI cards and an event detail panel (hashes, correlation, SAP response); verified filters and verdict in the browser (O2 merged via PR #22).
- O2 done on feat/settings-page: AdopsPageTabs component, Settings page with Target Systems and Telemetry tabs; verified toggle identified mode -> IDENTIFIED_USAGE_CHANGED audit rows visible on the page, telemetry save persists (O5 merged via PR #19). PR #22 opened; merged origin/main (S1, A2) into the branch.
- O5 done on feat/client-crash-reporting: render crashes land in ClientErrorReports (verified: route, feature, correlation/session id, stacks, app version); every request now carries x-correlation-id (O4 merged via PR #17).
- O4 done on fix/proposal-plan-counts: deriveActivationEffort (activation-plan.js) feeds the candidate query and the engine default; effort now counts the 10-step single-app plan instead of the literal 4 (O1 merged via PR #15).

### 2026-09-16
- Placeholder pages left: Activation Plans, Settings, Audit Log, Product Insights, User & Role Landscape. Settings and Audit Log wait for A4's AuditEvents shape; Landscape waits for S8 data.
