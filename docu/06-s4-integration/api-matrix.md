# Verified API matrix — probe runs on A4H and customer DEV (RD1)

| Run | System | Date | What it is |
|---|---|---|---|
| 1 | A4H client 001, `vhcala4hci` | 2026-08-12 | ABAP Platform appliance (no S4CORE) — our lab box |
| 2 | **RD1 client 100**, `aubls4hd01` | 2026-08-12 | **Customer DEV: S4CORE 108 SP03 = S/4HANA 2023 SP03**, SAP_UI 758 SP3, client role C (customizing) |
| 3 | RD1 client 100 (probe **v2**) | 2026-08-12 | Adds field lists (4b), STC scenario inventory (4c), spaces/pages table scan, STC session-lifecycle FMs |
| 7 | **RD1 client 100** (probe round 4) | 2026-09-18 | Entity methods and header types of the space / page API, `CL_PFCG_MENU_MODIFY` as the role-menu writer, Fiori id of a target mapping; the S3 part 2 executors are built on it. |
| 6 | **RD1 client 100** (probe round 3) | 2026-09-18 | Interface methods of the space / page API, PFCG node writers, service nodes resolved through `USOBHASH`; corrects run 5: the customizing layer holds 340 spaces / 529 pages. |
| 5 | **RD1 client 100** (probe round 2 / 2b) | 2026-09-18 | Signatures and tables behind run 4; corrects the client-400 reading of the empty space / page tables. |
| 4 | **RD1 client 400** (`ZADO_PROBE_ACTIVATION`, `ZADO_PROBE_CATALOG`) | 2026-09-18 | S3 part 2 and S9 part 2 inputs; raw output in [probe-activation-rd1-400-2026-09-18.txt](probe-activation-rd1-400-2026-09-18.txt) and [docu/08 probe-catalog-rd1-400-2026-09-18.txt](../08-catalog-and-proposals/probe-catalog-rd1-400-2026-09-18.txt). Client 400 = unit-test client. Run 5 showed the empty space / page tables are a system-wide fact (no client column), only roles, alias assignments and the customizing layer differ per client. |

**Status after run 3: Phase 0 is complete.** Every API uncertainty the design
flagged is now resolved with evidence from the customer's own S/4HANA 2023.

This document converts the design's marked UNCERTAINs into facts. Both
systems agree on every function-module verdict, which strongly suggests the
signatures are stable across the 758 basis line.

## Run 7 findings (2026-09-18, RD1/100, probe round 4) - the executors' API

Raw output: [probe-activation-rd1-100-round4-2026-09-18.txt](probe-activation-rd1-100-round4-2026-09-18.txt),
[docu/08 probe-catalog-rd1-100-round4-2026-09-18.txt](../08-catalog-and-proposals/probe-catalog-rd1-100-round4-2026-09-18.txt).

Product owner, same day: RD1 users see **spaces** in the launchpad. `/UI2/FLPRT`
(CLASSIC active) is therefore no indicator of spaces vs groups and
`/UI2/FLPRTC` / `/UI2/FLPRTSC` are empty; idea I53 is closed - the plan's
space / page steps are right for this system. 30 of the 340 customizing
spaces are customer spaces (`ZSS_*`), none has a master space.

1. **Space / page entities.** `/UI2/IF_FDM_SPACE`: `ASSIGN_PAGE( IV_ID,
   IV_INDEX )`, `UNASSIGN_PAGE`, `MOVE_PAGE`, `SET_PAGE_VISIBILITY`,
   `ASSIGN_TO_TRANSPORT( IV_TRKORR )`, `UPDATE_TITLE / _DESCRIPTION /
   _SORT_PRIORITY`, `GET_PAGE_IDS`, `LOCK` / `UNLOCK`.
   `/UI2/IF_FDM_PAGE`: `ADD_SECTION( IS_HEADER TYPE
   /UI2/IF_FDM_PAGE_SECTION=>TS_HEADER, IV_INDEX, IV_LANGU -> RO_SECTION )`,
   `REMOVE_SECTION`, `GET_STRUCTURE`, `ASSIGN_TO_TRANSPORT`. Tiles are methods
   of `/UI2/IF_FDM_PAGE_SECTION` (round 5).
   `TS_HEADER` (space) = `ID` C35, `TITLE` C100, `DESCRIPTION` C100, `BASE_ID`,
   `MERGE_ID`, `SORT_PRIORITY`; page alike without the priority.
