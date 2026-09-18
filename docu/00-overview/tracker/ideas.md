# Ideas and parking lot

Anyone appends; nobody deletes. When an idea becomes work it gets a roadmap-style ID
and a To-do line in the owning workstream's tracker; the entry here gets a
"-> promoted to <ID>" note. Parked items keep the reason.

## Open

- I1 (2026-09-16) Dashboard KPI cards should link through to the filtered list they count (fiori-ux navigation rule); today the dashboard is a journey strip only.
- I2 (2026-09-16) `AdopsToast` success feedback component does not exist; pages use MessageStrips that a list reload wipes. Build once, use on Transports, Access Requests, Activation Runs.
- I3 (2026-09-16) The hardcoded catalog in `shipped-overlay-catalog.js` (42 rows) needs an owner for content verification of the F-numbers regardless of PO-1.
- I4 (2026-09-16) Worktrees share `node_modules` via junctions; a branch that changes dependencies must run `npm ci` locally. Consider a `worktree.mjs doctor` command that detects lockfile drift between a worktree and the primary checkout.
- I5 (2026-09-16) `cds serve --watch` children stop serving HTTP after a reload on this machine; root cause unknown (cds-dk 8.9). Investigate or document a supported restart shortcut.
- I6 (2026-09-16) Two "RD1 Development" target-system rows exist in the local dev sqlite (pre-existing); decide whether Target Systems should enforce unique destinationName per tenant.
- I7 (2026-09-16) Activation Runs list: KPI cards could act as status filters once the run query accepts a status parameter (same server expression for card and slice).
- I8 (2026-09-16) Audit chain proves internal consistency, not completeness: a DBA can truncate the tail and rewind AuditChainHeads undetected. Anchor the latest Hash externally (BTP Audit Log service, T3) or publish a periodic checkpoint.
- I9 (2026-09-16) Subscription purge (T2) vs. append-only AuditEvents: the database guard refuses DELETE; decide whether a tenant's audit rows are exported-then-purged or retained under a legal hold, and give the purge an explicit bypass.
- I10 (2026-09-16) verifyAuditChain walks the whole tenant chain (paged, 500 rows). Beyond ~1M events add an incremental mode that verifies from a stored checkpoint, and an index on (TenantId, Sequence) once the Postgres deployment (A1) exists.
- I11 (2026-09-16) ICF step keys resolve `url`/`icfName` from `BackendCatalogApps.BspApplication`, which only S9 (catalog derivation) fills; until then every ICF step fails fast in ABAP. Once S4 (live simulation) exists, an unresolved ICF key should surface as SIMULATED_BLOCKED at plan time instead of at execution. -> addressed in S4 (ZCL_ADO_ACT_PROBE blocks an ICF step whose key has no url/icfName)
- I12 (2026-09-16) The planner's ADD_TO_TRANSPORT step is last, but `PRGN_RFC_CREATE_ACTIVITY_GROUP` takes the TRKORR at role-creation time and the dispatcher does not pass one; role/profile steps currently land on no request. S3's transport-append step needs either a create-request step first in the sequence or a plan-level TRKORR threaded into the role keys. -> addressed in S3 part 1 (both: request created before the first transportable write, engine injects the TRKORR into role/append keys)
- I13 (2026-09-17) `npm run lint` fails on `main` (unused `userInfo` prop in `AdopsShell.jsx:56`); fix in a tiny chore PR so the client lint gate (A6) starts green. -> done in PR #16 (integration housekeeping)
- I14 (2026-09-17) Icons are registered one by one in `ui5Assets.js`; `restart`/`stop` (Activation Runs) are still missing and log "No loader registered" errors. Audit every `icon=` prop against the list, or add an eslint check.
- I15 (2026-09-17) Fresh worktree databases are empty, so a browser check of the Activate journey needs a manual seed chain (target system -> mock extraction -> proposals -> wave -> approvals). Add `scripts/seed-dev.mjs` (mock mode only) that performs it against a CAP port. -> the S5 browser check drove exactly this chain through the public actions with a 60-line node script (runUsageExtraction -> generateProposals -> queryProposals -> createAdoptionWave -> approveProposal -> assignProposalsToWave -> createActivationPlan -> simulate -> execute, polling getTaskStatus); promote it into scripts/ under the worktree tooling.
- I16 (2026-09-17) Crash reporting covers React render errors only (O5). recordClientError also accepts WINDOW_ERROR / UNHANDLED_REJECTION / API_FAILURE: add window error + unhandledrejection listeners and an axios response-error hook (rate-limited, A13) so non-render failures are reported too. -> done in the global-error-reporting PR (client-side dedupe + session cap; server-side rate limiting stays with A13).

- I16 (2026-09-17) The db deployer (code/db/package.json) has no lockfile; the CF buildpack resolves ^8.9.4 / ^1.10.0 at staging. Pin a lockfile under T5 so deployer and runtime cannot drift.
- I17 (2026-09-17) First cf deploy against a Postgres instance that was schema-deployed by hand (no cds_model row) fails on existing tables; docu/05 describes the --model-only seeding. Add a worktree script for it if the dev space instance turns out to be in that state.
- I18 (2026-09-17) worktree.mjs doctor (I4) should also flag junctioned client node_modules as "mbt build unsafe here", since mbt's npm ci would wipe the primary checkout's modules.
- I19 (2026-09-17) The connection check reports USAGE and ACTIVATE endpoints; S9 should add a CATALOG endpoint verdict (ZADO_CATALOG read unit) to the same `Endpoints` list so the Target Systems page needs no new shape. An EXPOSED activation verdict on QA/PROD is only shown today; consider also writing an audit event (A4 chain) since it is a safety finding.

