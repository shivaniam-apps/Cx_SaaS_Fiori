// ---------------------------------------------------------------------------
// Activation plans: the cross-wave list page's view over ActivationPlans.
// Pure helpers only (no DB access) so the shaping is unit-testable; the
// PublicService handlers do the reads and call these.
//
// A plan row carries its wave / target-system / transport labels and the
// latest ACTIVATION_EXECUTION run, resolved by the handler in one pass per
// entity - the list page never does child reads.
// ---------------------------------------------------------------------------

const ACTIVE_TASK_STATES = ['QUEUED', 'CLAIMED', 'RUNNING'];

// Status buckets for the KPI strip. They partition every plan status the
// engine can produce (data-model.cds ActivationPlans.Status), so the cards
// always sum to the total (performance.md: summaries over the full scope).
function planBucket(status) {
  switch (status) {
    case 'DRAFT': return 'DRAFT';
    case 'SIMULATING':
    case 'SIMULATED':
    case 'READY': return 'SIMULATED';
    case 'EXECUTING': return 'EXECUTING';
    case 'COMPLETED': return 'COMPLETED';
    case 'PARTIAL':
    case 'FAILED':
    case 'ROLLED_BACK': return 'ATTENTION';
    default: return 'OTHER';
  }
}

// Grouped Status counts (SELECT Status, count(*) ... GROUP BY Status) into
// the summary the list page renders.
function summarizePlanStatuses(groupedRows) {
  const summary = { Total: 0, Draft: 0, Simulated: 0, Executing: 0, Completed: 0, Attention: 0, Other: 0 };
  for (const row of groupedRows || []) {
    const count = Number(row.cnt ?? row.count ?? 0) || 0;
    summary.Total += count;
    switch (planBucket(row.Status)) {
      case 'DRAFT': summary.Draft += count; break;
      case 'SIMULATED': summary.Simulated += count; break;
      case 'EXECUTING': summary.Executing += count; break;
      case 'COMPLETED': summary.Completed += count; break;
      case 'ATTENTION': summary.Attention += count; break;
      default: summary.Other += count;
    }
  }
  return summary;
}

function runOutranks(candidate, current) {
  const candidateActive = ACTIVE_TASK_STATES.includes(candidate.Status);
  const currentActive = ACTIVE_TASK_STATES.includes(current.Status);
  if (candidateActive !== currentActive) return candidateActive;
  return String(candidate.QueuedAt || candidate.createdAt || '') > String(current.QueuedAt || current.createdAt || '');
}

// The most recent run per plan from a set of ACTIVATION_EXECUTION tasks
// (any order). An ACTIVE run always wins over a finished one, so a plan whose
// resume is queued shows the queued run, not the failed one before it.
function latestRunByPlan(tasks) {
  const byPlan = new Map();
  for (const task of tasks || []) {
    if (!task?.ObjectId) continue;
    const current = byPlan.get(task.ObjectId);
    if (!current || runOutranks(task, current)) byPlan.set(task.ObjectId, task);
  }
  return byPlan;
}

function systemLabel(system) {
  if (!system) return '';
  return `${system.displayName || system.systemId || ''}${system.environment ? ` (${system.environment})` : ''}`;
}

// One list row: plan facts + labels. Never ships ObjectKeyJson or step rows.
function decoratePlanRow(plan, { wave, system, transport, run } = {}) {
  return {
    ID: plan.ID,
    Name: plan.Name || '',
    Description: plan.Description || '',
    Status: plan.Status || '',
    StepCount: plan.StepCount ?? 0,
    SucceededCount: plan.SucceededCount ?? 0,
    WarningCount: plan.WarningCount ?? 0,
    FailedCount: plan.FailedCount ?? 0,
    SkippedCount: plan.SkippedCount ?? 0,
    SimulatedAt: plan.SimulatedAt || null,
    SimulatedBy: plan.SimulatedBy || '',
    ExecutedAt: plan.ExecutedAt || null,
    ExecutedBy: plan.ExecutedBy || '',
    CreatedAt: plan.createdAt || null,
    CreatedBy: plan.createdBy || '',
    WaveId: wave?.ID || plan.wave_ID || null,
    WaveName: wave?.Name || '',
    TargetSystemId: system?.ID || plan.targetSystem_ID || null,
    TargetSystemName: systemLabel(system),
    TransportRequestId: transport?.TransportRequestId || '',
    LastRunId: run?.ID || null,
    LastRunStatus: run?.Status || '',
    LastRunQueuedAt: run?.QueuedAt || run?.createdAt || null
  };
}

module.exports = {
  planBucket,
  summarizePlanStatuses,
  latestRunByPlan,
  decoratePlanRow
};
