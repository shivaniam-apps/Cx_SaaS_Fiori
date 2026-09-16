# Scheduling — tracker

Worktree `Cx_SaaS_Fiori.worktrees/scheduling` · CAP 4124 · client 5293 · owns S items
(background tasks, S/4 adapters, activation engine, ABAP mirror `abap/src`).
ABAP changes start in `../a4h_2023_zado`, are smoke-tested on RD1 DEV/100, then mirrored
wholesale into `abap/src`. Format: see [program-tracker.md](../program-tracker.md).

## In progress

- [~] S2 ObjectKeyJson contract alignment planner <-> ABAP (ICF, role, transport keys), shared fixture for activation-plan.test.js and zado_activate_smoke — branch feat/activation-key-contract, started 2026-09-16

## To-do (critical path first)

- [ ] S1 Connection check covers the activation service: wire probeActivateService into checkTargetSystemConnection / getBackendCapabilities, per-endpoint verdicts on Target Systems page
- [ ] S3 Implement ABAP step types returning not_implemented (ACTIVATE_ODATA_SERVICE, CREATE_SPACE, CREATE_PAGE, ASSIGN_PAGE_TO_SPACE, ADD_SPACE_TO_ROLE, ASSIGN_BUSINESS_CATALOG, ADD_CATALOG_TO_ROLE) + transport-append step; verify-first / verify-after / one commit per step — XL, needs RD1 DEV/100
- [ ] S4 Live simulation: ZADO read-side state probe so simulate reports existsAlready from the real system
- [ ] S5 Operator skip and rollback actions (skipActivationStep, rollbackActivationStep); ICF stays audit-only
- [ ] S6 Forward topUsersPerTcode / minExecutions to ABAP (CDS parameters on ZADO_C_USER_TX_USAGE)
- [ ] S7 ABAP snapshot collector: ZADO_CFG, ZADO_RUN, ZADO_AUDIT, snapshot tables, background job; CAP reads snapshots instead of live ST03N — XL
- [ ] S8 Roles/users readers (AGR_*, USR02) filling UserInventory, RoleInventory, RoleUsers, RoleTransactions; roles/Fiori rollups
- [ ] S9 Catalog derivation: ZADO_CATALOG package + CATALOG_DERIVATION task handler writing BackendCatalogApps / BackendLaunchpadContent (after PO-1)
- [ ] S10 Transport QA/PROD verification reads behind the manifest; import status on TransportRequests

## Accomplished

- [x] ABAP mirror brought to parity with a4h_2023_zado main (DEV-only activation write unit, RAP OData V4 write service, RFC function group) — PR #5, 2026-09-15
- [x] ST03 reader fixes from the RD1 export run (top-users 0 = unlimited, truncated-tcode aggregation, control bytes in JSON) — PR #4, 2026-09-15

## Daily log

### 2026-09-16
- Survey result to keep in mind: the planner emits seven step types the ABAP dispatcher hard-fails, so a live run stops at step 2 until S3 lands; S2 is the cheap, high-value precursor.
