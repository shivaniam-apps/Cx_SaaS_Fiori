// ---------------------------------------------------------------------------
// Activation runs: the monitor's view over ACTIVATION_EXECUTION background
// tasks. Pure helpers only (no DB access) so the shaping is unit-testable;
// the PublicService handlers do the reads and call these.
//
// A "run" IS a BackgroundTasks row of TaskType ACTIVATION_EXECUTION. The
// engine's summary (executePlanSteps) lands in ResultJson as { result },
// while the enqueue payload lives there as { payload } until the task
// finishes - never ship ResultJson raw, project the outcome instead.
// ---------------------------------------------------------------------------

const ACTIVE_TASK_STATES = ['QUEUED', 'CLAIMED', 'RUNNING'];
const TERMINAL_TASK_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

// Status buckets for the KPI strip. They partition every task status the
// runner can produce, so the cards always sum to the total (performance.md).
function runBucket(status) {
  if (ACTIVE_TASK_STATES.includes(status)) return 'ACTIVE';
  if (status === 'SUCCEEDED') return 'SUCCEEDED';
  if (status === 'FAILED' || status === 'TIMED_OUT') return 'FAILED';
  if (status === 'CANCELLED') return 'CANCELLED';
  return 'OTHER';
}

// Grouped Status counts (SELECT Status, count(*) ... GROUP BY Status) into
// the summary the list page renders. Computed server-side over the FULL
// filter scope, never from the rows currently loaded.
function summarizeRunStatuses(groupedRows) {
  const summary = { Total: 0, Active: 0, Succeeded: 0, Failed: 0, Cancelled: 0, Other: 0 };
  for (const row of groupedRows || []) {
    const count = Number(row.cnt ?? row.count ?? 0) || 0;
    summary.Total += count;
    switch (runBucket(row.Status)) {
      case 'ACTIVE': summary.Active += count; break;
      case 'SUCCEEDED': summary.Succeeded += count; break;
      case 'FAILED': summary.Failed += count; break;
      case 'CANCELLED': summary.Cancelled += count; break;
      default: summary.Other += count;
    }
  }
  return summary;
}

// The engine summary, or null while the task is still running / when the
// column only carries the enqueue payload. Never throws on a corrupt column.
function parseRunOutcome(resultJson) {
  if (!resultJson) return null;
  let parsed;
  try {
    parsed = typeof resultJson === 'string' ? JSON.parse(resultJson) : resultJson;
  } catch {
    return null;
  }
  const result = parsed?.result;
  if (!result || typeof result !== 'object') return null;
  return {
    Status: result.status || null,
    ExecutedSteps: Number(result.executedSteps || 0),
    Cancelled: Boolean(result.cancelled),
    SucceededCount: Number(result.SucceededCount || 0),
    WarningCount: Number(result.WarningCount || 0),
    FailedCount: Number(result.FailedCount || 0),
    SkippedCount: Number(result.SkippedCount || 0)
  };
}

// Wall-clock duration from claim (or queue, if never claimed) to completion;
// null while the run is still open or when the timestamps are unusable.
function runDurationMs(task) {
  const start = task?.ClaimedAt || task?.QueuedAt;
  const end = task?.CompletedAt;
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function systemLabel(system) {
  if (!system) return '';
  return `${system.displayName || system.systemId || ''}${system.environment ? ` (${system.environment})` : ''}`;
}

// One list/detail row: task facts + labels resolved by the handler in a
// single pass (plan, wave, system, transport). Same shape for both reads so
// the client has one row model.
function decorateRun(task, { plan, wave, system, transport } = {}) {
  return {
    ID: task.ID,
    Status: task.Status,
    Phase: task.Phase || '',
    ProgressPercent: task.ProgressPercent ?? null,
    ProcessedItems: task.ProcessedItems ?? null,
    TotalItems: task.TotalItems ?? null,
    QueuedAt: task.QueuedAt || task.createdAt || null,
    ClaimedAt: task.ClaimedAt || null,
    CompletedAt: task.CompletedAt || null,
    DurationMs: runDurationMs(task),
    RequestedBy: task.RequestedBy || '',
    AttemptCount: task.AttemptCount ?? 0,
    CancelRequested: Boolean(task.CancelRequested),
    ErrorText: task.ErrorText || '',
    Outcome: parseRunOutcome(task.ResultJson),
    PlanId: plan?.ID || task.ObjectId || null,
    PlanName: plan?.Name || '',
    PlanStatus: plan?.Status || '',
    StepCount: plan?.StepCount ?? null,
    WaveId: wave?.ID || plan?.wave_ID || null,
    WaveName: wave?.Name || '',
    TargetSystemId: system?.ID || task.targetSystem_ID || plan?.targetSystem_ID || null,
    TargetSystemName: systemLabel(system),
    TransportRequestId: transport?.TransportRequestId || ''
  };
}

module.exports = {
  ACTIVE_TASK_STATES,
  TERMINAL_TASK_STATES,
  runBucket,
  summarizeRunStatuses,
  parseRunOutcome,
  runDurationMs,
  decorateRun
};
