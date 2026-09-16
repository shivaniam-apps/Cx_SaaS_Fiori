# Ideas and parking lot

Anyone appends; nobody deletes. When an idea becomes work it gets a roadmap-style ID
and a To-do line in the owning workstream's tracker; the entry here gets a
"-> promoted to <ID>" note. Parked items keep the reason.

## Open

- I1 (2026-09-16) Dashboard KPI cards should link through to the filtered list they count (fiori-ux navigation rule); today the dashboard is a journey strip only.
- I2 (2026-09-16) `AdopsToast` success feedback component does not exist; pages use MessageStrips that a list reload wipes. Build once, use on Transports, Access Requests, Activation Runs.
- I3 (2026-09-16) The hardcoded catalog in `shipped-overlay-catalog.js` (42 rows) needs an owner for content verification of the F-numbers regardless of PO-1.
- I4 (2026-09-16) Worktrees share `node_modules` via junctions; a branch that changes dependencies must run `npm ci` locally. Consider a `worktree.mjs doctor` command that detects lockfile drift between a worktree and the primary checkout.
- I5 (2026-09-16) `cds serve --watch` children stop serving HTTP after a reload on this machine; root cause unknown (cds-dk 8.9). Investigate or document a supported restart shortcut.
- I6 (2026-09-16) Two "RD1 Development" target-system rows exist in the local dev sqlite (pre-existing); decide whether Target Systems should enforce unique destinationName per tenant.
- I7 (2026-09-16) Activation Runs list: KPI cards could act as status filters once the run query accepts a status parameter (same server expression for card and slice).

## Parked

(none)
