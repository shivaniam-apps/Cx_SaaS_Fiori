// Pure view-model for the Adoption Cockpit (PublicService
// queryDashboardSummary). Dependency-free: runs under node --test.
//
// The dashboard consumes ONE server summary (performance.md); this module
// only lays its partitions out along the journey and attaches to every card
// the route that opens the same slice (fiori-ux.md, Navigation). Bucket
// names in the links are the ones the list reads accept as `status`, so a
// card and the page it opens are the same server-side expression.

export const JOURNEY = [
  { key: 'connect', label: 'Connect', hint: 'Register the S/4HANA system' },
  { key: 'extract', label: 'Extract', hint: 'Pull the real usage pattern' },
  { key: 'analyse', label: 'Analyse', hint: 'Score Fiori app candidates' },
  { key: 'review', label: 'Review', hint: 'Approve, reject or defer' },
  { key: 'activate', label: 'Activate', hint: 'Ship it, captured in a TR' }
];

const clean = (v) => String(v ?? '').trim();
const n = (v) => Number(v || 0);

// Route + query string; empty params are dropped.
export function linkTo(path, params) {
  const query = Object.entries(params || {})
    .filter(([, value]) => clean(value))
    .map(([key, value]) => `${key}=${encodeURIComponent(clean(value))}`)
    .join('&');
  return query ? `${path}?${query}` : path;
}

// Proposal links carry the analysis run only when exactly one is in scope;
// otherwise the Proposals page opens its default (latest) run and the
// card's figure spans every system's current run.
function proposalRun(summary) {
  const ids = summary?.Scope?.AnalysisRunIds || [];
  return ids.length === 1 ? ids[0] : '';
}

// One card: { key, label, value, to, design? }. `design` marks attention
// figures (Negative / Critical) so the page can colour them; the value is
// always the server's count.
const card = (key, label, value, to, design) => ({ key, label, value: n(value), to, ...(design ? { design } : {}) });

// Cards per journey stage. Partition members (they sum to that entity's
// Total) come first; cross-cutting indicators are kept separate so the
// strip never suggests they add up (performance.md, KPI partition rule).
export function stageCards(summary, scope = {}) {
  const s = summary || {};
  const system = clean(scope.targetSystemId);
  const run = proposalRun(s);
  const sys = s.Systems || {};
  const ext = s.Extractions || {};
  const ana = s.Analyses || {};
  const pro = s.Proposals || {};
  const wav = s.Waves || {};
  const pla = s.Plans || {};
  const runs = s.Runs || {};
  const tr = s.Transports || {};

  return {
    connect: [
      card('SYSTEMS', 'Target systems', sys.Total, '/systems'),
      card('HEALTHY', 'Healthy', sys.Healthy, '/systems'),
      card('ATTENTION', 'Needing attention', sys.Attention, '/systems', sys.Attention ? 'Negative' : undefined),
      card('UNCHECKED', 'Never checked', sys.Unchecked, '/systems', sys.Unchecked ? 'Critical' : undefined)
    ],
    extract: [
      card('EXTRACTIONS', 'Extractions', ext.Total, '/extractions'),
      card('EXTRACT_ACTIVE', 'Running', ext.Active, '/extractions', ext.Active ? 'Critical' : undefined),
      card('EXTRACT_COMPLETED', 'Completed', ext.Completed, '/extractions'),
      card('EXTRACT_PARTIAL', 'Partial', ext.Partial, '/extractions', ext.Partial ? 'Critical' : undefined),
      card('EXTRACT_FAILED', 'Failed / cancelled', ext.Failed, '/extractions', ext.Failed ? 'Negative' : undefined)
    ],
    analyse: [
      card('ANALYSES', 'Analysis runs', ana.Total, '/proposals'),
      card('ANALYSE_ACTIVE', 'Running', ana.Active, '/proposals', ana.Active ? 'Critical' : undefined),
      card('ANALYSE_COMPLETED', 'Completed', ana.Completed, '/proposals'),
      card('ANALYSE_FAILED', 'Failed / cancelled', ana.Failed, '/proposals', ana.Failed ? 'Negative' : undefined)
    ],
    review: [
      card('PROPOSALS', 'Proposals (current run)', pro.Total, linkTo('/proposals', { run })),
      card('PROPOSALS_OPEN', 'To review', pro.Open, linkTo('/proposals', { run, status: 'OPEN' }), pro.Open ? 'Critical' : undefined),
      card('PROPOSALS_APPROVED', 'Approved', pro.Approved, linkTo('/proposals', { run, status: 'APPROVED' })),
      card('PROPOSALS_REJECTED', 'Rejected', pro.Rejected, linkTo('/proposals', { run, status: 'REJECTED' })),
      card('PROPOSALS_DEFERRED', 'Deferred', pro.Deferred, linkTo('/proposals', { run, status: 'DEFERRED' })),
      card('PROPOSALS_NOPATH', 'No Fiori path', pro.NoPath, linkTo('/proposals', { run, status: 'NOPATH' }))
    ],
    activate: [
      card('WAVES', 'Waves', wav.Total, '/waves'),
      card('WAVES_IN_PROGRESS', 'Waves in progress', wav.InProgress, '/waves'),
      card('PLANS', 'Activation plans', pla.Total, '/activation'),
      card('PLANS_READY', 'Plans ready', pla.Ready, '/activation'),
      card('PLANS_ATTENTION', 'Plans needing attention', pla.Attention, '/activation', pla.Attention ? 'Negative' : undefined),
      card('RUNS_ACTIVE', 'Runs active', runs.Active, linkTo('/activation-runs', { system, status: 'ACTIVE' }), runs.Active ? 'Critical' : undefined),
      card('RUNS_FAILED', 'Runs failed', runs.Failed, linkTo('/activation-runs', { system, status: 'FAILED' }), runs.Failed ? 'Negative' : undefined),
      card('TRANSPORTS_OPEN', 'Open transports', tr.Open, linkTo('/transports', { system, status: 'OPEN' })),
      card('TRANSPORTS_RELEASED', 'Released transports', tr.Released, linkTo('/transports', { system, status: 'RELEASED' })),
      card('TRANSPORTS_FAILED', 'Failed releases', tr.Failed, linkTo('/transports', { system, status: 'FAILED' }), tr.Failed ? 'Negative' : undefined)
    ]
  };
}

