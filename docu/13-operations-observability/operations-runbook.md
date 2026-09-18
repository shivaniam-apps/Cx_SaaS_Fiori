# Operations runbook (pilot)

Roadmap item A10. How to run a deployed AdoptOps space from day to day:
what to look at, what the states mean, and what to do when something is
off. Deployment is [docu/05 deploy runbook](../05-deployment-tiers/deploy-runbook.md);
onboarding an S/4HANA system is [docu/15](../15-target-system-configuration/onboarding-a-target-system.md).

Failed and timed-out background tasks page the operators through SAP
Alert Notification (section 3); everything else is still found by looking,
so the daily routine in section 1 stays.

## 1. Daily routine

1. `/readyz` of `adops-basic-srv-<space>` answers 200 and `cf apps` shows
   the expected instance count (two in prod).
2. Alert Notification: every `AdoptOpsTaskFailed` event of the last day has
   an owner (section 3).
3. Product Insights > Crash reports: new fingerprints since yesterday.
4. Extractions and Activation Runs: no task older than a few minutes still
   `RUNNING`, no unexplained `FAILED`.
5. Target Systems: every active system's last connection check is `OK`
   (rerun Test Connection for any that is stale or red).
6. Audit Log page: chain verdict `OK`.
7. Access Requests: pending requests decided.

## 2. Health and logs

| What | Where |
|---|---|
| Liveness | `GET /healthz` on the server route answers `OK` while the process is up; the Cloud Foundry health check uses it |
| Readiness | `GET /readyz` answers 200 with `{"status":"ok","version":"X.Y.Z","checks":{"db":{"ok":true,"ms":n}}}` (the version is the release that is running); 503 with `"status":"unavailable"` and the error text when the database does not answer within five seconds |
| Recent server log | `cf logs adops-basic-srv-<space> --recent` |
| Persistent log | SAP Cloud Logging: the `<space>-adops-basic-cloud-logging` instance (BTP cockpit > the space > Instances > open the dashboard). The server logs JSON under the production profile, so every line carries the level, the component, the correlation id and the message as fields; Cloud Foundry metrics and router logs arrive through the same binding. Retention is 14 days (`retentionPeriod` in `deploy/cf/mta.yaml`) |
| Client-side failures | Product Insights > Crash reports (render errors, window errors, unhandled rejections, API failures) |
| User feedback | Product Insights > Feedback |

Every request carries an `x-correlation-id`, minted by the client or the
server and echoed on the response. A crash report or feedback row shows the
id of the request it belongs to; search the server log for that id to find
the matching backend lines. Log components are named after the module
(`destination`, `user-management`, `basic-subscription`, `task-runner`, the
adapters, `startup` for the boot lines).

Two server instances (prod) are safe: task claims are atomic and the audit
chain locks its per-tenant head row, so instances never write over each
other.

## 3. Alerts

The server raises an `AdoptOpsTaskFailed` event through the bound SAP
Alert Notification instance (`<space>-adops-basic-alert-notification`,
`code/srv/srv/utils/alert-notification.js`) whenever a background task
ends `FAILED` or `TIMED_OUT`: a handler error after the last attempt, a
worker that went silent with no attempts left, or a deadline overrun. One
event per terminal failure; requeued attempts are not alerted.

| Field | Content |
|---|---|
| `eventType` | `AdoptOpsTaskFailed` |
| `severity` / `category` | `ERROR` / `ALERT` |
| `subject` | `AdoptOps <task type> <status>: <object type> <object id>` |
| `body` | error text, phase, attempts, tenant, target system, requester, correlation id, where to look |
| `resource` | the server app (`resourceName`, instance index) with tags `taskId`, `taskType`, `taskStatus`, `tenant`, `objectType`, `objectId` |

Who gets notified is configured once per space on the instance (BTP
cockpit > the space > Instances > `<space>-adops-basic-alert-notification`
> Manage instance): create a *condition* `eventType` equals
`AdoptOpsTaskFailed`, an *action* (email, Slack, Teams, webhook or a
ticketing system) and a *subscription* joining both. Test it from the
same screen ("Test action") before relying on it.

Without a binding (local runs, tests) the alert is written to the log as
`ALERT (not sent)` and nothing else happens; an unreachable service or a
refused event is logged as a warning and never changes the task outcome.
Alerts for other signals (a `BROKEN` audit chain, a 503 readiness) are
not raised yet.

## 4. Background tasks

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

## 5. Target systems and connectivity

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

## 6. Activation and transports

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

## 7. Audit chain

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

## 8. Telemetry and retention

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

Ingestion is rate limited per user and minute (feedback 5, crash reports
30, usage and performance batches 20 by default; a tenant ceiling of 20
times the user limit sits above them). A user over the feedback limit gets
HTTP 429 with a retry hint; crash reports and batches over the limit are
dropped without an error, and the server logs one line per window
(`Feedback rate limit`, `Client error rate limit`, `Telemetry batch rate
limit`) naming the user and tenant. The counters are per server instance,
so two instances allow about twice the configured number. The knobs are
in the deploy runbook.

## 9. Access requests

A user who lands on "Request Access" (no Member role) or on a restricted
page files a request naming the area (application, settings, product
insights, access requests). The Administrator decides on the Access
Requests page. On approval the server assigns the matching role collection
through the XSUAA API; if no collection with the expected name exists in
the subaccount, the request is marked `MANUAL` and the collection is
assigned in the BTP cockpit. Both outcomes are audited.

## 10. Data hygiene

- A wrong or test extraction is removed with `purgeExtractionRun`
  (AdminService, Administrator); it is audited.
- Identified usage mode is a per-system, audited opt-in on the Settings
  page; the privacy rules and the retention of identified data are in
  [docu/11](../11-privacy-pseudonymisation/pseudonymisation.md).
- Rotating a system's pseudonymisation secret (`ZADO_CFG_INIT` with
  "Rotate existing secret") changes every pseudonym: earlier extractions no
  longer join with later ones. Agree it with the AdoptOps administrator
  first and start a fresh extraction afterwards.

## 11. Incident quick reference

| Symptom | First check | Then |
|---|---|---|
| Login loop or 401 after login | the user's role collections in the subaccount that subscribed | trust configuration of the identity provider |
| Every S/4 call fails with 502 or 503 | Cloud Connector connected to the subscriber subaccount; Location ID on the destination matches the connector | mapping and exposed resources (docu/15) |
| S/4 answers 401 or 403 | technical user in the destination: locked, expired password, missing authorization | SU53 on the S/4 system under that user |
| Test Connection `EXPOSED` on QAS or PRD | | remove the SICF node / unpublish the binding (section 4) |
| Health check red after a deployment | `cf tasks adops-basic-db-deployer-<space>`, `cf logs ... --recent` | deploy runbook section 5 |
| `/readyz` answers 503 | the error text in its body; `cf service <space>-adops-basic-postgres` | PostgreSQL instance state in the cockpit; the server recovers on its own once the database answers again |
| Extraction returns no periods | SAP workload collector (`SAP_COLLECTOR_FOR_PERFMONITOR`) not running or ST03N retention too short | basis on the S/4 system; `SystemInfo.CollectorRunning` shows the flag |
| Database growing | retention settings, old extraction runs | sections 8 and 10 |

## Not yet in place

| Item | Roadmap |
|---|---|
| BTP Audit Log service binding (external anchor for the chain) | T3 |
