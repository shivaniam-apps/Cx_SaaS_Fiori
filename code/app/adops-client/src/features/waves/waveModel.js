// Pure view-model helpers for Adoption Waves and activation plans.
// No service/axios imports: this module runs under node --test.

export const WAVE_STATUS_DESIGN = {
  PLANNED: 'Information',
  IN_PROGRESS: 'Critical',
  COMPLETED: 'Positive',
  ON_HOLD: 'Neutral'
};

export const PLAN_STATUS_DESIGN = {
  DRAFT: 'Information',
  SIMULATING: 'Critical',
  SIMULATED: 'Critical',
  READY: 'Positive',
  EXECUTING: 'Critical',
  COMPLETED: 'Positive',
  PARTIAL: 'Critical',
  FAILED: 'Negative',
  ROLLED_BACK: 'Negative'
};

export const STEP_STATUS_DESIGN = {
  PENDING: 'Neutral',
  SIMULATED_OK: 'Positive',
  SIMULATED_WARN: 'Critical',
  SIMULATED_BLOCKED: 'Negative',
  RUNNING: 'Critical',
  SUCCESS: 'Positive',
  WARNING: 'Critical',
  FAILED: 'Negative',
  SKIPPED: 'Neutral',
  ROLLED_BACK: 'Negative'
};

// A wave qualifies for plan building when it has at least one APPROVED member.
export function canBuildPlan(rollup) {
  return Boolean(rollup && rollup.approved > 0);
}

// "4 apps · 4 approved" / "3 apps · 1 approved · 2 open"
export function membershipLabel(rollup) {
  if (!rollup || !rollup.appCount) return 'No proposals assigned';
  const parts = [`${rollup.appCount} app${rollup.appCount === 1 ? '' : 's'}`, `${rollup.approved} approved`];
  if (rollup.open) parts.push(`${rollup.open} open`);
  if (rollup.deferred) parts.push(`${rollup.deferred} deferred`);
  if (rollup.rejected) parts.push(`${rollup.rejected} rejected`);
  return parts.join(' · ');
}

// Simulation outcome in one line; empty until a simulation ran.
export function simulationLabel(plan) {
  if (!plan || !plan.SimulatedAt) return '';
  const parts = [`${plan.SucceededCount ?? 0} OK`];
  if (plan.WarningCount) parts.push(`${plan.WarningCount} warning${plan.WarningCount === 1 ? '' : 's'}`);
  if (plan.FailedCount) parts.push(`${plan.FailedCount} blocked`);
  if (plan.SkippedCount) parts.push(`${plan.SkippedCount} skippable`);
  return parts.join(', ');
}

// Preselection mirror of the server-side activation-target rule
// (srv/utils/activation-plan.js isActivationTargetEnvironment - keep the
// lists identical; ENFORCEMENT lives in CAP, this only drives the picker).
const BLOCKED_TARGET_ENVIRONMENTS = ['QAS', 'QA', 'PRD', 'PROD', 'PRODUCTION', 'PREPROD', 'PRE-PROD'];

export function isActivationTargetAllowed(system) {
  const environment = String(system?.environment || '').trim().toUpperCase();
  return !BLOCKED_TARGET_ENVIRONMENTS.includes(environment);
}

// Default write target for a plan: the wave's own system when permissible,
// else an explicit DEV/SANDBOX system, else any permissible system.
export function defaultActivationTarget(systems, preferredSystemId) {
  const allowed = (systems || []).filter(isActivationTargetAllowed);
  return (
    allowed.find((s) => s.ID === preferredSystemId) ||
    allowed.find((s) => ['DEV', 'SANDBOX'].includes(String(s.environment || '').trim().toUpperCase())) ||
    allowed[0] ||
    null
  );
}

// Execution applicability - the same predicate gates the button and the
// action (fiori-ux mass-action rule). DRAFT must simulate first; EXECUTING
// and COMPLETED have nothing to execute.
export function canExecutePlan(plan) {
  return Boolean(plan) && ['SIMULATED', 'READY', 'PARTIAL', 'FAILED'].includes(plan.Status);
}

// PARTIAL/FAILED plans resume (completed steps are skipped), they never
// re-run wholesale - the label says so.
export function executeActionLabel(plan) {
  return ['PARTIAL', 'FAILED'].includes(plan?.Status) ? 'Resume' : 'Execute';
}

// Steps in render order, grouped by StepGroup with first-seen ordering
// preserved (FOUNDATION -> SERVICE -> CONTENT -> ROLE -> TRANSPORT).
export function groupSteps(steps) {
  const groups = [];
  const byKey = new Map();
  for (const step of steps || []) {
    let group = byKey.get(step.StepGroup);
    if (!group) {
      group = { group: step.StepGroup, steps: [] };
      byKey.set(step.StepGroup, group);
      groups.push(group);
    }
    group.steps.push(step);
  }
  return groups;
}
