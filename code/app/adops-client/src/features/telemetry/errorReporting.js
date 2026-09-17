// Pure logic for client-side crash reporting (recordClientError): the
// payload for every error type, the client-side dedupe / session cap, and
// the API-failure capture policy. Transport lives in
// services/telemetryService.js; this stays testable under node --test.

import { REPORT_LIMITS, normalizeCorrelationId, featureFromRoute } from './correlation.js';
import { isTelemetryEndpoint } from './performancePolicy.js';

export const ERROR_TYPES = ['RENDER_ERROR', 'UNHANDLED_REJECTION', 'WINDOW_ERROR', 'API_FAILURE', 'INIT_FAILURE'];
export const SEVERITIES = ['FATAL', 'ERROR', 'WARNING'];

const clip = (value, limit) => String(value ?? '').trim().slice(0, limit);

// The recordClientError action payload. Every field is clamped to its
// ClientErrorReports column width (the server clamps again); nothing here
// may throw, since it runs inside the error path itself.
export function buildClientErrorReport({
  errorType, severity, error, message, componentStack, route, feature,
  endpointPath, httpMethod, httpStatus, sessionId, correlationId, appVersion, browserInfo
} = {}) {
  const resolvedMessage = clip(message || error?.message || (typeof error === 'string' ? error : ''), REPORT_LIMITS.errorMessage)
    || 'Unknown client error';
  const routeText = clip(String(route || '').replace(/^#/, ''), REPORT_LIMITS.route);
  return {
    errorType: ERROR_TYPES.includes(errorType) ? errorType : 'WINDOW_ERROR',
    severity: SEVERITIES.includes(severity) ? severity : 'ERROR',
    errorMessage: resolvedMessage,
    stackTrace: clip(error?.stack, REPORT_LIMITS.stackTrace),
    componentStack: clip(componentStack, REPORT_LIMITS.componentStack),
    route: routeText,
    feature: clip(feature ?? featureFromRoute(routeText), REPORT_LIMITS.feature),
    endpointPath: clip(endpointPath, 300) || null,
    httpMethod: clip(httpMethod, 10).toUpperCase() || null,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    appVersion: clip(appVersion, REPORT_LIMITS.appVersion),
    browserInfo: clip(browserInfo, REPORT_LIMITS.browserInfo),
    sessionId: clip(sessionId, REPORT_LIMITS.sessionId),
    correlationId: normalizeCorrelationId(correlationId)
  };
}

// Client-side gate: identical errors collapse into one report per window and
// a session-wide cap stops a crash loop from flooding the backend (the server
// dedupes by fingerprint anyway; this protects the network path and is the
// client half of A13 rate limiting).
export function createReportGate({ maxReportsPerSession = 25, dedupeWindowMs = 30000 } = {}) {
  const lastSeenByKey = new Map();
  let reportCount = 0;
  return {
    shouldReport(report, now = Date.now()) {
      if (reportCount >= maxReportsPerSession) return false;
      const key = [report?.errorType, report?.errorMessage, report?.endpointPath, report?.httpStatus].join('||');
      const lastSeen = lastSeenByKey.get(key);
      if (lastSeen !== undefined && now - lastSeen < dedupeWindowMs) return false;
      lastSeenByKey.set(key, now);
      reportCount += 1;
      return true;
    },
    reportedCount() {
      return reportCount;
    }
  };
}

// API-failure capture policy: report infrastructure failures (network
// errors, timeouts, 5xx), not business validation responses (4xx) - and
// never the telemetry endpoints themselves (a failing reporter must not
// report itself).
export function shouldCaptureApiFailure({ status, url } = {}) {
  if (isTelemetryEndpoint(url)) return false;
  if (status === undefined || status === null) return true;
  return Number(status) >= 500;
}

// An unhandled rejection's reason can be anything; keep an Error as-is (for
// its stack) and stringify the rest for the message.
export function describeRejection(reason) {
  if (reason instanceof Error) return { error: reason, message: reason.message };
  if (reason && typeof reason === 'object') {
    const message = reason.message || reason.error?.message || safeJson(reason);
    return { error: reason.error instanceof Error ? reason.error : undefined, message: String(message || 'Unhandled promise rejection') };
  }
  return { error: undefined, message: String(reason ?? 'Unhandled promise rejection') };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
