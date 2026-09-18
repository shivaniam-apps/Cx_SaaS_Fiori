# Deploy runbook: first deployment and every redeployment

Roadmap item A10. This is the step-by-step procedure for putting one
Cloud Foundry space (`dev`, `qa` or `prod`) of the **provider** subaccount
on the air and keeping it current. The two chapters next to it explain the
mechanics this runbook relies on: [environments.md](environments.md)
(one MTA, one extension descriptor per space) and
[postgres-schema-deployment.md](postgres-schema-deployment.md) (the
database deployer and its additive-only migrations). Onboarding customer
S/4HANA systems is [docu/15](../15-target-system-configuration/onboarding-a-target-system.md);
day-two operation is [docu/13](../13-operations-observability/operations-runbook.md).

## 1. Prerequisites (once per subaccount)

| Area | Requirement |
|---|---|
| Subaccount | Cloud Foundry environment enabled; one space per stage (`dev`, `qa`, `prod`); the person deploying is Space Developer |
| Entitlements | `xsuaa` (application), `postgresql-db` (`development` for dev, `standard` for qa/prod), `connectivity` (lite), `destination` (lite), `html5-apps-repo` (app-host and app-runtime), `saas-registry` (application), `application-logs` (lite for dev/qa, standard for prod) |
| Identity | The subaccount's trust to an identity provider (default SAP ID service is enough for the pilot) |
| Workstation | Node 22, npm, `cf` CLI v8 with the `multiapps` plugin, `mbt` |
| Checkout | The **primary** checkout on `main` (a worktree with junctioned `node_modules` cannot run `mbt build`, see environments.md) |

Service instances, apps and the XSUAA application are created by the
deployment itself, all named from the space (`${space}-adops-basic-uaa`,
`adops-basic-srv-${space}` and so on). Nothing is created by hand.

## 2. Build

```bash
cd deploy/cf && mbt build
```

The build installs the server dependencies, runs `npm run build:basic`
(`cds build --production` plus the `prepare-basic-runtime` check that the
deployer CSN matches the runtime CSN), builds the client and packages
everything as `mta_archives/adops-basic_<version>.mtar`. The version comes
from `mta.yaml`; every `mtaext/*.mtaext` carries the same version, and a
mismatch fails the deploy. T5 defines when the version is bumped.

Keep the produced `.mtar` (or its CI artefact): it is what you redeploy to
roll back.

## 3. Deploy

```bash
cf login -a <api-endpoint> --sso
```

```bash
cf target -s dev && cf deploy mta_archives/adops-basic_0.1.0.mtar -e mtaext/dev.mtaext
```

Replace `dev` on both sides with `qa` or `prod`. The MTA deployer then, in
this order:

