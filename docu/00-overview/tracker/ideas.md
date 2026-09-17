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
- I16 (2026-09-17) Crash reporting covers React render errors only (O5). recordClientError also accepts WINDOW_ERROR / UNHANDLED_REJECTION / API_FAILURE: add window error + unhandledrejection listeners and an axios response-error hook (rate-limited, A13) so non-render failures are reported too.

- I16 (2026-09-17) The db deployer (code/db/package.json) has no lockfile; the CF buildpack resolves ^8.9.4 / ^1.10.0 at staging. Pin a lockfile under T5 so deployer and runtime cannot drift.
- I17 (2026-09-17) First cf deploy against a Postgres instance that was schema-deployed by hand (no cds_model row) fails on existing tables; docu/05 describes the --model-only seeding. Add a worktree script for it if the dev space instance turns out to be in that state.
- I18 (2026-09-17) worktree.mjs doctor (I4) should also flag junctioned client node_modules as "mbt build unsafe here", since mbt's npm ci would wipe the primary checkout's modules.
- I19 (2026-09-17) The connection check reports USAGE and ACTIVATE endpoints; S9 should add a CATALOG endpoint verdict (ZADO_CATALOG read unit) to the same `Endpoints` list so the Target Systems page needs no new shape. An EXPOSED activation verdict on QA/PROD is only shown today; consider also writing an audit event (A4 chain) since it is a safety finding.

- I19 (2026-09-17) s4-http-client.js still defaults S4_DESTINATION to the hardcoded S4H_2023 (architecture.md forbids environment identifiers in code). Drop the fallback and make callers without a target-system destination fail with a clear error; touches the scheduling workstream's adapters, so land it as a shared change.
- I20 (2026-09-17) dev.mtaext requests the PostgreSQL plan "development"; confirm the plan is entitled in the ap10 subaccount before the first dev deploy, else switch it to "standard" (plans cannot be changed on an existing instance by the deployer).
- I21 (2026-09-17) server.js still defaults CORS_ORIGINS to Vite's 5173 while the clients run on 5273/5283/5293/5303/5313; align the local default with the worktree port slots.

- I22 (2026-09-17) Users/Roles admin handlers run only under the hybrid/production profiles and read XSUAA through UserManagement; the tenant filter on their db reads is in place but untested locally. Cover them in the two-tenant suite once a hybrid test binding exists (A12).
- I23 (2026-09-17) PilotFeedback carries a plain TenantId (stamped per tenant since A5) but not the aspect; align it with the other seven when the entity is next touched.

## Parked

(none)
