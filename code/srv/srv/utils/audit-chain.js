const cds = require('@sap/cds');
const { createHash, randomUUID } = require('node:crypto');
const { currentTenant } = require('./tenant-scope.js');

// ---------------------------------------------------------------------------
// Append-only, hash-chained audit log (roadmap A4, .claude/rules/sap-backend.md).
//
// One writer for every audit row in the product: appendAuditEvent(). It
// assigns the next per-tenant Sequence, links the row to its predecessor via
// PrevHash and seals the business fields with a SHA-256 Hash. The per-tenant
// tail lives in AuditChainHeads and is read with SELECT ... FOR UPDATE inside
// the caller's transaction, so two writers - in one process or across app
// instances on Postgres - serialise on that row instead of forking the
// sequence. An in-process mutex on top keeps sqlite (which has no row locks)
// honest in local development and tests.
//
// The database service refuses UPDATE / DELETE / UPSERT on AuditEvents
// (registerAuditLogGuard), the OData projections are @readonly, and
// verifyAuditChain() recomputes every hash so tampering through raw SQL is
// detected on the next check. Rows written before the chain existed carry no
// Sequence and are reported as "unchained", not as broken.
// ---------------------------------------------------------------------------

const AUDIT_EVENTS = 'adops.db.AuditEvents';
const CHAIN_HEADS = 'adops.db.AuditChainHeads';

const HASH_VERSION = 'adops-audit-v1';
const GENESIS_HASH = '0'.repeat(64);
const VERIFY_PAGE_SIZE = 500;

// Column widths from db/data-model.cds. The writer clamps so a long S/4
// response or message can never turn an audit write into a failed request
// on Postgres (sqlite does not enforce lengths, so this is the only guard).
const FIELD_LIMITS = {
    EventType: 60,
    Severity: 30,
    ObjectType: 80,
    ObjectName: 160,
    ObjectId: 120,
    UserId: 120,
    TargetSystem: 120,
    Source: 80,
    Message: 500,
    BeforeValue: 120,
    AfterValue: 120,
    SAPResponse: 1000,
    CorrelationId: 120
};

// The fields sealed by Hash, in this order. Changing the list or the order
// changes every hash, so it is versioned via HASH_VERSION.
const HASHED_FIELDS = [
    'ID', 'TenantId', 'Sequence', 'PrevHash', 'Timestamp',
    'EventType', 'Severity', 'ObjectType', 'ObjectName', 'ObjectId',
    'UserId', 'TargetSystem', 'Source', 'Message',
    'BeforeValue', 'AfterValue', 'SAPResponse', 'CorrelationId'
];

function clamp(value, max) {
    if (value === undefined || value === null) return '';
    const text = String(value);
    return text.length > max ? text.slice(0, max) : text;
}

