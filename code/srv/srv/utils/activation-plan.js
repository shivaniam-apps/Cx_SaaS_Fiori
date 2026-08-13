const { randomUUID } = require('node:crypto');

// ---------------------------------------------------------------------------
// Activation plan derivation and simulation (Phase 3).
//
// deriveActivationSteps is pure: approved proposals in, ordered step rows
// out (with IDs and dependsOn wiring), following the step taxonomy in
// db.ActivationSteps and the verified API matrix
// (docu/06-s4-integration/api-matrix.md):
//   - ICF steps are irreversible (HTTP_DEACTIVATE_NODE* missing on RD1).
//   - Gateway/ICF/foundation steps are per-system local replay.
//   - Space/page/role/transport steps are transportable.
//
// Simulation is verify-first and never writes: each step gets
// SIMULATED_OK / SIMULATED_WARN / SIMULATED_BLOCKED plus a message. The
// probe is injected; mockSimulationProbe is the deterministic ADOPTOPS_MOCK_S4
// implementation, the live probe arrives with the ZADO activation read unit.
// ---------------------------------------------------------------------------

// 'Wave 1' -> 'W1'; 'Core SD/MM' -> 'CORE_SD_MM'. Bounded so PFCG role and
// space ids stay inside their SAP length limits.
function waveTechnicalKey(name, maxLength = 12) {
  const cleaned = String(name || '')
    .toUpperCase()
    .replace(/\bWAVE\s*/g, 'W')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  return (cleaned || 'WAVE').slice(0, maxLength).replace(/_+$/g, '');
}

function deriveActivationSteps({ proposals, waveName }) {
  const key = waveTechnicalKey(waveName);
  const spaceId = `ZADO_${key}`;
  const pageId = `ZADO_${key}_P1`;
  const roleName = `Z_ADO_${key}`;

  let seq = 0;
  const steps = [];
  const step = (o) => {
    const row = {
      ID: randomUUID(),
      SequenceNo: ++seq,
      Status: 'PENDING',
      Idempotent: true,
      IsDestructive: false,
      dependsOn_ID: null,
      ...o
    };
    steps.push(row);
    return row;
  };

  const foundation = step({
    StepGroup: 'FOUNDATION', StepType: 'RUN_TASK_LIST',
    ObjectType: 'STC_SCENARIO', ObjectName: 'SAP_FIORI_FOUNDATION_S4',
    Transportable: false, LocalReplay: true, Reversible: false,
    ObjectKeyJson: JSON.stringify({ scenario: 'SAP_FIORI_FOUNDATION_S4', driver: 'STC_TM_SESSION_BEGIN' })
  });

  for (const p of proposals) {
    step({
      StepGroup: 'SERVICE', StepType: 'ACTIVATE_ODATA_SERVICE',
      ObjectType: 'FIORI_APP', ObjectName: p.FioriId, proposal_ID: p.ID,
      Transportable: false, LocalReplay: true, Reversible: true,
      dependsOn_ID: foundation.ID,
      ObjectKeyJson: JSON.stringify({ fioriId: p.FioriId, scenario: 'SAP_GATEWAY_ACTIVATE_ODATA_SERV' })
    });
  }
  for (const p of proposals) {
    step({
      StepGroup: 'SERVICE', StepType: 'ACTIVATE_ICF_NODE',
      ObjectType: 'FIORI_APP', ObjectName: p.FioriId, proposal_ID: p.ID,
      Transportable: false, LocalReplay: true, Reversible: false,
      dependsOn_ID: foundation.ID,
      ObjectKeyJson: JSON.stringify({ fioriId: p.FioriId, api: 'HTTP_ACTIVATE_NODE', stateColumn: 'ICFSERVICE.ICF_NOACT' })
    });
  }

  const space = step({
    StepGroup: 'CONTENT', StepType: 'CREATE_SPACE',
    ObjectType: 'FLP_SPACE', ObjectName: spaceId,
    Transportable: true, LocalReplay: false, Reversible: true,
    ObjectKeyJson: JSON.stringify({ spaceId, title: waveName })
  });
  const page = step({
    StepGroup: 'CONTENT', StepType: 'CREATE_PAGE',
    ObjectType: 'FLP_PAGE', ObjectName: pageId,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: space.ID,
    ObjectKeyJson: JSON.stringify({ pageId, apps: proposals.map((p) => p.FioriId) })
  });
  step({
    StepGroup: 'CONTENT', StepType: 'ASSIGN_PAGE_TO_SPACE',
    ObjectType: 'FLP_PAGE', ObjectName: pageId,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: page.ID,
    ObjectKeyJson: JSON.stringify({ spaceId, pageId })
  });

  const referenceRoles = [...new Set(proposals.map((p) => p.BusinessRoleId).filter(Boolean))];
  const role = step({
    StepGroup: 'ROLE', StepType: 'CREATE_PFCG_ROLE',
    ObjectType: 'PFCG_ROLE', ObjectName: roleName,
    Transportable: true, LocalReplay: false, Reversible: true,
    ObjectKeyJson: JSON.stringify({ role: roleName, api: 'PRGN_RFC_CREATE_ACTIVITY_GROUP', referenceRoles })
  });
  const spaceToRole = step({
    StepGroup: 'ROLE', StepType: 'ADD_SPACE_TO_ROLE',
    ObjectType: 'PFCG_ROLE', ObjectName: roleName,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: role.ID,
    ObjectKeyJson: JSON.stringify({ role: roleName, spaceId, menuPath: 'AGR_HIER via HIERARCHY_NODES' })
  });
  const profile = step({
    StepGroup: 'ROLE', StepType: 'GENERATE_PROFILE',
    ObjectType: 'PFCG_ROLE', ObjectName: roleName,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: spaceToRole.ID,
    ObjectKeyJson: JSON.stringify({ role: roleName, api: 'PRGN_AUTO_GENERATE_PROFILE_NEW' })
  });

  step({
    StepGroup: 'TRANSPORT', StepType: 'ADD_TO_TRANSPORT',
    ObjectType: 'TRANSPORT', ObjectName: `${key}_TR`,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: profile.ID,
    ObjectKeyJson: JSON.stringify({ apis: ['TR_INSERT_NEW_COMM', 'TR_APPEND_TO_COMM_OBJS_KEYS'], simulation: 'IV_SIMULATION' })
  });

  return { steps, spaceId, pageId, roleName };
}

