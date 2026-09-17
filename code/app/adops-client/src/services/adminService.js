import axios from 'axios';
import { installCorrelation } from './httpCorrelation.js';

// AdminService (/catalog/AdminService): Admin-only surfaces. Currently the
// redacted BTP destination catalog + subaccount identity used by Target
// Systems administration. Thin: HTTP + OData unwrapping + error normalisation.
const http = installCorrelation(axios.create({ timeout: 120000 }));

export function getServiceErrorMessage(error, fallback) {
  const data = error?.response?.data;
  return (
    data?.error?.message ||
    (typeof data === 'string' && data.slice(0, 300)) ||
    error?.message ||
    fallback ||
    'The request failed.'
  );
}

// The catalog reads are Admin-only; a non-Admin user gets 403. Callers use
// this to decide whether to silently omit the catalog rather than error.
export function isForbidden(error) {
  return error?.response?.status === 403;
}

// listBtpDestinations()/getBtpAccountInfo() are unbound OData V4 functions that
// return a LargeString, which comes back as { value: '<json string>' }. Parse
// to the real payload; tolerate an already-parsed value.
function parseLargeString(data) {
  const raw = typeof data === 'string' ? data : data?.value;
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listBtpDestinations() {
  const response = await http.get('/catalog/AdminService/listBtpDestinations()');
  const parsed = parseLargeString(response.data);
  return Array.isArray(parsed) ? parsed : [];
}

export async function getBtpAccountInfo() {
  const response = await http.get('/catalog/AdminService/getBtpAccountInfo()');
  return parseLargeString(response.data) || {};
}

// --- Telemetry settings (Settings page, Admin only) --------------------------
// Typed CDS results (TelemetrySettingsResult), no LargeString unwrapping.

export async function getTelemetrySettings() {
  const response = await http.get('/catalog/AdminService/getTelemetrySettingsAdmin()');
  return response.data;
}

export async function updateTelemetrySettings(payload) {
  const response = await http.post('/catalog/AdminService/updateTelemetrySettings', payload);
  return response.data;
}
