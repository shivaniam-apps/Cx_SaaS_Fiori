# Transport verification on follow-on systems (S10)

AdoptOps writes only in DEV. Everything transportable travels to QA and PROD
via CTS, and the activation manifest (`readActivationManifest`) is the runbook
a basis admin works through per follow-on system. This chapter describes what
AdoptOps verifies **itself** on those systems, how the result is persisted and
what stays a manual runbook item.

## What is verified, and through what

Follow-on systems publish only the ZADO **read** unit (`ZADO_USAGE_SRV`); the
write unit stays unpublished there (S1 reports an EXPOSED write unit on QA/PROD
as a safety finding). Verification therefore uses two read entities:

| Check | Read | Verdict |
|---|---|---|
| `TRANSPORT_IMPORTED` (`ADD_TO_TRANSPORT`, `APPEND_TO_TRANSPORT`) | `TransportStatus?$filter=Trkorr eq '<TRKORR>'` → `ZADO_C_TRANSPORT_STATUS` on `E070`/`E07T`/`E071` | On a follow-on system the request exists in `E070` only once tp imported it (the object list travels with the import). Row with status `R` → **VERIFIED**; no row → **NOT_FOUND** (not imported yet). |
| `ROLE_EXISTS` (`CREATE_PFCG_ROLE`, `ADD_SPACE_TO_ROLE`, `GENERATE_PROFILE`) | `RoleInventory?$filter=RoleName eq '…' or …` → `ZADO_C_ROLE_INVENTORY` on `AGR_DEFINE` (S8) | Role listed → **VERIFIED** (the menu node and the generated profile are not readable through the read unit; the detail says so); missing → **NOT_FOUND**. |
| `ROLE_HAS_USERS` (`ASSIGN_ROLE_TO_USERS`) | same `RoleInventory` read, `UserCount` | Users assigned on this system → **VERIFIED**; role present without users → **NOT_FOUND** (assignments are client-local, never transported). |
| everything else (task list, OData service, ICF node, space, page, page↔space) | none yet | **MANUAL** — the manifest's verification hint is the check. |

A read that fails (destination down, add-on older than S10 without the
`TransportStatus` entity, RAP error) degrades its verdicts to **UNKNOWN**,
never to a false NOT_FOUND. The import status follows the same rule:

| `ImportStatus` | Meaning |
|---|---|
| `IMPORTED` | `E070` on the follow-on system carries the request with status `R`. |
| `PENDING` | No `E070` row there yet (or the row is modifiable — that is the source system answering). |
| `IMPORT_FAILED` | Only an operator can record this: the tp return code lives in the TMS logs, which the read unit does not read (see Limits). |
| `UNKNOWN` | The read failed or the add-on has no `TransportStatus` entity. |

## Where it lives

| Layer | Piece |
|---|---|
| ABAP (`a4h_2023_zado`, mirrored to `abap/src/usage/`) | `ZADO_C_TRANSPORT_STATUS` + `ZCL_ADO_Q_TRANSPORT`, exposed as `TransportStatus` in `ZADO_USAGE_SRV`. Requires a `Trkorr` filter — without one it answers nothing rather than paging the transport history. |
| CAP | `utils/transport-verification.js` (pure: read spec per manifest entry, verdicts, counts, persisted row shapes; `verifyTransportImport` takes injected readers), `s4-fiori-adapter.js` (`fetchTransportStatus` with the 404 → `supported: false` fallback, `fetchRolesByName`), `public-service.js` actions. |
| Data | `TransportImports`: one row per transport and follow-on system (`ImportStatus`, `Source` READ_UNIT / OPERATOR, `RequestStatus`, `ObjectCount`, `CheckedAt/By`, the verification counts and `VerificationJson`). `TransportRequests.imports` composes them. |
| Audit | `TRANSPORT_IMPORT_CHECKED` and `TRANSPORT_IMPORT_RECORDED` on the hash chain, before/after = previous/new `ImportStatus`, WARN severity on `IMPORT_FAILED`. |
| Client | Transports page: **Imports** column (status per follow-on system, source, stamp, verdict counts), **Verify** (released requests; preselects the next hop of the tenant's transport route configured on Target Systems (`followOnSystem`, DEV -> QAS -> PRD) that has no import row yet, falling back to environment order without a route; shows the last persisted verdicts, "Verify now" runs the reads; the System column shows the route per request), **Record import** (Activator; the runbook outcome with a note). Pure model in `features/transports/transportModel.js`. |

## API

- `verifyTransportImport(transportId, targetSystemId)` — any member; read-only towards S/4. Rejects the request's own source system (400) and a follow-on system without a destination (400, record by hand instead). Returns `{ Import, TransportStatus, Verification }`.
- `recordTransportImport(transportId, targetSystemId, status, note)` — Activator; `status` ∈ IMPORTED, IMPORT_FAILED, PENDING. Keeps the last verification verdicts on the row.
- `readTransportImport(transportId, targetSystemId)` — the row with `Verification` parsed; `queryTransportRequests` carries the rows per request (`Imports`) without the verdict payload, plus `FollowOnSystems`.

Mock mode (`ADOPTOPS_MOCK_S4`, tests): a RELEASED transport counts as imported with its roles present and no users assigned; anything else is PENDING.

## Limits (deliberate, tracked in tracker/ideas.md)

- The tp **return code** of an import (RC 4/8/12) is not read: it lives in the
  TMS logs (`TMS_MGR_READ_TRANSPORT_HISTORY` / ALOG), whose surface is not RD1-verified.
  An operator records `IMPORT_FAILED` from STMS.
- Spaces, pages, ICF nodes, OData services and task-list runs have no read-unit
  entity yet; they stay MANUAL until the corresponding readers exist (S3 part 2
  brings the write side; a `ZADO_C_ICF_NODE` / `/UI2/` reader would close the gap).
- The role menu node (`ADD_SPACE_TO_ROLE`) and the generated profile are verified
  only as "role exists".

## RD1 acceptance

1. Syntax check `ZADO_C_TRANSPORT_STATUS` / `ZCL_ADO_Q_TRANSPORT`, republish
   `ZADO_USAGE_O4`, then in the browser on DEV:
   `…/zado_usage_srv/0001/TransportStatus?$filter=Trkorr eq 'RD1K9xxxxx'` answers
   the request with its E070 status; without a filter the set is empty.
2. Release a smoke request (S3 part 1 smoke Transport → Role → Append), import it
   into the follow-on client/system, then **Verify** on the Transports page: the
   import goes IMPORTED, the role entries VERIFIED, the rest MANUAL.
3. Verify before the import: PENDING / NOT_FOUND, no UNKNOWN.
