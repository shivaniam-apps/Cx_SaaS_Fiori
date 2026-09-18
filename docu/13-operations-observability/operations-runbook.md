# Operations runbook (pilot)

Roadmap item A10. How to run a deployed AdoptOps space from day to day:
what to look at, what the states mean, and what to do when something is
off. Deployment is [docu/05 deploy runbook](../05-deployment-tiers/deploy-runbook.md);
onboarding an S/4HANA system is [docu/15](../15-target-system-configuration/onboarding-a-target-system.md).

The pilot has no alerting: nobody is paged. The daily routine in section 1
is what stands in for it until Cloud Logging and Alert Notification land
(roadmap T4).

## 1. Daily routine

1. `/healthz` of `adops-basic-srv-<space>` answers `OK` and `cf apps` shows
   the expected instance count (two in prod).
2. Product Insights > Crash reports: new fingerprints since yesterday.
3. Extractions and Activation Runs: no task older than a few minutes still
   `RUNNING`, no unexplained `FAILED`.
4. Target Systems: every active system's last connection check is `OK`
   (rerun Test Connection for any that is stale or red).
5. Audit Log page: chain verdict `OK`.
6. Access Requests: pending requests decided.

## 2. Health and logs

| What | Where |
|---|---|
| Process health | `GET /healthz` on the server route; the Cloud Foundry health check uses the same endpoint (database readiness is A11) |
| Recent server log | `cf logs adops-basic-srv-<space> --recent` |
| Persistent log | the `application-logs` service instance bound to the server (BTP cockpit > the space > Services > `<space>-adops-basic-logging` > open the Logs viewer) |
| Client-side failures | Product Insights > Crash reports (render errors, window errors, unhandled rejections, API failures) |
| User feedback | Product Insights > Feedback |

Every request carries an `x-correlation-id`, minted by the client or the
server and echoed on the response. A crash report or feedback row shows the
id of the request it belongs to; search the server log for that id to find
the matching backend lines. Log components are named after the module
(`destination`, `user-management`, `basic-subscription`, `task-runner`, the
adapters); the `[startup]` lines still go to the console and move to
`cds.log` with A11.

Two server instances (prod) are safe: task claims are atomic and the audit
chain locks its per-tenant head row, so instances never write over each
other.

## 3. Background tasks

Extractions, analyses and activation executions run as rows in
`BackgroundTasks`, processed by the task runner inside the server
(`code/srv/srv/utils/task-runner.js`). Task types: `USAGE_EXTRACTION`,
`ANALYSIS`, `ACTIVATION_EXECUTION`.

| Status | Meaning |
|---|---|
| `QUEUED` | waiting for a free worker |
| `CLAIMED` | a worker took it (`ClaimedBy` = instance:pid:uuid) |
| `RUNNING` | in progress; `Phase`, `ProgressPercent`, `ProcessedItems` / `TotalItems` are updated as it goes |
| `SUCCEEDED` | done |
| `FAILED` | handler error, or attempts exhausted; `ErrorText` says which |
| `CANCELLED` | an operator called cancel and the handler stopped at its next checkpoint |
| `TIMED_OUT` | `DeadlineAt` passed while the task was still open |

Liveness: a worker heartbeats every 5 s. A `CLAIMED` or `RUNNING` task
without a heartbeat for 120 s is reclaimed: back to `QUEUED` while
`AttemptCount` is below `MaxAttempts` (2), otherwise `FAILED` with "went
silent". This is how a killed Cloud Foundry instance recovers without an
operator. Concurrency is per instance (`ADOPTOPS_TASK_CONCURRENCY`, 2 by
default, 1 in dev); the knobs are listed in the deploy runbook.

Where to look: the Extractions page shows extraction tasks, Activation Runs
shows executions; both poll `getTaskStatus`. `listActiveTasks` (PublicService)
lists everything open for a target system.

| Symptom | Cause | Action |
|---|---|---|
| Task `RUNNING`, heartbeat older than two minutes | instance died mid-task | none; the runner requeues it within the stale window |
| Repeated `FAILED` "went silent" | the handler dies each attempt (memory, crash) | `cf events adops-basic-srv-<space>`; check memory in the `.mtaext`; look for the correlation id in the log |
| `FAILED` with an S/4 message | destination, tunnel or authorization | Target Systems > Test Connection; then docu/15 |
| Extraction slow, log shows "slow" calls | S/4 or Cloud Connector capacity | lower `ADOPTOPS_ONPREM_CONCURRENCY`; check the connector's capacity |
| Need to stop a task | | `cancelTask` from the page; the handler honours it at the next checkpoint, the row ends `CANCELLED` |

Never requeue a task by editing the table. Activation executions in
particular resume (completed steps are skipped, verify-first turns a
repeated step into `SKIPPED`); they are never replayed wholesale.

## 4. Target systems and connectivity

Test Connection on the Target Systems page runs
`checkTargetSystemConnection`, stores the verdict on the row and shows one
line per ZADO endpoint.

| Stage | Meaning | Action |
|---|---|---|
| `DESTINATION` | the destination could not be resolved in the subscriber subaccount | name mismatch, missing destination, or the subaccount is not the one that subscribed (docu/15) |
| `SERVICE` | the usage service did not answer 200 to `UsagePeriods?$top=1` | Cloud Connector mapping, service not published, technical user authorization (docu/15) |
| `ACTIVATION` | usage is fine but the activation endpoint is wrong for the environment | see below |
| `OK` | both endpoints in their expected state | none |

