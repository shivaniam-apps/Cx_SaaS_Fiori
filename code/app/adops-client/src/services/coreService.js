import axios from 'axios';
import { installCorrelation, correlation } from './httpCorrelation.js';
import { buildRenderErrorReport } from '../features/telemetry/correlation.js';

// CoreService (/core): the role-less front door. This module is the single
// place that reads server-derived identity; gates consume its result, never
// a client-side guess.
const http = installCorrelation(axios.create({ timeout: 120000 }));

let userInfoPromise = null;

// Crash reporting (recordClientError). Never throws and never blocks: a
// failed report is logged and forgotten, since it runs inside the error
// path itself. Returns the receipt ({ received, fingerprint,
// occurrenceCount }) plus the correlation id the report carried, so the
// boundary can show the user a reference to quote.
export async function reportRenderError({ error, componentStack }) {
  const correlationId = correlation.lastCorrelationId;
  const report = buildRenderErrorReport({
    error,
    componentStack,
    route: typeof window !== 'undefined' ? window.location.hash : '',
    sessionId: correlation.sessionId,
    correlationId,
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
    browserInfo: typeof navigator !== 'undefined' ? navigator.userAgent : ''
  });
  try {
    const response = await http.post('/core/recordClientError', report);
    return { ...(response.data || {}), correlationId: correlation.lastCorrelationId || correlationId };
  } catch (reportError) {
    console.warn('Crash report could not be sent:', reportError?.message || reportError);
    return { received: false, fingerprint: null, occurrenceCount: 0, correlationId };
  }
}

export async function fetchUserInfo({ fresh = false } = {}) {
  if (!userInfoPromise || fresh) {
    userInfoPromise = http
      .get('/core/userInfo()')
      .then((response) => response.data)
      .catch((error) => {
        userInfoPromise = null;
        throw error;
      });
  }
  return userInfoPromise;
}

export function getServiceErrorMessage(error, fallback) {
  const data = error?.response?.data;
  return (
    data?.error?.message ||
    (typeof data === 'string' && data) ||
    error?.message ||
    fallback ||
    'The request failed.'
  );
}
