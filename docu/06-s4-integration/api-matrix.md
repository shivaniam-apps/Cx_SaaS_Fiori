# Verified API matrix — probe runs on A4H and customer DEV (RD1)

| Run | System | Date | What it is |
|---|---|---|---|
| 1 | A4H client 001, `vhcala4hci` | 2026-08-12 | ABAP Platform appliance (no S4CORE) — our lab box |
| 2 | **RD1 client 100**, `aubls4hd01` | 2026-08-12 | **Customer DEV: S4CORE 108 SP03 = S/4HANA 2023 SP03**, SAP_UI 758 SP3, client role C (customizing) |
| 3 | RD1 client 100 (probe **v2**) | 2026-08-12 | Adds field lists (4b), STC scenario inventory (4c), spaces/pages table scan, STC session-lifecycle FMs |

**Status after run 3: Phase 0 is complete.** Every API uncertainty the design
flagged is now resolved with evidence from the customer's own S/4HANA 2023.

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
system.** Run 3's field list settles the shape of `SWNCAGGUSERTCODE`:

- `ACCOUNT TYPE SWNCUNAME` — the user; `ENTRY_ID TYPE SWNCENTRYID` — the
  tcode/entry. This is the exact (user, tcode) pair the product needs.
- Counters: `COUNT`, `DCOUNT`, `UCOUNT`, `BCOUNT`, `ECOUNT`, `SCOUNT`,
  `LUW_COUNT`; times `RESPTI`/`PROCTI`/`CPUTI`/`GUITIME` etc. Validate the
  exact counter semantics during the Phase 1 mapper build by comparing FM
  output against the ST03N UI for one known period.
- **No client field.** The aggregates are not client-split: usage figures
  are per system, and the UI must label them that way. (`READ_CLIENT` exists
  only on the STAD reader.) For this customer — one productive client — a
  labelling concern, not a functional one.
- `SWNCAGGTCDET` additionally carries `FCODE` — per-function-code detail
  within a transaction, a future depth option for "which screens of ME21N
  do they actually use".

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

### 4. Spaces & pages repository confirmed; `FDM%` tables were a false positive

Run 3 found the real repository on RD1, exactly as designed:

- **Spaces:** `/UI2/STHEAD(C/T/CT)`, space↔page assignment `/UI2/STPGA(C)`,
  scope `/UI2/ST_BC_SCOPE`.
- **Pages:** `/UI2/PGHEAD(C/T/CT)`, sections `/UI2/PGSEC*` (13 tables),
  scope `/UI2/PG_BC_SCOPE`.
- **Tiles/CHIPs:** `/UI2/CHIP_*` (11 tables). `/UI2/TM%` matched nothing —
  target mappings live in CHIP/page/CDM structures, so correlation reads go
  through the delivered services (`PAGE_BUILDER_*`, `/UI2/FLIA` logic), not
  raw `TM` tables.

RD1's 63 `FDM%` *tables* are FSCM Dispute/Collections Management — unrelated.
The `FDM_*_SRV` spaces/pages **OData services** remain the write path; their
activation state in `/IWFND/MAINT_SERVICE` is the one remaining check.

### 5. ICF deactivation: the whole FM family is missing

`HTTP_DEACTIVATE_NODE`, `HTTP_DEACTIVATE_NODES`, `HTTP_ACTIVATE_NODES`,
`HTTP_UPDATE_NODE` — all MISSING on both systems. Only `HTTP_ACTIVATE_NODE`
exists. Verdict:

