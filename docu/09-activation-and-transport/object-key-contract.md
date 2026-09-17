# ObjectKeyJson contract (planner ↔ ABAP write unit)

Every `ActivationSteps` row carries `StepType` plus `ObjectKeyJson`, the typed
key the ABAP write unit needs to execute that one step. The SaaS planner is
the **single source** of these shapes; the ABAP dispatcher deserializes them
field for field. This chapter is the reference for both sides.

| Where | Role |
|---|---|
| `code/srv/srv/utils/activation-plan.js` → `objectKey(stepType, params)` | Builds every key. `deriveActivationSteps` and the `releaseTransport` action use it; nothing else assembles a key by hand. |
| `code/test/fixtures/activation-object-keys.json` | The contract as data: one key per step type for a fixed input, plus the non-planner variants. |
| `abap/src/activate/zcl_ado_activate.clas.abap` (mirror of `a4h_2023_zado`) | One `ty_*_key` type per dispatchable step type; `/ui2/cl_json` maps camelCase on the wire to the snake_case fields. |
| `abap/src/activate/zado_activate_smoke.prog.abap` | Feeds the same shapes into `EXECUTE_STEP` on RD1 DEV; the *Custom* scenario takes a planner row verbatim. |
| `code/test/activation-plan.test.mjs`, `code/test/activation-key-contract.test.mjs` | Fail when planner, fixture, ABAP types or smoke literals drift. |

Wire format: JSON object, camelCase keys, strings unless stated. The transport
(`s4-activate-adapter.js`) passes the string through untouched, both on the
ICF handler (`objectKeyJson`) and the RAP action (`ObjectKeyJson`).

## Keys per step type

| StepType | Key | Values come from | ABAP executor | Status |
|---|---|---|---|---|
| `RUN_TASK_LIST` | `{ scenario }` | constant `SAP_FIORI_FOUNDATION_S4` | `zcl_ado_act_tasklist=>begin` | executable |
| `ACTIVATE_ODATA_SERVICE` | `{ fioriId, scenario }` | proposal; constant `SAP_GATEWAY_ACTIVATE_ODATA_SERV` | — | S3 (`not_implemented`) |
| `ACTIVATE_ICF_NODE` | `{ fioriId, url, icfName }` | proposal; `BackendCatalogApps.BspApplication` → `/sap/bc/ui5_ui5/sap/<bsp>` and `<bsp>` (lower case) | `zcl_ado_act_icf=>activate` (`HTTP_ACTIVATE_NODE`, verify via `ICFSERVICE.ICF_NOACT`) | executable; empty `url`/`icfName` → FAILED before the FM |
| `CREATE_SPACE` | `{ spaceId, title }` | `ZADO_<wave key>`, wave name | — | S3 |
| `CREATE_PAGE` | `{ pageId, apps[] }` | `ZADO_<wave key>_P1`, approved Fiori IDs | — | S3 |
| `ASSIGN_PAGE_TO_SPACE` | `{ spaceId, pageId }` | as above | — | S3 |
| `CREATE_PFCG_ROLE` | `{ role, text, referenceRoles[], trkorr }` | `Z_ADO_<wave key>`, `AdoptOps <wave>` (≤ 80), distinct `BusinessRoleId`s; `trkorr` empty in the row, injected at dispatch | `zcl_ado_act_role=>create_role` (`PRGN_RFC_CREATE_ACTIVITY_GROUP` with `REQUEST`); `referenceRoles` reserved for menu derivation | executable |
| `ADD_SPACE_TO_ROLE` | `{ role, spaceId }` | as above | — | S3 |
| `GENERATE_PROFILE` | `{ role }` | as above | `zcl_ado_act_role=>generate_profile` | executable |
| `ASSIGN_ROLE_TO_USERS` | `{ role, users[] }` | plan with `AssignUsers` (not emitted by the planner yet) | `zcl_ado_act_role=>assign_users` | executable |
| `ADD_TO_TRANSPORT` | `{ text }` — create<br>`{ trkorr, simulation }` — release | `AdoptOps <wave>` (≤ 60);<br>`releaseTransport` action | `zcl_ado_act_cts=>create_request` / `release_request` (`TRINT_RELEASE_REQUEST IV_SIMULATION`) | executable; a set `trkorr` selects release |
| `APPEND_TO_TRANSPORT` | `{ trkorr, objects[{ pgmid, object, objName }] }` | the wave's transportable objects (today `R3TR ACGR <role>`; spaces/pages join with their executors); `trkorr` injected at dispatch | `zcl_ado_act_cts=>append_missing` (`TR_APPEND_TO_COMM_OBJS_KEYS`, verify-first and verify-after on `E071` of the request and its tasks) | executable; all objects present → `SKIPPED` |

