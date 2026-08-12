# Verified API matrix — probe runs on A4H and customer DEV (RD1)

| Run | System | Date | What it is |
|---|---|---|---|
| 1 | A4H client 001, `vhcala4hci` | 2026-08-12 | ABAP Platform appliance (no S4CORE) — our lab box |
| 2 | **RD1 client 100**, `aubls4hd01` | 2026-08-12 | **Customer DEV: S4CORE 108 SP03 = S/4HANA 2023 SP03**, SAP_UI 758 SP3, client role C (customizing) |

This document converts the design's marked UNCERTAINs into facts. Both
systems agree on every function-module verdict, which strongly suggests the
signatures are stable across the 758 basis line.

## Headline findings

### 1. The user×tcode aggregate EXISTS — on the customer system too

`SWNC_COLLECTOR_GET_AGGREGATES` carries `T USERTCODE TYPE SWNCAGGUSERTCODE`
on **both** systems. Per-user-per-tcode usage comes from full-period ST03N
aggregates; STAD (`SWNC_STAD_READ_STATRECS`, confirmed on both) is optional
fine detail only. The collector job is scheduled and finishing on both
systems (RD1: scheduled by DDIC), and `SWNCMONI`/`SWNCMONIINDEX` hold data.

**The Phase 1 extraction path is fully de-risked on the customer's own
system.** Remaining detail: the `SWNCAGGUSERTCODE` field list (client
dimension) — probe v2 section 4b answers it.

### 2. RD1 validates everything A4H couldn't

- **IAM app repository exists:** `/IAM/I_APPL` + `/IAM/I_APPL_T` — the
  backend-derived catalog design has its anchor tables.
- **601 `SAP_BR_*` business roles** are installed. Catalog derivation,
  role-implied correlation and role-copy activation all have real content
  to work against.
- The division of labour stands: A4H validates mechanics (extraction, PFCG,
  CTS, ICF, STC, transport of the add-on itself); **RD1 is where catalog
  derivation and content work get validated.**

### 3. Business role menus are AGR_HIER-only

For all three sampled `SAP_BR_*` roles the probe printed **zero
`AGR_TCODES` rows** — SAP business role menus carry no transaction codes at
all; the menu is entirely `AGR_HIER` nodes (54 for `SAP_BR_AA_ACCOUNTANT`),
i.e. business-catalog references.

Design consequences:
- `ROLE_IMPLIED` correlation runs via `AGR_HIER` (+ `AGR_HIERT` texts,
  `AGR_BUFFI` URLs) → catalog → app; `PRGN_READ_ROLE_MENU` returns exactly
  those tables and is the supported read path.
- The tcode side of "role grants tcode T" comes from `AGR_1251`
  (`S_TCODE` auth values), never from `AGR_TCODES`, for SAP_BR roles.
- Next manual step (30 min on RD1): SE16 one `AGR_HIER` row of
  `SAP_BR_AA_ACCOUNTANT` to record the node-type and catalog-id columns.

### 4. `FDM%` table hits are a false positive

RD1's 63 `FDM%` tables are **FSCM Financial Dispute/Collections Management**
(`FDM_COLL_*`, `FDM_AR_*`) — unrelated to Fiori spaces/pages. The spaces &
pages repository lives in `/UI2/ST*` / `/UI2/PG*` tables and is exposed via
the `FDM_*_SRV` OData services (service names, not table names). Probe v2
scans `/UI2/ST%` and `/UI2/PG%`; the service activation check remains a
`/IWFND/MAINT_SERVICE` follow-up on RD1.

### 5. ICF deactivation: the whole FM family is missing

`HTTP_DEACTIVATE_NODE`, `HTTP_DEACTIVATE_NODES`, `HTTP_ACTIVATE_NODES`,
`HTTP_UPDATE_NODE` — all MISSING on both systems. Only `HTTP_ACTIVATE_NODE`
exists. Verdict:

