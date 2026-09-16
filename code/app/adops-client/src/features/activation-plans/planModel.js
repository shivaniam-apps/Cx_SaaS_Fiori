// Pure view-model helpers for the Activation Plans page (cross-wave list +
// detail). No service/axios imports: this module runs under node --test.
// Status designs, execution applicability and step grouping are shared with
// the Adoption Waves page through features/waves/waveModel.js.

import { canBuildPlan, simulationLabel } from '../waves/waveModel.js';
import { isRunActive, durationLabel } from '../activation-runs/runModel.js';

// One-line cell for a run row of the plan detail: the phase while active,
// the error when the task failed before the engine, else the wall-clock
// duration from claim to completion (raw task columns, no server decoration).
export function runRowLabel(run) {
  if (!run) return '';
  if (isRunActive(run)) return run.Phase || '';
  if (run.ErrorText) return run.ErrorText;
  if (!run.ClaimedAt || !run.CompletedAt) return '—';
  const ms = new Date(run.CompletedAt).getTime() - new Date(run.ClaimedAt).getTime();
  return durationLabel(ms);
}

// Simulation runs on DRAFT or SIMULATED plans (server rule in
// simulateActivationPlan); the same predicate gates button and action.
export function canSimulatePlan(plan) {
  return Boolean(plan) && ['DRAFT', 'SIMULATED'].includes(plan.Status);
}

export function simulateActionLabel(plan) {
  return plan?.SimulatedAt ? 'Re-simulate' : 'Simulate';
}

// The replay manifest needs simulation verdicts; a DRAFT has none.
export function canShowManifest(plan) {
  return Boolean(plan) && plan.Status !== 'DRAFT';
}

// Runs arrive newest-first from readActivationPlan; an active run always
// wins so the header links to what is happening now.
export function activeRun(runs) {
  return (runs || []).find(isRunActive) || null;
}

export function latestRun(runs) {
  return activeRun(runs) || (runs || [])[0] || null;
}

// Polling stops once no run of the plan is active (useRunPolling isTerminal).
export function hasActiveRun(payload) {
  return Boolean(activeRun(payload?.Runs));
}

// Only APPROVED proposals become steps, so only waves with approvals can
// seed a plan (mirrors createActivationPlan's 400).
export function wavesEligibleForPlan(waves) {
  return (waves || []).filter((wave) => canBuildPlan(wave.Rollup));
}

// Mirror of the server default (createActivationPlan) for the dialog placeholder.
export function defaultPlanName(wave) {
  return wave?.Name ? `Activation of ${wave.Name}` : '';
}

// The one-line state of a plan: the run phase while a run is active, else
// the lifecycle verdict with the simulation / execution counts.
export function planPhaseLabel(plan, run) {
  if (!plan) return '';
  if (run && isRunActive(run)) {
    const phase = run.Phase || (run.Status === 'QUEUED' ? 'Queued - waiting for a worker' : 'Starting');
    return run.CancelRequested ? `Cancel requested · ${phase}` : phase;
  }
  const counts = simulationLabel(plan);
  switch (plan.Status) {
    case 'DRAFT': return 'Draft - simulate to get the blast-radius verdicts before executing';
    case 'SIMULATING': return 'Simulating';
    case 'SIMULATED':
    case 'READY': return counts ? `Simulated: ${counts}` : 'Simulated';
    case 'EXECUTING': return 'Executing';
    case 'COMPLETED': return counts ? `Completed: ${counts}` : 'Completed';
    case 'PARTIAL': return `Partially executed${counts ? `: ${counts}` : ''} - Resume skips completed steps`;
    case 'FAILED': return `Failed${counts ? `: ${counts}` : ''} - Resume skips completed steps`;
    case 'ROLLED_BACK': return 'Rolled back';
    default: return plan.Status || '';
  }
}

// MessageStrip design for the phase line.
export function planStripDesign(plan, run) {
  if (run && isRunActive(run)) return 'Information';
  switch (plan?.Status) {
    case 'FAILED':
    case 'ROLLED_BACK': return 'Negative';
    case 'PARTIAL':
    case 'EXECUTING':
    case 'SIMULATING': return 'Critical';
    case 'COMPLETED': return 'Positive';
    case 'SIMULATED':
    case 'READY': return plan.FailedCount ? 'Critical' : 'Positive';
    default: return 'Information';
  }
}

// KPI cards partition Summary.Total exactly (Draft + Simulated + Executing +
// Completed + Attention [+ Other]); "Other" only appears when the engine
// produced a status the buckets do not know, so the strip still sums.
export function summaryCards(summary) {
  const s = summary || {};
  const cards = [
    { key: 'DRAFT', label: 'Draft', value: s.Draft || 0 },
    { key: 'SIMULATED', label: 'Simulated', value: s.Simulated || 0 },
    { key: 'EXECUTING', label: 'Executing', value: s.Executing || 0 },
    { key: 'COMPLETED', label: 'Completed', value: s.Completed || 0 },
    { key: 'ATTENTION', label: 'Needs attention', value: s.Attention || 0 }
  ];
  if (s.Other) cards.push({ key: 'OTHER', label: 'Other', value: s.Other });
  return cards;
}
