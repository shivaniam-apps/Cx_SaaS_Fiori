// Pure view-model helpers for the Audit Log page (AdminService AuditEvents
// + verifyAuditChain). No service/axios imports: runs under node --test.

export const AUDIT_PAGE_SIZE = 100;

export const SEVERITY_DESIGN = {
  INFO: 'Information',
  WARNING: 'Critical',
  ERROR: 'Negative',
  CRITICAL: 'Negative'
};

// verifyAuditChain Status (docu/10-security-authorization/audit-log-chain.md).
export const CHAIN_STATUS_DESIGN = {
  OK: 'Positive',
  BROKEN: 'Negative',
  EMPTY: 'Neutral'
};

export const SEVERITIES = ['INFO', 'WARNING', 'ERROR'];

export const EMPTY_FILTER = {
  eventType: '',
  objectType: '',
  objectName: '',
  userId: '',
  severity: ''
};

// OData string literal: single quotes double up; nothing else needs escaping.
export function odataString(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

// $filter for the bounded AuditEvents read. Exact match on the coded
// columns (type, object type, severity), contains() on the free-text ones
// (object name, user). Empty string when nothing is set.
export function buildAuditFilter(filter) {
  const f = { ...EMPTY_FILTER, ...(filter || {}) };
  const clauses = [];
  if (f.eventType.trim()) clauses.push(`EventType eq ${odataString(f.eventType.trim())}`);
  if (f.objectType.trim()) clauses.push(`ObjectType eq ${odataString(f.objectType.trim())}`);
  if (f.severity.trim()) clauses.push(`Severity eq ${odataString(f.severity.trim().toUpperCase())}`);
  if (f.objectName.trim()) clauses.push(`contains(ObjectName,${odataString(f.objectName.trim())})`);
  if (f.userId.trim()) clauses.push(`contains(UserId,${odataString(f.userId.trim())})`);
  return clauses.join(' and ');
}

export function hasActiveFilter(filter) {
  return Boolean(buildAuditFilter(filter));
}

// "PROPOSAL_APPROVED" -> "Proposal approved"; unknown/empty -> ''.
export function eventTypeLabel(type) {
  const text = String(type || '').trim();
  if (!text) return '';
  const words = text.toLowerCase().split('_').filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

// "PSEUDONYMISED → IDENTIFIED"; '' when the event carries no values.
export function changeLabel(event) {
  const before = event?.BeforeValue || '';
  const after = event?.AfterValue || '';
  if (!before && !after) return '';
  return `${before || '—'} → ${after || '—'}`;
}

// "ActivationSteps · F3893" / "AppProposals"; '' without a type or name.
export function objectLabel(event) {
  const parts = [event?.ObjectType, event?.ObjectName].map((v) => String(v || '').trim()).filter(Boolean);
  return parts.join(' · ');
}

// Rows written before A4 have no Sequence: they are listed, but they are
// not part of the verified chain and the page says so per row.
export function isChainedEvent(event) {
  return event?.Sequence !== null && event?.Sequence !== undefined;
}

export function hasMore(count, loaded) {
  return Number(count || 0) > Number(loaded || 0);
}

// One-line verdict for the strip and the KPI cards under it.
export function chainVerdictSummary(verdict) {
  if (!verdict) return null;
  return {
    status: verdict.Status || 'EMPTY',
    design: CHAIN_STATUS_DESIGN[verdict.Status] || 'Neutral',
    message: verdict.Message || '',
    cards: [
      { key: 'CHAINED', label: 'Chained events', value: Number(verdict.ChainedEvents || 0) },
      { key: 'LEGACY', label: 'Legacy (pre-chain)', value: Number(verdict.UnchainedEvents || 0) },
      { key: 'LAST', label: 'Last sequence', value: Number(verdict.LastSequence || 0) },
      { key: 'HEAD', label: 'Chain head', value: verdict.HeadConsistent ? 'consistent' : 'stale' }
    ],
    brokenAt: verdict.FirstBrokenSequence ?? null,
    checkedAt: verdict.CheckedAt || ''
  };
}

// Option lists from the grouped reads (server-side distinct), sorted; the
// currently applied value stays selectable even when the grouped read
// (bounded to the same scope) no longer returns it.
export function optionList(rows, field, current) {
  const values = new Set((rows || []).map((r) => String(r?.[field] ?? '').trim()).filter(Boolean));
  if (current) values.add(current);
  return [...values].sort((a, b) => a.localeCompare(b));
}
