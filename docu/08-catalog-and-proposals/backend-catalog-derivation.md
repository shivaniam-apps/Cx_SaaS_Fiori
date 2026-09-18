# Backend catalog derivation (S9)

`BackendCatalogApps` and `BackendLaunchpadContent` hold what a target system
itself knows about its Fiori content: which apps are installed, under which
BSP application they are served, whether their ICF node and OData services
are active, which business catalogs, groups and roles carry them, and which
spaces and pages exist. Two consumers depend on it:

- `fiori-candidate-query.js` answers a candidate's `Availability` from the
  catalog row (UNKNOWN without one), which the proposal confidence reflects.
- `createActivationPlan` takes the ICF node of an app from
  `BackendCatalogApps.BspApplication`; without a row the ICF step travels
  with an empty URL and the ABAP dispatcher fails it fast (docu/09
  object-key-contract).

S9 is split in two, because only one half depends on the open decision PO-1:

| Part | Content | Depends on |
|---|---|---|
| **1 (this)** | The CAP pipeline: `CATALOG_DERIVATION` task handler, `deriveBackendCatalog` action, Extractions-page trigger and run row, adapter reads of the catalog read unit with the 404 fallback, the catalog endpoint in the connection check, the mock derivation, and the read-only ABAP probe `ZADO_PROBE_CATALOG` that records the table shapes the readers need. | nothing |
| **2** | The ABAP readers (`ZADO_CATALOG_SRV`: `CatalogApps`, `LaunchpadContent`) written from the probe output, and the tcode → app mapping source. | probe output from RD1 DEV/100; PO-1 for the mapping source |

The derivation reads the customer's own system. It never touches the SAP
Fiori Apps Reference Library; that question (PO-1) concerns how the shipped
overlay maps transactions to app IDs, not this chapter.

## Run semantics

- A derivation is an `ExtractionRuns` row with `SourcesJson` `["CATALOG"]`
  and a `CATALOG_DERIVATION` background task, so it shows on the
  Extractions page with the usual QUEUED / RUNNING / COMPLETED / PARTIAL /
  FAILED states and progress. `FioriRowCount` carries the app count.
- Rows are written under the new run. The previous run's rows of that
  system are deleted only after the new set is complete; a failed or
  cancelled derivation keeps the last good catalog.
- An add-on without the catalog service (part 2 not installed) answers 404:
  the run ends PARTIAL with the log line "The ZADO add-on has no catalog
  service", availability stays UNKNOWN and any earlier catalog stays.
- `Availability` is judged from the three backend states with one rule
  (`availabilityOf` in `catalog-derivation.js`), for mock and live rows alike:
  UI component MISSING → NOT_INSTALLED; ICF or service INACTIVE / MISSING →
  MISSING_SERVICE; INSTALLED + ACTIVE (+ service ACTIVE or unreported) →
  AVAILABLE; otherwise UNKNOWN.
- Mock mode derives one row per Fiori app of the shipped overlay, installed
  and active with a `zmock_<id>` BSP application, plus a space, a page and
  the referenced business catalogs.

## Contract of the catalog read unit (for part 2)

Service root: `/sap/opu/odata4/sap/zado_catalog_o4/srvd/sap/zado_catalog_srv/0001`
(`ADOPTOPS_S4_CATALOG_ROOT`, or `TargetSystems.catalogRootPath` per system).
Published on every environment like the usage read unit; read-only.

`CatalogApps` (one row per installed Fiori app; ordered by `FioriId`):

| Field | Source (to confirm with the probe) |
|---|---|
| `FioriId` | PFCG app nodes: `AGR_BUFFI.URL` = `OTSERVICE <FioriId> TR` under a `CAT_PROVIDER` folder (probe round 2) |
| `AppTitle`, `AppSubtitle` | `AGR_HIERT.TEXT` of the app node; `O2APPLT.TEXT` of the BSP |
| `AppType` (SAPUI5 / WDA / GUI / WEBCLIENT / URL), `AppCategory` | target mapping of the app (round 3) |
| `SemanticObject`, `SemanticAction` | target mapping of the app |
| `IamAppId`, `UI5ComponentName`, `BspApplication` | target mapping / SU22 data of the app id (round 3); `O2APPL` for the BSP inventory. `IamAppId` stays empty (the `/IAM/` assumption was wrong) |
| `TechnicalCatalogId`, `BusinessCatalogId`, `BusinessGroupId`, `BusinessRoleId` | CDM3 catalog tables, `AGR_HIER` of `SAP_BR_*` roles |
| `ODataServicesJson` `[{service, version, active}]`, `ServiceActivationState` | `/IWFND/` service registry |
| `IcfNodeState` | `ICFSERVICE.ICF_NOACT` where `ICF_NAME = to_upper( bsp )` (verified on RD1, round 2) |
| `UiComponentState` | `TADIR` WAPA presence |
| `Availability` | may be left empty; CAP applies the rule above |
| `MinS4Release` | optional |

`LaunchpadContent` (ordered by `ContentType`, `ContentId`): `ContentType`
SPACE / PAGE / SECTION / GROUP / CATALOG, `ContentId`, `Title`, `ParentId`,
`AssignedRolesJson`, `ItemCount`, `IsSapDelivered`.

The CAP mappers (`mapCatalogApp`, `mapLaunchpadContent`) default every
absent field, so a first reader may ship a subset.

## Connection check

`checkTargetSystemConnection` lists a third endpoint, `CATALOG`, for
registered systems: `OK` when `CatalogApps?$top=1` answers, `MISSING`
(informational, the badge reads "Catalog not published") on 404, `SERVICE`
on any other failure. It never changes the rollup verdict.

## Probe findings, round 1 (RD1/400, 2026-09-18)

