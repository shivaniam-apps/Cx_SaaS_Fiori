const cds = require('@sap/cds');
const crypto = require('node:crypto');
const { isDatabaseLess } = require('./tier.js');
const {
    clampText,
    redactSensitiveText,
    sanitizeEndpointPath,
    buildErrorFingerprint,
} = require('./telemetry-sanitize.js');
const { readEffectiveTelemetrySettings } = require('./telemetry-settings.js');

const logger = cds.log('telemetry');

// Privacy: how a user is recorded in usage/error telemetry, per the tenant
// setting. Hashing is a salted-by-nothing stable pseudonym - enough to count
// distinct users without naming them; ANONYMOUS drops identity entirely.
function applyIdentification(userId, mode) {
    if (mode === 'ANONYMOUS') return 'anonymous';
    if (mode === 'HASHED') {
        return crypto.createHash('sha256').update(String(userId || 'anonymous')).digest('hex').slice(0, 16);
    }
    return userId || 'anonymous';
}

const FEEDBACK_CATEGORIES = new Set([
    'FEATURE_REQUEST',
    'IMPROVEMENT',
    'REMOVE_OR_SIMPLIFY',
    'USABILITY',
    'ENTERPRISE_REQUIREMENT',
    'DEFECT',
    'GENERAL',
]);
const FEEDBACK_IMPACTS = new Set(['LOW', 'MEDIUM', 'HIGH', 'BLOCKER']);
const PERFORMANCE_SOURCES = new Set(['CLIENT', 'API', 'CAP']);

// Per-batch row caps: a well-behaved client flushes far below these; anything
// larger is a bug or abuse and the excess is dropped (reported in the receipt).
const MAX_USAGE_EVENTS_PER_BATCH = 50;
const MAX_PERFORMANCE_EVENTS_PER_BATCH = 50;
const ERROR_TYPES = new Set(['RENDER_ERROR', 'UNHANDLED_REJECTION', 'WINDOW_ERROR', 'API_FAILURE', 'INIT_FAILURE']);
const ERROR_SEVERITIES = new Set(['FATAL', 'ERROR', 'WARNING']);

function normalizeChoice(value, allowed, fallback) {
    const normalized = clampText(value, 60).toUpperCase().replace(/[\s-]+/g, '_');
    if (!normalized) return { value: fallback, valid: true };
    return { value: normalized, valid: allowed.has(normalized) };
}

// Prefer the id our middleware/CAP already assigned to this request so the
// stored row matches the backend log lines; a client-provided id only fills
// in when the platform ids are unavailable.
function resolveCorrelationId(req, provided) {
    const headerValue = req.headers?.['x-correlation-id'];
    const candidate = clampText(headerValue, 64) || clampText(cds.context?.id, 64) || clampText(provided, 64);
    return candidate || cds.utils.uuid();
}

function submitterDisplayName(req) {
    try {
        return clampText(req.req?.authInfo?.getGivenName?.(), 160);
    } catch {
        return '';
    }
}

function buildReferenceNumber(prefix = 'FB') {
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const randomPart = Math.random().toString(36).slice(2, 7).toUpperCase();
    return `${prefix}-${datePart}-${randomPart}`;
}

