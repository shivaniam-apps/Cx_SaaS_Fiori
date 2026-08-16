const cds = require('@sap/cds');
const { isDatabaseLess } = require('./tier.js');
const { readEffectiveTelemetrySettings } = require('./telemetry-settings.js');
const { writeAdminAuditEvent } = require('./admin-audit.js');

const LOG = cds.log('telemetry-retention');

const DEFAULT_CLEANUP_INTERVAL_HOURS = 24;
const MAX_CLEANUP_INTERVAL_HOURS = 24 * 7;
// Spread instance start-up so several CF instances of the app do not fire
// their first cleanup at the same moment. Overlap is harmless (deleting
// already-expired rows is idempotent) - the jitter only avoids needless
// duplicate work.
const START_JITTER_MS = 5 * 60 * 1000;

function daysAgoIso(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Exported for tests: pure resolution of the scheduler interval.
// <= 0 or non-numeric ADOPTOPS_TELEMETRY_CLEANUP_INTERVAL_HOURS disables
// the scheduler (operator-only cleanup); values are capped at one week so a
// typo cannot silently turn retention off for months.
function resolveTelemetryCleanupIntervalMs(rawHours) {
    if (rawHours === undefined || rawHours === null || String(rawHours).trim() === '') {
        return DEFAULT_CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000;
    }

    const hours = Number(rawHours);
    if (!Number.isFinite(hours) || hours <= 0) return 0;

    return Math.min(hours, MAX_CLEANUP_INTERVAL_HOURS) * 60 * 60 * 1000;
}

// Deletes telemetry rows past their configured retention. Shared by the
// admin-triggered runTelemetryCleanup action and the interval scheduler so
// the two can never disagree about what "expired" means. Pilot feedback is
// deliberately never auto-deleted.
async function runTelemetryRetentionCleanup() {
    if (isDatabaseLess()) return { usageDeleted: 0, performanceDeleted: 0, errorsDeleted: 0 };

    const settings = await readEffectiveTelemetrySettings();
    const [usageDeleted, performanceDeleted, errorsDeleted] = await Promise.all([
        DELETE.from('adops.db.UsageEvents').where({ Timestamp: { '<': daysAgoIso(settings.UsageRetentionDays) } }),
        DELETE.from('adops.db.PerformanceEvents').where({ Timestamp: { '<': daysAgoIso(settings.PerformanceRetentionDays) } }),
        DELETE.from('adops.db.ClientErrorReports').where({ LastSeenAt: { '<': daysAgoIso(settings.ErrorRetentionDays) } }),
    ]);

    return {
        usageDeleted: usageDeleted || 0,
        performanceDeleted: performanceDeleted || 0,
        errorsDeleted: errorsDeleted || 0,
    };
}

async function runScheduledCleanup() {
    try {
        const result = await runTelemetryRetentionCleanup();
        const total = result.usageDeleted + result.performanceDeleted + result.errorsDeleted;
        LOG.info(`Scheduled telemetry cleanup removed ${result.usageDeleted} usage, ${result.performanceDeleted} performance, ${result.errorsDeleted} error rows.`);

        // Audit only runs that actually removed data - a daily "0 rows" entry
        // would drown the trail the audit exists for.
        if (total > 0) {
            await writeAdminAuditEvent(
                { user: { id: 'SYSTEM' }, headers: {} },
                {
                    eventType: 'TELEMETRY_CLEANUP_RUN',
                    objectType: 'Telemetry Retention',
                    objectName: 'GLOBAL',
                    objectId: 'TELEMETRY_CLEANUP',
                    message: `Scheduled telemetry cleanup removed ${result.usageDeleted} usage, ${result.performanceDeleted} performance, ${result.errorsDeleted} error rows.`,
                    beforeValue: '',
                    afterValue: `${total} rows`,
                    source: 'Retention Scheduler',
                }
            );
        }
    } catch (error) {
        LOG.warn(`Scheduled telemetry cleanup failed; next interval will retry: ${error.message}`);
    }
}

// Interval-based retention enforcement. Timers are unref'd so they never keep
// a CLI invocation or test process alive.
function scheduleTelemetryRetentionCleanup() {
    const intervalMs = resolveTelemetryCleanupIntervalMs(process.env.ADOPTOPS_TELEMETRY_CLEANUP_INTERVAL_HOURS);

    if (!intervalMs) {
        LOG.info('Telemetry retention scheduler disabled (ADOPTOPS_TELEMETRY_CLEANUP_INTERVAL_HOURS <= 0); cleanup remains operator-triggered.');
        return null;
    }

    if (isDatabaseLess()) {
        LOG.info('Telemetry retention scheduler not started: databaseless tier persists no telemetry.');
        return null;
    }

    const initialDelayMs = Math.floor(Math.random() * START_JITTER_MS) + 60 * 1000;
    const startTimer = setTimeout(() => { void runScheduledCleanup(); }, initialDelayMs);
    const intervalTimer = setInterval(() => { void runScheduledCleanup(); }, intervalMs);
    startTimer.unref?.();
    intervalTimer.unref?.();

    LOG.info(`Telemetry retention scheduler active: every ${Math.round(intervalMs / 3600000 * 10) / 10}h, first run in ${Math.round(initialDelayMs / 1000)}s.`);
    return { startTimer, intervalTimer };
}

module.exports = {
    resolveTelemetryCleanupIntervalMs,
    runTelemetryRetentionCleanup,
    scheduleTelemetryRetentionCleanup,
};