// Deterministic mock probe: same inputs, same verdicts, so demo runs are
// stable. Foundation is reported as already executed (verify-first showcase);
// ICF steps warn because their irreversibility is a real property of the
// target (HTTP_DEACTIVATE_NODE* missing), not a mock artifact.
function mockSimulationProbe(step) {
  if (step.StepType === 'RUN_TASK_LIST') {
    return { verdict: 'SIMULATED_OK', existsAlready: true, message: 'Task list already executed on the target (mock probe) - step will be skipped at execution.' };
  }
  if (step.StepType === 'ACTIVATE_ODATA_SERVICE') {
    return { verdict: 'SIMULATED_OK', existsAlready: false, message: `Service ${step.ObjectName}_SRV resolvable and inactive (mock probe).` };
  }
  if (step.StepType === 'ACTIVATE_ICF_NODE') {
    return { verdict: 'SIMULATED_WARN', existsAlready: false, message: 'ICF activation is irreversible on this release (HTTP_DEACTIVATE_NODE missing) - execution cannot be rolled back.' };
  }
  return { verdict: 'SIMULATED_OK', existsAlready: false, message: `${step.StepType} ${step.ObjectName}: no conflict found (mock probe).` };
}

// Pure: apply probe verdicts to steps, produce updated step rows + plan
// rollup. Blocked steps make the plan SIMULATED with a blocked count;
// otherwise SIMULATED (READY is a separate explicit gate before execution).
function simulateSteps(steps, probe) {
  const updated = steps.map((step) => {
    const { verdict, existsAlready, message } = probe(step);
    return {
      ID: step.ID,
      Status: verdict,
      ExistsAlready: Boolean(existsAlready),
      SimulationMessage: String(message || '').slice(0, 1000)
    };
  });
  const count = (v) => updated.filter((s) => s.Status === v).length;
  return {
    steps: updated,
    rollup: {
      SucceededCount: count('SIMULATED_OK'),
      WarningCount: count('SIMULATED_WARN'),
      FailedCount: count('SIMULATED_BLOCKED'),
      SkippedCount: updated.filter((s) => s.ExistsAlready).length
    }
  };
}

module.exports = { waveTechnicalKey, deriveActivationSteps, simulateSteps, mockSimulationProbe };
