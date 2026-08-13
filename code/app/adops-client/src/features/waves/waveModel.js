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
