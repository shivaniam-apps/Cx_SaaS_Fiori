# Release process

Roadmap item T5. How a change on `main` becomes a numbered release that
runs in production: one version number, a tagged build, a fixed order of
spaces, blue-green in production, and rules that keep the database safe
across the switch. The deploy mechanics are in
[deploy-runbook.md](deploy-runbook.md); this chapter is the checklist
around them.

## One version

The product carries one semantic version in eight files: `mta.yaml`, the
three extension descriptors, the server, deployer, client and deploy
package files. `scripts/release.mjs` keeps them identical:

```bash
node scripts/release.mjs current
```

```bash
node scripts/release.mjs set 0.2.0
```

```bash
node scripts/release.mjs check
```

The CI gate runs the check on every pull request, so a version bump that
misses a file cannot merge. The version shows up in three places at
runtime: the archive name (`adops-basic_<version>.mtar`), the client's
telemetry (`__APP_VERSION__` from the client package) and the server's
`/readyz` answer (`version` field), which is the quickest way to confirm
what a space is running.

## Semantic versioning rules

| Bump | When |
|---|---|
| **MAJOR** | a consumer has to change: a CDS entity or action removed or renamed, a persisted field dropped, an ABAP contract (`ObjectKeyJson`, the ZADO service names) changed incompatibly, a role collection removed, a subscription callback changed |
| **MINOR** | new capability without breaking anything: a new page, action, entity, field, task type, environment knob, ABAP entity; a new service instance in the MTA |
| **PATCH** | fixes, documentation, tests, dependency updates that change no contract |

Pre-releases (`1.0.0-rc.1`) are allowed for a candidate that goes to `qa`
only. The version is bumped once per release, in its own small pull
request, after the feature pull requests it ships have merged.

## Release checklist

1. **Freeze**: every pull request meant for the release is merged; the
   tracker files show them as accomplished; `main` is green in CI.
2. **Bump**: from a fresh `main`, `node scripts/release.mjs set X.Y.Z`,
   commit, pull request titled `Release X.Y.Z`, merge.
3. **Tag**: on the merged `main`:

```bash
git checkout main && git pull --ff-only origin main
```

```bash
git tag -a vX.Y.Z -m "AdoptOps X.Y.Z" && git push origin vX.Y.Z
```

4. **Build**: the Release workflow (`.github/workflows/release.yml`) runs on
   the tag: it re-checks that the tag matches the version, runs `mbt build`
   on Linux, attaches `adops-basic_X.Y.Z.mtar` to a GitHub release with
   generated notes and keeps it as a workflow artefact for 90 days. That
   archive, and only that archive, is what gets deployed to every space.
5. **dev**: `cf deploy adops-basic_X.Y.Z.mtar -e mtaext/dev.mtaext`;
   verify per the deploy runbook (`/readyz` shows `X.Y.Z`); run the pilot
   smoke path: register or check a target system, one extraction in mock or
   against RD1, one plan simulated.
6. **qa**: same archive with `mtaext/qa.mtaext`; the QA checks of the
   release (customer acceptance of the shipped items) happen here.
7. **prod**: blue-green (next section), same archive with
   `mtaext/prod.mtaext`.
8. **Close**: note the version and date in the admin tracker's daily log;
   the GitHub release is the changelog.

A hotfix follows the same path from a branch cut at the tag
(`git checkout -b fix/<topic> vX.Y.Z`), bumps PATCH, merges to `main` first
and is tagged from `main`; the tag is never placed on the hotfix branch.

## Blue-green in production

Production deploys with the MultiApps plugin's blue-green strategy and a
manual testing phase, so the new version is validated before it takes the
traffic and the old version stays running until then:

```bash
cf target -s prod && cf deploy mta_archives/adops-basic_X.Y.Z.mtar -e mtaext/prod.mtaext --strategy blue-green
```

What happens: the service instances are updated, the database deployer
task runs once (additive delta, see below), the new server and approuter
start as idle applications on temporary routes, and the deployment pauses.
Now validate the idle colour:

- `curl https://<idle srv route>/readyz` answers 200 with the new version;
- open the idle approuter route, log in, load the Dashboard and one list
  page;
- `cf logs <idle srv app> --recent` shows no errors after start.

Then either finish or back out:

```bash
cf deploy -i <operation id> -a resume
```

```bash
cf deploy -i <operation id> -a abort
```

`resume` maps the production routes to the new colour and stops the old
one; `abort` deletes the idle colour and leaves production untouched. The
operation id is printed by the first command and listed by `cf mta-ops`.
`--skip-testing-phase` exists for a fully automatic switch; do not use it
in production until the validation above is automated.

Two server instances (prod sizing) mean the task runner and the audit chain
already tolerate two writers, so old and new colour running side by side
during the testing phase is safe: task claims are atomic and the chain
locks its head row.

## Migration safety

The database is shared by both colours during a blue-green switch and by
the old server during a plain redeploy, so every schema change must be
compatible with the version that is still running:

- **Additive only.** The deployer refuses dropped elements, dropped
  entities and narrowed types ([postgres-schema-deployment.md](postgres-schema-deployment.md)).
  New tables and columns are invisible to the old server, which is what
  makes the switch safe. A column the new version needs must be nullable
  or defaulted, never required from the old rows.
- **Two releases to remove.** Stop reading and writing a column or table in
  release N, remove it from the model in release N+1 (or later) with the
  manual `DROP` from the schema chapter. Never remove and stop using in the
  same release.
- **Same compiler for deployer and runtime.** The build pins the deployer's
  `@sap/cds` and `@cap-js/postgres` to the exact versions the build ran
  with (`scripts/prepare-basic-runtime.mjs`), so the DDL the deployer
  renders comes from the same compiler that produced the runtime CSN. The
  server runtime keeps caret ranges; a dependency update that changes the
  compiler is a PATCH release of its own, deployed to `dev` first.
- **Indexes travel with the deployer.** `code/db/indexes.js` is applied
  after every schema deployment (`CREATE INDEX IF NOT EXISTS`), so an
  index is a normal code change in a MINOR or PATCH release, never a manual
  step on a space.
- **Preview the delta.** Before a release that changes the model, run
  `npm run db:deploy:postgres:dry` against the `qa` binding (hybrid) and
  read the statements; an unexpected `DROP` or a refused change means the
  model is not additive.
- **Roll back the code, never the schema.** An older archive redeploys over
  a newer schema without harm; the extra columns are ignored. The
  `cds_model` row keeps the newer CSN, so the next forward deployment
  computes its delta from the schema that really exists.

## Not automated yet

- Deployment to the spaces is a manual `cf deploy` by the operator with
  their own login; a pipeline with a technical user and space-scoped
  credentials is a later item.
- The blue-green validation is a manual checklist; automating it behind
  `--skip-testing-phase` needs a smoke test that can log in.
- The release workflow builds with the MTA build tool installed at run
  time (`npm install -g mbt@1`); it has not run on GitHub yet and its
  first tag is the acceptance test.
