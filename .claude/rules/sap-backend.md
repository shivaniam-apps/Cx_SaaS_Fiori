---
paths:
  - "code/srv/**"
  - "code/api/**"
  - "code/db/**"
  - "code/db-com/**"
---
# AdoptOps SAP Backend Rules

AdoptOps integrates with SAP S/4HANA using RAP/CDS/OData V4 through the ZADO
add-on, for usage extraction, Fiori catalog derivation, activation and CTS.

## Namespace

Custom SAP backend objects belong to the ZADO namespace unless an existing
project convention explicitly requires otherwise.

## API Design

Prefer efficient SAP-side filtering and projection.

Do not expose unnecessarily broad datasets merely because the frontend can
filter them later.

Where practical:
- filter at CDS/database level
- project only required fields
- support paging
- support meaningful selection parameters
- keep API semantics stable

## Activation Operations

Preserve existing support for capabilities such as:
- dry-run / simulate / execute modes on activation plans
- per-step idempotency (verify-before-execute, verify-after-execute)
- one commit per step, never one plan-wide LUW
- step retry, skip and rollback semantics
- transport request create / append / release
- the transportable vs. local-replay split per step
- the activation manifest for QA/PROD replay
- blast-radius reporting before execution
- append-only, hash-chained audit with the initiator identity

Never silently re-run a write against a customer's S/4 system: execution
resumes (completed steps are skipped), it does not retry wholesale.

Do not alter activation or transport semantics as a side effect of a
UI-only task.

## S/4 Read Probes and Fallback Paths

- $count can succeed on an entity whose row reads fail: RAP serialization
  errors are data-dependent. A count-only probe must never establish that an
  entity is usable for row reads; probe with $top=1&$count=true.
- A parameterized/windowed CDS entity may scope differently from the base
  entity with an equivalent $filter. When counters and a table feed one
  page, pin every read to ONE path family per destination and validate
  scope equality (compare $counts) before trusting the faster path. A
  serialization 500 on the fast path downgrades it for the process
  lifetime (sticky downgrade).
- testS4Destination is a lax generic GET proxy: it returns the payload even
  when S/4 answers 4xx/5xx, and capability/value-help reads depend on
  exactly that behaviour. Never tighten it. A caller that needs a pass/fail
  verdict gets its own structured action (pattern:
  checkTargetSystemConnection).

## Usage Data Source

- Usage facts come from ZADO snapshot tables persisted by the backend
  collector, not from live ST03N calls in the request path. Live custom
  entities are for bounded ad-hoc drill-down only.
- STAD-derived numbers are samples, not a census; every consumer must
  label them as such.
- Pseudonymisation is enforced server-side in the add-on
  (per-tenant salt), not in CAP or the client. Identified mode is an
  explicit, audited opt-in per target system.

## Shipped / Seed Content

- Do not ship content via CSV seed files.
- Ship initial content (e.g. the AppMappingOverlay curated catalog) via an
  idempotent boot upsert in service init, keyed on a stable business key
  (MappingKey) with an integer Revision for upgrade-in-place.
- Wrap seeding in try/catch so a seed failure never blocks server startup.
- The database-less tier does not run boot upserts; it needs its own
  in-memory seed path for the same content.

## Target Systems and Destinations

Keep separate:
- AdoptOps Target System
- SAP SID/system identity
- BTP Destination
- Cloud Connector Location ID

A Location ID belongs to connectivity routing and must not be inferred merely
from the display name of a destination. It is resolved at call time and never
persisted in the AdoptOps database.

Use configured target-system metadata as the authoritative source.

Destinations live in the subscriber's (consumer) subaccount; the service
resolves them with a tenant-scoped token. Never assume provider-subaccount
destinations for customer systems.

## Error Handling

Preserve useful SAP/CAP error context while avoiding disclosure of credentials,
tokens or other secrets.

Frontend-friendly errors may be normalised in CAP where appropriate.

## Compatibility

Before changing SAP CDS/RAP service contracts, identify:
- CAP consumers
- frontend consumers
- persisted-data impact
- other workstreams affected
