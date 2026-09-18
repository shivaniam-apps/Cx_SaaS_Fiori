# Onboarding a target system

Roadmap item A10. Everything needed to connect one SAP S/4HANA system to
AdoptOps, from the ABAP add-on to the first extraction. Written so the
pilot administrator can onboard RD1 without help; the steps on the S/4
side are for the customer's basis team.

## Concepts

AdoptOps keeps four things apart, and this runbook does too
(`.claude/rules/sap-backend.md`):

| Concept | Where it lives | Example |
|---|---|---|
| **Target system** | a row on the Target Systems page (display name, SID, client, environment, options) | "RD1 Development" |
| **SAP system identity** | SID and client, informational | `RD1` / `100` |
| **BTP destination** | in the **consumer** subaccount that subscribed to AdoptOps; the only routing identity AdoptOps stores is its name | `RD1_DEV_100` |
| **Cloud Connector Location ID** | on the destination and the connector, resolved at call time, never stored by AdoptOps | `SCC_HQ` |

A destination is one system **and one client**: usage statistics have no
client dimension, but roles, users and every activation write do.

**Source and target.** Usage and role/user inventories should come from the
most representative system, normally PROD (DEV usage is technical noise).
Activation writes go only to the DEV customizing client, and transportable
changes travel DEV > QA > PROD through CTS. Onboard each system as its own
target system; in the pilot RD1 client 100 stands in for both.

## Overview

| Step | Who | Where |
|---|---|---|
| 1. Install the ZADO add-on | basis | S/4HANA DEV, then transport |
| 2. Configure the add-on per system | basis | every S/4HANA system and client |
| 3. Technical user | basis | every S/4HANA system |
| 4. Cloud Connector mapping | customer network admin | Cloud Connector |
| 5. Destination | BTP subaccount admin | consumer subaccount |
| 6. Register the target system | AdoptOps Administrator | AdoptOps > Target Systems |
| 7. Test Connection | AdoptOps Administrator | AdoptOps > Target Systems |
| 8. Settings | AdoptOps Administrator | AdoptOps > Settings |
| 9. First extraction | AdoptOps Member | AdoptOps > Extractions |

## Step 1: install the ZADO add-on

