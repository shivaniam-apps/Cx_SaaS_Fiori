// Pure decision and view logic for the access-request workflow: which
// areas/roles are requestable, what a restricted page shows for the
// requester, how the admin triage list is filtered server-side and how its
// rows/KPIs are labelled. Dependency-free so node --test covers it; the
// service layer (services/accessRequestService.js) and components consume it.

// Area keys match the CAP vocabulary (REQUESTABLE_AREAS in
// srv/utils/access-request-handlers.js): 'application' is the shell-level
// Member gate, the others are Admin-only pages.
export const ACCESS_REQUEST_AREAS = {
  application: { label: 'AdoptOps Application', role: 'Member', roleLabel: 'Member' },
  settings: { label: 'Settings', role: 'Admin', roleLabel: 'Administrator' },
  'product-insights': { label: 'Product Insights', role: 'Admin', roleLabel: 'Administrator' },
  'access-requests': { label: 'Access Requests', role: 'Admin', roleLabel: 'Administrator' }
};

export const ACCESS_REQUEST_URGENCIES = [
  { id: 'LOW', label: 'Low - whenever convenient' },
  { id: 'NORMAL', label: 'Normal' },
  { id: 'HIGH', label: 'High - blocking my work' }
];

export const ACCESS_REQUEST_STATUS_OPTIONS = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'DECLINED', label: 'Declined' }
];

export const ACCESS_REQUEST_URGENCY_OPTIONS = [
  { value: 'LOW', label: 'Low' },
  { value: 'NORMAL', label: 'Normal' },
  { value: 'HIGH', label: 'High' }
];

export const ACCESS_REQUEST_STATUS_DESIGN = { PENDING: 'Critical', APPROVED: 'Positive', DECLINED: 'Negative' };
export const GRANT_STATUS_DESIGN = { GRANTED: 'Positive', MANUAL: 'Information', FAILED: 'Negative' };
export const GRANT_STATUS_LABELS = { GRANTED: 'Granted', MANUAL: 'Grant manually', FAILED: 'Grant failed' };

const STATUS_LABELS = new Map(ACCESS_REQUEST_STATUS_OPTIONS.map((o) => [o.value, o.label]));
const URGENCY_LABELS = new Map(ACCESS_REQUEST_URGENCY_OPTIONS.map((o) => [o.value, o.label]));

export function accessRequestStatusLabel(status) {
  return STATUS_LABELS.get(status) || status || '';
}

export function accessRequestUrgencyLabel(urgency) {
  return URGENCY_LABELS.get(urgency || 'NORMAL') || urgency || '';
}

export function accessRequestAreaLabel(area) {
  return ACCESS_REQUEST_AREAS[area]?.label || area || '';
}

export function accessRequestAreaOptions() {
  return Object.entries(ACCESS_REQUEST_AREAS).map(([value, config]) => ({ value, label: config.label }));
}

export function grantStatusLabel(grantStatus) {
  return GRANT_STATUS_LABELS[grantStatus] || grantStatus || '';
}

// --- Requester side -----------------------------------------------------------

// CoreService getMyAccessRequests row -> client shape.
export function mapMyRequest(row = {}) {
  return {
    id: row.ID,
    referenceNumber: row.referenceNumber,
    area: row.requestedArea,
    role: row.requestedRole,
    status: row.status,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    decisionNotes: row.decisionNotes,
    grantStatus: row.grantStatus
  };
}

// The requester's most recent request for one area decides what the
// restricted page shows: a pending request beats older decided ones.
// Requests arrive newest-first from the backend.
export function findRequestForArea(requests, area) {
  const forArea = (requests || []).filter((request) => request.area === area);
  return forArea.find((request) => request.status === 'PENDING') || forArea[0] || null;
}

// Database-less tiers reject submissions with 501.
export function isTierUnavailableError(error) {
  return error?.response?.status === 501;
}

// View model for RestrictedState: `requests === null` means the history is
// still loading (no CTA yet, so it cannot flash and be replaced by a pending
// strip); a pending or approved request suppresses the CTA; a declined one
// keeps its notice but allows a re-request.
export function deriveRestrictedView({ requests, area, tierUnavailable = false }) {
  const loading = requests === null || requests === undefined;
  const request = loading ? null : findRequestForArea(requests, area);
  const status = request?.status || null;
  return {
    loading,
    request,
    showPending: status === 'PENDING',
    showApproved: status === 'APPROVED',
    showDeclined: status === 'DECLINED',
    showTierUnavailable: Boolean(tierUnavailable),
    showCta: !loading && !tierUnavailable && status !== 'PENDING' && status !== 'APPROVED'
  };
}