2. **Scope and transport mode.** `/UI2/IF_FDM=>GC_SCOPE`: `CONF` / `CUST`
   (the executors use `-CUSTOMIZATION`); transport modes `E` / `P` - the
   executors read the API's current mode and hand it back with the plan's
   request instead of guessing. Customizing content is recorded as
   `R3TR UIPC / UISC <id>` (E071, no E071K keys).
3. **Role menu writer = `CL_PFCG_MENU_MODIFY`** (headless):
   `RETRIEVE_FOR_UPDATE( IV_ROLE -> ER_ROLE, ET_RETURN )`,
   `MENU_ADD_APPLICATION_GROUP( IV_URL, IV_URL_TYPE, IV_NODE_TEXT,
   IV_TARGET_ID, IV_CALCULATE_APPS, IT_APPL_FOR_GROUP -> EV_NEW_OBJECT_ID,
   ET_RETURN )`, `MENU_ADD_SERVICE( IS_SERVICE TYPE USOBHASH )`,
   `MENU_ADD_URL`, `MENU_ADD_FOLDER`, `MENU_DELETE_NODE`, `SAVE( -> ET_RETURN,
   EV_REJECTED )`, `CANCEL`, `ROLE_ADD_TO_REQUEST( CV_REQUEST, IV_NO_DIALOG )`.
   URL types = `/UI2/IF_FDM=>GC_PROVIDER`: `CAT_PROVIDER`, `GROUP_PROVIDER`,
   `SPACE_PROVIDER`. Read side: `/UI2/CL_PFCG_UTILS`
   (`GET_SPACE_FOR_ROLES`, `GET_CATALOGS_GROUPS_FOR_ROLES`,
   `GET_ROLES_N_DESCR_FOR_CATALOG`). `/UI2/CL_FDM_PFCG_ROLE_API` is read-only.
4. **Fiori id of a target mapping:** the TM default parameter
   `sap-fiori-id` (`/UI2/IF_FDM=>GC_SEMANTIC_PARAMETER_NAME`), and for SAPUI5
   apps the `TCODE` column of `/UI2/PB_C_TM` (see docu/08 round 4).

**What was built from it (S3 part 2):** `ZCL_ADO_ACT_ODATA` (gateway API,
verify on `/IWFND/I_MED_SRH`), `ZCL_ADO_ACT_SPACE` (create space / page,
assign page; customizing scope; verify `EXISTS_*` and `/UI2/STPGAC`),
`ZCL_ADO_ACT_MENU` (catalog / space node; verify `AGR_BUFFI`). The dispatcher
calls them **dynamically**: a system without one of these APIs loses that
step type only (idea I58, portability). Requests are customizing requests by
default (`ZADO_CFG TRANSPORT_KIND = K` switches back to workbench).

## Round 5 addendum (2026-09-18, RD1/100, section "3e")

- **Transport modes:** `E` = *External* (the caller supplies the request),
  `P` = *Transport Popup*. The space / page executor therefore sets `E`
  with the plan's request (a4h fix `fix/space-transport-mode-external`);
  handing back the API's current mode could have been the popup.
- **Launchpad customizing sits on customizing requests:** E070 of the
  requests carrying `R3TR UISC / UIPC`: `TRFUNCTION = W`, `KORRDEV = CUST` -
  confirms the customizing request default (idea I62, launchpad part).
- **Sections:** `/UI2/IF_FDM_PAGE_SECTION=>TS_HEADER` = `ID` C35, `TITLE` C100;
  the interface offers `GET_ITEM`, `MOVE_ITEM`, `REMOVE_ITEM`,
  `ADD_CHILD_SECTION` but **no add-tile method**; `/UI2/IF_FDM_PAGE_SECTION_TILE`
  has `UPDATE_TARGET_MAPPING( IV_TM_CATALOG_ID, IV_TM_CATALOG_TYPE, IV_TM_ID )`
  and `UPDATE_TILE_DISPLAY_FORMAT`. The writer sits in a comprised interface
  or the implementing class - probe round 6 (section "3f") follows SEOMETAREL.
- First activation of the S3 part 2 classes on RD1: no syntax errors.

