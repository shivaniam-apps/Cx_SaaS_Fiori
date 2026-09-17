import axios from 'axios';
import { installCorrelation, correlation, setApiTimingListener } from './httpCorrelation.js';
import { featureFromRoute } from '../features/telemetry/correlation.js';
import { createTelemetryQueue } from '../features/telemetry/queue.js';
import {
  isTelemetryEndpoint,
  classifyApiTiming,
  classifyRouteRender,
  apiOperationName,
  buildUsageEvent,
  buildPerformanceEvent
} from '../features/telemetry/performancePolicy.js';
import {
  buildClientErrorReport,
  createReportGate,
  shouldCaptureApiFailure,
  describeRejection
} from '../features/telemetry/errorReporting.js';

// Client telemetry: crash reports (recordClientError, I16) and batched usage
// + performance events (recordTelemetryBatch, I17). Everything here is
// fire-and-forget: a telemetry failure must never surface into the user
// workflow, so every path swallows errors after the gate. The server applies
// identity, tenant, sampling and the authoritative enable/disable gate again.

const http = installCorrelation(axios.create({ timeout: 30000 }));
const queue = createTelemetryQueue();
const reportGate = createReportGate();
const FLUSH_DELAY_MS = 10000;
const BATCH_URL = '/core/recordTelemetryBatch';
const ERROR_URL = '/core/recordClientError';

// Tenant collection settings, fetched once per page load. Collection stays
// ON until the fetch resolves; the server gate is the authoritative one.
let settings = {
  usageEnabled: true,
  performanceEnabled: true,
  crashReportingEnabled: true,
  slowRouteThresholdMs: undefined,
  slowApiThresholdMs: undefined,
  severeApiThresholdMs: undefined
};

function loadSettings() {
  http.get('/core/getTelemetrySettings()')
    .then((response) => {
      const data = response?.data;
      if (data && typeof data === 'object') settings = { ...settings, ...data };
    })
    .catch(() => null);
}

const appVersion = () => (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '');
const currentRoute = () => (typeof window !== 'undefined' ? window.location.hash || window.location.pathname || '' : '');
const browserInfo = () => (typeof navigator !== 'undefined' ? navigator.userAgent : '');

// --- Crash reports -----------------------------------------------------------

// input: { errorType, severity, error, message, componentStack, endpointPath,
// httpMethod, httpStatus, correlationId }. Resolves to the receipt
// ({ received, fingerprint, occurrenceCount }) plus the correlation id the
// report carried, or null when the gate or the settings suppressed it.
export async function reportClientError(input) {
  let correlationId = '';
  try {
    if (!settings.crashReportingEnabled) return null;
    correlationId = input?.correlationId || correlation.lastCorrelationId;
    const report = buildClientErrorReport({
      ...input,
      route: input?.route ?? currentRoute(),
      sessionId: correlation.sessionId,
      correlationId,
      appVersion: appVersion(),
      browserInfo: browserInfo()
    });
    if (!reportGate.shouldReport(report)) return null;
    const response = await http.post(ERROR_URL, report);
    return { ...(response.data || {}), correlationId: correlation.lastCorrelationId || correlationId };
  } catch (reportError) {
    console.warn('Crash report could not be sent:', reportError?.message || reportError);
    return { received: false, fingerprint: null, occurrenceCount: 0, correlationId };
  }
}

// React render crash (AppErrorBoundary.componentDidCatch).
export function reportRenderError({ error, componentStack }) {
  return reportClientError({ errorType: 'RENDER_ERROR', severity: 'FATAL', error, componentStack });
}

// --- Usage + performance (batched) ------------------------------------------

function batchPayload(batch) {
  return {
    sessionId: correlation.sessionId,
    appVersion: appVersion(),
    usageEvents: batch.usageEvents,
    performanceEvents: batch.performanceEvents
  };
}

let flushTimer = null;

function scheduleFlush(delayMs = FLUSH_DELAY_MS) {
  if (flushTimer !== null || typeof setTimeout === 'undefined') return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushTelemetry();
  }, delayMs);
}

export async function flushTelemetry() {
  const batch = queue.takeBatch();
  if (!batch) return;
  try {
    await http.post(BATCH_URL, batchPayload(batch));
    queue.onFlushSuccess();
    if (queue.size() > 0) scheduleFlush(0);
  } catch {
    const backoffMs = queue.onFlushFailure(batch);
    if (backoffMs !== null) scheduleFlush(backoffMs);
  }
}

// Page-lifecycle flush: pending events would otherwise be lost on tab close.
// keepalive lets the request outlive the page; failures are irrelevant here.
function flushOnPageHide() {
  const batch = queue.takeBatch();
  if (!batch || typeof fetch === 'undefined') return;
  try {
    fetch(BATCH_URL, {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(batchPayload(batch))
    }).catch(() => null);
  } catch {
    // Never let telemetry interfere with page teardown.
  }
}

