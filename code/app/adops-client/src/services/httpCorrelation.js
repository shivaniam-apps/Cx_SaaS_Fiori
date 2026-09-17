import {
  CORRELATION_HEADER,
  createCorrelationContext
} from '../features/telemetry/correlation.js';

// One correlation context per page load, shared by every axios instance
// (coreService, fioriService): each request carries a fresh id in
// x-correlation-id, and the id the server echoes back becomes the reference
// a crash report quotes.
export const correlation = createCorrelationContext();

export function installCorrelation(http) {
  http.interceptors.request.use((config) => {
    config.headers = config.headers || {};
    config.headers[CORRELATION_HEADER] = correlation.nextRequestId();
    return config;
  });
  http.interceptors.response.use(
    (response) => { correlation.adoptResponseHeaders(response.headers); return response; },
    (error) => { correlation.adoptResponseHeaders(error?.response?.headers); return Promise.reject(error); }
  );
  return http;
}
