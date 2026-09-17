// Pure view-model for the Product Insights page (AdminService telemetry
// reads: PilotFeedback, ClientErrorReports, queryUsageSummary,
// queryPerformanceSummary). Dependency-free: runs under node --test.

export const INSIGHTS_VIEWS = [
  { id: 'feedback', routeSuffix: '', label: 'Feedback', icon: 'feedback' },
  { id: 'errors', routeSuffix: 'errors', label: 'Crash reports', icon: 'message-error' },
  { id: 'usage', routeSuffix: 'usage', label: 'Usage', icon: 'bar-chart' },
  { id: 'performance', routeSuffix: 'performance', label: 'Performance', icon: 'performance' }
];

const BY_ID = new Map(INSIGHTS_VIEWS.map((view) => [view.id, view]));

export function resolveInsightsView(param) {
  const candidate = String(param || '').trim().toLowerCase();
  return BY_ID.has(candidate) ? candidate : INSIGHTS_VIEWS[0].id;
}

export function getInsightsViewPath(id) {
  const view = BY_ID.get(id);
  return view?.routeSuffix ? `/product-insights/${view.routeSuffix}` : '/product-insights';
}

// Value sets mirror the server (feedback-telemetry-handlers.js,
// telemetry-admin-handlers.js); the server validates again.
export const FEEDBACK_STATUSES = ['NEW', 'UNDER_REVIEW', 'PLANNED', 'IMPLEMENTED', 'DECLINED', 'DUPLICATE', 'CLOSED'];
export const FEEDBACK_CATEGORIES = ['FEATURE_REQUEST', 'IMPROVEMENT', 'REMOVE_OR_SIMPLIFY', 'USABILITY', 'ENTERPRISE_REQUIREMENT', 'DEFECT', 'GENERAL'];
export const FEEDBACK_IMPACTS = ['LOW', 'MEDIUM', 'HIGH', 'BLOCKER'];
export const ERROR_STATUSES = ['NEW', 'INVESTIGATING', 'RESOLVED', 'IGNORED'];
export const ERROR_SEVERITIES = ['FATAL', 'ERROR', 'WARNING'];
export const WINDOW_OPTIONS = [7, 30, 90];
export const DEFAULT_WINDOW_DAYS = 30;
export const LIST_PAGE_SIZE = 100;

export const FEEDBACK_STATUS_DESIGN = {
  NEW: 'Information',
  UNDER_REVIEW: 'Critical',
  PLANNED: 'Information',
  IMPLEMENTED: 'Positive',
  DECLINED: 'Neutral',
  DUPLICATE: 'Neutral',
  CLOSED: 'Neutral'
};

export const IMPACT_DESIGN = { LOW: 'Neutral', MEDIUM: 'Information', HIGH: 'Critical', BLOCKER: 'Negative' };

export const ERROR_STATUS_DESIGN = { NEW: 'Negative', INVESTIGATING: 'Critical', RESOLVED: 'Positive', IGNORED: 'Neutral' };

export const ERROR_SEVERITY_DESIGN = { FATAL: 'Negative', ERROR: 'Negative', WARNING: 'Critical' };

export const EMPTY_FEEDBACK_FILTER = { status: '', category: '', impact: '', search: '' };
export const EMPTY_ERROR_FILTER = { status: '', severity: '', errorType: '', search: '' };

