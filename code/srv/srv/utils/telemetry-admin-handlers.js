const { isDatabaseLess } = require('./tier.js');
const { clampText } = require('./telemetry-sanitize.js');
const {
    readEffectiveTelemetrySettings,
    saveTelemetrySettings,
    IDENTIFICATION_MODES,
} = require('./telemetry-settings.js');
const { runTelemetryRetentionCleanup } = require('./telemetry-retention.js');
const { writeAdminAuditEvent } = require('./admin-audit.js');

const FEEDBACK_STATUSES = new Set(['NEW', 'UNDER_REVIEW', 'PLANNED', 'IMPLEMENTED', 'DECLINED', 'DUPLICATE', 'CLOSED']);
const ERROR_STATUSES = new Set(['NEW', 'INVESTIGATING', 'RESOLVED', 'IGNORED']);

function daysAgoIso(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function boundedDays(value, fallback = 30) {
    return Number.isInteger(value) && value >= 1 && value <= 365 ? value : fallback;
}

const count = (as = 'count') => ({ func: 'count', args: [{ ref: ['ID'] }], as });

function registerTelemetryAdminHandlers(service) {
    service.on('getTelemetrySettingsAdmin', async () => {
        return readEffectiveTelemetrySettings();
    });

    service.on('updateTelemetrySettings', async (req) => {
        if (isDatabaseLess()) return req.reject(501, 'Telemetry settings persistence is available in Standard or Enterprise tiers.');

        const mode = req.data.userIdentificationMode
            ? String(req.data.userIdentificationMode).toUpperCase()
            : undefined;
        if (mode !== undefined && !IDENTIFICATION_MODES.has(mode)) {
            return req.reject(400, `Unsupported user identification mode: ${mode}`);
        }

        const before = await readEffectiveTelemetrySettings();
        // Only pass through known keys; normalizeSettings bounds the values.
        const patch = {
            FeedbackEnabled: req.data.feedbackEnabled,
            UsageEnabled: req.data.usageEnabled,
            CrashReportingEnabled: req.data.crashReportingEnabled,
            PerformanceEnabled: req.data.performanceEnabled,
            StackTraceEnabled: req.data.stackTraceEnabled,
            UserIdentificationMode: mode,
            SamplingPercent: req.data.samplingPercent,
            SlowRouteThresholdMs: req.data.slowRouteThresholdMs,
            SlowApiThresholdMs: req.data.slowApiThresholdMs,
            SevereApiThresholdMs: req.data.severeApiThresholdMs,
            UsageRetentionDays: req.data.usageRetentionDays,
            PerformanceRetentionDays: req.data.performanceRetentionDays,
            ErrorRetentionDays: req.data.errorRetentionDays,
        };
        for (const key of Object.keys(patch)) {
            if (patch[key] === undefined || patch[key] === null) delete patch[key];
        }

        const saved = await saveTelemetrySettings(patch, req.user?.id || 'anonymous');
        await writeAdminAuditEvent(req, {
            eventType: 'TELEMETRY_SETTINGS_UPDATED',
            objectType: 'Telemetry Settings',
            objectName: 'GLOBAL',
            objectId: 'TELEMETRY_SETTINGS/GLOBAL',
            message: `Telemetry settings updated: ${Object.keys(patch).join(', ') || 'no changes'}.`,
            beforeValue: `${before.UserIdentificationMode}/${before.SamplingPercent}%`,
            afterValue: `${saved.UserIdentificationMode}/${saved.SamplingPercent}%`,
        });
        return saved;
    });

    service.on('updateFeedbackTriage', async (req) => {
        if (isDatabaseLess()) return req.reject(501, 'Feedback triage is available in Standard or Enterprise tiers.');

        const id = clampText(req.data.ID, 36);
        if (!id) return req.reject(400, 'ID is required.');
        const existing = await SELECT.one.from('adops.db.PilotFeedback').where({ ID: id });
        if (!existing) return req.reject(404, 'Feedback entry not found.');

        const status = req.data.status ? String(req.data.status).toUpperCase() : existing.Status;
        if (!FEEDBACK_STATUSES.has(status)) return req.reject(400, `Unsupported feedback status: ${status}`);

        const patch = {
            Status: status,
            AssignedTo: req.data.assignedTo !== undefined ? clampText(req.data.assignedTo, 120) : existing.AssignedTo,
            AdminNotes: req.data.adminNotes !== undefined ? clampText(req.data.adminNotes, 2000) : existing.AdminNotes,
            ResolutionNotes: req.data.resolutionNotes !== undefined ? clampText(req.data.resolutionNotes, 2000) : existing.ResolutionNotes,
        };
        await UPDATE('adops.db.PilotFeedback').set(patch).where({ ID: id });
        await writeAdminAuditEvent(req, {
            eventType: 'FEEDBACK_TRIAGED',
            objectType: 'Pilot Feedback',
            objectName: existing.ReferenceNumber || id,
            objectId: id,
            message: `Feedback ${existing.ReferenceNumber || id} triaged.`,
            beforeValue: existing.Status,
            afterValue: status,
        });
        return SELECT.one.from('adops.db.PilotFeedback').where({ ID: id });
    });

    service.on('updateClientErrorStatus', async (req) => {
        if (isDatabaseLess()) return req.reject(501, 'Error triage is available in Standard or Enterprise tiers.');

        const id = clampText(req.data.ID, 36);
        if (!id) return req.reject(400, 'ID is required.');
        const status = String(req.data.status || '').toUpperCase();
        if (!ERROR_STATUSES.has(status)) return req.reject(400, `Unsupported error status: ${status}`);

        const existing = await SELECT.one.from('adops.db.ClientErrorReports').where({ ID: id });
        if (!existing) return req.reject(404, 'Error report not found.');

        await UPDATE('adops.db.ClientErrorReports').set({ Status: status }).where({ ID: id });
        return SELECT.one.from('adops.db.ClientErrorReports').where({ ID: id });
    });

    // Server-side aggregation for the Usage view: the frontend never
    // downloads raw usage events to count them (performance rule).
    service.on('queryUsageSummary', async (req) => {
        if (isDatabaseLess()) {
            return { windowDays: boundedDays(req.data.days), totalEvents: 0, activeUsers: 0, activeSessions: 0, byEventName: [], byFeature: [], byVersion: [], feedbackByFeature: [] };
        }
        const windowDays = boundedDays(req.data.days);
        const cutoff = daysAgoIso(windowDays);
        const usage = 'adops.db.UsageEvents';
        const since = { Timestamp: { '>=': cutoff } };

        const [totals, users, sessions, byEventName, byFeature, byVersion, feedbackByFeature] = await Promise.all([
            SELECT.one.from(usage).columns(count('total')).where(since),
            SELECT.from(usage).columns('UserId').where(since).groupBy('UserId'),
            SELECT.from(usage).columns('SessionId').where(since).groupBy('SessionId'),
            SELECT.from(usage).columns('EventName', count()).where(since).groupBy('EventName'),
            SELECT.from(usage).columns('Feature', 'Outcome', count()).where(since).groupBy('Feature', 'Outcome'),
            SELECT.from(usage).columns('AppVersion', count()).where(since).groupBy('AppVersion'),
            SELECT.from('adops.db.PilotFeedback').columns('Feature', count()).where({ SubmittedAt: { '>=': cutoff } }).groupBy('Feature'),
        ]);

        const desc = (rows) => [...rows].sort((a, b) => (b.count || 0) - (a.count || 0));
        return {
            windowDays,
            totalEvents: totals?.total || 0,
            activeUsers: users.length,
            activeSessions: sessions.length,
            byEventName: desc(byEventName).map((row) => ({ eventName: row.EventName, count: row.count })),
            byFeature: desc(byFeature).map((row) => ({ feature: row.Feature || '(none)', outcome: row.Outcome || '', count: row.count })),
            byVersion: desc(byVersion).map((row) => ({ appVersion: row.AppVersion || '(unknown)', count: row.count })),
            feedbackByFeature: desc(feedbackByFeature).map((row) => ({ feature: row.Feature || '(none)', count: row.count })),
        };
    });

    service.on('queryPerformanceSummary', async (req) => {
        if (isDatabaseLess()) {
            return { windowDays: boundedDays(req.data.days), totalEvents: 0, failedCount: 0, operations: [] };
        }
        const windowDays = boundedDays(req.data.days);
        const cutoff = daysAgoIso(windowDays);
        const perf = 'adops.db.PerformanceEvents';
        const since = { Timestamp: { '>=': cutoff } };

        const [totals, failed, operations] = await Promise.all([
            SELECT.one.from(perf).columns(count('total')).where(since),
            SELECT.one.from(perf).columns(count('total')).where({ ...since, Outcome: 'FAILED' }),
            SELECT.from(perf)
                .columns(
                    'Source',
                    'OperationName',
                    count(),
                    { func: 'avg', args: [{ ref: ['DurationMs'] }], as: 'avgMs' },
                    { func: 'max', args: [{ ref: ['DurationMs'] }], as: 'maxMs' }
                )
                .where(since)
                .groupBy('Source', 'OperationName'),
        ]);

        const ranked = [...operations]
            .sort((a, b) => (b.avgMs || 0) - (a.avgMs || 0))
            .slice(0, 25)
            .map((row) => ({
                source: row.Source,
                operationName: row.OperationName,
                count: row.count,
                avgMs: Math.round(row.avgMs || 0),
                maxMs: row.maxMs || 0,
            }));

        return {
            windowDays,
            totalEvents: totals?.total || 0,
            failedCount: failed?.total || 0,
            operations: ranked,
        };
    });

    // Admin-triggered retention cleanup. The interval scheduler
    // (telemetry-retention.js, wired in server.js) runs the same routine, so
    // this action is the on-demand form of the identical deletion rules.
    service.on('runTelemetryCleanup', async (req) => {
        if (isDatabaseLess()) return { usageDeleted: 0, performanceDeleted: 0, errorsDeleted: 0 };

        const result = await runTelemetryRetentionCleanup();
        await writeAdminAuditEvent(req, {
            eventType: 'TELEMETRY_CLEANUP_RUN',
            objectType: 'Telemetry Retention',
            objectName: 'GLOBAL',
            objectId: 'TELEMETRY_CLEANUP',
            message: `Telemetry cleanup removed ${result.usageDeleted} usage, ${result.performanceDeleted} performance, ${result.errorsDeleted} error rows.`,
            beforeValue: '',
            afterValue: `${result.usageDeleted + result.performanceDeleted + result.errorsDeleted} rows`,
        });
        return result;
    });
}

module.exports = { registerTelemetryAdminHandlers };
