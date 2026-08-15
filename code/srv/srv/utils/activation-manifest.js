// ---------------------------------------------------------------------------
// Activation manifest: the QA/PROD replay runbook (Phase 3).
//
// AdoptOps automates writes only in DEV. Everything transportable travels
// via CTS; the LocalReplay steps (ICF, gateway, task lists, user
// assignments) must be re-done per follow-on system by a basis admin. The
// manifest turns a plan into that runbook: what arrives by transport, what
// to replay per system, and how to VERIFY each item - verification is what
// AdoptOps can later check itself through the read unit.
//
// Pure module: no cds imports, fully unit-testable.
// ---------------------------------------------------------------------------

// How a basis admin verifies each step type in the follow-on system.
const VERIFICATION_HINTS = {
  RUN_TASK_LIST: 'STC02: confirm the scenario shows a completed run on this system.',
  ACTIVATE_ODATA_SERVICE: '/IWFND/MAINT_SERVICE: the app service is active with a green ICF node.',
  ACTIVATE_ICF_NODE: 'SICF: the node is active (ICFSERVICE.ICF_NOACT empty).',
  CREATE_SPACE: 'Transported - verify /UI2/FLPD or spaces app shows the space after import.',
  CREATE_PAGE: 'Transported - verify the page exists and lists the wave apps.',
  ASSIGN_PAGE_TO_SPACE: 'Transported - verify the page is assigned to the space.',
  CREATE_PFCG_ROLE: 'Transported - PFCG: role exists after import.',
  ADD_SPACE_TO_ROLE: 'Transported - PFCG: role menu contains the space node.',
  GENERATE_PROFILE: 'PFCG/SUPC: regenerate the authorization profile after import (profiles are not reliably transported).',
  ASSIGN_ROLE_TO_USERS: 'SU01/PFCG: assign the role to this system\'s users (assignments are client-local and never transported).',
  ADD_TO_TRANSPORT: 'SE10/STMS: request released and imported into this system.'
};

// Local-replay step types that must be REPEATED per system even though they
// were executed in DEV; transportable ones only need verification.
function replayAction(step) {
  switch (step.StepType) {
    case 'RUN_TASK_LIST': return `Run task list ${step.ObjectName} (STC01), or confirm a prior run covers this system.`;
    case 'ACTIVATE_ODATA_SERVICE': return `Activate the OData service for app ${step.ObjectName} (/IWFND/MAINT_SERVICE).`;
    case 'ACTIVATE_ICF_NODE': return `Activate the ICF node for app ${step.ObjectName} (SICF). IRREVERSIBLE - activate only what the wave needs.`;
    case 'ASSIGN_ROLE_TO_USERS': return `Assign role ${step.ObjectName} to this system's user population.`;
    default: return `Repeat ${step.StepType} for ${step.ObjectName} on this system.`;
  }
}

function stepEntry(step) {
  let objectKey = null;
  try {
    objectKey = step.ObjectKeyJson ? JSON.parse(step.ObjectKeyJson) : null;
  } catch {
    objectKey = null;
  }
  return {
    sequence: step.SequenceNo,
    stepType: step.StepType,
    object: step.ObjectName,
    group: step.StepGroup,
    statusInDev: step.Status,
    objectKey,
    verification: VERIFICATION_HINTS[step.StepType] || 'Verify the object exists and is active on this system.'
  };
}

function buildActivationManifest({ plan, steps, wave, targetSystem, transport }) {
  const ordered = [...(steps || [])].sort((a, b) => a.SequenceNo - b.SequenceNo);
  const transportable = ordered.filter((s) => s.Transportable);
  const localReplay = ordered.filter((s) => s.LocalReplay);

  return {
    plan: {
      id: plan.ID,
      name: plan.Name,
      status: plan.Status,
      executedAt: plan.ExecutedAt || null,
      executedBy: plan.ExecutedBy || null
    },
    wave: wave ? { id: wave.ID, name: wave.Name } : null,
    devSystem: targetSystem
      ? { name: targetSystem.displayName, systemId: targetSystem.systemId || '', client: targetSystem.client || '' }
      : null,
    transport: transport
      ? { id: transport.TransportRequestId, status: transport.Status, description: transport.Description }
      : null,
    transportable: transportable.map(stepEntry),
    localReplay: localReplay.map((s) => ({ ...stepEntry(s), action: replayAction(s) })),
    notes: [
      'Import order: release the transport in DEV, import into the follow-on system, then work through the per-system replay list.',
      'Replay steps are idempotent by design: repeating a completed item is safe.',
      'User-role assignments are client-local: assign per system to that system\'s users, never expect them from the transport.',
      'ICF activation is irreversible on this release (no deactivation API) - activate only what the wave requires.'
    ]
  };
}

function renderManifestMarkdown(manifest) {
  const lines = [];
  const push = (text = '') => lines.push(text);

  push(`# Activation replay manifest — ${manifest.plan.name}`);
  push();
  push(`- Plan status in DEV: ${manifest.plan.status}${manifest.plan.executedBy ? ` (executed by ${manifest.plan.executedBy})` : ''}`);
  if (manifest.wave) push(`- Wave: ${manifest.wave.name}`);
  if (manifest.devSystem) push(`- Source of the content (DEV): ${manifest.devSystem.name}${manifest.devSystem.systemId ? ` [${manifest.devSystem.systemId}${manifest.devSystem.client ? `/${manifest.devSystem.client}` : ''}]` : ''}`);
  if (manifest.transport) push(`- Transport request: ${manifest.transport.id} (${manifest.transport.status})`);
  push();

  push(`## 1. Arrives via transport${manifest.transport ? ` (${manifest.transport.id})` : ''} — verify after import`);
  push();
  if (!manifest.transportable.length) {
    push('_No transportable content in this plan._');
  } else {
    for (const entry of manifest.transportable) {
      push(`- [ ] ${entry.stepType} \`${entry.object}\` — ${entry.verification}`);
    }
  }
  push();

  push('## 2. Per-system replay — repeat on EVERY follow-on system (QA, then PROD)');
  push();
  if (!manifest.localReplay.length) {
    push('_No local-replay steps in this plan._');
  } else {
    manifest.localReplay.forEach((entry, index) => {
      push(`${index + 1}. [ ] ${entry.action}`);
      push(`   - Verify: ${entry.verification}`);
    });
  }
  push();

  push('## Notes');
  push();
  for (const note of manifest.notes) push(`- ${note}`);
  push();

  return lines.join('\n');
}

module.exports = { buildActivationManifest, renderManifestMarkdown, VERIFICATION_HINTS };
