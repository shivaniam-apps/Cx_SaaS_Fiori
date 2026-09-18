# Troubleshooting

Roadmap item T6. Known failure modes by symptom, with the cause and the
remedy, collected from the runbooks and the daily logs. Each row points to
the chapter that owns the detail. The first question is always: which
checkout, which server, which space answered? (`/readyz` prints the
version; a localhost 200 proves nothing about which process answered,
see [local-db rules](../14-local-development/parallel-worktrees.md).)

## Login and authorization

| Symptom | Cause | Remedy |
|---|---|---|
| Login loop, or 401 right after login | the user has no AdoptOps role collection in the subaccount that subscribed, or the identity provider trust is missing | assign the collection (deploy runbook section 6) or approve the user's access request; check the subaccount's trust configuration |
| Every page shows "Request Access" | the user is authenticated but holds no Member scope | same as above; the request lands on the Access Requests page |
| 403 on an action that the page offers | the action needs a higher role than the user has (Approver for decisions, Activator for plans and transports, Admin for AdminService) | [security model](../10-security-authorization/security-model.md) |
| Access request approved but the user still lacks the role | the grant fell back to `MANUAL` (no matching collection name, no XSUAA binding in the profile) | assign the collection in the cockpit; the request row shows `GrantStatus` |
| SaaS subscription fails with 401 or 403 | the registry's token lacks the `mtcallback` scope (wrong xsappname, plan not registered) | compare the registry instance's xsappname with the XSUAA instance of the same space |

## S/4HANA connectivity

| Symptom | Cause | Remedy |
|---|---|---|
| Test Connection stage `DESTINATION` | destination not found in the subscriber subaccount, or name typo on the target system | docu/15 step 5 and 6 |
| Stage `SERVICE` with 404 | usage binding `ZADO_USAGE_O4` not published, path not exposed in the Cloud Connector, wrong `sap-client`, or a service-root override that does not match | docu/15 step 2 and 4; clear the override |
| Stage `SERVICE` with 401 or 403 | technical user locked, password expired or missing authorization | `SU53` under that user on the S/4 system; rotate per the secret rotation runbook |
| Stage `SERVICE` with 502, 503 or a timeout, message mentions the Connectivity proxy | Cloud Connector disconnected, Location ID mismatch, virtual host mismatch; locally: the SSH tunnel to the proxy is not running | docu/15 step 4 and 5; locally `npm run srv:hybrid:check` and the tunnel from docu/14 |
| `ACTIVATE` `SERVICE` on a DEV system | the SICF node `zado_act` (or the `ZADO_ACTIVATE_O4` binding) is not published, or the activation root override is wrong | docu/15 step 2.4 / 2.5 |
| `ACTIVATE` `EXPOSED` on QAS or PRD | the write unit answers where it must not | remove the SICF node or unpublish the binding on that system, rerun the check |
| "S/4 path must be relative to the destination" | a path with a scheme, `//host` or backslashes was passed to a connection check or the proxy action | pass a path such as `/sap/opu/odata4/...`; the guard exists to keep credentials inside the destination |
| Direct-access variables ignored or refused | `ADOPTOPS_S4_URL_OVERRIDES` and friends are development switches; Cloud Foundry refuses them (S11) | remove them from the space; use destinations |
| CSRF token errors on writes | the write unit's session expired between token fetch and call | the transport retries once with a fresh token; if it persists, check the SICF node's logon settings |

## Extractions, proposals and tasks

| Symptom | Cause | Remedy |
|---|---|---|
| Extraction returns no periods | `SAP_COLLECTOR_FOR_PERFMONITOR` not running, or ST03N retention shorter than the requested window | basis on the S/4 system; `SystemInfo.CollectorRunning` shows the flag; choose a window inside the retention |
| Task stays `RUNNING` with an old heartbeat | the server instance running it died | nothing: the runner requeues it after the stale window (operations runbook section 4) |
| Task `FAILED` "went silent and attempts are exhausted" | the handler crashed on every attempt (memory, unhandled error) | `cf events`, the correlation id in Cloud Logging; raise the instance memory in the `.mtaext` |
| Task `TIMED_OUT` | the deadline for the task type passed | the S/4 side was slow or the tunnel stalled; rerun after the connection check is `OK` |
| An alert `AdoptOpsTaskFailed` arrived | any of the above | the alert body carries the error text and the correlation id |
| `generateProposals` answers 400 "is QUEUED" | the extraction run has not completed | wait for the task; the page polls it |
| Proposals list is short or empty | the mapped share of the usage is low (DEV usage is technical noise) or the overlay lacks the customer's transactions | extract from PROD; curate the overlay on the Settings page (Administrator) |
| Import Extract answers 400 | the file is not a `ZADO_EXPORT_USAGE` export (missing format marker), carries no period, or holds no dialog transactions | export again from `SE38`; the sanitizer strips control bytes but not a wrong format |

