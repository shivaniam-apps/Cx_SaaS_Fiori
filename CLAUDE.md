# AdoptOps

AdoptOps is an enterprise SaaS product that helps SAP S/4HANA on-premise
customers adopt SAP Fiori: it analyses real SAP GUI transaction usage,
proposes the relevant Fiori apps per user population, and activates the
approved apps in the backend (technical foundation, launchpad spaces & pages,
PFCG business roles) with all transportable changes captured in a transport
request for DEV → QA → PROD.

Stack: React + UI5 Web Components for React (Fiori) -> SAP CAP Node.js on
BTP Cloud Foundry (PostgreSQL in the SaaS tier) -> S/4HANA via RAP/CDS/OData V4
in the ZADO namespace (custom add-on, read unit + write unit).

The structural template is the sibling product ChronoPilot
(`../Cx_SaaS_Job`); its conventions apply here unless a rule in
`.claude/rules/` says otherwise. The ABAP conventions template is
`../a4h_2023_zshvm`.

## Attribution

Never add "Co-Authored-By: Claude", "Generated with Claude Code", or any
reference to Claude, Anthropic, or an AI model to commit messages, PR titles
or bodies, code comments, changelogs, docs, or any other project file.

A `commit-msg` hook in `.githooks/` strips such trailers as a backstop
(enabled locally via `git config core.hooksPath .githooks`), but do not rely
on it — never write them in the first place.

## Skills and Rules

- Rules live in `.claude/rules/` on `main`. Branches consume them; updates
  flow back to `main` via PR.
- Rule files scope themselves with `paths:` YAML frontmatter. The opening
  `---` must be the file's very first bytes — a UTF-8 BOM before it
  silently disables scoping, so keep rules files BOM-free.
- Propose skill/rule changes as a diff for the user's approval. Never write
  to `.claude/rules/` or CLAUDE.md unprompted.

## Product Journey

Connect → Analyse (usage extraction) → Propose (scoring) → Review
(approve/reject/defer) → Activate (plan, simulate, execute) → Transport
(DEV → QA → PROD replay). The plan of record is the approved implementation
plan; `docu/` carries the per-area chapters.

## Safety

This product writes PFCG roles and transports into customer S/4HANA systems.

- The ABAP write unit (`ZADO_ACTIVATE`, `ZADO_CTS`) ships only to DEV;
  the write service binding stays unpublished in QA/PROD.
- Execution is resumable, never blindly retried; every step is idempotent
  and verify-first; one commit per step.
- Never independently perform destructive database operations, schema
  resets, production deployments, destructive SAP operations, or shared
  infrastructure changes without explicit approval.

## Command Output Discipline

Build, install and test commands emit hundreds to thousands of lines, and
everything you read stays in context for the rest of the session.

- Pipe long output: `npm test 2>&1 | tail -n 40`
- Filter builds: `npm run build 2>&1 | grep -Ei "error|warn" | head -n 30`
- Never run `npm install` / `npm ci` without redirecting output.
- Do not read `package-lock.json`, `code/gen/`, `node_modules/` or `*.sqlite`.
- Prefer a targeted `grep` over reading a whole large file.

## Local Ports

AdoptOps dev servers use PORT=4104. ChronoPilot owns 4004 on this machine.