The `ACTIVATE` endpoint is judged by the system's environment: on `DEV`
and `SANDBOX` it must be reachable (`OK`); on `QAS` and `PRD` it must be
`UNPUBLISHED`. `EXPOSED` on a QAS or PRD system is a safety finding: the
write unit is reachable where it must not be. Have basis remove the SICF
node `zado_act` (or unpublish the `ZADO_ACTIVATE_O4` binding) on that
system, then rerun the check.

Destination lookups are cached for five minutes; after changing a
destination either wait or restart the server.

## 5. Activation and transports

The operator's duties around an activation plan (the mechanics are
[docu/09](../09-activation-and-transport/object-key-contract.md)):

1. Simulate before executing. Execution is refused without a simulation,
   and the simulation reports which objects already exist and which steps
   carry a caveat (`SIMULATED_WARN`, for example an irreversible ICF
   activation).
2. Watch the run on Activation Runs. Every step ends `SUCCESS`, `WARNING`,
   `FAILED` or `SKIPPED` with its messages; a failed step stops the run.
3. Decide per failed step: fix the cause and resume (the engine skips
   completed steps), or skip it (`skipActivationStep`, which satisfies its
   dependents), or roll it back (`rollbackActivationStep`; irreversible
   steps are recorded as audit-only).
4. Release the plan's transport request from the Transports page
   (`releaseTransport`, with a simulate option). Statuses: `MODIFIABLE`,
   `RELEASING`, `RELEASED`, `RELEASE_FAILED`.
5. Hand the activation manifest (`readActivationManifest`) to basis for the
   QA and PROD replay of the local, non-transportable steps. Import status
   tracking behind the manifest is roadmap S10.

Every step is one commit in S/4HANA and every operator decision is an
audit event with the acting user.

## 6. Audit chain

The Audit Log page (Administrator) shows the result of `verifyAuditChain`.

| Verdict | Action |
|---|---|
| `OK` | none |
| `EMPTY` | no chained rows yet (fresh space) |
| `BROKEN` | stop writing, keep the database as it is, escalate. `FirstBrokenSequence` names the first row that does not verify; the usual causes are a partial database restore or table access outside the application |

`UnchainedEvents` counts rows from before the chain existed; they are
reported, not counted as broken. The chain proves internal consistency
only; external anchoring in the BTP Audit Log service is T3 (product-owner
decision PO-2).

## 7. Telemetry and retention

Product Insights > Settings (Administrator) switches feedback, usage,
crash and performance collection on and off per tenant, sets the identity
mode and the retention periods. Changes apply server-side within the
settings cache window and are audited.

Retention runs inside the server every
`ADOPTOPS_TELEMETRY_CLEANUP_INTERVAL_HOURS` hours (24 by default, 12 in
prod); "Run Retention Cleanup Now" runs the same deletion on demand. Pilot
feedback is never auto-deleted. In an incident where telemetry itself is
the problem, untick the affected stream and save; the server stops
persisting immediately.

## 8. Access requests

A user who lands on "Request Access" (no Member role) or on a restricted
page files a request naming the area (application, settings, product
insights, access requests). The Administrator decides on the Access
Requests page. On approval the server assigns the matching role collection
through the XSUAA API; if no collection with the expected name exists in
the subaccount, the request is marked `MANUAL` and the collection is
assigned in the BTP cockpit. Both outcomes are audited.

## 9. Data hygiene

- A wrong or test extraction is removed with `purgeExtractionRun`
  (AdminService, Administrator); it is audited.
- Identified usage mode is a per-system, audited opt-in on the Settings
  page; the privacy rules and the retention of identified data are in
  [docu/11](../11-privacy-pseudonymisation/pseudonymisation.md).
- Rotating a system's pseudonymisation secret (`ZADO_CFG_INIT` with
  "Rotate existing secret") changes every pseudonym: earlier extractions no
  longer join with later ones. Agree it with the AdoptOps administrator
  first and start a fresh extraction afterwards.

## 10. Incident quick reference

| Symptom | First check | Then |
|---|---|---|
| Login loop or 401 after login | the user's role collections in the subaccount that subscribed | trust configuration of the identity provider |
| Every S/4 call fails with 502 or 503 | Cloud Connector connected to the subscriber subaccount; Location ID on the destination matches the connector | mapping and exposed resources (docu/15) |
| S/4 answers 401 or 403 | technical user in the destination: locked, expired password, missing authorization | SU53 on the S/4 system under that user |
| Test Connection `EXPOSED` on QAS or PRD | | remove the SICF node / unpublish the binding (section 4) |
| Health check red after a deployment | `cf tasks adops-basic-db-deployer-<space>`, `cf logs ... --recent` | deploy runbook section 5 |
| Extraction returns no periods | SAP workload collector (`SAP_COLLECTOR_FOR_PERFMONITOR`) not running or ST03N retention too short | basis on the S/4 system; `SystemInfo.CollectorRunning` shows the flag |
| Database growing | retention settings, old extraction runs | section 7 and 9 |

## Not yet in place

| Item | Roadmap |
|---|---|
| Readiness probe with a database check | A11 |
| BTP Audit Log service binding (external anchor for the chain) | T3 |
| Cloud Logging, Alert Notification, task-failure alerts | T4 |
| Release process, blue-green | T5 |
| Secret rotation runbook, security review, `docu/16` troubleshooting | T6 |
| Server-side telemetry rate limiting | A13 |
