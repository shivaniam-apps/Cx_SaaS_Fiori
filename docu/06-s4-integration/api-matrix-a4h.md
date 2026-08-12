# Verified API matrix — A4H probe run, 2026-08-12

Source: `ZADO_PROBE_APIS` output on A4H client 001 (SAP_BASIS 758, SAP_UI 758
SP2, SAP_GWFND 758, UIBAS001 758). This document converts the design's marked
UNCERTAINs into facts for this system. Re-run the probe on the customer's
systems before trusting release-specific rows there.

## Headline findings

### 1. The user×tcode aggregate EXISTS — STAD demoted to optional

`SWNC_COLLECTOR_GET_AGGREGATES` carries `T USERTCODE TYPE SWNCAGGUSERTCODE`.
That is the combined **user × transaction** aggregate, straight from the
ST03N collector. Consequences:

- `ZADO_USG_USER`/`UserTransactionUsage` fills from ST03N aggregates —
  full-period coverage, not samples.
- STAD (`SWNC_STAD_READ_STATRECS`, confirmed, with `READ_TCODE`/`READ_CLIENT`
  filters) becomes an *optional* fine-detail source, no longer the fallback
  the product depends on. The "sample, not census" labelling requirement now
  applies only to STAD-derived numbers, which may never ship.
- Remaining check: inspect structure `SWNCAGGUSERTCODE` in SE11 for the
  client/account field to answer the client-dimension question.

### 2. Collector is running, aggregates exist

`SAP_COLLECTOR_FOR_PERFMONITOR` scheduled and finishing (status F), and
`SWNCMONI`/`SWNCMONIINDEX` both exist with rows. The
`ZADO_C_ST03_PERIODS` design (enumerate periods from `SWNCMONIINDEX`) is
viable as designed.

### 3. A4H is an ABAP Platform box — NOT a full S/4HANA

No `S4CORE` component row came back, `%IAM%APP%` matched **0** tables,
`FDM%` matched **0** tables, and exactly **one** `SAP_BR_*` role exists
(`SAP_BR_ADMINISTRATOR_DANA`, demo content). Client 001 role is `D` (demo).

**What A4H can validate:** usage extraction (SWNC/STAD), PFCG role machinery,
CTS, ICF activation, STC task lists, the whole CAP↔OData V4 transport path.

**What A4H cannot validate:** catalog derivation (business catalogs, IAM
apps, target mappings), spaces/pages via `FDM_*` services, `SAP_BR_*` menu
reverse-engineering, and content activation. Those need a real S/4HANA 2023
stack — the customer's sandbox/DEV, or an SAP CAL "S/4HANA 2023 fully
activated appliance".

> Planning impact: Phase 1 (extract → show) proceeds on A4H unchanged.
> Phase 2 catalog derivation and everything in Phase 3 need the S/4 system
> lined up — raise with the customer early (added to the open-questions list).

## Function-module verdicts

