import {
  CORRELATION_HEADER,
  createCorrelationContext
} from '../features/telemetry/correlation.js';

// One correlation context per page load, shared by every axios instance
// (coreService, fioriService, adminService): each request carries a fresh id
// in x-correlation-id, and the id the server echoes back becomes the
// reference a crash report quotes.
export const correlation = createCorrelationContext();

// Every timed request lands here (telemetryService registers the listener
// and applies the capture policy); one listener, set once, never throws into
// the request path.
let apiTimingListener = null;

export function setApiTimingListener(listener) {
  apiTimingListener = typeof listener === 'function' ? listener : null;
}

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function notifyTiming(config, { status, failed }) {
  if (!apiTimingListener || !config || config.adopsRequestStart === undefined) return;
  try {
    apiTimingListener({
      url: config.url || '',
      method: String(config.method || 'get').toUpperCase(),
      status: status ?? null,
      durationMs: now() - config.adopsRequestStart,
      failed: Boolean(failed),
      correlationId: correlation.lastCorrelationId
    });
  } catch {
    // Telemetry never interferes with the request.
  }
}

export function installCorrelation(http) {
  http.interceptors.request.use((config) => {
    config.headers = config.headers || {};
    config.headers[CORRELATION_HEADER] = correlation.nextRequestId();
    config.adopsRequestStart = now();
    return config;
  });
  http.interceptors.response.use(
    (response) => {
      correlation.adoptResponseHeaders(response.headers);
      notifyTiming(response.config, { status: response.status, failed: false });
      return response;
    },
    (error) => {
      correlation.adoptResponseHeaders(error?.response?.headers);
      notifyTiming(error?.config, { status: error?.response?.status, failed: true });
      return Promise.reject(error);
    }
  );
  return http;
}