- I19 (2026-09-17) s4-http-client.js still defaults S4_DESTINATION to the hardcoded S4H_2023 (architecture.md forbids environment identifiers in code). Drop the fallback and make callers without a target-system destination fail with a clear error; touches the scheduling workstream's adapters, so land it as a shared change.
- I20 (2026-09-17) dev.mtaext requests the PostgreSQL plan "development"; confirm the plan is entitled in the ap10 subaccount before the first dev deploy, else switch it to "standard" (plans cannot be changed on an existing instance by the deployer).
- I21 (2026-09-17) server.js still defaults CORS_ORIGINS to Vite's 5173 while the clients run on 5273/5283/5293/5303/5313; align the local default with the worktree port slots.
- I17 (2026-09-17) The client emits no usage or performance telemetry yet (CoreService recordTelemetryBatch exists; ChronoPilot has features/telemetry/queue.js + performancePolicy.js as the template), so the Product Insights Usage and Performance tabs (O7) stay empty until a client emitter lands. Pair with I16 (window error reporting) and A13 rate limiting. -> emitter done in the client-telemetry-emitter PR; window/API-failure error reporting (I16) still open.

- I22 (2026-09-17) Users/Roles admin handlers run only under the hybrid/production profiles and read XSUAA through UserManagement; the tenant filter on their db reads is in place but untested locally. Cover them in the two-tenant suite once a hybrid test binding exists (A12).
- I23 (2026-09-17) PilotFeedback carries a plain TenantId (stamped per tenant since A5) but not the aspect; align it with the other seven when the entity is next touched.

- I24 (2026-09-17) The pre-push hook only blocks pushes to main; consider a fast `npm run lint` (server + client) in pre-push now that both exist, leaving the slow suites to CI.
- I25 (2026-09-17) worktree.mjs add --link-modules junctions node_modules; the first `npm install` in a worktree silently replaces the junction with a real directory. Document or detect it in the planned doctor command (I4, I18).

- I26 (2026-09-17) The direct-access variables (ADOPTOPS_S4_URL_OVERRIDES, DIRECT_USER/PASSWORD, INSECURE_TLS) are development conveniences; add a boot-time warning (or refusal under the production profile) when any of them is set in a Cloud Foundry instance.
- I27 (2026-09-17) S8 leaves UserInventory.UsesFioriToday and RoleInventory.HasFioriCatalog / BusinessCatalogCount at false / 0: they need the FIORI usage source (launchpad usage, /UI2 tables) and the catalog derivation (S9). Also FullName / Email / Department stay empty by design in pseudonymised mode; identified mode (audited opt-in) could read USR21/ADRP through a dedicated entity later.
- I28 (2026-09-17) The DistinctTcodeCount rollup in usage-extraction.js issues one UPDATE per inventory user with usage (bounded by tcodes x topUsersPerTcode). On PostgreSQL a single UPDATE ... FROM (subquery) would replace the loop; do it when S7 moves the extraction onto snapshots.

- I27 (2026-09-17) server.js registers the /-/basic/saas-provisioning callbacks only when the tier is basic; a standard-tier instance (same shared PostgreSQL, same registry entry) would answer 404 on subscribe. Register them for every non-enterprise tier as part of T2 (subscription lifecycle).

- I28 (2026-09-17) A9 CAP side passes P_TopUsers / P_MinExecutions to the usage entity whenever $metadata declares them, which is the CAP half of S6; scheduling should verify on RD1 and close S6 instead of re-implementing it.
- I30 (2026-09-18) App.jsx keys AppErrorBoundary on the full pathname, so every /page/:view tab switch (Settings, Product Insights, Landscape) remounts the page and drops its state, contrary to the fiori-ux Page-Level Tabs intent. The Landscape page therefore carries cross-links as URL params (run / role / user). Keying the boundary on the first path segment would keep tab state but also keep a crashed boundary across tab switches - decide deliberately, shell-level change.
- I31 (2026-09-18) `safeResponseData` in s4-http-client.js masks secret-shaped fields with a regex that stops at the first space, so `"authorization":"Bearer abc"` becomes `"authorization":"*** abc"` and the token itself survives into connection-check messages and logs. Mask to the closing quote (or the value end) instead; pinned as a known gap in s4-http-client-helpers.test.mjs. Belongs to T6.
- I29 (2026-09-17) docu/15 target-system onboarding (A10) must include "run ZADO_CFG_INIT in every productive client" and the check that the connection verdict reports the pseudonym secret as configured (add a SystemInfo field for it in the usage service).
- I30 (2026-09-18) The SaaS subscription callback returns the tenant URL but nothing maps the route `<subdomain>-adops-basic-<space>` on the approuter; the deploy runbook (docu/05) tells the operator to run `cf map-route` by hand after each subscription. Map the route from the callback (CF API with a bound credential) as part of T2.
- I31 (2026-09-18) `safeResponseData` in s4-http-client.js masks secret-shaped fields with a regex that stops at the first space, so `"authorization":"Bearer abc"` becomes `"authorization":"*** abc"` and the token itself survives into connection-check messages and logs. Mask to the closing quote (or the value end) instead; pinned as a known gap in s4-http-client-helpers.test.mjs. Belongs to T6.

## Parked

(none)