## Activation and transports

| Symptom | Cause | Remedy |
|---|---|---|
| `createActivationPlan` refused: "development systems only" | the chosen or default target system is `QAS` or `PRD` | pass a `DEV` or `SANDBOX` system; QA and PROD receive content by transport |
| `executeActivationPlan` refused: "Simulate the plan first" | plans execute only from `SIMULATED`, `READY`, `PARTIAL` or `FAILED` | simulate; the blast-radius verdicts are required |
| A step ends `FAILED`, the run stops | `StopOnError` is on by default | fix the cause and execute again (resume skips completed steps), or skip the step (Activator), or roll it back |
| Rollback refused | the step is irreversible (ICF activation, task list) or not executed | irreversible steps are recorded audit-only (docu/09) |
| `releaseTransport` answers 400 "no TRKORR" | the transport row was created without a request number (execution stopped before `ADD_TO_TRANSPORT`) | resume the run; release afterwards |
| Transport `RELEASE_FAILED` | the S/4 release returned errors (open tasks, objects locked) | the release log text on the row; fix in `SE10`, release again |
| Manifest verification stays `MANUAL` for a kind | no read-unit entity exists for that object kind yet (S10) | verify by hand on the follow-on system and record the import |

## Deployment and operations

| Symptom | Cause | Remedy |
|---|---|---|
| `cf deploy` fails in the db deployer task: "Dropping elements is not supported" | the model change is not additive | [schema deployment](../05-deployment-tiers/postgres-schema-deployment.md); two releases to remove a field |
| db deployer fails on `CREATE TABLE` against an existing schema | no `cds_model` row (schema created before A1) | seed `cds_model` per the schema chapter |
| deploy refused: version mismatch between `mta.yaml` and the extension descriptor | the descriptors carry different versions | `node scripts/release.mjs check` and `set` |
| Health check red after a deployment | the deployer task did not finish, or a binding is missing | `cf tasks` on the deployer, `cf logs --recent` (deploy runbook section 5) |
| `/readyz` 503 | PostgreSQL does not answer within five seconds | `cf service <space>-adops-basic-postgres`; the server recovers on its own |
| No alerts although tasks fail | the Alert Notification instance has no subscription, or the binding is missing (log says `ALERT (not sent)`) | operations runbook section 3 |
| No lines in Cloud Logging | binding missing, or the app runs a profile without JSON logging | check the binding; the production profile logs JSON |
| Feedback answers 429 | per-user rate limit reached | wait for the window (operations runbook section 8); raise the knob if legitimate |
| Blue-green testing phase stuck | the operator never resumed or aborted | `cf mta-ops`, then `cf deploy -i <id> -a resume` or `-a abort` |

## Local development

| Symptom | Cause | Remedy |
|---|---|---|
| Reads 500 after `git pull` or a merge | `code/db.sqlite` bakes the CDS views; they are stale | `npm run db:refresh:sqlite` (the `srv:*sqlite` scripts and the post-merge hook run it; `git pull --rebase` does not) |
| CAP dev server stops answering after a reload | `cds serve --watch` children on this machine stop serving after a reload | use the no-watch scripts (`srv:sqlite:nowatch`), restart by hand |
| A localhost smoke test passes although the server failed to start | another worktree or ChronoPilot answers on that port | check the listener's process (local-db rules); use the worktree's own port slot |
| `git pull` opens vi and strands a merge | the machine's editor is vi and `pull` builds a merge commit | `git pull --ff-only`; `git config --global pull.ff only` |
| `mbt build` empties the primary checkout's `node_modules` | the worktree's `node_modules` is a junction; `npm ci` inside the build clears the target | build from the primary checkout or CI |
| `cds env get ... --profile production` prints `plain` although production logs JSON | the CLI does not apply the root-level `[production]` block | verify with `NODE_ENV=production node -e` |
| Hybrid run: S/4 calls fail although bindings resolve | the connectivity proxy points to `localhost` and the SSH tunnel is not running | docu/14 running-in-bas.md, `npm run srv:hybrid:check` |
| Mocha run never finishes | a suite started a second `cds.test` server, or a handler left a request open | import `test` from `helpers/cds-http-test.mjs`; run the suite alone with `timeout` to find it |
| A later test suite counts rows it did not write | a suite with tenant-less users left `GLOBAL` rows (feedback, errors, usage events, access requests) | clean up in `after()`; tenant-scope.test.mjs runs late alphabetically |

## When nothing here fits

1. Take the correlation id from the error message, the crash report or the
   feedback row and search Cloud Logging (`cf logs --recent` locally).
2. Check the audit chain verdict and the last connection check of the
   target system involved.
3. File the failure mode here with the fix, and an idea in the tracker if
   the fix is not a one-liner.