1. creates or updates the service instances (the PostgreSQL instance
   dominates the first deployment's duration);
2. pushes `adops-basic-db-deployer-<space>` without starting it and runs
   its task `deploy-to-postgresql`, which creates every table and view on an
   empty database or applies the additive delta to an existing one;
3. starts `adops-basic-srv-<space>` only after that task succeeded (the
   module requires the deployer) and waits for its HTTP health check on
   `/healthz` (up to 180 s);
4. pushes the approuter `adops-basic-<space>` and uploads the client to the
   HTML5 repository.

A failure in step 2 stops the deployment before the new server starts;
read the task log (section 5) and rerun the same command after fixing the
cause. Redeployments run exactly the same sequence.

## 4. Verify

```bash
cf apps
```

Expected: `adops-basic-<space>` and `adops-basic-srv-<space>` started,
`adops-basic-db-deployer-<space>` stopped (it is `no-start` by design; a
stopped deployer is not an error).

```bash
cf tasks adops-basic-db-deployer-<space>
```

The latest `deploy-to-postgresql` task must show `SUCCEEDED`.

```bash
curl -s https://adops-basic-srv-<space>.<default-domain>/healthz
```

Expected: `OK`. `/healthz` proves the process is up, not that the database
answers; a readiness probe with a database check is roadmap item A11.

```bash
cf logs adops-basic-srv-<space> --recent | grep -E "startup|connectivity|listening"
```

The line `[startup] Connectivity proxy effective host=... port=...`
confirms the connectivity binding. Then open the approuter URL
(`cf app adops-basic-<space>` prints it): the identity provider login must
appear, and a user without a role collection lands on the "Request Access"
screen, which is correct.

## 5. Reading the deployer task log

```bash
cf logs adops-basic-db-deployer-<space> --recent
```

Look for the `cds-deploy` output. "Dropping elements is not supported" or
"length reduction is not supported" means the model change is not additive;
the deployer refuses it and nothing was applied. The manual path for such
changes is in postgres-schema-deployment.md. A first deployment against a
database that already has tables but no `cds_model` row fails on
`CREATE TABLE`; the same chapter explains how to seed `cds_model`.

## 6. Role collections (per space)

The deployment creates four role collections in the subaccount that hosts
the XSUAA instance. Assign them in the BTP cockpit under Security > Role
Collections; the first assignment after a fresh deployment is the
Administrator, because only an Administrator can decide access requests.

| Role collection | Grants | Typical holder |
|---|---|---|
| AdoptOps Member (`<space>`) | read usage analyses and proposals, run extractions | analysts, functional consultants |
| AdoptOps Approver (`<space>`) | Member plus approve / reject / defer proposals | process owners |
| AdoptOps Activator (`<space>`) | Approver plus execute activation plans and release transports in S/4HANA DEV | basis, Fiori administrators |
| AdoptOps Administrator (`<space>`) | target systems, settings, overlay curation, telemetry, access requests, audit verification, SaaS administration | the pilot administrator |

Everyone else asks from inside the app: a user without a role sees "Request
Access", the Administrator decides on the Access Requests page, and the
grant is applied automatically through the XSUAA API when a role collection
with the expected name exists (otherwise the request is marked MANUAL and
the collection is assigned in the cockpit). The scopes and role templates
behind the collections are in `deploy/cf/config/xs-security.json`.

## 7. Subscribing a consumer subaccount

The provider subaccount runs the application; a **consumer** subaccount is
what a customer subscribes from, and it is where that customer's S/4HANA
destinations live (docu/15). For the pilot the provider subaccount may
subscribe to itself; the steps are the same.

1. In the consumer subaccount (same region), open Services > Instances and
   Subscriptions, choose `AdoptOps (<space>)` and the plan (`basic` or
   `standard`).
2. The SaaS registry calls the server's subscription callback, which
   answers with the tenant URL `https://<subdomain>-adops-basic-<space>.<default-domain>`.
   The route must exist:

```bash
cf map-route adops-basic-<space> <default-domain> --hostname <subdomain>-adops-basic-<space>
```

3. Assign the role collections to the consumer's users in the consumer
   subaccount.
4. Open the tenant URL and run the target-system onboarding (docu/15).

Today the callbacks only resolve the URL; tenant rows on subscribe and
purge on unsubscribe are roadmap item T2, and the server registers the
callbacks only when `ADOPTOPS_TIER` is `basic` (idea I27, also T2).

## 8. Redeploying

Run the build and the same `cf deploy` command with the new archive. The
database delta is applied first, then the server is restarted; expect a
short outage of the API while the health check passes. Blue-green
deployment and the release checklist arrive with T5.

## 9. Rolling back

There is no automated rollback. Redeploy the previous `.mtar` with the same
extension descriptor. Because the schema only ever grows, an older server
runs correctly against a newer schema: it does not read the columns it does
not know. Do not attempt to roll the schema back.

## 10. Runtime configuration

Every product knob is read through `code/srv/srv/utils/env.js`, which
resolves `ADOPTOPS_<name>`, then `ADOPS_<name>`, then the bare name. Set
persistent values in the space's `.mtaext` (they survive redeployments);
`cf set-env` plus `cf restart` is for a temporary experiment only, because
the next deployment overwrites it.

| Variable | Default | Meaning |
|---|---|---|
| `ADOPTOPS_TIER` | `basic` | tier; `basic` registers the subscription callbacks |
| `ADOPTOPS_DB_MODE` | `postgres` | persistence; never change in CF |
| `CORS_ORIGINS` | approuter URL | allowed browser origins; dev adds the local client ports |
| `ADOPTOPS_S4_SERVICE_ROOT` | `/sap/opu/odata4/sap/zado_usage_o4/srvd/sap/zado_usage_srv/0001` | default ZADO usage service root; a target system can override it |
| `ADOPTOPS_TASK_CONCURRENCY` | `2` | background tasks claimed per server instance |
| `ADOPTOPS_TASK_HEARTBEAT_MS` | `5000` | worker heartbeat |
| `ADOPTOPS_TASK_STALE_MS` | `120000` | a task without heartbeat for this long is reclaimed |
| `ADOPTOPS_TASK_POLL_MS` | `3000` | queue polling interval |
| `ADOPTOPS_TELEMETRY_CLEANUP_INTERVAL_HOURS` | `24` | retention scheduler; `0` disables, capped at `168` |
| `ADOPTOPS_ONPREM_CONCURRENCY` | `4` | parallel calls through the connectivity proxy per destination |
| `ADOPTOPS_ONPREM_KEEPALIVE` | unset | `on` / `off` overrides the keep-alive heuristic for on-premise calls |
| `ADOPTOPS_S4_SLOW_MS` | `2500` | S/4 calls slower than this are logged as slow |
| `ADOPTOPS_DESTINATION_CACHE_TTL_MS` | `300000` | destination lookup cache; a changed destination is picked up after this or a restart |
| `ADOPTOPS_CSRF_CACHE_TTL_MS` | `1200000` | CSRF token cache for S/4 writes |

Never set in Cloud Foundry: `ADOPTOPS_MOCK_S4`, `ADOPTOPS_S4_URL_OVERRIDES`,
`ADOPTOPS_S4_DIRECT_USER`, `ADOPTOPS_S4_DIRECT_PASSWORD`,
`ADOPTOPS_S4_DIRECT_INSECURE_TLS` (development conveniences, see
[docu/06 direct access](../06-s4-integration/direct-access.md)) and
`ADOPTOPS_S4_DESTINATION` (there is no default destination in CF; every
target system carries its own).

## 11. Secrets

The MTA contains none. XSUAA, PostgreSQL, destination and connectivity
credentials are service bindings that Cloud Foundry injects. The
pseudonymisation secret lives inside each S/4HANA system (`ZADO_CFG`,
docu/11) and the per-tenant salt in the `TenantSecrets` table, generated
on first use. The secret rotation runbook is T6.

## Known limits

- `/healthz` does not check the database (A11).
- No blue-green deployment, no release checklist (T5).
- Only the `basic` tier registers subscription callbacks (I27, T2).
- Logging is the `application-logs` service; Cloud Logging and alerts arrive
  with T4. Until then, operators look, nobody is paged (docu/13).