## Run 6 findings (2026-09-18, RD1/100, probe round 3)

Raw output: [probe-activation-rd1-100-round3-2026-09-18.txt](probe-activation-rd1-100-round3-2026-09-18.txt),
[docu/08 probe-catalog-rd1-100-round3-2026-09-18.txt](../08-catalog-and-proposals/probe-catalog-rd1-100-round3-2026-09-18.txt).

**Correction to run 5:** RD1 does have spaces and pages - in the
**customizing layer** of client 100: `/UI2/STHEADC` 340 rows, `/UI2/PGHEADC`
529, `/UI2/STPGAC` 535 (object types `UISC` / `UIPC`, client-dependent,
customizing request). Only the cross-client template layer (`/UI2/STHEAD`,
`UIST` / `UIPG`) is empty. The executors therefore write in the customizing
scope, which matches the write client (DEV/100) and the customizing request
the plan already carries. `/UI2/FLPRT` still reads CLASSIC active; round 4
reads the per-client override `/UI2/FLPRTC` before I53 is decided.

1. **Space / page API methods** (`/UI2/IF_FDM_SPACE_API`, `_PAGE_API`):
   `EXISTS_SPACE( IV_ID )` / `EXISTS_PAGE` = verify-first;
   `CREATE_SPACE( IS_HEADER TYPE /UI2/IF_FDM_SPACE=>TS_HEADER, IV_LANGU ->
   RO_SPACE TYPE /UI2/IF_FDM_SPACE )`, `CREATE_PAGE` alike; `GET_SPACE`,
   `DELETE_SPACE` (rollback), `COPY_SPACE_TO_CUSTOMIZING`,
   `GET_PAGE_STRUCTURE`. Before writing: `SET_SCOPE( IV_SCOPE TYPE
   /UI2/FDM_SCOPE )` and `SET_TRANSPORT_SETTINGS( IV_DEVCLASS,
   IV_TRANSPORT_MODE, IV_TRKORR )` - the plan TRKORR goes in here, no
   dialog. Exceptions: `/UI2/CX_FDM_AUTHORIZATION, _DUPLICATE, _INPUT_INVALID,
   _LOCKED, _NOT_FOUND, _TRANSPORT, _UNEXPECTED, _USER_ABORT`.
   **Page-to-space assignment, sections and tiles are not API methods**: they
   are methods of the returned entity (`/UI2/IF_FDM_SPACE`, `/UI2/IF_FDM_PAGE`).
   Round 4 lists those and the `TS_HEADER` components (RTTI).
2. **Task-list value row:** `STCTM_SX_VALUE` = `TASKNAME`, `LNR`,
   `FIELDNAME`, `VALUE` (for the record; OData activation does not use it).
3. **PFCG node writers:** `/UI2/SPACE_PFCG_CREATE / _CHANGE / _EXECUTE` and
   `/UI2/CAT_PROV_PFCG_PAGES_*` are the PFCG **dialog exits** of the node
   types (export `URL` + `SHORT_TEXT`, exception `ACTION_CANCELLED`) - not
   headless writers. `PRGN_RFC_ADD_TRANSACTION` adds transactions only.
   Candidates listed for round 4: `/UI2/CL_FDM_PFCG_ROLE_API`,
   `/UI2/CL_FDM_PUB_PFCG_ROLE_API`, `CL_PFCG_MENU_MODIFY`,
   `CL_PFCG_MENU_TOOLS`, `PRGN_STRU_LOAD_NODES` / `PRGN_STRU_SAVE_NODES`.
4. **The node shape to reproduce** (`ZFIORI_MASTER_DEV_ROLE`): folder node
   with `AGR_BUFFI.URL = X-SAP-UI2-CATALOGPAGE:<catalog>?AUTH_DEFAULTS=X&DEST_FES=`,
   child nodes `REPORTTYPE = OT`, `REPORT = SERVICE`, URL
   `OTSERVICE` + 13 blanks + 30-character name + 2-character type; groups as
   `sap-ui2-group:<group>`. No `AGR_TCODES` rows.
