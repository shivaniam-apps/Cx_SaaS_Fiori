---
paths:
  - "code/db/**"
  - "code/db-com/**"
  - "code/srv/**"
---

# AdoptOps Local SQLite Rules

Each worktree's local `code/db.sqlite` bakes in the deployed CDS service views.
After merging a CDS projection change they go stale and read requests 500.

The sqlite dev-server scripts (`srv:sqlite`, `srv:hybrid:sqlite`) and the
`.githooks/post-merge` hook self-heal this by running
`npm run db:refresh:sqlite`, which re-creates the views from the compiled model
(no-op when unchanged) and heals additive base-table drift in place. New tables
and ADD COLUMN-compatible new columns are applied after writing a timestamped
`db.sqlite.bak-*` backup, with existing row data untouched.

Only non-additive drift needs a full `cds deploy`; the script detects that and
prints instructions.

Note: `git pull --rebase` does not trigger `post-merge`. The dev-server scripts
remain the safety net there.

## Local Server Port Ownership

AdoptOps dev servers default to PORT=4104. ChronoPilot (Cx_SaaS_Job / Cx_Job)
owns 4004 on the same machine — never start AdoptOps on 4004.

A 200 from localhost proves nothing about WHICH checkout answered: multiple
worktrees and sibling products run CAP dev servers side by side, and a
curl-based smoke test happily hits a stale or foreign one while your own
server failed to start. Before trusting a localhost smoke test, confirm the
listener's owning process/path
(`Get-NetTCPConnection -LocalPort <port>` + `Get-CimInstance Win32_Process`)
or start your server on an explicit unused PORT.
