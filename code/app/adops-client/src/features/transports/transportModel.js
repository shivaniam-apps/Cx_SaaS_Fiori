// Pure presentation model for the Transports page (S10): release status,
// import status per follow-on system and the verification verdicts the
// server persisted on TransportImports. No services, no env access - node
// --test loads this outside Vite.
//
// Status semantics come from the server (transport-verification.js):
//   ImportStatus PENDING | IMPORTED | IMPORT_FAILED | UNKNOWN
//   Source       READ_UNIT (verified through the ZADO read unit) | OPERATOR
//   Verdict      VERIFIED | NOT_FOUND | MANUAL | UNKNOWN per manifest entry

export const RELEASE_STATUS_DESIGN = {
  MODIFIABLE: 'Information',
  RELEASING: 'Critical',
  RELEASED: 'Positive',
  RELEASE_FAILED: 'Negative'
};

export const IMPORT_STATUS = {
  PENDING: 'PENDING',
  IMPORTED: 'IMPORTED',
  IMPORT_FAILED: 'IMPORT_FAILED',
  UNKNOWN: 'UNKNOWN'
};

const IMPORT_STATUS_META = {
  PENDING: { label: 'Not imported', design: 'Information' },
  IMPORTED: { label: 'Imported', design: 'Positive' },
  IMPORT_FAILED: { label: 'Import failed', design: 'Negative' },
  UNKNOWN: { label: 'Unknown', design: 'Critical' }
};

const VERDICT_META = {
  VERIFIED: { label: 'Verified', design: 'Positive' },
  NOT_FOUND: { label: 'Not found', design: 'Negative' },
  MANUAL: { label: 'Manual', design: 'Information' },
  UNKNOWN: { label: 'Unknown', design: 'Critical' }
};

// What an operator may record by hand (the runbook outcome).
export const RECORDABLE_IMPORT_STATUSES = [
  { value: 'IMPORTED', label: 'Imported' },
  { value: 'IMPORT_FAILED', label: 'Import failed' },
  { value: 'PENDING', label: 'Not imported yet' }
];

export function importStatusTag(status) {
  return IMPORT_STATUS_META[status] || { label: status || 'Unchecked', design: 'Neutral' };
}

export function verdictTag(verdict) {
  return VERDICT_META[verdict] || { label: verdict || '—', design: 'Neutral' };
}

export function formatStamp(value) {
  if (!value) return '';
  return String(value).slice(0, 16).replace('T', ' ');
}

// One line per import row: "RD1 Quality (QAS): Imported · checked 2026-09-18 08:00 by dave".
export function importSummaryLine(imp) {
  const tag = importStatusTag(imp?.ImportStatus);
  const who = imp?.CheckedBy ? ` by ${imp.CheckedBy}` : '';
  const source = imp?.Source === 'OPERATOR' ? ' (recorded)' : '';
  const when = imp?.CheckedAt ? ` · ${formatStamp(imp.CheckedAt)}${who}` : '';
  return `${imp?.TargetSystemName || 'Follow-on system'}: ${tag.label}${source}${when}`;
}

// The systems a transport can be verified on: every registered system but
// the request's own source. Environment order QAS before PRD keeps the
// transport route reading top-down.
const ENVIRONMENT_ORDER = { QAS: 0, QA: 0, PREPROD: 1, 'PRE-PROD': 1, PRD: 2, PROD: 2, PRODUCTION: 2 };

export function followOnSystemsFor(transport, systems) {
  return (systems || [])
    .filter((s) => s && s.ID && s.ID !== transport?.targetSystem_ID)
    .sort((a, b) => {
      const oa = ENVIRONMENT_ORDER[String(a.environment || '').toUpperCase()] ?? 9;
      const ob = ENVIRONMENT_ORDER[String(b.environment || '').toUpperCase()] ?? 9;
      return oa - ob || String(a.displayName || '').localeCompare(String(b.displayName || ''));
    });
}

// The tenant's transport route from a source system (O13): each system may
// name its followOnSystem (DEV -> QAS -> PRD). Walks the chain, cycle-safe,
// and never returns the source itself. Empty when no route is configured.
export function transportRoute(sourceId, systems) {
  const byId = new Map((systems || []).filter((s) => s?.ID).map((s) => [s.ID, s]));
  const route = [];
  const seen = new Set([sourceId]);
  let current = byId.get(sourceId);
  while (current?.followOnSystem_ID && !seen.has(current.followOnSystem_ID)) {
    const next = byId.get(current.followOnSystem_ID);
    if (!next) break;
    route.push(next);
    seen.add(next.ID);
    current = next;
  }
  return route;
}

// "RD1 Development (DEV) -> RD1 Quality (QAS) -> RD1 Production (PRD)" for
// the transport's source, '' when no route is configured.
export function routeLabel(transport, systems) {
  const source = (systems || []).find((s) => s?.ID === transport?.targetSystem_ID);
  const route = transportRoute(transport?.targetSystem_ID, systems);
  if (!source || !route.length) return '';
  const label = (s) => `${s.displayName || s.ID}${s.environment ? ` (${s.environment})` : ''}`;
  return [source, ...route].map(label).join(' -> ');
}

// What the Verify dialog preselects: the first system on the configured
// route that has no import row yet (then the first hop); without a route,
// the first follow-on system not yet checked, else the first one.
export function defaultFollowOnSystem(transport, systems) {
  const checked = new Set((transport?.Imports || []).map((i) => i.targetSystem_ID));
  const route = transportRoute(transport?.targetSystem_ID, systems);
  if (route.length) return route.find((s) => !checked.has(s.ID)) || route[0];
  const candidates = followOnSystemsFor(transport, systems);
  return candidates.find((s) => !checked.has(s.ID)) || candidates[0] || null;
}

// Verification only makes sense once the request left DEV.
export function canVerifyImport(transport, systems) {
  return transport?.Status === 'RELEASED' && followOnSystemsFor(transport, systems).length > 0;
}

export function canRecordImport(transport, activator) {
  return Boolean(activator) && Boolean(transport?.TransportRequestId);
}

// "3 verified · 1 not found · 6 manual" from the persisted counts.
export function verificationSummary(counts) {
  if (!counts) return '';
  const parts = [];
  const push = (n, label) => { if (Number(n) > 0) parts.push(`${n} ${label}`); };
  push(counts.verified ?? counts.VerifiedCount, 'verified');
  push(counts.notFound ?? counts.NotFoundCount, 'not found');
  push(counts.unknown ?? counts.UnknownCount, 'unknown');
  push(counts.manual ?? counts.ManualCount, 'manual');
  return parts.join(' · ');
}

// The verdict rows of a verification, transportable content first (what the
// import delivers), then the per-system replay list, each by sequence.
export function verificationRows(verification) {
  const items = Array.isArray(verification?.items) ? verification.items : [];
  const bySequence = (a, b) => (a.sequence || 0) - (b.sequence || 0);
  return [
    ...items.filter((i) => i.transportable).sort(bySequence).map((i) => ({ ...i, section: 'Transported' })),
    ...items.filter((i) => !i.transportable).sort(bySequence).map((i) => ({ ...i, section: 'Replay' }))
  ];
}

// The strip design for a verification result: anything not found or
// unknown wants attention; manual-only outcomes are informational.
export function verificationDesign(verification) {
  const counts = verification?.counts || {};
  if (Number(counts.notFound) > 0 || Number(counts.unknown) > 0) return 'Critical';
  if (Number(counts.verified) > 0) return 'Positive';
  return 'Information';
}
