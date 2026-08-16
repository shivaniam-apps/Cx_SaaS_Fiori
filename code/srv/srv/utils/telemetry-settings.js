const cds = require('@sap/cds');
const { isDatabaseLess } = require('./tier.js');

const SINGLETON_KEY = 'GLOBAL';

// Pilot defaults per the implementation brief. Everything on, identified
// users, no sampling, conservative retention.
const DEFAULT_TELEMETRY_SETTINGS = Object.freeze({
    FeedbackEnabled: true,
    UsageEnabled: true,
    CrashReportingEnabled: true,
    PerformanceEnabled: true,
    StackTraceEnabled: true,
    UserIdentificationMode: 'IDENTIFIED',
    SamplingPercent: 100,
    SlowRouteThresholdMs: 2000,
    SlowApiThresholdMs: 3000,
    SevereApiThresholdMs: 10000,
    UsageRetentionDays: 90,
    PerformanceRetentionDays: 90,
    ErrorRetentionDays: 180,
});

const IDENTIFICATION_MODES = new Set(['IDENTIFIED', 'HASHED', 'ANONYMOUS']);

// Ingestion reads settings on every event; a short TTL cache keeps that off
// the database without letting admin changes lag noticeably.
const CACHE_TTL_MS = 30000;
let cached = null;
let cachedAt = 0;

function coerceBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function coerceBoundedInteger(value, fallback, { min, max }) {
    if (!Number.isInteger(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

function normalizeSettings(row = {}) {
    const mode = String(row.UserIdentificationMode || '').toUpperCase();
    return {
        FeedbackEnabled: coerceBoolean(row.FeedbackEnabled, DEFAULT_TELEMETRY_SETTINGS.FeedbackEnabled),
        UsageEnabled: coerceBoolean(row.UsageEnabled, DEFAULT_TELEMETRY_SETTINGS.UsageEnabled),
        CrashReportingEnabled: coerceBoolean(row.CrashReportingEnabled, DEFAULT_TELEMETRY_SETTINGS.CrashReportingEnabled),
        PerformanceEnabled: coerceBoolean(row.PerformanceEnabled, DEFAULT_TELEMETRY_SETTINGS.PerformanceEnabled),
        StackTraceEnabled: coerceBoolean(row.StackTraceEnabled, DEFAULT_TELEMETRY_SETTINGS.StackTraceEnabled),
        UserIdentificationMode: IDENTIFICATION_MODES.has(mode) ? mode : DEFAULT_TELEMETRY_SETTINGS.UserIdentificationMode,
        SamplingPercent: coerceBoundedInteger(row.SamplingPercent, DEFAULT_TELEMETRY_SETTINGS.SamplingPercent, { min: 0, max: 100 }),
        SlowRouteThresholdMs: coerceBoundedInteger(row.SlowRouteThresholdMs, DEFAULT_TELEMETRY_SETTINGS.SlowRouteThresholdMs, { min: 100, max: 600000 }),
        SlowApiThresholdMs: coerceBoundedInteger(row.SlowApiThresholdMs, DEFAULT_TELEMETRY_SETTINGS.SlowApiThresholdMs, { min: 100, max: 600000 }),
        SevereApiThresholdMs: coerceBoundedInteger(row.SevereApiThresholdMs, DEFAULT_TELEMETRY_SETTINGS.SevereApiThresholdMs, { min: 100, max: 600000 }),
        UsageRetentionDays: coerceBoundedInteger(row.UsageRetentionDays, DEFAULT_TELEMETRY_SETTINGS.UsageRetentionDays, { min: 1, max: 3650 }),
        PerformanceRetentionDays: coerceBoundedInteger(row.PerformanceRetentionDays, DEFAULT_TELEMETRY_SETTINGS.PerformanceRetentionDays, { min: 1, max: 3650 }),
        ErrorRetentionDays: coerceBoundedInteger(row.ErrorRetentionDays, DEFAULT_TELEMETRY_SETTINGS.ErrorRetentionDays, { min: 1, max: 3650 }),
    };
}

async function readEffectiveTelemetrySettings() {
    const now = Date.now();
    if (cached && now - cachedAt < CACHE_TTL_MS) return cached;
    if (isDatabaseLess()) {
        cached = { ...DEFAULT_TELEMETRY_SETTINGS };
        cachedAt = now;
        return cached;
    }
    try {
        const row = await SELECT.one.from('adops.db.TelemetrySettings').where({ SingletonKey: SINGLETON_KEY });
        cached = normalizeSettings(row || {});
    } catch {
        // Never let a settings-read failure break ingestion: fall back to
        // defaults but do not cache the failure for the full TTL.
        return { ...DEFAULT_TELEMETRY_SETTINGS };
    }
    cachedAt = now;
    return cached;
}

// Upsert of the singleton row. Only defined keys in `patch` are applied over
// the current effective settings; the result is normalized before storing so
// invalid values can never persist.
async function saveTelemetrySettings(patch = {}, userId = 'anonymous') {
    const current = await readEffectiveTelemetrySettings();
    const merged = normalizeSettings({ ...current, ...patch });

    const existing = await SELECT.one.from('adops.db.TelemetrySettings').where({ SingletonKey: SINGLETON_KEY });
    if (existing) {
        await UPDATE('adops.db.TelemetrySettings').set({ ...merged, UpdatedBy: userId }).where({ ID: existing.ID });
    } else {
        await INSERT.into('adops.db.TelemetrySettings').entries({
            ID: cds.utils.uuid(),
            SingletonKey: SINGLETON_KEY,
            ...merged,
            UpdatedBy: userId,
        });
    }
    invalidateTelemetrySettingsCache();
    return merged;
}

function invalidateTelemetrySettingsCache() {
    cached = null;
    cachedAt = 0;
}

module.exports = {
    DEFAULT_TELEMETRY_SETTINGS,
    IDENTIFICATION_MODES,
    readEffectiveTelemetrySettings,
    saveTelemetrySettings,
    invalidateTelemetrySettingsCache,
};