5. **Service nodes name the OData services.** Type `HT` = the 30-character
   name is `USOBHASH-NAME`; `USOBHASH` resolves it to `R3TR IWSV <service
   padded to 36><version>`, `R3TR IWSG <service group>_<version>` or
   `R3TR G4BA <V4 service group>` (node text in `AGR_HIERT` repeats it).
   Type `TR` = a transaction-type SU22 name, which for Fiori apps is the
   Fiori id (`F1873`). So the services of a **catalog folder** are readable
   from the role menu; they hang on the catalog, not on a single app.
   `/IWFND/I_MED_SRH` confirms the pairing: `SERVICE_NAME = SD_F1873_SO_WL_SRV`,
   `SERVICE_VERSION = 0001`, `OBJECT_NAME = ZFTSD_F1873_SO_WL_SRV` (the IWSG
   name), `IS_ACTIVE = A`.

## Run 5 findings (2026-09-18, RD1/100, probe round 2)

Raw output: [probe-activation-rd1-100-round2-2026-09-18.txt](probe-activation-rd1-100-round2-2026-09-18.txt),
[docu/08 probe-catalog-rd1-100-round2-2026-09-18.txt](../08-catalog-and-proposals/probe-catalog-rd1-100-round2-2026-09-18.txt).

**Correction to run 4:** spaces, pages and assignments are zero in client 100
as well. `/UI2/STHEAD`, `/UI2/STPGA`, `/UI2/PGHEAD` have no client column;
TADIR has no `UIST` / `UIPG` objects. RD1 has **no space or page templates**
(run 6: the customizing layer of client 100 does hold 340 spaces and 529
pages) and runs the **CLASSIC** launchpad runtime (`/UI2/FLPRT`: CLASSIC active,
RA_BASED inactive). Client-dependent are only the PFCG roles, the gateway
alias assignments (`/IWFND/C_MGDEAM`: 102 rows in client 100, 8 in 400) and
the customizing layer (`/UI2/STHEADC` ..., object types `UISC` / `UIPC`).

1. **OData activation goes through the gateway API, not the task list.**
   `STC_TM_SCENARIO_GET_PARAMETERS` returns 15 parameters for
   `SAP_GATEWAY_ACTIVATE_ODATA_SERV`, all of task
   `CL_STCT_SET_TRANSPORT_OPTIONS` (prefix, package, requests, client): the
   service selection is not a parameter. The executor uses
   `/IWFND/CL_MGW_ACTIVATION_API`: `GET_INSTANCE`, `IS_ACTIVE( IV_SERVICE_NAME,
   IV_SERVICE_VERSION -> EV_ACTIVE )` for verify-first / verify-after,
   `ACTIVATE_SERVICE( IV_SERVICE_NAME, IV_SERVICE_VERSION, IV_SYSTEM_ALIAS,
   IV_PACKAGE, IV_PREFIX, IV_TRANSPORT, IV_TRANSPORT_CUST, IV_SUPPRESS_DIALOG,
   IV_DO_ACTIVATE_ICF_NODE, IV_PROCESS_MODE -> EV_SRG_IDENTIFIER,
   EV_TECH_SERVICE_NAME )`, `CHECK_ICF_NODE`. The simple FM is
   `/IWFND/FM_ACTIVATE_SERVICE( IV_TECH_SERVICE_NAME, IV_TECH_SERVICE_VERSION
   -> EV_ERROR_OCCURRED, EV_ERROR_TEXT )`. Consequence for the key contract:
   `ACTIVATE_ODATA_SERVICE` needs the service names and versions of the app
   (today it carries `fioriId` + scenario) - they come from the catalog
   derivation (round 3 looks at the SU22 data of the app id).
   Task-list row types for the record: `STCTM_TX_VALUE` rows are
   `STCTM_SX_VALUE`, `STCTM_TX_PARAMETER` rows `STCTM_SX_PARAMETER`
   (`TASKNAME`, `LNR`, `FIELDNAME`, `MANDATORY`, `DATATYPE`, ...,
   `DEFAULTVAL`); `STC_EXT_CALLER_INFO` = `EXT_SESSION_ID`, `USERNAME`,
   `SID`, `SYSNR`, `MANDT`, `HOST`.
2. **Role deletion:** `PRGN_ACTIVITY_GROUP_DELETE( ACTIVITY_GROUP,
   ENQUEUE_AND_TRANSPORT, SHOW_DIALOG, DISTRIBUTE, REQUEST -> ERROR_FLAG,
   NEW_REQUEST; MESSAGES TYPE SPROT_U_TAB )`. `ZCL_ADO_ACT_ROLE=>delete_role`
   calls it first now (idea I37 closed).