// details: { eventCategory, route, feature, action, outcome, durationMs, targetSystem, metadataJson }
export function trackUsage(eventName, details = {}) {
  try {
    if (!settings.usageEnabled) return;
    const route = details.route ?? currentRoute();
    const event = buildUsageEvent({
      eventName,
      ...details,
      route,
      feature: details.feature ?? featureFromRoute(route)
    });
    if (!event) return;
    queue.enqueueUsage(event);
    scheduleFlush();
  } catch {
    // Usage tracking is always best-effort.
  }
}

// Derive the feature from the SAME route value, not from window.location:
// a redirect can move the address bar between the router's effect and this
// read, which would otherwise label the event with the wrong feature.
// Immediate repeats of the same route are one view: React StrictMode runs
// the navigation effect twice in development, and a redirect can commit the
// same pathname twice within a frame.
const PAGE_VIEW_DEDUPE_MS = 1000;
let lastPageView = { route: '', at: 0 };

export function trackPageView(route) {
  const at = Date.now();
  if (route === lastPageView.route && at - lastPageView.at < PAGE_VIEW_DEDUPE_MS) return;
  lastPageView = { route, at };
  trackUsage('PAGE_VIEWED', { eventCategory: 'NAVIGATION', route, feature: featureFromRoute(route) });
}

export function trackPerformance(input) {
  try {
    if (!settings.performanceEnabled) return;
    const event = buildPerformanceEvent(input);
    if (!event) return;
    queue.enqueuePerformance(event);
    scheduleFlush();
  } catch {
    // Best-effort.
  }
}

// Route-render timing: measured from the navigation effect to the second
// animation frame (first paintable frame after React commits). Only slow
// renders are recorded, per the capture policy.
export function measureRouteRender(route) {
  if (typeof requestAnimationFrame === 'undefined' || typeof performance === 'undefined') return;
  const start = performance.now();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const durationMs = performance.now() - start;
      const classification = classifyRouteRender(durationMs, settings);
      if (!classification) return;
      trackPerformance({
        source: 'CLIENT', operationName: 'ROUTE_RENDER', routeOrEndpoint: route,
        durationMs, thresholdMs: classification.thresholdMs, outcome: classification.outcome
      });
    });
  });
}

// Initial application load, once per session, recorded unconditionally (a
// single event, and cold-start time is a headline pilot metric).
let appLoadRecorded = false;

function recordInitialAppLoad() {
  if (appLoadRecorded || typeof performance === 'undefined' || typeof window === 'undefined') return;
  const record = () => {
    if (appLoadRecorded) return;
    const [navigation] = performance.getEntriesByType?.('navigation') || [];
    const durationMs = navigation?.loadEventEnd || navigation?.domComplete || 0;
    if (durationMs > 0) {
      appLoadRecorded = true;
      trackPerformance({
        source: 'CLIENT', operationName: 'APP_LOAD', routeOrEndpoint: window.location.hash || '/',
        durationMs, thresholdMs: 0, outcome: 'COMPLETE'
      });
    }
  };
  if (document.readyState === 'complete') record();
  else window.addEventListener('load', () => setTimeout(record, 0), { once: true });
}

// --- Registration ------------------------------------------------------------

let registered = false;

// Registered once from main.jsx. The module flag guards StrictMode re-renders
// and dev hot reloads from stacking duplicate listeners.
export function registerTelemetry() {
  if (registered || typeof window === 'undefined') return;
  registered = true;

  // Uncaught errors and unhandled rejections outside React's render path
  // (event handlers, timers, async work) - the boundary never sees these.
  window.addEventListener('error', (event) => {
    reportClientError({
      errorType: 'WINDOW_ERROR', severity: 'ERROR',
      error: event?.error, message: event?.message
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const { error, message } = describeRejection(event?.reason);
    reportClientError({ errorType: 'UNHANDLED_REJECTION', severity: 'ERROR', error, message });
  });

  // Every timed CAP request lands here. Slow-API capture stores only
  // threshold-crossing operations; failure capture keeps to infrastructure
  // failures (network / 5xx). Neither ever observes the telemetry endpoints.
  setApiTimingListener(({ url, method, status, durationMs, failed, message, correlationId }) => {
    if (isTelemetryEndpoint(url)) return;
    if (failed && shouldCaptureApiFailure({ status, url })) {
      reportClientError({
        errorType: 'API_FAILURE', severity: status ? 'ERROR' : 'WARNING',
        message: message || `${method} ${url} failed`,
        endpointPath: url, httpMethod: method, httpStatus: status ?? null, correlationId
      });
    }
    const classification = classifyApiTiming({ durationMs, failed }, settings);
    if (!classification) return;
    trackPerformance({
      source: 'API', operationName: apiOperationName(method, url), routeOrEndpoint: url,
      durationMs, thresholdMs: classification.thresholdMs, outcome: classification.outcome
    });
  });

  loadSettings();
  recordInitialAppLoad();

  window.addEventListener('pagehide', flushOnPageHide);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnPageHide();
  });
}
