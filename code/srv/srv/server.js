const cds = require('@sap/cds');
const cov2ap = require('@cap-js-community/odata-v2-adapter')
const { randomUUID } = require('node:crypto');
const { effectiveConnectivityProxyDetails } = require('./utils/s4-http-client.js');
const { scheduleTelemetryRetentionCleanup } = require('./utils/telemetry-retention.js');
const { registerBasicSubscriptionRoutes } = require('./basic-subscription.js');
const { currentTier } = require('./utils/tier.js');

// Keep in sync with the client contract in
// app/adops-client/src/features/telemetry/correlation.js.
const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_ID_MAX_LENGTH = 64;

function resolveCorrelationId(req) {
    const incoming =
        req.headers[CORRELATION_HEADER] || req.headers['x-request-id'] || req.headers['x-vcap-request-id'];
    const value = Array.isArray(incoming) ? incoming[0] : incoming;
    const trimmed = String(value || '').trim();
    return trimmed ? trimmed.slice(0, CORRELATION_ID_MAX_LENGTH) : randomUUID();
}

let startupProxyLogged = false;

cds.on('bootstrap', async (app) => {
    if (!startupProxyLogged) {
        startupProxyLogged = true;

        try {
            const proxy = effectiveConnectivityProxyDetails();
            const profileList = Array.isArray(cds.env?.profiles) ? cds.env.profiles.join(',') : '';

            if (proxy.bound) {
                console.log(
                    `[startup] Connectivity proxy effective host=${proxy.host || '<empty>'} port=${proxy.port || '<empty>'} rawHost=${proxy.rawHost || '<empty>'} rawHttpPort=${proxy.rawHttpPort || '<empty>'} profiles=${profileList || '<none>'}`
                );
            } else {
                console.log(`[startup] Connectivity service binding not available. profiles=${profileList || '<none>'}`);
            }
        } catch (error) {
            console.warn(`[startup] Unable to resolve Connectivity proxy details: ${error.message}`);
        }
    }

    const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

    // Adopt (or mint) the correlation id before CAP's own correlate middleware
    // runs, and echo it on the response so the frontend can show users the id
    // that ties an incident to the matching backend/BTP log lines. Writing the
    // normalized id back onto req.headers makes CAP derive the identical
    // cds.context.id.
    app.use((req, res, next) => {
        const correlationId = resolveCorrelationId(req);
        req.headers[CORRELATION_HEADER] = correlationId;
        res.setHeader(CORRELATION_HEADER, correlationId);
        next();
    });

    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Authorization,Content-Type,Accept');
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
            res.setHeader('Access-Control-Expose-Headers', CORRELATION_HEADER);
            res.setHeader('Access-Control-Max-Age', '600');
        }

        if (req.method === 'OPTIONS') return res.status(204).end();
        next();
    });

    app.get('/healthz', (_, res) => res.status(200).send('OK'));

    // Basic tier subscribes via SAP SaaS Provisioning without CAP MTX; the
    // callbacks only resolve the tenant URL. Enterprise (MTX) wiring returns
    // with ER-19..ER-26.
    if (currentTier() === 'basic') registerBasicSubscriptionRoutes(app);

    app.use(cov2ap());
});

// Retention enforcement was operator-only ("Run Retention Cleanup Now" in
// Product Insights); the scheduler makes the configured retention periods
// real without an operator remembering to click. Interval via
// ADOPTOPS_TELEMETRY_CLEANUP_INTERVAL_HOURS (default 24, <=0 disables).
cds.on('served', () => {
    scheduleTelemetryRetentionCleanup();

    // Async S/4 work: register handlers, then start the claim/heartbeat poller.
    const { registerTaskHandler, startTaskRunner } = require('./utils/task-runner.js');
    const { runUsageExtraction } = require('./utils/usage-extraction.js');
    const { runAnalysis } = require('./utils/analysis-run.js');
    const { runActivationExecution } = require('./utils/activation-execution.js');
    registerTaskHandler('USAGE_EXTRACTION', runUsageExtraction);
    registerTaskHandler('ANALYSIS', runAnalysis);
    registerTaskHandler('ACTIVATION_EXECUTION', runActivationExecution);
    startTaskRunner();

    // Shipped curated overlay content (idempotent, failure never blocks boot).
    const { seedShippedOverlay } = require('./utils/shipped-overlay-catalog.js');
    seedShippedOverlay();
});

module.exports = cds.server;