`<wave key>` is `waveTechnicalKey(waveName)` (`Wave 1` → `W1`).

## Sequence and the plan's transport request

The planner orders a wave as FOUNDATION → SERVICE (OData, ICF per app) →
**`ADD_TO_TRANSPORT` (create)** → CONTENT (space, page, assignment) → ROLE
(create, add space, profile) → **`APPEND_TO_TRANSPORT`**. The request is
created before the first transportable write because PFCG and the launchpad
repositories record objects on a request at write time; the space and role
steps depend on it.

The TRKORR does not exist when the plan is derived, so the rows keep
`trkorr: ""`. At dispatch the execution engine merges the plan's request into
the keys listed in `TRKORR_STEP_TYPES` (`withPlanTrkorr` in
`activation-plan.js`): the persisted row stays as planned, only the executor
sees the completed key. A resumed plan reads the request back from
`TransportRequests`. Release remains the operator's `releaseTransport` action.

## Simulation: the read-side state probe

`simulateActivationPlan` in live mode sends every step to the write unit with
the same `StepType` + `ObjectKeyJson` and `probe: true` (ICF body field, or
`Probe` on the RAP action parameter). `ZCL_ADO_ACT_PROBE` reads the DEV
system's state and answers `{ verdict, existsAlready, message }` without a
LUW:

| Verdict | Meaning | Examples |
|---|---|---|
| `SIMULATED_OK` | executable; `existsAlready` says the executor will skip it | role exists, ICF node already active, request already released |
| `SIMULATED_WARN` | executable with a caveat | inactive ICF node (activation irreversible) |
| `SIMULATED_BLOCKED` | cannot run | incomplete key (ICF app without BSP application), no executor on this release (S3 pending), unknown request |

A transport failure or a foreign payload is mapped to `SIMULATED_BLOCKED` by
the adapter, so a plan never claims a state it could not read. Mock mode keeps
the deterministic `mockSimulationProbe`; a live target system without a
destination gets the structural simulation with an explicit "not probed"
suffix. `ZADO_ACTIVATE_SMOKE` has a "Probe only" checkbox that runs a
scenario through the probe instead of the executor.

## Rules

- **Only what the executor needs.** Keys carry no documentation fields (API
  names, table columns); those live in `docu/06-s4-integration/api-matrix.md`
  and in the step's `VERIFICATION_HINTS` for the manifest.
- **Fail fast, never dump.** The dispatcher refuses an incomplete key with
  `FAILED` and a message naming the missing field, before any function module
  runs; the step LUW is rolled back like any failure and the run resumes from
  that step once the key is fixed.
- **ICF URLs come from the catalog.** Until catalog derivation (S9) fills
  `BackendCatalogApps.BspApplication` for the target system, ICF steps travel
  with empty `url`/`icfName` and fail fast on the ABAP side with an explicit
  message. `createActivationPlan` looks the BSP application up per target
  system and Fiori ID at planning time; re-create the plan after a catalog
  derivation to pick it up.
- **Changing a shape** means changing the planner builder, the fixture, the
  ABAP type (in `a4h_2023_zado` first, then the mirror) and, when the smoke
  program covers the step, its literal — the two test suites enforce this.
- **Persisted plans keep their keys.** `ObjectKeyJson` is stored per step;
  plans created before a contract change carry the old shape. Recreate such
  plans rather than migrating rows (they are cheap to derive and not yet
  executed in QA/PROD).

## Smoke test on RD1 DEV/100

`ZADO_ACTIVATE_SMOKE` (SE38) executes one step with a planner-shaped key and
prints the full result contract:

| Scenario | Key it sends | Expected on repeat |
|---|---|---|
| Transport | `{ "text": "<description>" }` | new request each run (clean up in SE10) |
| Role | `{ "role": "Z_ADO_SMOKE", "text": "...", "referenceRoles": [] }` | `SKIPPED` + exists already |
| Profile | `{ "role": "Z_ADO_SMOKE" }` | regenerated (harmless) |
| ICF | `{ "fioriId": "SMOKE", "url": "/sap/bc/ui5_ui5/ui2/ushell", "icfName": "ushell" }` | default node is already active → `SKIPPED`; point it at an inactive app node to see `HTTP_ACTIVATE_NODE` run (irreversible) |
| Custom | `StepType` + `ObjectKeyJson` copied from an `ActivationSteps` row | per step type |
