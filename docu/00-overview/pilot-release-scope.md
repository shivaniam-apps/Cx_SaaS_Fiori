# Pilot release scope - what must be in, what is parked

Decision of the product owner, 2026-09-19: finish the **must-have** items,
lock a version, deploy it for end-to-end testing against a real system;
everything else is recorded here and in
[tracker/ideas.md](tracker/ideas.md) and waits for a later version.

The line between the two lists is one question: *does the journey Connect →
Analyse → Propose → Review → Plan → Simulate → Execute → Transport run on a
real S/4HANA system without a developer standing next to it?* Whatever is
needed for that is a must-have. Whatever improves quality, comfort, depth or
reach beyond it is parked.

## Must-have for the version lock

| # | Item | State | Remaining action |
|---|---|---|---|
| 1 | Usage extraction, snapshots, proposals, review, waves (S1-S8, O items) | merged | RD1 acceptance run as part of the end-to-end test |
| 2 | Activation plan, simulation, execution engine, operator actions, transport verification (S3 part 1, S4, S5, S10) | merged | same |
| 3 | **S3 part 2** - executors for OData service, space, page, assignment, catalog / space in the role menu (a4h #38, #39; Cx #77) | merged, activated on RD1 without syntax errors | **Smoke run on RD1 DEV/100**: the eight rows in [docu/09 object-key-contract](../09-activation-and-transport/object-key-contract.md#acceptance-run-of-the-s3-part-2-executors-custom-scenario); every FAILED message comes back to the scheduling worktree |
| 4 | **S9 part 2** - catalog readers `CatalogApps` / `LaunchpadContent` in the usage read unit, planner uses the derived catalog (BSP, business catalog, OData services) | a4h `feat/catalog-readers`, Cx `feat/catalog-derivation-2` | merge both, pull on RD1, *Derive Catalog* on the Extractions page → run COMPLETED with an app count, "Catalog ok" badge |
| 5 | Security and deployment hardening (A items, T4-T7, S11) | merged | none |
| 6 | One version number and a tag ([release process](../05-deployment-tiers/release-process.md)) | tooling merged (T5) | after 3 and 4 are clean: `node scripts/release.mjs set <version>` via PR, tag, deploy per the runbook |

**Exit criterion:** one wave with two or three approved apps runs on RD1
DEV/100 from plan to a released customizing request - role with catalog and
space, space with page, inactive services and ICF nodes activated, a second
execution answering SKIPPED everywhere - and the import is verified on the
follow-on system.

Known and accepted in this version (each behaves honestly, none blocks the
journey):

- `CREATE_PAGE` creates an **empty page** and answers WARNING naming the apps;
  an administrator arranges the tiles in *Manage Launchpad Pages* (I59).
- OData **V4** service groups are not activated (V2 only); the catalog reader
  does not list them (I61).
- The new step types have **no rollback** yet; the operator's rollback of such
  a step answers "Unknown step type" (I60). Role and transport rollback work.
- Where an app's own service cannot be told from its name, the catalog's
  service list is planned - a few more services get activated than strictly
  needed, none is deactivated (I63).
- Titles of spaces, pages and catalogs in `LaunchpadContent` are their ids
  (I64).

## Parked for a later version

| Area | Item | Where it is recorded |
|---|---|---|
| Activation | Tiles and sections on the created page (needs probe round 6 output) | I59 |
| Activation | Rollback of space / page / assignment / menu node | I60 |
| Activation | OData V4 service group publishing | I61 |
| Activation | Second (workbench) request when a customer wants the service registration transported | I62 |
| Catalog | Exact app-to-service link instead of the name match | I63 |
| Catalog | Language-dependent titles of launchpad content; GUI / Web Dynpro apps as catalog rows | I64 |
| Catalog | Mapping source transaction → Fiori app (licence question) | **PO-1** - proposal quality, not a precondition of the readers |
| Transport | tp return code per import, import history depth | S12 |
| Portability | Re-run the probes on the lab system and the next customer system, diff against RD1, turn differences into capability flags | I58 |
| Security | Row-level tenant checks and the other review follow-ups | A14 |
| Operations | BTP Audit Log service binding | T3 (after **PO-2**) |
| Product | Multitenancy model, enterprise tier, service broker claim | **PO-3**, **PO-4** |
| Overview | Usage Insight drill-down per run, deep links behind the approuter | O18 |

Rule while the version is locked: a parked item is not started on the release
branch. A defect found by the end-to-end test is fixed on `main` through a
pull request and released as a patch version.
