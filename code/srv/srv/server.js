const cds = require('@sap/cds');
const cov2ap = require('@cap-js-community/odata-v2-adapter')
const { randomUUID } = require('node:crypto');
const { effectiveConnectivityProxyDetails } = require('./utils/s4-http-client.js');
const { scheduleTelemetryRetentionCleanup } = require('./utils/telemetry-retention.js');
const { registerBasicSubscriptionRoutes } = require('./basic-subscription.js');
const { currentTier } = require('./utils/tier.js');
const { checkReadiness } = require('./utils/readiness.js');

const STARTUP_LOG = cds.log('startup');
const { assessStartupConfig, corsOriginsFrom } = require('./utils/config-hardening.js');

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
                STARTUP_LOG.info(
                    `Connectivity proxy effective host=${proxy.host || '<empty>'} port=${proxy.port || '<empty>'} rawHost=${proxy.rawHost || '<empty>'} rawHttpPort=${proxy.rawHttpPort || '<empty>'} profiles=${profileList || '<none>'}`
                );
            } else {
                STARTUP_LOG.info(`Connectivity service binding not available. profiles=${profileList || '<none>'}`);
            }
        } catch (error) {
            STARTUP_LOG.warn(`Unable to resolve Connectivity proxy details: ${error.message}`);
        }

        // S11: development conveniences (direct S/4 access, mock S/4) are
        // warned about everywhere and refused in a Cloud Foundry instance.
        const config = assessStartupConfig({ env: process.env, profiles: cds.env?.profiles });
        for (const finding of config.findings) {
            if (finding.level === 'refuse') STARTUP_LOG.error(finding.message);
            else STARTUP_LOG.warn(finding.message);
        }
        if (config.refused) {
            throw new Error(`Refusing to start: ${config.findings.filter((f) => f.level === 'refuse').map((f) => f.variable).join(', ')} set in Cloud Foundry (see docu/05 deploy-runbook, "Never set in Cloud Foundry").`);
        }
    }

    // CORS_ORIGINS, or the local client port slots (5273 primary, 5283/5293/
    // 5303/5313 worktrees) when unset - never Vite's stock 5173.
    const allowedOrigins = corsOriginsFrom(process.env.CORS_ORIGINS);

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

    // Liveness (process up) for the Cloud Foundry health check; readiness
    // (database answers) for operators and monitors. See utils/readiness.js.
    app.get('/healthz', (_, res) => res.status(200).send('OK'));
    app.get('/readyz', async (_, res) => {
        const readiness = await checkReadiness();
        res.status(readiness.status === 'ok' ? 200 : 503).json(readiness);
    });

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
    // AuditEvents is append-only: refuse UPDATE/DELETE at the database
    // service so no handler, present or future, can alter an audit row.
    const { registerAuditLogGuard } = require('./utils/audit-chain.js');
    registerAuditLogGuard(cds.db);

    // Rows written before tenant scoping covered every entity carry a NULL
    // TenantId; assign them to GLOBAL so the strict filter keeps them
    // visible. Idempotent, and a failure never blocks boot.
    const { backfillTenantIds } = require('./utils/tenant-scope.js');
    backfillTenantIds().catch((error) => cds.log('tenant-scope').warn(`tenant backfill failed: ${error.message}`));

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