// Timestamps come back from Postgres and sqlite in slightly different
// textual forms; the hash always sees the canonical ISO form.
function canonicalTimestamp(value) {
    if (value === undefined || value === null || value === '') return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function canonicalValue(field, value) {
    if (field === 'Sequence') return String(Number(value));
    if (field === 'Timestamp') return canonicalTimestamp(value);
    return value === undefined || value === null ? '' : String(value);
}

function computeAuditHash(row) {
    const payload = [HASH_VERSION, ...HASHED_FIELDS.map((field) => canonicalValue(field, row[field]))];
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// --- In-process serialisation --------------------------------------------

const tenantLocks = new Map();

async function withTenantLock(tenantId, fn) {
    const previous = tenantLocks.get(tenantId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const chained = previous.then(() => current);
    tenantLocks.set(tenantId, chained);
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (tenantLocks.get(tenantId) === chained) tenantLocks.delete(tenantId);
    }
}

// Runs fn inside the caller's transaction when there is one (request or
// task-runner context: global INSERT/SELECT join it), otherwise in a fresh
// root transaction so the head lock, the event insert and the head update
// commit together.
function inTransaction(fn) {
    return cds.context?.tx ? fn() : cds.tx(fn);
}

async function readHeadForUpdate(tenantId) {
    const existing = await SELECT.one.from(CHAIN_HEADS).where({ TenantId: tenantId }).forUpdate();
    if (existing) return existing;
    const fresh = { TenantId: tenantId, LastSequence: 0, LastHash: GENESIS_HASH, UpdatedAt: new Date().toISOString() };
    try {
        await INSERT.into(CHAIN_HEADS).entries(fresh);
    } catch (error) {
        // Another instance created the head first; take its lock instead.
        const raced = await SELECT.one.from(CHAIN_HEADS).where({ TenantId: tenantId }).forUpdate();
        if (raced) return raced;
        throw error;
    }
    return (await SELECT.one.from(CHAIN_HEADS).where({ TenantId: tenantId }).forUpdate()) || fresh;
}

/**
 * Appends one audit event to the tenant's chain and returns the stored row.
 *
 * @param {object} event business fields (EventType, ObjectType, ObjectName,
 *   ObjectId, UserId, Source, Message, BeforeValue, AfterValue, Severity,
 *   TargetSystem, SAPResponse, CorrelationId). TenantId defaults to the
 *   current tenant, Timestamp to now, ID to a fresh UUID.
 * Throws when the write fails: an audited change must not commit without
 * its audit row, so callers let the error propagate (the request or task
 * transaction rolls back) or decide explicitly to log and continue.
 */
async function appendAuditEvent(event) {
    if (!event || !event.EventType) throw new Error('appendAuditEvent: EventType is required');
    const tenantId = event.TenantId || currentTenant();

    return withTenantLock(tenantId, () => inTransaction(async () => {
        const head = await readHeadForUpdate(tenantId);
        const sequence = Number(head.LastSequence || 0) + 1;
        const prevHash = head.LastHash || GENESIS_HASH;

        const row = {
            ID: event.ID || randomUUID(),
            TenantId: tenantId,
            Sequence: sequence,
            PrevHash: prevHash,
            Timestamp: canonicalTimestamp(event.Timestamp || new Date().toISOString()),
            EventType: clamp(event.EventType, FIELD_LIMITS.EventType),
            Severity: clamp(event.Severity || 'INFO', FIELD_LIMITS.Severity),
            ObjectType: clamp(event.ObjectType, FIELD_LIMITS.ObjectType),
            ObjectName: clamp(event.ObjectName, FIELD_LIMITS.ObjectName),
            ObjectId: clamp(event.ObjectId, FIELD_LIMITS.ObjectId),
            UserId: clamp(event.UserId, FIELD_LIMITS.UserId),
            TargetSystem: clamp(event.TargetSystem, FIELD_LIMITS.TargetSystem),
            Source: clamp(event.Source, FIELD_LIMITS.Source),
            Message: clamp(event.Message, FIELD_LIMITS.Message),
            BeforeValue: clamp(event.BeforeValue, FIELD_LIMITS.BeforeValue),
            AfterValue: clamp(event.AfterValue, FIELD_LIMITS.AfterValue),
            SAPResponse: clamp(event.SAPResponse, FIELD_LIMITS.SAPResponse),
            CorrelationId: clamp(event.CorrelationId || cds.context?.id, FIELD_LIMITS.CorrelationId)
        };
        row.Hash = computeAuditHash(row);

        await INSERT.into(AUDIT_EVENTS).entries(row);
        await UPDATE(CHAIN_HEADS)
            .set({ LastSequence: sequence, LastHash: row.Hash, UpdatedAt: new Date().toISOString() })
            .where({ TenantId: tenantId });
        return row;
    }));
}

// --- Append-only enforcement at the database service ----------------------

// Registered once on cds.db (server.js on 'served'). Application-level
// protection (@readonly projections) stops OData clients; this stops every
// CQN UPDATE/DELETE from inside the server as well, so no future handler can
// "fix up" an audit row. Raw SQL bypasses it by design - that is what
// verifyAuditChain() exists for.
function registerAuditLogGuard(db = cds.db) {
    if (!db || db.__adopsAuditGuard) return db;
    db.__adopsAuditGuard = true;
    // Pass the linked definition, not the name: a string is treated as a
    // service-relative path on db services and registers under
    // "db.adops.db.AuditEvents", which never matches a request.
    const entity = db.model?.definitions?.[AUDIT_EVENTS] || cds.model?.definitions?.[AUDIT_EVENTS];
    if (!entity) throw new Error(`registerAuditLogGuard: ${AUDIT_EVENTS} is not in the database model`);
    db.before(['UPDATE', 'DELETE', 'UPSERT'], entity, (req) => {
        req.reject(403, 'AuditEvents is append-only: rows can be added, never changed or removed.');
    });
    return db;
}

// --- Verification -----------------------------------------------------------

/**
 * Recomputes the tenant's chain from the stored rows.
 *
 * Status: OK (every chained row links and hashes correctly), BROKEN (first
 * offending Sequence in FirstBrokenSequence), EMPTY (no chained rows).
 * UnchainedEvents counts legacy rows without a Sequence. HeadConsistent is
 * false when AuditChainHeads disagrees with the last event.
 */
async function verifyAuditChain({ tenantId = currentTenant() } = {}) {
    const checkedAt = new Date().toISOString();
    let expectedSequence = 1;
    let expectedPrevHash = GENESIS_HASH;
    let chained = 0;
    let lastSequence = 0;
    let lastHash = GENESIS_HASH;
    let firstBroken = null;
    let problem = '';

    for (let offset = 0; ; offset += VERIFY_PAGE_SIZE) {
        const page = await SELECT.from(AUDIT_EVENTS)
            .where({ TenantId: tenantId, Sequence: { '!=': null } })
            .orderBy('Sequence asc')
            .limit(VERIFY_PAGE_SIZE, offset);
        for (const row of page) {
            chained += 1;
            const sequence = Number(row.Sequence);
            let fault = '';
            if (sequence !== expectedSequence) fault = `expected Sequence ${expectedSequence}, found ${sequence}`;
            else if (row.PrevHash !== expectedPrevHash) fault = `PrevHash of Sequence ${sequence} does not match the previous Hash`;
            else if (computeAuditHash(row) !== row.Hash) fault = `Hash of Sequence ${sequence} does not match its content`;
            if (fault) {
                firstBroken = sequence;
                problem = fault;
                break;
            }
            expectedSequence = sequence + 1;
            expectedPrevHash = row.Hash;
            lastSequence = sequence;
            lastHash = row.Hash;
        }
        if (firstBroken !== null || page.length < VERIFY_PAGE_SIZE) break;
    }

    const unchainedRow = await SELECT.one.from(AUDIT_EVENTS)
        .columns({ func: 'count', args: [{ ref: ['ID'] }], as: 'count' })
        .where({ TenantId: tenantId, Sequence: null });
    const unchained = Number(unchainedRow?.count || 0);

    const head = await SELECT.one.from(CHAIN_HEADS).where({ TenantId: tenantId });
    const headConsistent = firstBroken === null && (
        head ? Number(head.LastSequence) === lastSequence && head.LastHash === lastHash : lastSequence === 0
    );

    let status = 'OK';
    let message = `${chained} chained event${chained === 1 ? '' : 's'} verified.`;
    if (firstBroken !== null) {
        status = 'BROKEN';
        message = `Chain broken at Sequence ${firstBroken}: ${problem}.`;
    } else if (chained === 0) {
        status = 'EMPTY';
        message = 'No chained audit events yet.';
    } else if (!headConsistent) {
        message += ' Chain head disagrees with the last event (rebuilt on the next append).';
    }
    if (unchained > 0) message += ` ${unchained} legacy event${unchained === 1 ? '' : 's'} predate the chain.`;

    return {
        TenantId: tenantId,
        Status: status,
        ChainedEvents: chained,
        UnchainedEvents: unchained,
        LastSequence: lastSequence,
        LastHash: chained ? lastHash : '',
        FirstBrokenSequence: firstBroken,
        HeadConsistent: headConsistent,
        Message: message,
        CheckedAt: checkedAt
    };
}

module.exports = {
    appendAuditEvent,
    verifyAuditChain,
    registerAuditLogGuard,
    computeAuditHash,
    GENESIS_HASH,
    HASHED_FIELDS,
    AUDIT_EVENTS
};