| API | Verdict | Notes for implementation |
|---|---|---|
| `SWNC_COLLECTOR_GET_AGGREGATES` | ✅ confirmed | Primary extraction API. Keys: `COMPONENT`, `ASSIGNDSYS`, `PERIODTYPE`, `PERIODSTRT`; use `SUMMARY_ONLY` for probes. Tables of interest: `USERTCODE` (user×tcode), `TCDET` (transaction detail), `TASKTYPE` (GUI vs HTTP/RFC adoption metric), `TIMES`, `MEMORY`, `HITLIST_*`. |
| `SWNC_GET_WORKLOAD_STATISTIC` | ✅ exists | Export-parameter variant (`SWNCGL_T_*` types); keep as documented fallback only. |
| `SAPWL_WORKLOAD_GET_STATISTIC` / `_GET_SUMMARY` | ✅ exist | Legacy family present on 758; not needed. |
| `SWNC_STAD_READ_STATRECS` | ✅ confirmed | Optional detail source. Bounded window via `READ_START_DATE/TIME` + `READ_TIME`; filters for client/user/tcode; `CHANGING ALL_STATS TYPE STAD_ALLSTATS`. |
| `SAPWL_STATREC_*` / `SAPWL_READ_STATISTIC_FILES` | ✅ exist | Not needed given the above. |
| `HTTP_ACTIVATE_NODE` | ✅ confirmed | `URL` or `NODEGUID` (+`EXPAND`), `NO_COMMIT` flag fits the one-commit-per-step engine. |
| `HTTP_DEACTIVATE_NODE` | ❌ **missing** | Rollback path for `ICF_ACTIVATE` must use another route — probe next: `HTTP_DEACTIVATE_NODES` (plural) and the `CL_ICF_TREE` / `IF_ICF_TREE` deactivation methods. Until confirmed, `ICF_ACTIVATE` steps are `REVERSIBLE = false`. |
| `PRGN_RFC_CREATE_AGR_MULTIPLE` | ✅ confirmed | Role create/copy (`PARENT_ROLE` for derived), returns `BAPIRET2`, accepts/returns a `TRKORR` — **CTS integration is built into the PFCG APIs**, which simplifies `ZCL_ADO_CTS`. |
| `PRGN_RFC_CREATE_ACTIVITY_GROUP` | ✅ confirmed | Role + tcode menu + profile in one call (`T TCODES`, `PROFILE_NAME`, `REQUEST`). |
| `PRGN_READ_ROLE_MENU` | ✅ confirmed | Returns `AGR_HIER` nodes, `AGR_TCODES`, `AGR_HIERT` texts and `AGR_BUFFI` URLs — the read side of role menus is fully covered. |
| `PRGN_AUTO_GENERATE_PROFILE_NEW` | ✅ confirmed | Profile generation with `REQUEST` (TRKORR) and granular auth exceptions. |
| `BAPI_USER_ACTGROUPS_ASSIGN` | ✅ confirmed | User↔role assignment. |
| `PFCG_TIME_DEPENDENCY` | ❌ **missing** | User master comparison: `SUBMIT` report `RHAUTUPD_NEW` in a background job instead (as ST01/where-used will confirm), or probe `PRGN_*` compare candidates next run. |
| `TR_INSERT_NEW_COMM` / `TRINT_INSERT_NEW_COMM` | ✅ confirmed | Full signatures captured, including `IV_SIMULATION` — dry-run support exists at the CTS layer itself. |
| `TR_APPEND_TO_COMM_OBJS_KEYS` / `TR_OBJECTS_CHECK` / `TR_READ_COMM` | ✅ confirmed | Object append + lockability pre-check (`WE_OBJECTS_APPENDABLE`) + read-back. |
| `TR_RELEASE_REQUEST` / `TRINT_RELEASE_REQUEST` | ✅ confirmed | Both present; `IV_AS_BACKGROUND_JOB`, `IV_SIMULATION`, and (TRINT) `ET_MESSAGES`/`ET_STATUS_MSGS`. Poll `E070-TRSTATUS` after release as designed. |
| `STC_TM_GET_SCENARIO_LIST` / `SCENARIO_GET_TASKLIST` / `SCENARIO_GET_PARAMETERS` / `GET_TEMPLATE_LIST` / `GET_SESSION_LIST` | ✅ all confirmed | Read/monitor side of task lists complete, incl. `STC_EXT_CALLER_INFO` (external-caller support is first-class). **Still missing: the create/start FMs** — probe `STC_TM_SESSION_BEGIN`, `STC_TM_SESSION_START`, `STC_TM_SESSION_GET_STATUS`, `STC_TM_SESSION_RESUME` next run. |

## Table inventory verdicts

| Area | Verdict |
|---|---|
| `/UI2/*` | 201 tables — launchpad framework present (incl. `/UI2/BROLEDEF`, CDM3 tables). Next probe: targeted `/UI2/ST%` and `/UI2/PG%` patterns for the spaces/pages tables. |
| IAM app tables | Absent on A4H (no S4CORE). Verify on a real S/4 2023. |
| `FDM*` | Absent on A4H. Spaces/pages repository validation deferred to a real S/4. |
| `STC*` | 55 tables present. |
| `ICFSERVICE` | Present; `ICFACTIVE` is not a table (activation state lives inside `ICFSERVICE` — confirm the column in SE11). |

## Still open (carried into the next probe run / manual list)

1. `SWNCAGGUSERTCODE` field list (client dimension, entry-id decomposition).
2. ICF deactivation API (`HTTP_DEACTIVATE_NODES`, `CL_ICF_TREE`).
3. STC session create/start FM family.
4. User master comparison route (`RHAUTUPD_NEW` submit).
5. ST03N retention settings (manual, ST03N → Collector & Perf. DB).
6. Everything catalog/content-related — **requires a real S/4HANA 2023 system.**
7. STC01 scenario names for the Fiori task lists — the read FMs are confirmed,
   so the next probe version lists scenarios programmatically.