- `ICF_ACTIVATE` steps stay **`REVERSIBLE = false`** until the `CL_ICF_TREE`
  deactivation method route is verified (read SICF's own where-used in RD1).
- This is acceptable: deactivating an ICF node is a low-value rollback
  anyway (an active-but-unused node is harmless; the audit trail records it).

### 6. User master comparison

`PFCG_TIME_DEPENDENCY` missing on both; `PRGN_UPDATE_DATABASE` and
`SUSR_USER_BUFFER_AFTER_CHANGE` exist on RD1. Working assumption:
`BAPI_USER_ACTGROUPS_ASSIGN` + `PRGN_UPDATE_DATABASE`, with
`SUBMIT RHAUTUPD_NEW` as the bulk/scheduled fallback. Confirm via ST05/where-
used when building `ZCL_ADO_ACT_USER_ASSIGN`.

## Function-module verdicts (identical on A4H and RD1)

| API | Verdict | Notes for implementation |
|---|---|---|
| `SWNC_COLLECTOR_GET_AGGREGATES` | ✅ confirmed ×2 | Primary extraction API. Keys `COMPONENT`/`ASSIGNDSYS`/`PERIODTYPE`/`PERIODSTRT`; `SUMMARY_ONLY` for probes. Tables: `USERTCODE` (user×tcode), `TCDET` (transaction detail), `TASKTYPE` (GUI vs HTTP/RFC — the adoption trend metric), `TIMES`, `HITLIST_*`. Sole exception `NO_DATA_FOUND`. |
| `SWNC_GET_WORKLOAD_STATISTIC` | ✅ ×2 | Export-variant fallback; not needed. |
| `SAPWL_WORKLOAD_GET_STATISTIC` / `_GET_SUMMARY` | ✅ ×2 | Legacy; not needed. |
| `SWNC_STAD_READ_STATRECS` | ✅ ×2 | Optional detail; bounded window + client/user/tcode filters; `CHANGING ALL_STATS`. |
| `SAPWL_STATREC_*`, `SAPWL_READ_STATISTIC_FILES` | ✅ ×2 | Not needed. |
| `HTTP_ACTIVATE_NODE` | ✅ ×2 | `URL` or `NODEGUID`, `EXPAND`, `NO_COMMIT` — fits one-commit-per-step. |
| `HTTP_DEACTIVATE_NODE(S)` / `HTTP_ACTIVATE_NODES` / `HTTP_UPDATE_NODE` | ❌ ×2 | See headline 5 — `CL_ICF_TREE` route or irreversible. |
| `PRGN_RFC_CREATE_AGR_MULTIPLE` | ✅ ×2 | Role create/copy with `PARENT_ROLE`, `BAPIRET2`, `REQUEST`/`NEW_REQUEST` TRKORR — CTS built in. |
| `PRGN_RFC_CREATE_ACTIVITY_GROUP` | ✅ ×2 | Role + menu (`T TCODES`, `HIERARCHY_NODES`!) + profile in one call, TRKORR in/out. `HIERARCHY_NODES TYPE SMENSAPNEW` is the likely write path for catalog menu nodes — verify on RD1. |
| `PRGN_READ_ROLE_MENU` | ✅ ×2 | Returns `AGR_HIER`/`AGR_HIERT`/`AGR_TCODES`/`AGR_BUFFI` — the supported role-menu read. |
| `PRGN_AUTO_GENERATE_PROFILE_NEW` | ✅ ×2 | Profile generation, TRKORR, granular exceptions. |
| `BAPI_USER_ACTGROUPS_ASSIGN` | ✅ ×2 | User↔role assignment. |
| `PFCG_TIME_DEPENDENCY` | ❌ ×2 | Use `PRGN_UPDATE_DATABASE` (✅ RD1) / `SUSR_USER_BUFFER_AFTER_CHANGE` (✅ RD1) / `SUBMIT RHAUTUPD_NEW`. |
| `TR_INSERT_NEW_COMM` / `TRINT_INSERT_NEW_COMM` | ✅ ×2 | Incl. `IV_SIMULATION`. |
| `TR_APPEND_TO_COMM_OBJS_KEYS` / `TR_OBJECTS_CHECK` / `TR_READ_COMM` | ✅ ×2 | Append + appendability pre-check + read-back. |
| `TR_RELEASE_REQUEST` / `TRINT_RELEASE_REQUEST` | ✅ ×2 | `IV_AS_BACKGROUND_JOB`, `IV_SIMULATION`, TRINT message tables. Poll `E070-TRSTATUS`. |
| `STC_TM_GET_SCENARIO_LIST` + task-list read family | ✅ ×2 | Incl. `STC_EXT_CALLER_INFO`. Session create/start FMs still unprobed — v2 section 2 covers them. |

## Table inventory

| Area | A4H | RD1 | Verdict |
|---|---|---|---|
| `/UI2/*` | 201 | 201 | Launchpad framework present on both (incl. `/UI2/BROLEDEF`, CDM3). |
| IAM apps | 0 | **2** (`/IAM/I_APPL`, `/IAM/I_APPL_T`) | Backend catalog anchor confirmed on RD1. |
| `FDM%` | 0 | 63 — **false positive** (FSCM dispute mgmt) | Spaces/pages live in `/UI2/ST*`/`/UI2/PG*`; v2 scans them. |
| `STC*` | 55 | 58 | Task manager present. |
| `ICFSERVICE` | ✅ | ✅ | Activation state column: v2 dumps the field list. |
| `SAP_BR_*` roles | 1 (demo) | **601** | Full business-role content on RD1. |

## Remaining opens → all funnel into probe v2 on RD1

Probe v2 (already committed) adds exactly the sections that close these:

1. **4b field lists** — `SWNCAGGUSERTCODE` (client dimension?),
   `SWNCAGGTCDET`, `ICFSERVICE` (activation-state column).
2. **4c STC scenario inventory** — lists Fiori/Gateway/UI2 scenarios
   programmatically via the confirmed `STC_TM_GET_SCENARIO_LIST`; settles the
   task-list names (`SAP_FIORI_CONTENT_ACTIVATION` etc.).
3. **`/UI2/ST%` + `/UI2/PG%` + `/UI2/TM%`** — the real spaces/pages and
   target-mapping tables.
4. **STC session lifecycle FMs** (`STC_TM_SESSION_BEGIN/START/RESUME/...`).

Manual items that stay manual (on RD1): ST03N retention setting; one
`AGR_HIER` row inspected in SE16; `/UI2/FLIA` on one WEBGUI target mapping
(`sap-ui2-tcode` spelling); `FDM_*_SRV` activation state in
`/IWFND/MAINT_SERVICE`; ST01 trace for the `ZADO_BR_READER` authorization
list.

> **Action:** run probe v2 (current `abap/src/core/zado_probe_apis.prog.abap`)
> on RD1 — the run 2 output above came from the earlier version and lacks
> sections 4b/4c.