// "Alice (alice)" / "alice" from the /core/userInfo payload.
export function requesterLabel(userInfo) {
  const id = userInfo?.user || '';
  const name = userInfo?.givenName || '';
  if (name && name !== id) return id ? `${name} (${id})` : name;
  return id || 'Current user';
}

// --- Admin triage -------------------------------------------------------------

// AdminService AccessRequests row -> client shape.
export function mapAdminRequest(row = {}) {
  return {
    id: row.ID,
    referenceNumber: row.ReferenceNumber,
    requesterId: row.RequesterId,
    requesterName: row.RequesterName,
    requesterEmail: row.RequesterEmail,
    area: row.RequestedArea,
    role: row.RequestedRole,
    justification: row.Justification,
    urgency: row.Urgency,
    status: row.Status,
    requestedAt: row.RequestedAt,
    decidedBy: row.DecidedBy,
    decidedAt: row.DecidedAt,
    decisionNotes: row.DecisionNotes,
    grantStatus: row.GrantStatus,
    grantError: row.GrantError
  };
}

export const ACCESS_REQUEST_FILTER_DEFAULTS = { search: '', status: '', area: '', urgency: '' };

function odataString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Server-side $filter for the bounded triage read (performance.md: filter in
// CAP, never in React). Status/area/urgency are equality terms - the same
// expression the KPI summary groups by - and the search is a contains() over
// the human-facing columns. Empty selections add no term; '' means no filter.
export function buildAccessRequestFilter(filters = {}) {
  const terms = [];
  if (filters.status) terms.push(`Status eq ${odataString(filters.status)}`);
  if (filters.area) terms.push(`RequestedArea eq ${odataString(filters.area)}`);
  if (filters.urgency) terms.push(`Urgency eq ${odataString(filters.urgency)}`);
  const term = String(filters.search || '').trim();
  if (term) {
    const needle = odataString(term);
    const columns = ['ReferenceNumber', 'RequesterId', 'RequesterName', 'RequesterEmail', 'Justification'];
    terms.push(`(${columns.map((column) => `contains(${column},${needle})`).join(' or ')})`);
  }
  return terms.join(' and ');
}

export function hasActiveFilters(filters = {}) {
  return Boolean(filters.search?.trim() || filters.status || filters.area || filters.urgency);
}

// Decision applicability - the same predicate gates the row buttons and the
// dialog submit (fiori-ux enablement rule).
export function canDecide(request) {
  return Boolean(request) && request.status === 'PENDING';
}

// One-line consequence shown in the decision dialog.
export function decisionDescription(request, action) {
  if (!request) return '';
  const who = request.requesterName || request.requesterId || 'The requester';
  const role = ACCESS_REQUEST_AREAS[request.area]?.roleLabel || request.role || 'access';
  const area = accessRequestAreaLabel(request.area);
  const verb = action === 'APPROVE' ? 'Approve' : 'Decline';
  return `${verb} ${request.referenceNumber}: ${who} requests ${role} access for ${area}.`;
}

// KPI cards partition Summary.Total exactly (Pending + Approved + Declined
// [+ Other]); "Other" appears only when the backend reports a status outside
// the vocabulary, so the strip always sums to the total.
export function accessRequestSummaryCards(summary) {
  const s = summary || {};
  const cards = [
    { key: 'PENDING', label: 'Pending', value: s.Pending || 0 },
    { key: 'APPROVED', label: 'Approved', value: s.Approved || 0 },
    { key: 'DECLINED', label: 'Declined', value: s.Declined || 0 }
  ];
  if (s.Other) cards.push({ key: 'OTHER', label: 'Other', value: s.Other });
  return cards;
}

// "Alice (alice)" / "alice · alice@x.com" for the requester column.
export function requesterDisplay(request) {
  if (!request) return { primary: '', secondary: '' };
  const primary = request.requesterName || request.requesterId || '';
  const secondaryParts = [];
  if (request.requesterName && request.requesterId) secondaryParts.push(request.requesterId);
  if (request.requesterEmail && request.requesterEmail !== request.requesterId) secondaryParts.push(request.requesterEmail);
  return { primary, secondary: secondaryParts.join(' · ') };
}

// ISO timestamp -> "yyyy-MM-dd HH:mm".
export function formatTimestamp(value) {
  if (!value) return '';
  return String(value).slice(0, 16).replace('T', ' ');
}
