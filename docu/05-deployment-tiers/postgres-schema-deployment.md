# PostgreSQL schema deployment (Basic and Standard tiers)

Roadmap item A1. The MTA now carries a database deployer module, so a plain
`mbt build && cf deploy` creates every table and view on an empty space and
upgrades an existing schema in place on every later deployment. Nothing has
to be deployed from a workstation any more.

## How it works

| Step | What happens |
|---|---|
| `npm run build:basic` (`cds build --production`) | The `postgres` build task in `code/package.json` compiles the same model as the srv runtime (`srv/srv`) into `code/gen/pg/db/csn.json` and copies `code/db/package.json` next to it. |
| `scripts/prepare-basic-runtime.mjs` | Strips `cds.xt.*` definitions from the deployer CSN and fails the build if `gen/pg` is missing or its persisted entities differ from `gen/srv`. |
| `mbt build` | Packages `gen/pg` as module `adops-basic-db-deployer` (see `deploy/cf/mta.yaml`). |
| `cf deploy` | Pushes the deployer with `no-start` and `no-route`, then runs its CF task `deploy-to-postgresql` (`npm start` = `cds-deploy`). `adops-basic-srv` requires the deployer module, so the app starts only after the task has finished. |

`cds-deploy` binds to the `postgresql-db` service instance
(`adops-basic-postgres`) through VCAP_SERVICES and runs with
`schema_evolution: auto`.

## Migration strategy: automatic, additive-only schema evolution

`cds-deploy` stores the deployed CSN in a table named `cds_model` and, on
the next run, computes the delta between that CSN and the new one. Verified
against `@sap/cds` 8.9 / `@sap/cds-compiler` 5.9 with `cds deploy --dry
--delta-from`:

| Model change | Result |
|---|---|
| New entity | `CREATE TABLE` |
| New or changed view / projection | `CREATE VIEW` (views are dropped and re-created) |
| New element | `ALTER TABLE ... ADD` |
| Widened string length, compatible type change | `ALTER TABLE ... ALTER ... TYPE` |
| Removed element | **Refused**: "Dropping elements is not supported". The task fails, nothing is applied. |
| Removed entity | **Refused**: "Dropping tables is not supported". |
| Narrowed length or incompatible type | **Refused**: "length reduction is not supported". |

So the deployer can never lose data by itself, and the rule in
`.claude/rules/architecture.md` (never rename or remove persisted fields
without checking consumers) is also what keeps deployments green. When a
column or table must really go:

1. Remove it from the model only after every consumer stopped using it.
2. Deploy the model with the element still present but no longer written.
3. Run the `DROP` by hand against the instance (`cf ssh` or a psql session
   through the service key) and delete the element from the `cds_model` CSN
   in the same session, or accept that the orphaned column stays. An orphaned
   column is harmless; an orphaned row in `cds_model` is not, because the next
   delta is computed against it.

A first deployment against a database that already has tables but no
`cds_model` row (for example one created by a manual `cds deploy` before A1)
computes the delta against an empty prior model and issues `CREATE TABLE`
for everything, which fails on the existing tables. Seed `cds_model` first
with the model that matches the existing schema:

```bash
cd code && npm run db:deploy:postgres:dry
```

shows what would run; a one-off `cds deploy --model-only` from the workstation
(hybrid binding) writes the row without touching tables.

## Workstation scripts (hybrid binding required)

```bash
cd code && npm run db:ddl:postgres
```

prints the full PostgreSQL DDL for review.

```bash
cd code && npm run db:deploy:postgres:dry
```

prints what a deployment would execute against the bound instance
(`.cdsrc-private.json`, see `srv:hybrid:check`).

```bash
cd code && npm run db:deploy:postgres
```

deploys from the workstation. Use it only for the `cds_model` seeding case
above or when a hotfix cannot wait for a full `cf deploy`; the CF task is the
normal path.

## Local development stays on sqlite

`npm run db:refresh:sqlite` heals additive drift in the developer's
`code/db.sqlite` the same way (new tables and `ADD COLUMN`); see
`.claude/rules/local-db.md`. The PostgreSQL deployer never runs locally.

## Acceptance (A1)

- `npm run build:basic` produces `code/gen/pg` and the verification line
  "Verified the PostgreSQL deployer covers all N persisted entities".
- `mbt mtad-gen` accepts the descriptor; `mbt module-build -m
  adops-basic-db-deployer` packages the module.
- `cf deploy` on an empty space: task `deploy-to-postgresql` succeeds, the
  `adops-basic-srv` health check on `/healthz` answers 200, and the tables
  exist. This last step runs on the `dev` space as part of the A2 rollout,
  since it needs the environment separation to pick the target space.

## Open points

- The deployer's `package.json` has no lockfile; the CF buildpack resolves
  `^8.9.4` / `^1.10.0` at staging time. T5 (release process) should pin a
  lockfile in `code/db/` for reproducible deployments.
- `cds_model` is the migration state. Include it in every database backup
  and never edit it except in the seeding case above.
