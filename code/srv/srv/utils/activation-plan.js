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

// Activation writes are DEV-only (the write unit itself only exists there).
// Anything that names a QA/PROD-like environment is refused as a plan
// target; unknown/empty passes, because pilot systems may be unclassified.
// The client mirrors this list for preselection only (features/waves) - the
// enforcement lives here.
const BLOCKED_TARGET_ENVIRONMENTS = ['QAS', 'QA', 'PRD', 'PROD', 'PRODUCTION', 'PREPROD', 'PRE-PROD'];

function isActivationTargetEnvironment(environment) {
  return !BLOCKED_TARGET_ENVIRONMENTS.includes(String(environment || '').trim().toUpperCase());
}

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

// ---------------------------------------------------------------------------
// ObjectKeyJson builders - the SINGLE source of the key shapes the ABAP
// dispatcher (zcl_ado_activate) deserializes per step type: camelCase on the
// wire, snake_case in the ABAP types (/ui2/cl_json pretty_mode-camel_case).
// The contract is captured in test/fixtures/activation-object-keys.json,
// enforced by activation-plan.test.js (this module) and
// activation-key-contract.test.js (the ABAP mirror), and explained in
// docu/09-activation-and-transport/object-key-contract.md. Keys carry only
// what the executor needs - no API names or documentation fields.
// ---------------------------------------------------------------------------

const ICF_UI5_ROOT = '/sap/bc/ui5_ui5/sap/';

// SAP text limits the keys are bound by: AGR_TITLE (80), AS4TEXT (60).
const sapText = (value, max) => String(value || '').trim().slice(0, max);

// SAPUI5 apps are served by the BSP application the catalog knows
// (BackendCatalogApps.BspApplication): the ICF node is /sap/bc/ui5_ui5/sap/
// <bsp> and the node name is the BSP name. Without a catalog row both stay
// empty on purpose - the ABAP dispatcher then fails that step fast with a
// message naming the app, before HTTP_ACTIVATE_NODE is touched.
function icfNodeFor(bspApplication) {
  const bsp = String(bspApplication || '').trim().toLowerCase();
  return bsp ? { url: `${ICF_UI5_ROOT}${bsp}`, icfName: bsp } : { url: '', icfName: '' };
}

const OBJECT_KEY_BUILDERS = {
  RUN_TASK_LIST: ({ scenario }) => ({ scenario }),
  ACTIVATE_ODATA_SERVICE: ({ fioriId }) => ({ fioriId, scenario: 'SAP_GATEWAY_ACTIVATE_ODATA_SERV' }),
  ACTIVATE_ICF_NODE: ({ fioriId, bspApplication }) => ({ fioriId, ...icfNodeFor(bspApplication) }),
  CREATE_SPACE: ({ spaceId, title }) => ({ spaceId, title }),
  CREATE_PAGE: ({ pageId, apps }) => ({ pageId, apps: [...(apps || [])] }),
  ASSIGN_PAGE_TO_SPACE: ({ spaceId, pageId }) => ({ spaceId, pageId }),
  CREATE_PFCG_ROLE: ({ role, text, referenceRoles }) => ({ role, text: sapText(text, 80), referenceRoles: [...(referenceRoles || [])] }),
  ADD_SPACE_TO_ROLE: ({ role, spaceId }) => ({ role, spaceId }),
  GENERATE_PROFILE: ({ role }) => ({ role }),
  ASSIGN_ROLE_TO_USERS: ({ role, users }) => ({ role, users: [...(users || [])] }),
  // Two variants share the step type, exactly as the ABAP dispatcher decides:
  // a TRKORR releases that request, otherwise a new request is created.
  ADD_TO_TRANSPORT: ({ text, trkorr, simulation }) => (trkorr
    ? { trkorr: String(trkorr).trim(), simulation: Boolean(simulation) }
    : { text: sapText(text, 60) })
};

function objectKey(stepType, params = {}) {
  const build = OBJECT_KEY_BUILDERS[stepType];
  if (!build) throw new Error(`No ObjectKeyJson builder for step type ${stepType}`);
  return build(params);
}

function objectKeyJson(stepType, params) {
  return JSON.stringify(objectKey(stepType, params));
}

