// Readiness (roadmap A11): /readyz answers 200 only when the server can
// serve requests, which on the database tiers means the database answers a
// trivial query within a short deadline. /healthz stays the Cloud Foundry
// liveness check (process up) on purpose: a database outage must make the
// instance report "not ready", not make the platform restart it in a loop.
const cds = require('@sap/cds');
const { isDatabaseLess } = require('./tier.js');

const DEFAULT_TIMEOUT_MS = 5000;

// The running product version (one number for MTA, client and server, kept
// in step by scripts/release.mjs) so operators can read it off /readyz. In
// the deployed runtime (gen/srv/srv/utils) the package is two levels up; in
// a local checkout (code/srv/srv/utils) code/srv/package.json exists only
// after a hybrid run, so the project package one level further is the
// fallback.
function productVersion() {
    for (const candidate of ['../../package.json', '../../../package.json']) {
        try {
            const version = require(candidate).version;
            if (version) return String(version);
        } catch {
            // next candidate
        }
    }
    return '0.0.0';
}
const PRODUCT_VERSION = productVersion();

function withTimeout(promise, timeoutMs) {
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Probe the database once. Returns { ok, ms, skipped?, error? }; never throws.
async function checkDatabase({ db = cds.db, timeoutMs = DEFAULT_TIMEOUT_MS, databaseLess = isDatabaseLess() } = {}) {
    if (databaseLess) return { ok: true, skipped: true, ms: 0 };
    if (!db) return { ok: false, ms: 0, error: 'database service not connected' };

    const started = Date.now();
    try {
        await withTimeout(db.run('SELECT 1 AS ok'), timeoutMs);
        return { ok: true, ms: Date.now() - started };
    } catch (error) {
        return { ok: false, ms: Date.now() - started, error: String(error?.message || error) };
    }
}

// Aggregate readiness: { status: 'ok' | 'unavailable', version, checks: { db } }.
async function checkReadiness(options = {}) {
    const db = await checkDatabase(options);
    return { status: db.ok ? 'ok' : 'unavailable', version: PRODUCT_VERSION, checks: { db } };
}

module.exports = { checkReadiness, checkDatabase, DEFAULT_TIMEOUT_MS, PRODUCT_VERSION };
