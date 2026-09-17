// Capture policy for usage/performance telemetry (pure, node --test):
// store threshold-crossing or failed operations only, never routine timing
// noise. Defaults mirror the server's DEFAULT_TELEMETRY_SETTINGS; the tenant
// values served by CoreService.getTelemetrySettings override them.

export const SLOW_ROUTE_MS = 2000;
export const SLOW_API_MS = 3000;
export const SEVERE_API_MS = 10000;

// Route renders are timed with requestAnimationFrame, which browsers suspend
// entirely for hidden tabs: a user backgrounding the tab mid-navigation would
// otherwise record a minutes-long "render". Anything above this bound is
// tab-suspension noise, not render time, and must be discarded.
export const ROUTE_RENDER_DISCARD_MS = 120000;

// Telemetry must never observe its own transport (report loops, self-timing).
const TELEMETRY_ENDPOINT_PATTERN = /\/core\/(recordTelemetryBatch|recordClientError|submitPilotFeedback|getTelemetrySettings)/i;

export function isTelemetryEndpoint(url) {
  return TELEMETRY_ENDPOINT_PATTERN.test(String(url || ''));
}

const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);

// Returns null when the timing should NOT be recorded. Fast failures return
// null too: the error path captures them as ClientErrorReports, and
// duplicating every failure into PerformanceEvents would double-count.
export function classifyApiTiming(
  { durationMs, failed = false },
  { slowApiThresholdMs, severeApiThresholdMs } = {}
) {
  const slow = positiveInt(slowApiThresholdMs, SLOW_API_MS);
  const severe = Math.max(positiveInt(severeApiThresholdMs, SEVERE_API_MS), slow);
  if (!Number.isFinite(durationMs) || durationMs < slow) return null;
  const isSevere = durationMs >= severe;
  return {
    outcome: failed ? 'FAILED' : isSevere ? 'SEVERE' : 'SLOW',
    thresholdMs: isSevere ? severe : slow
  };
}

export function classifyRouteRender(durationMs, { slowRouteThresholdMs } = {}) {
  const slow = positiveInt(slowRouteThresholdMs, SLOW_ROUTE_MS);
  if (!Number.isFinite(durationMs) || durationMs < slow) return null;
  if (durationMs > ROUTE_RENDER_DISCARD_MS) return null;
  return { outcome: 'SLOW', thresholdMs: slow };
}

// "GET /fiori/queryActivationPlans()" style operation names: the method and
// the path without query string or key segments, bounded to the column width.
export function apiOperationName(method, url) {
  const path = String(url || '').split('?')[0].replace(/\([^)]*\)/g, '()');
  return `${String(method || 'GET').toUpperCase()} ${path}`.trim().slice(0, 120);
}

// The UsageEventInput row for a usage event; every field bounded to its
// column width so the batch never carries oversized strings.
export function buildUsageEvent({ eventName, eventCategory, route, feature, action, outcome, durationMs, targetSystem, metadataJson, now = new Date() }) {
  const clamp = (v, max) => String(v ?? '').slice(0, max);
  if (!clamp(eventName, 60)) return null;
  return {
    timestamp: now.toISOString(),
    eventName: clamp(eventName, 60),
    eventCategory: clamp(eventCategory, 40),
    route: clamp(route, 200),
    feature: clamp(feature, 120),
    action: clamp(action, 60),
    outcome: clamp(outcome, 30),
    durationMs: Number.isInteger(durationMs) && durationMs >= 0 ? durationMs : null,
    targetSystem: clamp(targetSystem, 120),
    metadataJson: clamp(metadataJson, 2000)
  };
}

// The PerformanceEventInput row; null when it cannot be stored (the server
// drops rows without an operation name or duration).
export function buildPerformanceEvent({ source, operationName, routeOrEndpoint, durationMs, thresholdMs, outcome, now = new Date() }) {
  const clamp = (v, max) => String(v ?? '').slice(0, max);
  if (!clamp(operationName, 120) || !Number.isFinite(durationMs)) return null;
  return {
    timestamp: now.toISOString(),
    source: ['CLIENT', 'API', 'CAP'].includes(String(source || '').toUpperCase()) ? String(source).toUpperCase() : 'CLIENT',
    operationName: clamp(operationName, 120),
    routeOrEndpoint: clamp(routeOrEndpoint, 300),
    durationMs: Math.max(0, Math.round(durationMs)),
    thresholdMs: Number.isInteger(thresholdMs) && thresholdMs >= 0 ? thresholdMs : null,
    outcome: clamp(outcome, 30)
  };
}
