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

// --- Audit log (Audit Log page, Admin only) -----------------------------------

function unwrapCollection(data) {
  return Array.isArray(data?.value) ? data.value : [];
}

function odataQuery(params) {
  // Manual serialization: %20 for spaces, which CAP accepts inside
  // $filter/$orderby where axios' '+' is rejected.
  return params
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

// Bounded, server-filtered, server-sorted page of the audit trail. `filter`
// is a ready $filter expression (features/audit/auditModel.buildAuditFilter).
export async function fetchAuditEvents({ filter = '', top = 100, skip = 0 } = {}) {
  const query = odataQuery([
    ['$orderby', 'Sequence desc,Timestamp desc'],
    ['$top', String(top)],
    ['$skip', skip ? String(skip) : ''],
    ['$count', 'true'],
    ['$filter', filter]
  ]);
  const response = await http.get(`/catalog/AdminService/AuditEvents?${query}`);
  const items = unwrapCollection(response.data);
  return { items, count: Number(response.data?.['@odata.count'] ?? items.length) };
}

// Distinct values of one column (server-side groupby) for the filter
// selects; never the whole table.
export async function fetchAuditDistinct(field) {
  const response = await http.get(`/catalog/AdminService/AuditEvents?$apply=groupby((${field}))`);
  return unwrapCollection(response.data);
}

export async function verifyAuditChain() {
  const response = await http.get('/catalog/AdminService/verifyAuditChain()');
  return response.data;
}

// --- Product Insights (Admin only) --------------------------------------------
// Bounded, server-filtered list reads plus the server-side summaries; the
// page never downloads raw event tables to count them (performance.md).

async function fetchAdminList(entity, { filter = '', orderby, top = 100, skip = 0 } = {}) {
  const query = odataQuery([
    ['$orderby', orderby],
    ['$top', String(top)],
    ['$skip', skip ? String(skip) : ''],
    ['$count', 'true'],
    ['$filter', filter]
  ]);
  const response = await http.get(`/catalog/AdminService/${entity}?${query}`);
  const items = unwrapCollection(response.data);
  return { items, count: Number(response.data?.['@odata.count'] ?? items.length) };
}

// Status counts over the FULL entity (server groupby), for the KPI strips.
async function fetchStatusCounts(entity) {
  const response = await http.get(`/catalog/AdminService/${entity}?$apply=groupby((Status),aggregate($count as count))`);
  return unwrapCollection(response.data);
}

export function fetchPilotFeedback(options) {
  return fetchAdminList('PilotFeedback', { orderby: 'SubmittedAt desc', ...options });
}

export function fetchPilotFeedbackStatusCounts() {
  return fetchStatusCounts('PilotFeedback');
}

export async function updateFeedbackTriage(payload) {
  const response = await http.post('/catalog/AdminService/updateFeedbackTriage', payload);
  return response.data;
}

export function fetchClientErrorReports(options) {
  return fetchAdminList('ClientErrorReports', { orderby: 'LastSeenAt desc', ...options });
}

export function fetchClientErrorStatusCounts() {
  return fetchStatusCounts('ClientErrorReports');
}

export async function updateClientErrorStatus(id, status) {
  const response = await http.post('/catalog/AdminService/updateClientErrorStatus', { ID: id, status });
  return response.data;
}

export async function queryUsageSummary(days) {
  const response = await http.get(`/catalog/AdminService/queryUsageSummary(days=${Number(days) || 30})`);
  return response.data;
}

export async function queryPerformanceSummary(days) {
  const response = await http.get(`/catalog/AdminService/queryPerformanceSummary(days=${Number(days) || 30})`);
  return response.data;
}
