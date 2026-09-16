# Append-only, hash-chained audit log

Roadmap item A4. Every business/compliance event AdoptOps records (proposal
decisions, activation step outcomes, access-request decisions, telemetry
settings, the identified-usage opt-in) lands in `adops.db.AuditEvents`
through one writer, `srv/srv/utils/audit-chain.js`. Rows are never changed or
removed; the chain makes that verifiable rather than merely promised.

## Row shape

| Field | Meaning |
|---|---|
| `Sequence` | Per-tenant counter, contiguous from 1. |
| `PrevHash` | `Hash` of the previous row of the same tenant; a 64-zero genesis constant for the first row. |
| `Hash` | SHA-256 over a versioned canonical form of the business fields plus `Sequence` and `PrevHash` (see `HASHED_FIELDS`). |
| `UserId` | Initiator identity (`SYSTEM` for schedulers, `anonymous` without a user). |
| `TenantId` | Chain scope. Chains never cross tenants. |

`adops.db.AuditChainHeads` holds one row per tenant with the last `Sequence`
and `Hash`. It is a lock and a cache, not the source of truth: the writer
reads it with `SELECT ... FOR UPDATE` inside the caller's transaction, so
concurrent appends, also across app instances on PostgreSQL, serialise on
that row instead of forking the sequence. An in-process mutex covers sqlite,
which has no row locks.

## Writing an event

```js
const { appendAuditEvent } = require('./utils/audit-chain.js');
await appendAuditEvent({
  EventType: 'PROPOSAL_APPROVED', ObjectType: 'AppProposals', ObjectId: id,
  UserId: req.user.id, Source: 'PublicService', BeforeValue: 'PROPOSED', AfterValue: 'APPROVED'
});
```

Rules:

- Never `INSERT` into `AuditEvents` directly. The writer assigns `Sequence`,
  `PrevHash`, `Hash`, `Timestamp`, `CorrelationId` and clamps every text
  field to its column width.
- Inside a request or task handler the writer joins the current transaction:
  the audited change and its audit row commit or roll back together. A
  failed audit write therefore fails the request. `writeAdminAuditEvent`
  (admin-audit.js) propagates for that reason; only schedulers that run
  outside a request catch and log.
- Outside a transaction the writer opens its own, so the head lock, the row
  and the head update still commit together.

## Enforcement

1. **OData**: `AuditEvents` is `@readonly` on PublicService and AdminService.
   PATCH, DELETE and POST answer 405 for every role.
2. **Inside the server**: `registerAuditLogGuard(cds.db)` (server.js, on
   `served`) refuses CQN `UPDATE`, `DELETE` and `UPSERT` on the entity, so no
   handler can alter a row.
3. **Behind the guard**: raw SQL or direct table access cannot be prevented
   from the application. `verifyAuditChain()` recomputes every hash and link
   so such changes are detected on the next check.

## Verification

`GET /catalog/AdminService/verifyAuditChain()` (Admin only) returns:

| Field | Meaning |
|---|---|
| `Status` | `OK`, `BROKEN` or `EMPTY` |
| `ChainedEvents` | rows checked |
| `UnchainedEvents` | rows written before the chain existed (no `Sequence`); reported, never counted as broken |
| `FirstBrokenSequence` | first row whose sequence, link or hash does not verify |
| `HeadConsistent` | whether `AuditChainHeads` agrees with the last event |
| `LastSequence`, `LastHash` | the verified tail |

Verification pages through the table in blocks of 500 ordered by `Sequence`.
The Audit Log page (roadmap O3) shows the verdict.

## Known limits

- A party with table access can truncate the tail and rewind the head
  without detection: the chain proves internal consistency, not
  completeness. External anchoring is the BTP Audit Log service binding
  (roadmap T3).
- Subscription purge (T2) must decide what happens to a tenant's audit
  rows; the guard blocks `DELETE` today.
- Existing development databases keep their pre-A4 rows as unchained
  legacy events; `npm run db:refresh:sqlite` adds the new columns and the
  heads table in place.