// The journey with each stage's cards attached, in journey order.
export function journeyWithCards(summary, scope) {
  const cards = stageCards(summary, scope);
  return JOURNEY.map((stage) => ({ ...stage, cards: cards[stage.key] || [] }));
}

// Nothing extracted yet: the cockpit shows the journey hints instead of a
// wall of zeros.
export function isEmptyLandscape(summary) {
  const s = summary || {};
  return !n(s.Systems?.Total) && !n(s.Extractions?.Total);
}

// The first thing to do next, for the cockpit's one-line prompt.
export function nextStep(summary) {
  const s = summary || {};
  if (!n(s.Systems?.Total)) return { text: 'Register your first S/4HANA target system.', to: '/systems' };
  if (!n(s.Extractions?.Completed) && !n(s.Extractions?.Partial)) return { text: 'Run a usage extraction to see the real transaction pattern.', to: '/extractions' };
  if (!n(s.Analyses?.Completed)) return { text: 'Generate Fiori app proposals from the extracted usage.', to: '/proposals' };
  if (n(s.Proposals?.Open)) return { text: `${n(s.Proposals.Open).toLocaleString()} proposals are waiting for a decision.`, to: linkTo('/proposals', { run: proposalRun(s), status: 'OPEN' }) };
  if (n(s.Runs?.Failed)) return { text: `${n(s.Runs.Failed).toLocaleString()} activation runs failed and need an operator.`, to: linkTo('/activation-runs', { status: 'FAILED' }) };
  if (n(s.Transports?.Open)) return { text: `${n(s.Transports.Open).toLocaleString()} transports are open and can be released.`, to: linkTo('/transports', { status: 'OPEN' }) };
  if (!n(s.Waves?.Total)) return { text: 'Group approved proposals into an adoption wave.', to: '/waves' };
  return null;
}

// Target-system options for the scope select; the applied id stays
// selectable even when the list no longer carries it.
export function systemOptions(systems, current) {
  const rows = (systems || []).map((s) => ({ id: s.ID, label: `${s.displayName || s.ID}${s.environment ? ` (${s.environment})` : ''}` }));
  if (clean(current) && !rows.some((r) => r.id === current)) rows.push({ id: current, label: current });
  return rows;
}