Raw output: [probe-catalog-rd1-400-2026-09-18.txt](probe-catalog-rd1-400-2026-09-18.txt).
Consequences for the readers:

- **`/IAM/` is Issue and Activity Management, not the app repository.** The
  contract's "IAM app repository" source is withdrawn. Fiori app ids reach
  the backend through the launchpad content (`TADIR R3TR UIAD`, 18664
  items; `/UI2/FLPRT*`) and through PFCG (`AGR_BUFFI.URL` =
  `OTSERVICE <FioriId> TR`). Round 2 of the probe dumps both.
- **Business catalogs and spaces in PFCG:** `AGR_HIER.REPORTTYPE = OT` with
  `REPORT` = `CAT_PROVIDER` (URL `X-SAP-UI2-CATALOGPAGE:<catalog>`),
  `GROUP_PROVIDER` (`sap-ui2-group:<group>`), `SPACE_PROVIDER` (space id).
  `SAP_BR_INTERNAL_SALES_REP` has 242 nodes. This is the
  `BusinessCatalogId` / `BusinessRoleId` source and the `LaunchpadContent`
  role assignment.
- **UI5 app inventory:** `TADIR WAPA` (4572) plus `O2APPL` /
  `O2APPLT` (title, `APPLCLAS = /UI5/CL_UI5_BSP_APPLICATION`) →
  `UiComponentState`, `AppTitle`, `BspApplication`.
- **OData V2 state:** `/IWFND/I_MED_SRH.IS_ACTIVE` with `SERVICE_NAME`,
  `SERVICE_VERSION`; V4 in `/IWBEP/I_V4_MSRV`. The client-dependent alias
  assignment `/IWFND/C_MGDEAM` had 8 rows in client 400.
- **ICF:** no `ICFSERVICE` row answered for the lower-case BSP name; the
  storage form is checked in round 2 before `IcfNodeState` is trusted.
- **Spaces / pages tables** (`/UI2/STHEAD(T)`, `/UI2/STPGA`, `/UI2/PGHEAD(T)`)
  exist with the expected columns (`LANGU`, not `LANGUAGE`) and are empty
  in client 400; `/UI2/CATALOG%`, `/UI2/TC%`, `/UI2/BC%` do not exist, the
  CDM3 content sits under `/UI2/FLPRT*` / `/UI2/PB*` / `/UI2/CHIP*`
  (round 2 dumps the field lists).

## Probe findings, round 2 (RD1/100, 2026-09-18)

Raw output: [probe-catalog-rd1-100-round2-2026-09-18.txt](probe-catalog-rd1-100-round2-2026-09-18.txt).

- **Correction:** the empty space / page tables are not a client-400 effect.
  They have no client column and are empty in client 100 too; RD1 has no
  spaces or pages and runs the CLASSIC launchpad runtime. `LaunchpadContent`
  on RD1 is therefore catalogs and groups, read from PFCG and the
  page-builder tables, not from `/UI2/STHEAD`.
- **`FioriId` source:** TADIR `UIAD` names are GUIDs, so not TADIR. PFCG
  carries the id: a `CAT_PROVIDER` folder (catalog id in `AGR_BUFFI.URL`,
  `X-SAP-UI2-CATALOGPAGE:<catalog>?...`) with child nodes `REPORT = SERVICE`
  whose URL reads `OTSERVICE <FioriId> TR`. 6468 such nodes across the
  `SAP_BR_*` roles. `FioriId`, `AppTitle` (`AGR_HIERT`), `BusinessCatalogId`,
  `BusinessRoleId` and the group (`sap-ui2-group:<id>`) come from there.
- **`IcfNodeState`:** `ICFSERVICE.ICF_NAME` is upper case
  (`ORIG_NAME` lower); compare `to_upper( bsp )`, `ICF_NOACT` is the flag.
- **`ServiceActivationState`:** `/IWFND/I_MED_SRH` (`SERVICE_NAME`,
  `SERVICE_VERSION`, `IS_ACTIVE`) or `/IWFND/CL_MGW_ACTIVATION_API=>IS_ACTIVE`;
  client-specific alias rows in `/IWFND/C_MGDEAM`. V4: `/IWBEP/I_V4_MSRV`.
- **Still open (round 3):** app id -> BSP application and app id -> OData
  services. Candidates: the SU22 data of the app id (`USOBT` `S_SERVICE`
  values resolved through `USOBHASH`) and the classic page-builder tables
  (`/UI2/PB_C_PAGEM` catalogs, `/UI2/PB_C_CHIPM` tiles, `/UI2/PB_C_TMM` target
  mappings). `/UI2/PB_C_PAGE` is keyed by `ID`, not `PAGE_ID`.

## Operator steps for part 2 (RD1 DEV/100)

Round 3 of the probe (`ZADO_PROBE_CATALOG` section 8, `ZADO_PROBE_ACTIVATION`
section 3c) runs in client 100: roles, alias assignments and the customizing
layer are client-dependent, everything else it reads is cross-client.


1. Run `ZADO_PROBE_CATALOG` (SE38) with a known BSP application and one
   `SAP_BR_*` role; attach the list output here as `probe-output-rd1.md`.
2. Answer the manual follow-ups the probe prints (which IAM column carries
   the F-number, the UI5 component and the BSP; the ICF node naming; the
   `/IWFND/` activation state; the CDM3 catalog link; the `AGR_HIER` node
   type and catalog id column).
3. Part 2 writes the two readers from those answers, then: Derive Catalog
   on the Extractions page → the run COMPLETED with the app count, the
   Target Systems badge "Catalog ok", the proposals' availability filled,
   and an activation plan whose ICF steps carry `/sap/bc/ui5_ui5/sap/<bsp>`.
