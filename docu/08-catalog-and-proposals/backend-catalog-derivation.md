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
| `FioriId` | IAM app repository (`/IAM/I_APPL*`), the F-number |
| `AppTitle`, `AppSubtitle` | `/IAM/I_APPL_T` |
| `AppType` (SAPUI5 / WDA / GUI / WEBCLIENT / URL), `AppCategory` | IAM app type |
| `SemanticObject`, `SemanticAction` | target mapping of the app |
| `IamAppId`, `UI5ComponentName`, `BspApplication` | IAM app / `O2APPL` |
| `TechnicalCatalogId`, `BusinessCatalogId`, `BusinessGroupId`, `BusinessRoleId` | CDM3 catalog tables, `AGR_HIER` of `SAP_BR_*` roles |
| `ODataServicesJson` `[{service, version, active}]`, `ServiceActivationState` | `/IWFND/` service registry |
| `IcfNodeState` | `ICFSERVICE.ICF_NOACT` of `/sap/bc/ui5_ui5/sap/<bsp>` (verified on RD1) |
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

## Operator steps for part 2 (RD1 DEV/100)

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