function registerFeedbackTelemetryHandlers(service, { inMemory }) {
    // The telemetry entities are intentionally NOT exposed on PublicService
    // (write-only via these actions; reads are admin-only), so persistence
    // addresses the db-level entities directly.
    const persistFeedback = async (row) => {
        if (isDatabaseLess()) {
            inMemory.PilotFeedback.set(row.ID, row);
            return;
        }
        await INSERT.into('adops.db.PilotFeedback').entries(row);
    };

    // Effective settings for the telemetry client: which streams to collect
    // and which thresholds to apply. Any authenticated user may read this.
    service.on('getTelemetrySettings', async () => {
        const settings = await readEffectiveTelemetrySettings();
        return {
            feedbackEnabled: settings.FeedbackEnabled,
            usageEnabled: settings.UsageEnabled,
            crashReportingEnabled: settings.CrashReportingEnabled,
            performanceEnabled: settings.PerformanceEnabled,
            slowRouteThresholdMs: settings.SlowRouteThresholdMs,
            slowApiThresholdMs: settings.SlowApiThresholdMs,
            severeApiThresholdMs: settings.SevereApiThresholdMs,
        };
    });

    service.on('submitPilotFeedback', async (req) => {
        const settings = await readEffectiveTelemetrySettings();
        if (!settings.FeedbackEnabled) {
            return req.reject(400, 'Feedback collection is currently disabled by your administrator.');
        }

        const title = clampText(req.data.title, 160);
        if (!title) return req.reject(400, 'A short title is required to submit feedback.');

        const description = clampText(redactSensitiveText(req.data.description), 2000);
        if (!description) return req.reject(400, 'A description is required to submit feedback.');

        const category = normalizeChoice(req.data.category, FEEDBACK_CATEGORIES, 'GENERAL');
        if (!category.valid) return req.reject(400, `Unsupported feedback category: ${category.value}`);

        const impact = normalizeChoice(req.data.impact, FEEDBACK_IMPACTS, 'MEDIUM');
        if (!impact.valid) return req.reject(400, `Unsupported feedback impact: ${impact.value}`);

        const row = {
            ID: cds.utils.uuid(),
            SubmittedAt: new Date().toISOString(),
            SubmittedBy: req.user?.id || 'anonymous',
            SubmittedByName: submitterDisplayName(req),
            TenantId: req.user?.tenant || null,
            Category: category.value,
            Title: title,
            Description: description,
            Impact: impact.value,
            Sentiment: clampText(req.data.sentiment, 30) || null,
            Route: clampText(req.data.route, 200),
            Feature: clampText(req.data.feature, 120),
            TargetSystem: clampText(req.data.targetSystem, 120),
            AppVersion: clampText(req.data.appVersion, 60),
            BrowserInfo: clampText(req.data.browserInfo, 200),
            SessionId: clampText(req.data.sessionId, 64),
            CorrelationId: resolveCorrelationId(req, req.data.correlationId),
            ContactAllowed: req.data.contactAllowed === true,
            Status: 'NEW',
            ReferenceNumber: buildReferenceNumber(),
        };

        try {
            await persistFeedback(row);
        } catch (error) {
            // Feedback submission is an explicit user action: a lost submission
            // must surface, unlike passive telemetry.
            logger.error(`Feedback persistence failed (correlation ${row.CorrelationId}): ${error.message}`);
            return req.reject(500, 'Your feedback could not be saved. Please try again.');
        }

        logger.info(`Pilot feedback ${row.ReferenceNumber} recorded (correlation ${row.CorrelationId}).`);
        return { ID: row.ID, referenceNumber: row.ReferenceNumber, status: row.Status };
    });

    service.on('recordTelemetryBatch', async (req) => {
        try {
            const settings = await readEffectiveTelemetrySettings();
            const sessionId = clampText(req.data.sessionId, 64);
            const appVersion = clampText(req.data.appVersion, 60);
            const tenantId = req.user?.tenant || null;
            const userId = applyIdentification(req.user?.id, settings.UserIdentificationMode);
            const correlationId = resolveCorrelationId(req, null);
            const receivedAt = new Date().toISOString();

            // Server-side sampling applies to non-critical usage events only;
            // performance events already pass a threshold filter client-side.
            const sampledOut = () => settings.SamplingPercent < 100
                && Math.random() * 100 >= settings.SamplingPercent;

            const toTimestamp = (value) => {
                const parsed = Date.parse(String(value ?? ''));
                return Number.isFinite(parsed) ? new Date(parsed).toISOString() : receivedAt;
            };
            const toDuration = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
            const toMetadata = (value) => clampText(redactSensitiveText(value), 2000) || null;

            const usageRows = (settings.UsageEnabled ? (Array.isArray(req.data.usageEvents) ? req.data.usageEvents : []) : [])
                .slice(0, MAX_USAGE_EVENTS_PER_BATCH)
                .filter(() => !sampledOut())
                .map((event) => ({
                    ID: cds.utils.uuid(),
                    Timestamp: toTimestamp(event?.timestamp),
                    TenantId: tenantId,
                    UserId: userId,
                    SessionId: sessionId,
                    EventName: clampText(event?.eventName, 60),
                    EventCategory: clampText(event?.eventCategory, 40),
                    Route: clampText(event?.route, 200),
                    Feature: clampText(event?.feature, 120),
                    Action: clampText(event?.action, 60),
                    Outcome: clampText(event?.outcome, 30),
                    DurationMs: toDuration(event?.durationMs),
                    TargetSystem: clampText(event?.targetSystem, 120),
                    AppVersion: appVersion,
                    CorrelationId: correlationId,
                    MetadataJson: toMetadata(event?.metadataJson),
                }))
                .filter((row) => row.EventName);

            const performanceRows = (settings.PerformanceEnabled ? (Array.isArray(req.data.performanceEvents) ? req.data.performanceEvents : []) : [])
                .slice(0, MAX_PERFORMANCE_EVENTS_PER_BATCH)
                .map((event) => {
                    const source = clampText(event?.source, 20).toUpperCase();
                    return {
                        ID: cds.utils.uuid(),
                        Timestamp: toTimestamp(event?.timestamp),
                        TenantId: tenantId,
                        SessionId: sessionId,
                        Source: PERFORMANCE_SOURCES.has(source) ? source : 'CLIENT',
                        OperationName: clampText(event?.operationName, 120),
                        RouteOrEndpoint: sanitizeEndpointPath(event?.routeOrEndpoint) || clampText(event?.routeOrEndpoint, 300),
                        DurationMs: toDuration(event?.durationMs),
                        ThresholdMs: toDuration(event?.thresholdMs),
                        Outcome: clampText(event?.outcome, 30),
                        AppVersion: appVersion,
                        CorrelationId: correlationId,
                        MetadataJson: toMetadata(event?.metadataJson),
                    };
                })
                .filter((row) => row.OperationName && row.DurationMs !== null);

            if (isDatabaseLess()) {
                for (const row of usageRows) inMemory.UsageEvents.set(row.ID, row);
                for (const row of performanceRows) inMemory.PerformanceEvents.set(row.ID, row);
            } else {
                if (usageRows.length) await INSERT.into('adops.db.UsageEvents').entries(usageRows);
                if (performanceRows.length) await INSERT.into('adops.db.PerformanceEvents').entries(performanceRows);
            }

            return { acceptedUsage: usageRows.length, acceptedPerformance: performanceRows.length };
        } catch (error) {
            // Telemetry ingestion must never surface into the user workflow.
            logger.warn(`Telemetry batch ingestion failed: ${error.message}`);
            return { acceptedUsage: 0, acceptedPerformance: 0 };
        }
    });

    service.on('recordClientError', async (req) => {
        try {
            const settings = await readEffectiveTelemetrySettings();
            if (!settings.CrashReportingEnabled) {
                return { received: false, fingerprint: null, occurrenceCount: 0 };
            }
            const errorType = normalizeChoice(req.data.errorType, ERROR_TYPES, 'WINDOW_ERROR');
            const severity = normalizeChoice(req.data.severity, ERROR_SEVERITIES, 'ERROR');
            const errorMessage = clampText(redactSensitiveText(req.data.errorMessage), 1000) || 'Unknown client error';
            const stackTrace = settings.StackTraceEnabled
                ? clampText(redactSensitiveText(req.data.stackTrace), 4000)
                : '';
            const componentStack = settings.StackTraceEnabled
                ? clampText(redactSensitiveText(req.data.componentStack), 2000)
                : '';
            const route = clampText(req.data.route, 200);
            const endpointPath = sanitizeEndpointPath(req.data.endpointPath);
            const httpStatus = Number.isInteger(req.data.httpStatus) ? req.data.httpStatus : null;
            const now = new Date().toISOString();

            const fingerprint = buildErrorFingerprint({
                errorType: errorType.valid ? errorType.value : 'WINDOW_ERROR',
                errorMessage,
                stackTrace,
                route,
                endpointPath,
                httpStatus,
            });

            const correlationId = resolveCorrelationId(req, req.data.correlationId);
            const baseRow = {
                TenantId: req.user?.tenant || null,
                UserId: applyIdentification(req.user?.id, settings.UserIdentificationMode),
                SessionId: clampText(req.data.sessionId, 64),
                ErrorType: errorType.valid ? errorType.value : 'WINDOW_ERROR',
                ErrorMessage: errorMessage,
                StackTrace: stackTrace,
                ComponentStack: componentStack,
                Route: route,
                Feature: clampText(req.data.feature, 120),
                EndpointPath: endpointPath,
                HttpMethod: clampText(req.data.httpMethod, 10).toUpperCase(),
                HttpStatus: httpStatus,
                AppVersion: clampText(req.data.appVersion, 60),
                BrowserInfo: clampText(req.data.browserInfo, 200),
                CorrelationId: correlationId,
                Fingerprint: fingerprint,
                Severity: severity.valid ? severity.value : 'ERROR',
            };

            if (isDatabaseLess()) {
                const existing = [...inMemory.ClientErrorReports.values()].find((row) => row.Fingerprint === fingerprint);
                if (existing) {
                    existing.OccurrenceCount += 1;
                    existing.LastSeenAt = now;
                    existing.CorrelationId = correlationId;
                    return { received: true, fingerprint, occurrenceCount: existing.OccurrenceCount };
                }
                const row = { ID: cds.utils.uuid(), FirstSeenAt: now, LastSeenAt: now, OccurrenceCount: 1, Status: 'NEW', ...baseRow };
                inMemory.ClientErrorReports.set(row.ID, row);
                return { received: true, fingerprint, occurrenceCount: 1 };
            }

            const existing = await SELECT.one.from('adops.db.ClientErrorReports').where({ Fingerprint: fingerprint });
            if (existing) {
                const occurrenceCount = (existing.OccurrenceCount || 1) + 1;
                await UPDATE('adops.db.ClientErrorReports')
                    .set({ OccurrenceCount: occurrenceCount, LastSeenAt: now, CorrelationId: correlationId })
                    .where({ ID: existing.ID });
                return { received: true, fingerprint, occurrenceCount };
            }

            await INSERT.into('adops.db.ClientErrorReports').entries({
                ID: cds.utils.uuid(),
                FirstSeenAt: now,
                LastSeenAt: now,
                OccurrenceCount: 1,
                Status: 'NEW',
                ...baseRow,
            });
            return { received: true, fingerprint, occurrenceCount: 1 };
        } catch (error) {
            // Telemetry ingestion must never surface into the user workflow.
            logger.warn(`Client error ingestion failed: ${error.message}`);
            return { received: false, fingerprint: null, occurrenceCount: 0 };
        }
    });
}

module.exports = { registerFeedbackTelemetryHandlers, buildReferenceNumber };
