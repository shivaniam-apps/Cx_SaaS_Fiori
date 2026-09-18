// Pure view-model helpers for the Activation Runs monitor.
// No service/axios imports: this module runs under node --test.

export const ACTIVE_RUN_STATES = ['QUEUED', 'CLAIMED', 'RUNNING'];
export const TERMINAL_RUN_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

export const RUN_STATUS_DESIGN = {
  QUEUED: 'Information',
  CLAIMED: 'Information',
  RUNNING: 'Critical',
  SUCCEEDED: 'Positive',
  FAILED: 'Negative',
  TIMED_OUT: 'Negative',
  CANCELLED: 'Neutral'
};

export const LOG_SEVERITY_DESIGN = { INFO: 'Information', WARN: 'Critical', ERROR: 'Negative' };

export function isRunActive(run) {
  return Boolean(run) && ACTIVE_RUN_STATES.includes(run.Status);
}

export function isRunTerminal(run) {
  return Boolean(run) && TERMINAL_RUN_STATES.includes(run.Status);
}

// "3/9 steps" while the runner reports items, else the percentage, else ''.
export function progressLabel(run) {
  if (!run) return '';
  if (run.TotalItems) return `${run.ProcessedItems ?? 0}/${run.TotalItems} steps`;
  if (run.ProgressPercent !== null && run.ProgressPercent !== undefined) return `${run.ProgressPercent}%`;
  return '';
}

// The one-line state of a run: the runner phase while active (with the
// cancel request called out), the plan verdict or the error afterwards.
export function runPhaseLabel(run) {
  if (!run) return '';
  if (isRunActive(run)) {
    const phase = run.Phase || (run.Status === 'QUEUED' ? 'Queued - waiting for a worker' : 'Starting');
    return run.CancelRequested ? `Cancel requested · ${phase}` : phase;
  }
  if (run.Outcome?.Status) return `Plan ${run.Outcome.Status}`;
  return run.ErrorText || '';
}

// Step verdict counts after the run; progress while it runs; a hint when the
// task failed before the engine produced a summary.
export function outcomeLabel(run) {
  const outcome = run?.Outcome;
  if (!outcome) {
    if (isRunActive(run)) return progressLabel(run);
    return run?.ErrorText ? 'Failed before the first step' : '—';
  }
  const parts = [`${outcome.SucceededCount ?? 0} OK`];
  if (outcome.WarningCount) parts.push(`${outcome.WarningCount} warning${outcome.WarningCount === 1 ? '' : 's'}`);
  if (outcome.FailedCount) parts.push(`${outcome.FailedCount} failed`);
  if (outcome.SkippedCount) parts.push(`${outcome.SkippedCount} skipped`);
  return parts.join(' · ');
}

export function durationLabel(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return '<1 s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

// A finished step shows its measured duration; a running one says so.
export function stepDurationLabel(step) {
  if (!step) return '—';
  if (step.Status === 'RUNNING') return 'running';
  if (step.CompletedAt && step.DurationMs !== null && step.DurationMs !== undefined) return durationLabel(step.DurationMs);
  return '—';
}

// ISO timestamp -> "yyyy-MM-dd HH:mm" (same shape the Transports page uses).
export function formatTimestamp(value) {
  if (!value) return '';
  return String(value).slice(0, 16).replace('T', ' ');
}

// Resume re-invokes executeActivationPlan on the PLAN: only PARTIAL/FAILED
// plans resume, and never while a run is still active (the action would just
// hand back the active task). The same predicate gates button and action.
export function canResumeRun(run) {
  return Boolean(run) && !isRunActive(run) && ['PARTIAL', 'FAILED'].includes(run.PlanStatus);
}

// Cancel is honoured at step boundaries; a second request changes nothing.
export function canCancelRun(run) {
  return isRunActive(run) && !run.CancelRequested;
}

// Operator decisions on single steps (skipActivationStep /
// rollbackActivationStep). The same rules gate the server actions; here
// they gate the buttons, so a click never answers "not allowed".
export const OPERATOR_ACTION = { SKIPPED: 'SKIPPED', ROLLED_BACK: 'ROLLED_BACK', ROLLBACK_REQUESTED: 'ROLLBACK_REQUESTED' };
const EXECUTED_STEP_STATES = ['SUCCESS', 'WARNING'];

function stepSatisfied(step) {
  return EXECUTED_STEP_STATES.includes(step.Status)
    || (step.Status === 'SKIPPED' && (Boolean(step.ExistsAlready) || step.OperatorAction === OPERATOR_ACTION.SKIPPED));
}

export function stepOperatorActions(step, run) {
  const none = { canSkip: false, canRollback: false, rollbackAuditOnly: false };
  if (!step || !run) return none;
  if (isRunActive(run) || ['EXECUTING', 'SIMULATING'].includes(run.PlanStatus)) return none;
  const executed = EXECUTED_STEP_STATES.includes(step.Status);
  return {
    canSkip: step.Status !== 'RUNNING' && !stepSatisfied(step) && step.OperatorAction !== OPERATOR_ACTION.SKIPPED,
    canRollback: executed,
    rollbackAuditOnly: executed && step.Reversible === false
  };
}

// Suffix for the status tag when an operator decided on the step.
export function operatorLabel(step) {
  switch (step?.OperatorAction) {
    case OPERATOR_ACTION.SKIPPED: return 'by operator';
    case OPERATOR_ACTION.ROLLED_BACK: return 'by operator';
    case OPERATOR_ACTION.ROLLBACK_REQUESTED: return 'rollback recorded';
    default: return '';
  }
}

// KPI cards partition Summary.Total exactly (Active + Succeeded + Failed +
// Cancelled [+ Other]); "Other" only appears when the runner produced a status
// the buckets do not know, so the strip still sums to the total.
export function summaryCards(summary) {
  const s = summary || {};
  const cards = [
    { key: 'ACTIVE', label: 'Active', value: s.Active || 0, design: 'Critical' },
    { key: 'SUCCEEDED', label: 'Succeeded', value: s.Succeeded || 0, design: 'Positive' },
    { key: 'FAILED', label: 'Failed / timed out', value: s.Failed || 0, design: 'Negative' },
    { key: 'CANCELLED', label: 'Cancelled', value: s.Cancelled || 0, design: 'Neutral' }
  ];
  if (s.Other) cards.push({ key: 'OTHER', label: 'Other', value: s.Other, design: 'Neutral' });
  return cards;
}

// KPI card as an in-content scope gesture (fiori-ux.md, Filters): clicking a
// bucket card applies that status filter (and the page writes the draft);
// clicking the applied card again, or the total card (key ''), clears it.
// The bucket key is the `status` parameter of queryActivationRuns, so card
// and list slice are the same server expression (performance.md).
export function nextStatusFilter(appliedStatus, cardKey) {
  const key = String(cardKey || '').trim().toUpperCase();
  if (!key || key === 'OTHER') return '';
  return key === String(appliedStatus || '').trim().toUpperCase() ? '' : key;
}

// Monitor read discipline: per-step messages are fetched when a row is
// expanded and re-fetched only while that step is RUNNING - plus exactly once
// more when it leaves RUNNING, so the final verdict messages arrive.
export function shouldRefetchStepMessages(previousStep, currentStep) {
  if (!currentStep) return false;
  if (currentStep.Status === 'RUNNING') return true;
  return previousStep?.Status === 'RUNNING' && currentStep.Status !== 'RUNNING';
}