The add-on is the abapGit repository
[shivaniam-apps/a4h_2023_zado](https://github.com/shivaniam-apps/a4h_2023_zado)
(`abap/` in this repository is its mirror). Pull it into DEV with abapGit
into package `ZADO` (folder logic PREFIX, starting folder `/src/`), record
the objects on a workbench request and activate. Packages:

| Package | Content | Runs where |
|---|---|---|
| `ZADO_CORE` | configuration (`ZADO_CFG`), read-only probe reports | every system |
| `ZADO_USAGE` | usage, user and role readers, pseudonymisation, offline export, OData V4 service `ZADO_USAGE_SRV` | every system; PROD needs it |
| `ZADO_ACTIVATE` | the write unit (PFCG, ICF, launchpad content, CTS), its ICF handler and OData binding | code may travel with the transport; **published in DEV only** (step 2) |

`ZADO_USAGE` never depends on `ZADO_ACTIVATE`, which is what makes the
PROD install defensible to a change-advisory board. `ZADO_CFG` is
application data and is not transported.

Optional but recommended on the first system of a landscape: run the
read-only report `ZADO_PROBE_APIS` (SE38) and attach its output to
docu/06; it confirms the SAP APIs and, most importantly, that the workload
collector job `SAP_COLLECTOR_FOR_PERFMONITOR` is running. Without it there
is no usage history.

## Step 2: configure the add-on per system

**Every system, every client AdoptOps reads from** (the productive client
in PROD, client 100 in DEV):

1. Run `ZADO_CFG_INIT` (SE38) with "Rotate existing secret" **unticked**.
   It generates the pseudonymisation secret in `ZADO_CFG` and prints
   "generated and stored"; on a second run it prints "present, nothing
   changed". The secret is never displayed, exported or transported. Record
   the date, not the secret. Without it the add-on falls back to a
   system-derived salt that does not resist guessing
   ([docu/11](../11-privacy-pseudonymisation/pseudonymisation.md)).
2. Publish the OData V4 service binding `ZADO_USAGE_O4` for
   `ZADO_USAGE_SRV` (binding editor "Publish", or `/IWFND/V4_ADMIN`).
3. Smoke test in a browser on the S/4 host:

```text
/sap/opu/odata4/sap/zado_usage_o4/srvd/sap/zado_usage_srv/0001/UsagePeriods?$top=5
```

**DEV only**, the activation write unit. Publication is the safety gate
and stays manual; nothing here is transported:

4. In SICF create the node `default_host/sap/bc/zado_act` with handler
   class `ZCL_ADO_ACT_HTTP` and standard logon, then activate the node.
   `GET` on it answers a JSON identity (system, client, add-on version),
   which is what Test Connection probes.
5. Alternative: publish the OData V4 binding `ZADO_ACTIVATE_O4` and set
   the target system's activation root path to its service root
   (`/sap/opu/odata4/...`). The default root is the SICF node.

**QA and PROD**: do neither 4 nor 5. Test Connection reports `EXPOSED`
when the write unit answers on a `QAS` or `PRD` system, and the
environment field blocks activation there regardless.

Optional in DEV: `ZADO_ACTIVATE_SMOKE` (SE38) executes one step with the
planner's key shapes and shows the verify-first behaviour on a second run
([docu/09](../09-activation-and-transport/object-key-contract.md)). Clean up
its transport request and the smoke role afterwards.

## Step 3: technical user

One user per system and client, type Communication or System, whose
credentials go into the destination (step 5) and nowhere else. AdoptOps
never sees them.

| System | Needs |
|---|---|
| every system | call the OData V4 service `ZADO_USAGE_SRV` (`S_SERVICE` for it); read workload statistics (the `SWNC_*` collector reads), user master and role assignments (`USR02`, `AGR_*`) for the inventories |
| DEV in addition | everything the write unit does: PFCG role create / profile generation, ICF node activation, launchpad space and page content, transport request create / append / release (`Z_ADO_ACT_EXEC_STEP` is the RFC authorization the add-on ships) |

Derive the exact authorization objects from an ST01 trace of the first
extraction and, on DEV, of a `ZADO_ACTIVATE_SMOKE` run under that user; the
confirmed list belongs in docu/10 (roadmap T6). Set the password to
non-expiring or plan its rotation; an expired password shows up as stage
`SERVICE` with 401.

## Step 4: Cloud Connector

The Cloud Connector runs in the customer network and connects to the
**consumer subaccount**, the one that subscribed to AdoptOps. If the
subaccount has more than one connector, give this one a Location ID and
note it for step 5.

Cloud To On-Premise mapping, one per S/4 system:

| Setting | Value |
|---|---|
| Back-end type | ABAP System |
| Protocol | HTTPS (or HTTP inside a trusted network) |
| Internal host and port | the S/4 application server or web dispatcher, ICM port |
| Virtual host and port | a stable alias, e.g. `rd1dev:44300`; this is what the destination URL uses |
| Principal type | None (basic authentication in the destination) |

Exposed resources for that mapping, "path and all sub-paths":

| Path | Systems |
|---|---|
| `/sap/opu/odata4/sap/zado_usage_o4/` | every system |
| `/sap/bc/zado_act` | DEV only |
| `/sap/opu/odata4/sap/zado_activate_o4/` | DEV only, and only if step 2.5 was chosen |

Expose nothing else. A QA or PROD mapping without the activation paths is
the second line of defence after "not published".

## Step 5: destination in the consumer subaccount

One destination per system and client, created under the consumer
subaccount's Connectivity > Destinations. AdoptOps resolves it with a
tenant-scoped token, so a destination in the provider subaccount is not
found unless the provider is also the subscriber (pilot).

| Field | Value |
|---|---|
| Name | your convention, e.g. `RD1_DEV_100`; this exact string goes into AdoptOps |
| Type | HTTP |
| URL | `https://<virtual host>:<virtual port>` from the mapping |
| Proxy Type | OnPremise |
| Authentication | BasicAuthentication with the technical user from step 3 |
| Location ID | the connector's Location ID, only if one was set |
| Additional property `sap-client` | the client, e.g. `100` |

"Check Connection" in the cockpit only proves the connector path; the
service and authorization are proven in step 7.

## Step 6: register the target system in AdoptOps

Target Systems page (Administrator), "New target system":

| Field | Value |
|---|---|
| Display name | what users see, e.g. "RD1 Development" |
| BTP destination name | exactly the destination name from step 5 |
| SAP system ID | `RD1` |
| Client | `100` |
| Environment | `DEV`, `QAS`, `PRD` or `SANDBOX`. This decides the activation semantics: plans execute only against `DEV` and `SANDBOX`, and Test Connection expects the write unit unpublished on `QAS` and `PRD` |
| S/4 release | `2023` |

The row also carries two path overrides for systems whose bindings were
published under other names: the usage service root (defaults to the
`ZADO_USAGE_O4` path) and the activation root (defaults to
`/sap/bc/zado_act`; set the OData root if step 2.5 was chosen). The
activation root is edited on the Settings page.

## Step 7: Test Connection

Press Test Connection on the row. The verdict is stored on the row and
lists one line per endpoint.

| Result | Meaning | Fix |
|---|---|---|
| Stage `DESTINATION` | destination not found | name typo, destination in the wrong subaccount, subscription missing |
| `USAGE` `SERVICE` with 404 | service path not reachable | binding not published, mapping path not exposed, wrong `sap-client` |
| `USAGE` `SERVICE` with 401 / 403 | technical user | locked, expired, missing authorization (SU53 on the S/4 system) |
| `USAGE` `SERVICE` with 502 / 503 or a timeout | connector path | connector disconnected, Location ID mismatch, virtual host mismatch |
| `ACTIVATE` `SERVICE` on `DEV` | write unit not published | step 2.4 or 2.5; or the activation root override is wrong |
| `ACTIVATE` `EXPOSED` on `QAS` / `PRD` | safety finding | remove the SICF node or unpublish the binding on that system |
| `ACTIVATE` `UNPUBLISHED` on `QAS` / `PRD` | as required | none |
| Stage `OK` | done | continue |

A changed destination takes effect after the destination cache expires
(five minutes) or a server restart.

## Step 8: settings

Settings page (Administrator), per target system:

- **Usage mode**: pseudonymised by default. Identified mode is an audited
  opt-in that requires the legal basis described in docu/11; enabling it
  writes an audit event with the acting user.
- **Activation root path**: only when step 2.5 was chosen.

## Step 9: first extraction

Extractions page, "New extraction": choose the target system, the sources
(ST03N, STAD, AGR, USR02, FIORI), the period, top users per transaction
and the minimum executions. The extraction runs as a background task; its
progress and messages are on the page ([docu/13](../13-operations-observability/operations-runbook.md)
section 3 explains the states). No periods found means the workload
collector is not running or the ST03N retention does not cover the window.

**Offline bridge.** While the Cloud Connector path is not open yet, run
`ZADO_EXPORT_USAGE` (SE38) on the S/4 system, download the JSON file and
use "Import Extract" on the Extractions page. The file is pseudonymised
with the same secret and becomes a normal extraction run. An identified
export requires an explicit tick in the report, mirroring the audited
opt-in.

## Checklist per environment

| Item | DEV | QAS | PRD |
|---|---|---|---|
| ZADO add-on installed and active | yes | via transport | via transport |
| `ZADO_CFG_INIT` run in the client AdoptOps reads | yes (100) | yes | yes (productive client) |
| `ZADO_USAGE_O4` published | yes | yes | yes |
| SICF node `zado_act` or `ZADO_ACTIVATE_O4` published | yes | **no** | **no** |
| Cloud Connector resource `/sap/bc/zado_act` | yes | no | no |
| Technical user with write authorizations | yes | no | no |
| Environment on the target system row | `DEV` | `QAS` | `PRD` |
| Expected Test Connection | `OK`, write unit reachable | `OK`, write unit unpublished | `OK`, write unit unpublished |

## RD1 pilot values

| | |
|---|---|
| System | RD1, S/4HANA 2023 |
| Activation client | 100 (customizing client, transports originate here) |
| Usage source | PROD when the connector path opens; until then RD1 itself or the offline export |
| Environment | `DEV` |
| Destinations | one for RD1 client 100 |

## Known gaps

- `SystemInfo` does not yet report whether the pseudonymisation secret is
  configured (idea I29); until it does, the "present, nothing changed"
  output of a second `ZADO_CFG_INIT` run is the confirmation.
- The confirmed authorization object list for the technical user is
  written with T6 (docu/10).
- Catalog derivation (`ZADO_CATALOG`) and the ABAP snapshot collector are
  roadmap S9 and S7; today an extraction reads ST03N live through the
  bounded readers.