3. **ICF node names are stored in UPPER CASE.** `ICF_NAME = 'SD_SO_MANAGES1'`
   answers two rows (one per parent node), `ORIG_NAME` keeps
   `sd_so_manages1`; the lower-case read of round 1 found nothing.
   `ZCL_ADO_ACT_ICF=>is_node_active` compared the planner's lower-case name
   and therefore never saw a node as existing or active - fixed (upper case).
   13810 ICF rows; `UI5_UI5` exists twice.
4. **Space / page API = interfaces.** `/UI2/CL_FDM_SPACE_API` and
   `/UI2/CL_FDM_PAGE_API` (and their factories) only offer `GET_INSTANCE`
   returning `/UI2/IF_FDM_SPACE_API` / `/UI2/IF_FDM_PAGE_API`; the CTS access
   classes return `/UI2/IF_FDM_*_CTS_ACCESS` with `SET_CURRENT_TRANSPORT_REQUEST`,
   `SET_CURRENT_DEVCLASS`, `GET_ASSIGNED_TRANSPORT_REQUEST( IV_SCOPE, ... )`.
   Round 3 lists the interface methods. Object types: `UIST` / `UIPG` =
   space / page **template** (cross-client, SYST), `UISC` / `UIPC` = space /
   page **customizing** (client-dependent, CUST), `UIAC` technical catalog
   (200), `UIAD` app descriptor item (18664, GUID names), `UIBA` business
   application, `UIAA` descriptor adaptation.
5. **PFCG menu writer:** `SMENCUST` carries texts only, so
   `PRGN_RFC_CREATE_ACTIVITY_GROUP` cannot write the `AGR_BUFFI` URL of a
   catalog / space node. Round 3 records the PFCG-side writers
   (`/UI2/SPACE_PFCG_CREATE`, `/UI2/CAT_PROV_PFCG_PAGES_INIT`, PRGN node /
   folder FMs). `ZFIORI_MASTER_DEV_ROLE` (client 100) already carries a
   `CAT_PROVIDER` folder with child `REPORT = SERVICE` app nodes - the result
   to reproduce.
6. **App ids in PFCG:** across the `SAP_BR_*` roles 6468 `OTSERVICE` app
   nodes, 3142 catalog nodes, 1634 group nodes, 316 space nodes. App nodes
   read `OTSERVICE <FioriId> TR` (e.g. `F0029`, `F1873`) or a hashed id with
   type `HT`. The Fiori id is the name of the app's SU22 entry, so role ->
   catalog folder -> app id is fully readable from `AGR_HIER` / `AGR_BUFFI` /
   `AGR_HIERT`.

## Run 4 findings (2026-09-18, RD1/400) - what changed in the design

1. **`/IAM/` is NOT the Fiori app repository.** The 169 `/IAM/` tables are
   Issue and Activity Management (`/IAM/I_APPL` holds two rows: Change
   Record, Management of Change). Headline finding 2 of run 2 is withdrawn.
   The app id lives elsewhere:
   - PFCG references apps directly: `AGR_BUFFI.URL` = `OTSERVICE <FioriId> TR`
     (e.g. `F1765`) on `AGR_HIER` nodes with `REPORTTYPE = OT`, catalogs as
     `X-SAP-UI2-CATALOGPAGE:<catalog>?AUTH_DEFAULTS=X&DEST_FES=` with
     `REPORT = CAT_PROVIDER`, groups as `sap-ui2-group:<group>` with
     `GROUP_PROVIDER`, spaces as the plain space id with `SPACE_PROVIDER`.
   - `TADIR` carries **18664 `R3TR UIAD`** entries (launchpad app descriptor
     items) next to 4572 `WAPA` BSP applications; round 2 dumps the UIAD
     names and the `/UI2/FLPRT*` tables behind them.