// proposals: approved AppProposals rows, optionally enriched with the
// catalog's BspApplication per Fiori ID (createActivationPlan does this per
// target system) so ICF steps carry real node URLs.
function deriveActivationSteps({ proposals, waveName }) {
  const key = waveTechnicalKey(waveName);
  const spaceId = `ZADO_${key}`;
  const pageId = `ZADO_${key}_P1`;
  const roleName = `Z_ADO_${key}`;
  const title = `AdoptOps ${String(waveName || '').trim()}`.trim();

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
    ObjectKeyJson: objectKeyJson('RUN_TASK_LIST', { scenario: 'SAP_FIORI_FOUNDATION_S4' })
  });

  for (const p of proposals) {
    step({
      StepGroup: 'SERVICE', StepType: 'ACTIVATE_ODATA_SERVICE',
      ObjectType: 'FIORI_APP', ObjectName: p.FioriId, proposal_ID: p.ID,
      Transportable: false, LocalReplay: true, Reversible: true,
      dependsOn_ID: foundation.ID,
      ObjectKeyJson: objectKeyJson('ACTIVATE_ODATA_SERVICE', { fioriId: p.FioriId })
    });
  }
  for (const p of proposals) {
    step({
      StepGroup: 'SERVICE', StepType: 'ACTIVATE_ICF_NODE',
      ObjectType: 'FIORI_APP', ObjectName: p.FioriId, proposal_ID: p.ID,
      Transportable: false, LocalReplay: true, Reversible: false,
      dependsOn_ID: foundation.ID,
      ObjectKeyJson: objectKeyJson('ACTIVATE_ICF_NODE', { fioriId: p.FioriId, bspApplication: p.BspApplication })
    });
  }

  const space = step({
    StepGroup: 'CONTENT', StepType: 'CREATE_SPACE',
    ObjectType: 'FLP_SPACE', ObjectName: spaceId,
    Transportable: true, LocalReplay: false, Reversible: true,
    ObjectKeyJson: objectKeyJson('CREATE_SPACE', { spaceId, title: waveName })
  });
  const page = step({
    StepGroup: 'CONTENT', StepType: 'CREATE_PAGE',
    ObjectType: 'FLP_PAGE', ObjectName: pageId,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: space.ID,
    ObjectKeyJson: objectKeyJson('CREATE_PAGE', { pageId, apps: proposals.map((p) => p.FioriId) })
  });
  step({
    StepGroup: 'CONTENT', StepType: 'ASSIGN_PAGE_TO_SPACE',
    ObjectType: 'FLP_PAGE', ObjectName: pageId,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: page.ID,
    ObjectKeyJson: objectKeyJson('ASSIGN_PAGE_TO_SPACE', { spaceId, pageId })
  });

  const referenceRoles = [...new Set(proposals.map((p) => p.BusinessRoleId).filter(Boolean))];
  const role = step({
    StepGroup: 'ROLE', StepType: 'CREATE_PFCG_ROLE',
    ObjectType: 'PFCG_ROLE', ObjectName: roleName,
    Transportable: true, LocalReplay: false, Reversible: true,
    ObjectKeyJson: objectKeyJson('CREATE_PFCG_ROLE', { role: roleName, text: title, referenceRoles })
  });
  const spaceToRole = step({
    StepGroup: 'ROLE', StepType: 'ADD_SPACE_TO_ROLE',
    ObjectType: 'PFCG_ROLE', ObjectName: roleName,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: role.ID,
    ObjectKeyJson: objectKeyJson('ADD_SPACE_TO_ROLE', { role: roleName, spaceId })
  });
  const profile = step({
    StepGroup: 'ROLE', StepType: 'GENERATE_PROFILE',
    ObjectType: 'PFCG_ROLE', ObjectName: roleName,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: spaceToRole.ID,
    ObjectKeyJson: objectKeyJson('GENERATE_PROFILE', { role: roleName })
  });

  step({
    StepGroup: 'TRANSPORT', StepType: 'ADD_TO_TRANSPORT',
    ObjectType: 'TRANSPORT', ObjectName: `${key}_TR`,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: profile.ID,
    ObjectKeyJson: objectKeyJson('ADD_TO_TRANSPORT', { text: title })
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

module.exports = {
  waveTechnicalKey,
  icfNodeFor,
  objectKey,
  objectKeyJson,
  deriveActivationSteps,
  simulateSteps,
  mockSimulationProbe,
  isActivationTargetEnvironment
};
