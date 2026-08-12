# AdoptOps

**Fiori adoption, from evidence to activation.**

AdoptOps is a multitenant-ready SaaS for SAP BTP Cloud Foundry that helps
SAP S/4HANA on-premise customers move from SAP GUI transactions to SAP Fiori:

1. **Connect** — to the customer's S/4HANA system via SAP Cloud Connector and
   a lean ABAP add-on (`ZADO`, delivered by transport).
2. **Analyse** — extract the real usage pattern: which transactions run, how
   often, by whom, under which PFCG roles (ST03N workload, STAD samples,
   `AGR_*`/`USR02`, existing launchpad usage). Pseudonymised by default.
3. **Propose** — rank matching SAP Fiori apps with coverage and confidence
   scoring, grouped by business role and user population.
4. **Review** — approve, reject or defer proposals with comments and audit.
5. **Activate** — simulate, then execute: OData/ICF services, launchpad
   spaces & pages, PFCG business roles — captured in a transport request,
   with system-local steps replayed per system via the activation manifest.

## Repository layout

| Path | Content |
|---|---|
| `code/` | CAP Node.js service, React client, approuter, broker, scripts |
| `deploy/cf/` | MTA descriptors, xs-security, mtaext per tier |
| `abap/` | ZADO add-on (abapGit layout) |
| `docu/` | Numbered documentation chapters |
| `.claude/rules/` | Working conventions (scoped by path) |

## Setup

```
git config core.hooksPath .githooks
cd code
npm install
npm run srv:sqlite     # local dev server on port 4104, mocked auth
```

Mocked users: `alice` (Admin, Approver, Activator, Member), `bob` (Approver,
Member), `dave` (Activator, Member), `carol` (Member), `eve` (none).

## Sibling projects

- `../Cx_SaaS_Job` — ChronoPilot, the structural template for this product.
- `../a4h_2023_zshvm` — ABAP add-on conventions template (ZSHVM namespace).
