# CI gate

Roadmap item A6. `.github/workflows/ci.yml` runs on every pull request and
on `main` after a merge. It is the same set of commands the worktree brief
asks for before a push, run on Linux with a clean install.

## Jobs

| Job | Working directory | Steps |
|---|---|---|
| CAP server | `code/` | `npm ci`, `npm run lint`, `npm test` (mocha, in-memory sqlite, incl. the load suite at scale 1), `npm run build:basic` (cds production build plus the PostgreSQL deployer / runtime CSN check) |
| Client | `code/app/adops-client/` | rolldown lock check, `npm ci`, `npm run lint`, `npm test` (`node --test`), `npm run build` (Vite on Linux, the platform the CF build uses) |
| Program tracker | repo root | `node scripts/tracker.mjs --check`, `node scripts/release.mjs check` (one product version across the MTA descriptors and package files) |

The jobs are independent, so a client lint failure and a server test failure
are reported side by side. A new push to the same branch cancels the run in
progress.

## Release workflow

`.github/workflows/release.yml` runs on a pushed tag `vX.Y.Z`: it checks
that the tag matches the product version, installs the Cloud MTA Build
Tool, runs `mbt build` on Linux, uploads `adops-basic_X.Y.Z.mtar` as a
workflow artefact and attaches it to a GitHub release with generated
notes. The archive it produces is the one deployed to every space
([docu/05 release process](../05-deployment-tiers/release-process.md)).

## What "blocks the PR" means here

GitHub branch protection and rulesets are not available on this plan
(private repository, personal account), so a red check does not disable the
merge button. The rule in `.claude/rules/git-workflow.md` applies: a PR is
merged only with all three jobs green, and the reviewer checks the status
before squash-merging. The `.githooks/pre-push` hook keeps `main` PR-only;
it does not run tests, because the full server suite and a client build take
long enough to make people skip the hook.

## Server lint

`code/eslint.config.mjs` uses the same baseline as the client
(`@eslint/js` recommended). CommonJS for `srv/` and `scripts/*.js`, ESM for
`*.mjs` and the mocha suites. The cds query builders (`SELECT`, `INSERT`,
`UPDATE`, `UPSERT`, `DELETE`) are declared as globals because cds injects
them at runtime. Unused function arguments and unused catch bindings are
allowed; unused variables are errors.

```bash
cd code && npm run lint
```

## Server tests are `.mjs`

`code/test/*.test.mjs`: the suites are ES modules, and Node printed
`MODULE_TYPELESS_PACKAGE_JSON` on every run while they were `.js` files
inside a CommonJS package. Mocha's default spec pattern picks up `.mjs`
without configuration. New suites use the `.mjs` extension; the shared
server helper lives in `code/test/helpers/cds-http-test.mjs`.

## Rolldown lock check

`code/app/adops-client/scripts/check-rolldown-lock.mjs` (also
`npm run lock:check`) fails when `package-lock.json` lacks the Linux x64
rolldown binary. The CI client job runs it before `npm ci`, so a lock that
was regenerated on Windows with `node_modules` present (the npm bug in
`.claude/rules/frontend-dependencies.md`) fails with an explicit message
instead of a module-not-found error deep in the Vite build.

## Accessibility gate

The client suite includes `src/features/a11y/staticAudit.test.js`, which
scans every page, layout and component for UI5 controls without an
accessible name: icon-only buttons, fields without a linked Label or
`accessibleName`, tables, toggles, icons that are not decorative, dialogs
without a header, native fields without `aria-label`. A new control that
misses its name fails the client test job. `npm run a11y:audit` in
`code/app/adops-client` prints the findings with file and line.

## Running the same checks locally

```bash
cd code && npm run lint && npm test && npm run build:basic
```

```bash
cd code/app/adops-client && npm run lock:check && npm run lint && npm test && npm run build
```

In a worktree with junctioned `node_modules`, `npm ci` is unsafe (it empties
the primary checkout's modules); the commands above never run it.
