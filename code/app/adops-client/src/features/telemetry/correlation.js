// Client half of the correlation contract (server: srv/server.js
// resolveCorrelationId / CORRELATION_HEADER). Pure module: no axios, no
// import.meta - it runs under node --test. The services install it on their
// axios instances (services/httpCorrelation.js).
//
// One id per request, minted here and echoed back by the server, so a crash
// report, the failing call and the CAP/BTP log lines share one reference the
// user can quote. The session id ties every request of one page load.

export const CORRELATION_HEADER = 'x-correlation-id';
export const CORRELATION_ID_MAX_LENGTH = 64;

// Field limits mirror ClientErrorReports (db/data-model.cds); the server
// clamps again, this only keeps the payload small on the wire.
export const REPORT_LIMITS = {
  errorMessage: 1000,
  stackTrace: 4000,
  componentStack: 2000,
  route: 200,
  feature: 120,
  browserInfo: 200,
  appVersion: 60,
  sessionId: 64
};

export function normalizeCorrelationId(value) {
  const text = String(value ?? '').trim();
  return text.slice(0, CORRELATION_ID_MAX_LENGTH);
}

// `random` is injectable for tests; browsers and node provide crypto.randomUUID.
export function newCorrelationId(random = defaultRandomId) {
  return normalizeCorrelationId(random()) || defaultRandomId();
}

function defaultRandomId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// Per page-load context: session id + the id of the most recent request,
// which is what a crash report quotes when the crash follows a failed call.
export function createCorrelationContext({ sessionId, random } = {}) {
  const context = {
    sessionId: normalizeCorrelationId(sessionId) || newCorrelationId(random),
    lastCorrelationId: '',
    nextRequestId() {
      context.lastCorrelationId = newCorrelationId(random);
      return context.lastCorrelationId;
    },
    // The server may replace the id (it prefers platform ids); adopt what it
    // echoed so the reference we show matches the backend log line.
    adoptResponseHeaders(headers) {
      const echoed = normalizeCorrelationId(readHeader(headers, CORRELATION_HEADER));
      if (echoed) context.lastCorrelationId = echoed;
      return context.lastCorrelationId;
    }
  };
  return context;
}

function readHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  return headers[name] || headers[name.toUpperCase()] || '';
}

// Feature = first route segment ("/activation/abc" -> "activation"); the
// Product Insights page groups crash reports by it.
export function featureFromRoute(route) {
  const path = String(route || '').replace(/^#/, '').split('?')[0];
  const segment = path.split('/').filter(Boolean)[0] || '';
  return segment.slice(0, REPORT_LIMITS.feature);
}

const clamp = (value, max) => String(value ?? '').slice(0, max);

// The recordClientError action payload for a React render crash
// (AppErrorBoundary.componentDidCatch). Everything is clamped; nothing here
// may throw, since it runs inside the error path itself.
export function buildRenderErrorReport({
  error, componentStack, route, sessionId, correlationId, appVersion, browserInfo
} = {}) {
  const message = error?.message ?? (typeof error === 'string' ? error : String(error ?? 'Unknown render error'));
  const routeText = clamp(String(route || '').replace(/^#/, '') || '/', REPORT_LIMITS.route);
  return {
    errorType: 'RENDER_ERROR',
    severity: 'FATAL',
    errorMessage: clamp(message || 'Unknown render error', REPORT_LIMITS.errorMessage),
    stackTrace: clamp(error?.stack, REPORT_LIMITS.stackTrace),
    componentStack: clamp(componentStack, REPORT_LIMITS.componentStack),
    route: routeText,
    feature: featureFromRoute(routeText),
    endpointPath: null,
    httpMethod: null,
    httpStatus: null,
    appVersion: clamp(appVersion, REPORT_LIMITS.appVersion),
    browserInfo: clamp(browserInfo, REPORT_LIMITS.browserInfo),
    sessionId: clamp(sessionId, REPORT_LIMITS.sessionId),
    correlationId: normalizeCorrelationId(correlationId)
  };
}
