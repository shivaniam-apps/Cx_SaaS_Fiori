# ZADO — AdoptOps ABAP add-on

abapGit repository for the AdoptOps backend agent. Namespace prefix `ZADO`
(classes `ZCL_ADO_*`, interfaces `ZIF_ADO_*`), conventions mirrored from the
sibling `a4h_2023_zshvm` repo.

## Package plan

| Package | Folder | Content | Installed in |
|---|---|---|---|
| `ZADO` | `src/` | structure package, message class | all systems |
| `ZADO_CORE` | `src/core/` | config, audit, run tracking, helpers, **Phase 0 probe** | all |
| `ZADO_USAGE` | `src/usage/` | ST03N/STAD/AGR/USR02 readers, snapshot tables | all (PROD needs it) |
| `ZADO_CATALOG` | `src/catalog/` | FLP content derivation, tcode↔app correlation | all |
| `ZADO_ACTIVATE` | `src/activate/` | write engine, step strategies, task-list wrapper | DEV only (+ local replay) |
| `ZADO_CTS` | `src/cts/` | transport facade | DEV |
| `ZADO_API` | `src/api/` | service definitions/bindings, `.sush` | all (bindings differ) |

Hard rule: `ZADO_USAGE` never depends on `ZADO_ACTIVATE` — that is what makes
the PROD install defensible to a change-advisory board.

## Phase 0 — the probe

`src/core/zado_probe_apis.prog.abap` is a **read-only** SE38 report that
answers every API/table uncertainty in the design against the actual system:

1. System identity, component versions (`CVERS`), client change options
2. Candidate function modules — existence and full parameter signatures
   (`TFDIR` / `FUPARAREF`): the `SWNC_*`/`SAPWL_*` extraction family, ICF
   activation, PFCG, CTS (`TR_*`/`TRINT_*`), STC task manager
3. `SAP_COLLECTOR_FOR_PERFMONITOR` scheduling state and the SWNC aggregate
   inventory — **without this there is no usage history and no product**
4. Candidate table inventory: `/UI2/*`, IAM app tables, `FDM*`, `STC*`, ICF
5. How business catalogs appear in `SAP_BR_*` role menus (`AGR_TCODES` type
   distribution, `AGR_HIER` counts)
6. A checklist of manual follow-ups (STC01 scenario names, `/UI2/FLIA` target
   mapping parameter spelling, ST03N retention, ST01 authorization trace)

Install via abapGit (online repo, package `ZADO`) or paste the single report
into SE38 in a sandbox. Attach the list output to
`../docu/06-s4-integration/` as the verified API matrix.

**No downstream ZADO object (readers, RAP BOs, activation engine) may be
coded before the probe output is reviewed.** The design deliberately marks
several SAP API names as unverified; the probe is what converts them from
assumption to fact.

## Phase 1+ (after probe review)

- `ZADO_CORE` tables (`ZADO_CFG`, `ZADO_RUN`, `ZADO_RUN_MSG`, `ZADO_AUDIT`),
  domains, message class, `ZCL_ADO_LOG/CFG/MSG/HASH/PSEUDONYM`
- `ZADO_USAGE` snapshot tables + collector + CDS + OData V4 binding
  `ZADO_USAGE_O4` (service root consumed by the CAP layer:
  `/sap/opu/odata4/sap/zado_usage_o4/srvd/sap/zado_usage_srv/0001`)
- Seeded-usage generator for the A4H appliance (thin ST03N history there
  makes the analytics screens undemonstrable otherwise)