export function odataString(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

const clean = (v) => String(v ?? '').trim();

// $filter for the bounded PilotFeedback read: exact on coded columns,
// contains() on title/reference for the search box.
export function buildFeedbackFilter(filter) {
  const f = { ...EMPTY_FEEDBACK_FILTER, ...(filter || {}) };
  const clauses = [];
  if (clean(f.status)) clauses.push(`Status eq ${odataString(clean(f.status).toUpperCase())}`);
  if (clean(f.category)) clauses.push(`Category eq ${odataString(clean(f.category).toUpperCase())}`);
  if (clean(f.impact)) clauses.push(`Impact eq ${odataString(clean(f.impact).toUpperCase())}`);
  if (clean(f.search)) {
    const s = odataString(clean(f.search));
    clauses.push(`(contains(Title,${s}) or contains(ReferenceNumber,${s}) or contains(Feature,${s}))`);
  }
  return clauses.join(' and ');
}

// $filter for the bounded ClientErrorReports read.
export function buildErrorFilter(filter) {
  const f = { ...EMPTY_ERROR_FILTER, ...(filter || {}) };
  const clauses = [];
  if (clean(f.status)) clauses.push(`Status eq ${odataString(clean(f.status).toUpperCase())}`);
  if (clean(f.severity)) clauses.push(`Severity eq ${odataString(clean(f.severity).toUpperCase())}`);
  if (clean(f.errorType)) clauses.push(`ErrorType eq ${odataString(clean(f.errorType).toUpperCase())}`);
  if (clean(f.search)) {
    const s = odataString(clean(f.search));
    clauses.push(`(contains(ErrorMessage,${s}) or contains(Route,${s}) or contains(Feature,${s}))`);
  }
  return clauses.join(' and ');
}

// Grouped Status counts (server $apply groupby) -> ordered KPI cards that
// partition the total: one card per known status in order, plus "Other"
// only when the server produced a status the list does not know.
export function statusCards(groupedRows, statuses) {
  const counts = new Map();
  let total = 0;
  for (const row of groupedRows || []) {
    const status = clean(row?.Status).toUpperCase();
    const count = Number(row?.count ?? 0) || 0;
    counts.set(status, (counts.get(status) || 0) + count);
    total += count;
  }
  const cards = [{ key: 'TOTAL', label: 'Total', value: total }];
  let known = 0;
  for (const status of statuses) {
    const value = counts.get(status) || 0;
    known += value;
    cards.push({ key: status, label: humanize(status), value });
  }
  if (total - known > 0) cards.push({ key: 'OTHER', label: 'Other', value: total - known });
  return cards;
}

// "UNDER_REVIEW" -> "Under review"
export function humanize(value) {
  const text = clean(value);
  if (!text) return '';
  const words = text.toLowerCase().split('_').filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

export function hasMore(count, loaded) {
  return Number(count || 0) > Number(loaded || 0);
}

// Feedback triage draft <-> updateFeedbackTriage payload.
export function triageDraft(row) {
  return {
    status: clean(row?.Status).toUpperCase() || 'NEW',
    assignedTo: clean(row?.AssignedTo),
    adminNotes: String(row?.AdminNotes || ''),
    resolutionNotes: String(row?.ResolutionNotes || '')
  };
}

export function triagePayload(id, draft) {
  return {
    ID: id,
    status: clean(draft?.status).toUpperCase() || 'NEW',
    assignedTo: clean(draft?.assignedTo),
    adminNotes: String(draft?.adminNotes || '').trim(),
    resolutionNotes: String(draft?.resolutionNotes || '').trim()
  };
}

export function triageChanged(row, draft) {
  if (!row || !draft) return false;
  const stored = triageDraft(row);
  const next = triageDraft({ Status: draft.status, AssignedTo: draft.assignedTo, AdminNotes: draft.adminNotes, ResolutionNotes: draft.resolutionNotes });
  return Object.keys(stored).some((k) => String(stored[k]).trim() !== String(next[k]).trim());
}

// Usage summary -> KPI cards; empty summaries still yield zeros.
export function usageCards(summary) {
  const s = summary || {};
  return [
    { key: 'EVENTS', label: 'Usage events', value: Number(s.totalEvents || 0) },
    { key: 'USERS', label: 'Active users', value: Number(s.activeUsers || 0) },
    { key: 'SESSIONS', label: 'Sessions', value: Number(s.activeSessions || 0) },
    { key: 'FEATURES', label: 'Features used', value: new Set((s.byFeature || []).map((r) => r.feature)).size }
  ];
}

// Performance summary -> KPI cards; failed share as a percentage string.
export function performanceCards(summary) {
  const s = summary || {};
  const total = Number(s.totalEvents || 0);
  const failed = Number(s.failedCount || 0);
  const slowest = (s.operations || [])[0];
  return [
    { key: 'EVENTS', label: 'Timed operations', value: total },
    { key: 'FAILED', label: 'Failed', value: failed },
    { key: 'FAILED_SHARE', label: 'Failure rate', value: total ? `${Math.round((failed / total) * 1000) / 10}%` : '—' },
    { key: 'SLOWEST', label: 'Slowest avg', value: slowest ? `${Math.round(Number(slowest.avgMs || 0)).toLocaleString()} ms` : '—' }
  ];
}

export function windowLabel(days) {
  return `Last ${days} days`;
}
