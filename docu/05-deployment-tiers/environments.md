# Environments: dev, qa, prod

Roadmap item A2. One MTA (`deploy/cf/mta.yaml`, ID `adops-basic`) deploys
to every Cloud Foundry space; what differs per space lives in an extension
descriptor under `deploy/cf/mtaext/` and is applied at deploy time.

## Rules for mta.yaml

- No environment identifiers. Service instances, apps and the XSUAA app are
  named from `${space}` (and `${org}` for XSUAA), the SaaS registry entry is
  `adoptops-${space}`, and no S/4 destination name appears anywhere: each
  `TargetSystems` row carries its own destination, configured in the
  subscriber subaccount (`.claude/rules/sap-backend.md`).
- `CORS_ORIGINS` defaults to the approuter URL of the same deployment.
  Browser traffic never reaches `adops-basic-srv` directly in CF, so this is
  the only origin production needs.
- `version` is the product version, shared with the extension descriptors
  and the package files and maintained by `node scripts/release.mjs set`;
  the mtar file name carries it. The semver rules and the release
  checklist are in [release-process.md](release-process.md).

## Extension descriptors

| File | Space | What it overrides |
|---|---|---|
| `mtaext/dev.mtaext` | `dev` | `CORS_ORIGINS` adds the local client ports (5273 primary, 5283/5293/5303/5313 worktrees) so a local client can call the dev srv; one srv instance; task concurrency 1; PostgreSQL plan `development`; Cloud Logging plan `dev` |
| `mtaext/qa.mtaext` | `qa` | one srv instance, task concurrency 2, PostgreSQL plan `standard` |
| `mtaext/prod.mtaext` | `prod` | two srv instances at 1 GB, task concurrency 2, telemetry cleanup every 12 h, approuter 256 MB, PostgreSQL and Cloud Logging plan `standard` |

Every descriptor `extends: adops-basic` and carries the same `version`.
Placeholders (`${space}`, `~{provided/property}`) work in extension files
exactly as in mta.yaml.

Service plans apply on instance creation. Changing a plan for an existing
instance is not an update the deployer performs; it needs `cf update-service`
first, or a new instance.

## Deploying

```bash
cd deploy/cf && mbt build
```

```bash
cf target -s dev && cf deploy mta_archives/adops-basic_0.1.0.mtar -e mtaext/dev.mtaext
```

Replace `dev` with `qa` or `prod` on both sides. Without `-e` the deploy
still succeeds (mta.yaml is complete on its own) but with the base sizing and
no local CORS origins.

`mbt build` must run from a checkout whose `node_modules` are real folders:
in a worktree with junctioned modules its `npm ci` step would empty the
primary checkout's modules. Build from the primary checkout or from CI (A6).

To check a merged descriptor without deploying:

```bash
cd deploy/cf && mbt mtad-gen -e mtaext/prod.mtaext -t .mtad-check
```

## Runtime packages

`code/router/package.json` and `code/app/html5-deployer/package.json` pin
Node `22.x` like the CAP server, with `@sap/approuter ^20.5` and
`@sap/html5-app-deployer ^7`. Buildpack staging installs them; keep the three
`engines` fields in step.

## Known limits

- The SaaS registry `appName` changed from a fixed string to
  `adoptops-${space}`. A space that was registered under the old name keeps
  that registration until the instance is recreated; no space had been
  deployed when A2 landed.
- There is no default destination in the code (S11). A call without a
  destination name uses `ADOPTOPS_S4_DESTINATION` when the operator set
  one (single-system lab) and otherwise fails before any lookup with a
  message naming the target system; the connection check answers a
  DESTINATION verdict instead.
- A Cloud Foundry instance refuses to start when any development
  convenience is set (`ADOPTOPS_S4_URL_OVERRIDES`, `ADOPTOPS_S4_DIRECT_USER`
  / `_PASSWORD`, `ADOPTOPS_S4_DIRECT_INSECURE_TLS`, `ADOPTOPS_MOCK_S4`);
  outside CF they are logged as warnings at startup.
