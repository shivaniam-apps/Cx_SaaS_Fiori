// Rate limiting for the telemetry ingestion actions (roadmap A13).
//
// A misbehaving or hostile client can otherwise fill PilotFeedback,
// ClientErrorReports and the event tables at request speed. Every stream
// has a per-user limit per minute and a tenant ceiling derived from it;
// the counters live in process memory (fixed one-minute windows), so with
// two server instances the effective limit is about twice the configured
// one, which is acceptable for abuse protection and documented in docu/13.
//
// Knobs (0 disables the stream's limit):
//   ADOPTOPS_TELEMETRY_FEEDBACK_PER_MINUTE   default 5   submitPilotFeedback
//   ADOPTOPS_TELEMETRY_ERRORS_PER_MINUTE     default 30  recordClientError
//   ADOPTOPS_TELEMETRY_BATCHES_PER_MINUTE    default 20  recordTelemetryBatch
//   ADOPTOPS_TELEMETRY_TENANT_MULTIPLIER     default 20  tenant ceiling = user limit x multiplier
const { envNumber } = require('./env.js');

const WINDOW_MS = 60 * 1000;
const STREAMS = {
    feedback: { env: 'TELEMETRY_FEEDBACK_PER_MINUTE', fallback: 5 },
    errors: { env: 'TELEMETRY_ERRORS_PER_MINUTE', fallback: 30 },
    batches: { env: 'TELEMETRY_BATCHES_PER_MINUTE', fallback: 20 }
};
const PRUNE_EVERY = 500;

const buckets = new Map();
let calls = 0;

function userLimitFor(stream) {
    const config = STREAMS[stream];
    if (!config) throw new Error(`Unknown telemetry stream: ${stream}`);
    const value = envNumber(config.env, config.fallback);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function tenantMultiplier() {
    const value = envNumber('TELEMETRY_TENANT_MULTIPLIER', 20);
    return Number.isFinite(value) && value >= 1 ? value : 20;
}

function take(key, limit, now) {
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= WINDOW_MS) {
        bucket = { start: now, count: 0 };
        buckets.set(key, bucket);
    }
    bucket.count += 1;
    return {
        allowed: bucket.count <= limit,
        count: bucket.count,
        retryAfterMs: Math.max(0, bucket.start + WINDOW_MS - now)
    };
}

function prune(now) {
    for (const [key, bucket] of buckets) {
        if (now - bucket.start >= WINDOW_MS) buckets.delete(key);
    }
}

// Returns { allowed, scope, limit, remaining, retryAfterMs, firstExceeded }.
// scope is 'user' or 'tenant' when refused; firstExceeded is true for the
// first refused call of a window so the caller can log once, not per call.
function checkTelemetryRateLimit({ stream, tenant, user, now = Date.now() }) {
    const userLimit = userLimitFor(stream);
    if (userLimit === 0) return { allowed: true, scope: null, limit: 0, remaining: Infinity, retryAfterMs: 0, firstExceeded: false };

    calls += 1;
    if (calls % PRUNE_EVERY === 0) prune(now);

    const tenantKey = String(tenant || 'GLOBAL');
    const userKey = String(user || 'anonymous');
    const perUser = take(`${stream}|${tenantKey}|user|${userKey}`, userLimit, now);
    if (!perUser.allowed) {
        return { allowed: false, scope: 'user', limit: userLimit, remaining: 0, retryAfterMs: perUser.retryAfterMs, firstExceeded: perUser.count === userLimit + 1 };
    }
    const tenantLimit = userLimit * tenantMultiplier();
    const perTenant = take(`${stream}|${tenantKey}|tenant`, tenantLimit, now);
    if (!perTenant.allowed) {
        return { allowed: false, scope: 'tenant', limit: tenantLimit, remaining: 0, retryAfterMs: perTenant.retryAfterMs, firstExceeded: perTenant.count === tenantLimit + 1 };
    }
    return { allowed: true, scope: null, limit: userLimit, remaining: userLimit - perUser.count, retryAfterMs: 0, firstExceeded: false };
}

function retryAfterSeconds(verdict) {
    return Math.max(1, Math.ceil((verdict?.retryAfterMs || 0) / 1000));
}

function configuredTelemetryLimits() {
    return {
        feedbackPerMinute: userLimitFor('feedback'),
        errorsPerMinute: userLimitFor('errors'),
        batchesPerMinute: userLimitFor('batches'),
        tenantMultiplier: tenantMultiplier(),
        windowMs: WINDOW_MS
    };
}

// Test hook: forget every counter.
function resetTelemetryRateLimits() {
    buckets.clear();
    calls = 0;
}

module.exports = {
    checkTelemetryRateLimit,
    retryAfterSeconds,
    configuredTelemetryLimits,
    resetTelemetryRateLimits,
    WINDOW_MS
};