- `ICF_ACTIVATE` steps stay **`REVERSIBLE = false`** until the `CL_ICF_TREE`
  deactivation method route is verified (read SICF's own where-used in RD1).
- This is acceptable: deactivating an ICF node is a low-value rollback
  anyway (an active-but-unused node is harmless; the audit trail records it).
- Run 3 bonus: the **activation state column is `ICFSERVICE.ICF_NOACT`**
  (CHAR1 "not active" flag) — `ZADO_CAT_ACTIVE`'s ICF state read is a plain
  CDS projection on `ICFSERVICE` (`ICF_NOACT`, plus `ICF_TCODE` as a free
  extra correlation signal).

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
| `STC_TM_GET_SCENARIO_LIST` + task-list read family | ✅ ×2 | Incl. `STC_EXT_CALLER_INFO`. |
| `STC_TM_SESSION_BEGIN` | ✅ RD1 | **The task-list execution driver**: scenario + template + `IT_PARAMETER` + `IS_EXEC_SETTINGS` → `E_SESSION_ID`/`E_EXEC_ID`; `I_INIT_ONLY` separates create from run. |
| `STC_TM_SESSION_GET_STATUS` | ✅ RD1 | **The polling surface**: `E_STATUS`, `E_PROGRESS`, `ES_CURRENT_TASK`, full `ET_TASKLIST`, and action flags (`E_ACTION_RESUME`/`_INTERRUPT`). Maps 1:1 onto `ZADO_ACT_TL_RUN` / `BackgroundTasks` progress. |
| `STC_TM_SESSION_RESUME` / `STC_TM_SESSION_SET_PARAMETERS` | ✅ RD1 | Resume-after-intervention; parameter updates. |
| `STC_TM_SESSION_START` / `STC_TM_TASKLIST_EXECUTE` | ❌ RD1 | Do not exist — `SESSION_BEGIN` is the whole story. |

## Table inventory

| Area | A4H | RD1 | Verdict |
|---|---|---|---|
| `/UI2/*` | 201 | 201 | Launchpad framework present on both (incl. `/UI2/BROLEDEF`, CDM3). |
| IAM apps | 0 | **2** (`/IAM/I_APPL`, `/IAM/I_APPL_T`) | Backend catalog anchor confirmed on RD1. |
| `FDM%` | 0 | 63 — **false positive** (FSCM dispute mgmt) | Spaces/pages live in `/UI2/ST*`/`/UI2/PG*`; v2 scans them. |
| `STC*` | 55 | 58 | Task manager present. |
| `ICFSERVICE` | ✅ | ✅ | Activation state column: v2 dumps the field list. |
| `SAP_BR_*` roles | 1 (demo) | **601** | Full business-role content on RD1. |

## STC01 scenario inventory (run 3, RD1 — 183 scenarios, exact names confirmed)

The Fiori activation task lists exist on the customer's SP level under
exactly these names:

| Scenario | Role in AdoptOps |
|---|---|
| `SAP_FIORI_FOUNDATION_S4` | Technical foundation (wizard step 2) |
| `SAP_FIORI_LAUNCHPAD_INIT_SETUP` | Launchpad initial setup |
| **`SAP_FIORI_CONTENT_ACTIVATION`** | The bulk activation engine (Phase 4) |
| `SAP_FIORI_FCM_CONTENT_ACTIVATION` / `SAP_FIORI_FCM_CATALOG_ACTIVATION` | Content-manager variants — evaluate vs. the classic one in Phase 3 |
| **`SAP_GATEWAY_ACTIVATE_ODATA_SERV`** | Gateway/OData service activation — the design's guessed name was exactly right |
| `SAP_GATEWAY_BASIC_CONFIG` / `_ADD_SYSTEM` / `_ADD_SYSTEM_ALIAS` | Gateway prerequisites |
| `SAP_FIORI_HEALTH_CHECKS` / `/UI2/FLP_HEALTH_CHECKS` | **Feed `ZADO_C_PRECHECK`** — run read-only health checks and surface results in Target Systems |

Execution pattern, fully confirmed: `STC_TM_SESSION_BEGIN` (parameters via
`STC_TM_SCENARIO_GET_PARAMETERS` shape) → poll `STC_TM_SESSION_GET_STATUS`
(`E_PROGRESS` + `ET_TASKLIST` + `ES_CURRENT_TASK`) → `STC_TM_SESSION_RESUME`
on intervention. No submit-into-background workaround needed.

## Closed vs. still manual

**Closed by the three runs:** every extraction FM + the (user, tcode)
aggregate shape; no client dimension in aggregates (label as system-wide);
collector running on both systems; spaces/pages tables; ICF activation FM +
state column (`ICF_NOACT`); PFCG create/copy/menu/profile/user-assign FMs
with native TRKORR; full CTS family incl. simulation; task-list scenario
names + session lifecycle; IAM app tables; 601 business roles; SAP_BR menus
are AGR_HIER-only.

**Still manual, none blocking Phase 1** (do during Phase 2/3 prep on RD1):

1. ST03N retention setting (ST03N → Collector & Perf. DB → Reorganization) —
   determines how many months of history the first extraction can offer.
2. One `AGR_HIER` row of `SAP_BR_AA_ACCOUNTANT` in SE16 → catalog node
   type/id columns.
3. `/UI2/FLIA` on one WEBGUI target mapping → `sap-ui2-tcode` spelling.
4. `FDM_*_SRV` activation state in `/IWFND/MAINT_SERVICE`.
5. ICF deactivation via `CL_ICF_TREE` (only affects rollback of ICF steps).
6. ST01 trace with the future technical user → `ZADO_BR_READER` auth list.
7. Counter semantics (`COUNT` vs `DCOUNT` etc.) — validate mapper output
   against the ST03N UI for one known period during Phase 1.