2. **Task-list parameters are readable:** `STC_TM_SCENARIO_GET_PARAMETERS`
   (`I_SCENARIO_ID`, `I_TEMPLATE_ID` → `ET_PARAM_DEF TYPE STCTM_TX_PARAMETER`,
   `ET_PARAMETER TYPE STCTM_TX_VALUE`) and `STC_TM_SESSION_SET_PARAMETERS`
   (`I_SESSION_ID`, `IT_PARAMETER TYPE STCTM_TX_VALUE`, `C_EXEC_ID`). The
   `ACTIVATE_ODATA_SERVICE` recipe is therefore SESSION_BEGIN (init only) →
   SESSION_SET_PARAMETERS → SESSION_EXECUTE → SESSION_GET_STATUS. The
   `STCS_*` scenario tables do not exist on this release.
3. **Direct gateway activation exists:** `/IWFND/FM_ACTIVATE_SERVICE`,
   `/IWFND/CL_MGW_ACTIVATION_API`, `/IWFND/CL_MED_REM_ACTIVATION`
   (signatures in round 2). `/IWFND/I_MED_SRH` carries `IS_ACTIVE`,
   `SERVICE_NAME`, `SERVICE_VERSION`, `NAMESPACE` = the
   `ServiceActivationState` source; the client-dependent system-alias
   assignment is `/IWFND/C_MGDEAM` (8 rows in client 400). 876 services
   registered. V4 services: `/IWBEP/I_V4_MSRV` and friends (no `/IWFND/V4%`).
4. **Spaces / pages API surface:** `/UI2/CL_FDM_SPACE_API(_FACTORY,
   _HANDLER)`, `/UI2/CL_FDM_PAGE_API(_FACTORY, _HANDLER)`,
   `/UI2/CL_FDM_SPACE_CTS_ACCESS`, `/UI2/CL_FDM_PAGE_CTS_ACCESS`,
   `/UI2/CL_FDM_SPACE_TRANS_OBJECT`; PFCG-side FMs `/UI2/SPACE_PFCG_CREATE /
   _CHANGE`. Transport object types confirmed in `OBJH`: **`UIST`** (space),
   **`UIPG`** (page), `UIAD` (app descriptor), `ACGR` (role); `UIPGC` is not
   a TADIR type. Repository tables: `/UI2/STHEAD(T)` (`ID`, `TITLE`, `LANGU`),
   `/UI2/STPGA` (`ID`, `PAGE_ID`, `IDX`), `/UI2/PGHEAD(T)`. Empty in 400.
5. **Role deletion:** `PRGN_RFC_DELETE_AGR`, `PRGN_DELETE_AGR` and
   `PRGN_RFC_DELETE_ACTIVITY_GROUP` are all MISSING on RD1 - the S5
   `ROLLBACK_CREATE_PFCG_ROLE` executor therefore fails with its clear
   message today. `PRGN_ACTIVITY_GROUP_DELETE` exists; round 2 records its
   signature, then the executor switches to it.
6. **Menu writer:** `PRGN_RFC_CREATE_ACTIVITY_GROUP` takes `HIERARCHY_NODES
   TYPE SMENSAPNEW` + `HIERARCHY_TEXTS TYPE SMENCUST`; `SMENSAPNEW` has
   `REPORTTYPE` / `REPORT` but **no URL column**, so how the `AGR_BUFFI` URL
   of an OT node is passed is the open question round 2 answers
   (`SMENCUST` field list, `PRGN_RFC%` inventory, any Z role with an OT node).
   `PRGN_MENU_ADD_NODE` / `PRGN_MENU_ADD_SPACE` do not exist.
7. **ICF name case:** `ICFSERVICE` answered no row for `sd_so_manages1` and
   none for `ui5_ui5` - the node name is stored differently than assumed
   (case or structure). `ZCL_ADO_ACT_ICF` and `ZCL_ADO_ACT_PROBE` read the
   node by name, so this is verified in round 2 before the ICF executor is
   trusted; `ICF_NOACT` remains the activation flag.
8. **`O2APPL`** (`APPLNAME`, `APPLCLAS = /UI5/CL_UI5_BSP_APPLICATION`) and
   `O2APPLT` (`TEXT`) give the UI5 app inventory with titles - the
   `UiComponentState` source for the catalog readers.

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
| `E070` / `E07T` / `E071` table read on the **follow-on** system (S10 `ZADO_C_TRANSPORT_STATUS`) | table read, not yet run on RD1 | Import evidence without TMS: a request exists in the target's `E070` only once tp imported it (object list travels with the import), status `R`. tp return codes stay in the TMS logs (idea I31). |
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
