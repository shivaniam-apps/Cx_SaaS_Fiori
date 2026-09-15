# Running AdoptOps in SAP Business Application Studio

How to get from a fresh BAS dev space to the app running in the browser.
Everything below is driven by the npm scripts in `code/package.json` and the
profiles in `code/srv/.cdsrc.json`; if those change, this page is what to
update.

## 0. One-time: dev space

Use a **Full-Stack Cloud Application** dev space (it ships Node, `@sap/cds-dk`
and the CF CLI).

The project requires **Node 22.x** (`engines` in `code/package.json`). If the
dev space defaults lower:

    nvm use 22

> The repo-root `.nvmrc` currently says `v18`, which predates the `engines`
> constraint. `engines` is authoritative.

## 1. Get the code

Terminal → New Terminal:

    git clone https://github.com/shivaniam-apps/Cx_SaaS_Fiori.git

Then **File → Open Workspace** on the cloned folder.

## 2. Install dependencies

There are two package roots — install both, and keep the output short (the
install logs are long and stay in any assistant's context):

    cd Cx_SaaS_Fiori/code && npm install 2>&1 | tail -n 20
    cd Cx_SaaS_Fiori/code/app/adops-client && npm install 2>&1 | tail -n 20

## 3. Pick a run mode

All scripts run from `code/`. Every mode uses **mocked auth** (you are
`alice`: Admin / Approver / Activator / Member) and serves CAP on **port 4104**.

| Mode | Command | DB | S/4 calls | CF bindings |
|---|---|---|---|---|
| **A. Fully local mock** | `npm run srv:sqlite` | SQLite | Mocked (`ADOPTOPS_MOCK_S4=true`) | none |
| **B. SQLite + real S/4** | `npm run srv:hybrid:sqlite` | SQLite | Real, via bound destination + Cloud Connector | destination, connectivity |
| **C. Full hybrid** | `npm run srv:hybrid` | PostgreSQL | Real | destination, connectivity, PostgreSQL |

- **A** is the fastest and needs no CF login. Use it for UI and CAP logic
  work; every S/4 response is mocked.
- **B** is the day-to-day mode for anything touching destinations, target
  systems, usage extraction or activation against a real system.
- **C** is closest to the deployed service; use it only when PostgreSQL
  behaviour matters.

`srv:sqlite:nowatch` is mode A without `--watch`, for scripted runs.

## 4. Bindings (modes B and C)

Log in to Cloud Foundry — Command Palette → **CF: Login to Cloud Foundry**,
or:

    cf login -a <api-endpoint> --sso

List the service instances in the space, then bind them once. `cds bind`
stores the result in `code/.cdsrc-private.json`, which is git-ignored:

    cf services
    cd Cx_SaaS_Fiori/code
    cds bind -2 zado-destination:zado-destination-key
    cds bind -2 <connectivity-instance>:<key>

For mode C also bind the PostgreSQL instance:

    cds bind -2 <postgres-instance>:<key>

Take the exact instance and key names from `cf services`. Verify the
bindings before starting a hybrid server:

    npm run srv:hybrid:check

The `srv:hybrid*` scripts run `cds bind --exec --profile hybrid`, so they
pick these bindings up automatically.

If your hybrid session must reach the Connectivity proxy through a CF SSH
tunnel, copy `code/.env.sample` to `code/.env` and set
`CONNECTIVITY_PROXY_HOST` / `CONNECTIVITY_PROXY_PORT` there.

## 5. Run — two terminals

Start the **backend first**; it owns port 4104 and the frontend proxies to it.

Terminal 1 — backend, e.g. mode B:

    cd Cx_SaaS_Fiori/code && npm run srv:hybrid:sqlite

Terminal 2 — frontend (Vite on port 5273; proxies `/fiori`, `/core` and
`/catalog` to 4104 with `alice` basic auth):

    cd Cx_SaaS_Fiori/code/app/adops-client && npm run dev

Both run with hot reload. Restarting after a BAS timeout is just re-running
the same two commands.

## 6. Open the app

When Vite starts, BAS offers **"A service is listening on port 5273 →
Expose and Open"** (or use the Ports view and expose 5273). Open **5273**,
not 4104 — 4104 is the API only. You land in the app as `alice`.

## Gotchas

- **Order matters.** Frontend up without the backend means every API call
  returns 502.
- **Port ownership.** AdoptOps is 4104. ChronoPilot (`Cx_SaaS_Job`) owns
  4004 on shared machines — never start AdoptOps on 4004.
- **Stale SQLite views after `git pull`.** `code/db.sqlite` bakes in the
  compiled CDS views. The `srv:*sqlite` scripts and the `post-merge` hook
  run `npm run db:refresh:sqlite` to heal this; if a read still 500s after a
  model change, run it by hand. `git pull --rebase` does not fire
  `post-merge`.
- **Destination errors in mode B** (`ECONNRESET`, "Backend is not available
  in the list of defined system mappings in Cloud connector") are Cloud
  Connector / destination configuration problems, not application bugs.
  Check the destination in the BTP cockpit with *Check Connection* first.
  See chapter 06 and chapter 15.
