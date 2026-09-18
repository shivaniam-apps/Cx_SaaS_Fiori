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
  // The gateway API activates by SERVICE, not by app (RD1 probe rounds 2-4):
  // serviceName / serviceVersion come from the catalog derivation (the HT
  // nodes of the app's catalog folder). Until the catalog carries them they
  // travel empty and the ABAP dispatcher fails the step fast, naming the app
  // - the same pattern as the ICF node. systemAlias empty = system setting.
  ACTIVATE_ODATA_SERVICE: ({ fioriId, serviceName, serviceVersion, systemAlias }) => ({
    fioriId,
    scenario: 'SAP_GATEWAY_ACTIVATE_ODATA_SERV',
    serviceName: String(serviceName || '').trim(),
    serviceVersion: String(serviceVersion || '').trim(),
    systemAlias: String(systemAlias || '').trim()
  }),
  ACTIVATE_ICF_NODE: ({ fioriId, bspApplication }) => ({ fioriId, ...icfNodeFor(bspApplication) }),
  // Launchpad content is written in the customizing layer and recorded on
  // the plan's request at write time: trkorr is engine-injected like the role's.
  CREATE_SPACE: ({ spaceId, title, trkorr }) => ({ spaceId, title, trkorr: String(trkorr || '').trim() }),
  CREATE_PAGE: ({ pageId, title, apps, trkorr }) => ({
    pageId, title: sapText(title, 100), apps: [...(apps || [])], trkorr: String(trkorr || '').trim()
  }),
  ASSIGN_PAGE_TO_SPACE: ({ spaceId, pageId, trkorr }) => ({ spaceId, pageId, trkorr: String(trkorr || '').trim() }),
  // trkorr is the plan's transport request; the planner leaves it empty and
  // the execution engine injects it (withPlanTrkorr) once ADD_TO_TRANSPORT
  // has created the request, so PFCG records the role on it at creation.
  CREATE_PFCG_ROLE: ({ role, text, referenceRoles, trkorr }) => ({
    role, text: sapText(text, 80), referenceRoles: [...(referenceRoles || [])], trkorr: String(trkorr || '').trim()
  }),
  // E071-shaped references of the wave's transportable objects; verify-first
  // on the ABAP side (already-recorded objects are not appended again).
  APPEND_TO_TRANSPORT: ({ trkorr, objects }) => ({
    trkorr: String(trkorr || '').trim(),
    objects: (objects || []).map((o) => ({ pgmid: o.pgmid, object: o.object, objName: o.objName }))
  }),
  ADD_SPACE_TO_ROLE: ({ role, spaceId }) => ({ role, spaceId }),
  // A space shows tiles; the business catalog in the role menu is what
  // authorizes the apps (PFCG derives the app and service nodes from it).
  ADD_CATALOG_TO_ROLE: ({ role, catalogId }) => ({ role, catalogId }),
  ASSIGN_BUSINESS_CATALOG: ({ role, catalogId }) => ({ role, catalogId }),
  GENERATE_PROFILE: ({ role }) => ({ role }),
  ASSIGN_ROLE_TO_USERS: ({ role, users }) => ({ role, users: [...(users || [])] }),
  // Operator rollback (rollbackActivationStep): ROLLBACK_<type> carries only
  // what undoing needs; types without a builder travel with the original key.
  ROLLBACK_CREATE_PFCG_ROLE: ({ role }) => ({ role }),
  ROLLBACK_GENERATE_PROFILE: ({ role }) => ({ role }),
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

// Step types whose key carries the plan's transport request. The TRKORR
// only exists once the plan's ADD_TO_TRANSPORT step ran, so the engine
// merges it into the persisted key at dispatch time (the row keeps its
// planned key; only the executor sees the completed one).
const TRKORR_STEP_TYPES = ['CREATE_PFCG_ROLE', 'APPEND_TO_TRANSPORT', 'CREATE_SPACE', 'CREATE_PAGE', 'ASSIGN_PAGE_TO_SPACE'];

function withPlanTrkorr(step, trkorr) {
  if (!trkorr || !TRKORR_STEP_TYPES.includes(step.StepType)) return step;
  let key = {};
  try {
    key = step.ObjectKeyJson ? JSON.parse(step.ObjectKeyJson) : {};
  } catch {
    key = {};
  }
  return { ...step, ObjectKeyJson: JSON.stringify({ ...key, trkorr: String(trkorr).trim() }) };
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

  // The transport request is created BEFORE the first transportable write:
  // PFCG and the launchpad repositories record objects on a request at
  // write time, so the plan's TRKORR must exist first (engine threads it
  // into the later keys via withPlanTrkorr). Release stays an operator
  // action (releaseTransport).
  const transport = step({
    StepGroup: 'TRANSPORT', StepType: 'ADD_TO_TRANSPORT',
    ObjectType: 'TRANSPORT', ObjectName: `${key}_TR`,
    Transportable: true, LocalReplay: false, Reversible: true,
    ObjectKeyJson: objectKeyJson('ADD_TO_TRANSPORT', { text: title })
  });

  const space = step({
    StepGroup: 'CONTENT', StepType: 'CREATE_SPACE',
    ObjectType: 'FLP_SPACE', ObjectName: spaceId,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: transport.ID,
    ObjectKeyJson: objectKeyJson('CREATE_SPACE', { spaceId, title: waveName })
  });
  const page = step({
    StepGroup: 'CONTENT', StepType: 'CREATE_PAGE',
    ObjectType: 'FLP_PAGE', ObjectName: pageId,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: space.ID,
    ObjectKeyJson: objectKeyJson('CREATE_PAGE', { pageId, title: waveName, apps: proposals.map((p) => p.FioriId) })
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
    dependsOn_ID: transport.ID,
    ObjectKeyJson: objectKeyJson('CREATE_PFCG_ROLE', { role: roleName, text: title, referenceRoles })
  });
  // One menu node per distinct business catalog of the wave's apps; apps
  // whose proposal names no catalog contribute none (the step list then
  // equals the earlier template). Chained so PFCG sees one writer at a time.
  let lastRoleStep = role;
  const catalogIds = [...new Set(proposals.map((p) => String(p.BusinessCatalogId || '').trim()).filter(Boolean))];
  for (const catalogId of catalogIds) {
    lastRoleStep = step({
      StepGroup: 'ROLE', StepType: 'ADD_CATALOG_TO_ROLE',
      ObjectType: 'PFCG_ROLE', ObjectName: roleName,
      Transportable: true, LocalReplay: false, Reversible: true,
      dependsOn_ID: lastRoleStep.ID,
      ObjectKeyJson: objectKeyJson('ADD_CATALOG_TO_ROLE', { role: roleName, catalogId })
    });
  }
  const spaceToRole = step({
    StepGroup: 'ROLE', StepType: 'ADD_SPACE_TO_ROLE',
    ObjectType: 'PFCG_ROLE', ObjectName: roleName,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: lastRoleStep.ID,
    ObjectKeyJson: objectKeyJson('ADD_SPACE_TO_ROLE', { role: roleName, spaceId })
  });
  const profile = step({
    StepGroup: 'ROLE', StepType: 'GENERATE_PROFILE',
    ObjectType: 'PFCG_ROLE', ObjectName: roleName,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: spaceToRole.ID,
    ObjectKeyJson: objectKeyJson('GENERATE_PROFILE', { role: roleName })
  });

  // Safety net after the writes: whatever PFCG/the repositories did not
  // record on the request themselves is appended here (verify-first on
  // E071). Spaces and pages join this list with their S3 executors.
  step({
    StepGroup: 'TRANSPORT', StepType: 'APPEND_TO_TRANSPORT',
    ObjectType: 'TRANSPORT', ObjectName: `${key}_TR`,
    Transportable: true, LocalReplay: false, Reversible: true,
    dependsOn_ID: profile.ID,
    ObjectKeyJson: objectKeyJson('APPEND_TO_TRANSPORT', {
      objects: [{ pgmid: 'R3TR', object: 'ACGR', objName: roleName }]
    })
  });

  return { steps, spaceId, pageId, roleName };
}

// Effort figures for ONE app, derived from the same template that plans a
// wave, so the proposal scoring (effortScoreOf) can never drift from what an
// activation actually does. The single-app plan is the honest per-app cost:
// its shared steps (foundation, space/page, role, transport) are paid once
// per wave, but a proposal is scored before it belongs to any wave.
// newRolesNeeded counts CREATE_PFCG_ROLE steps - the template always
// creates the wave's own Z_ADO role; an existing-role check arrives with the
// role inventory (S8).
function deriveActivationEffort({ fioriId, bspApplication, businessRoleId } = {}) {
  const { steps } = deriveActivationSteps({
    proposals: [{ ID: 'effort-probe', FioriId: fioriId || 'FXXXX', BspApplication: bspApplication, BusinessRoleId: businessRoleId }],
    waveName: 'effort probe'
  });
  return {
    activationStepCount: steps.length,
    appStepCount: steps.filter((s) => s.proposal_ID).length,
    sharedStepCount: steps.filter((s) => !s.proposal_ID).length,
    newRolesNeeded: steps.filter((s) => s.StepType === 'CREATE_PFCG_ROLE').length,
    localReplayStepCount: steps.filter((s) => s.LocalReplay).length,
    transportableStepCount: steps.filter((s) => s.Transportable).length,
    irreversibleStepCount: steps.filter((s) => s.Reversible === false).length
  };
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

// Apply probe verdicts to steps, produce updated step rows + plan rollup.
// The probe may be sync (mock) or async (live ZADO state probe); steps are
// probed in sequence so the DEV system sees one read at a time. Blocked
// steps make the plan SIMULATED with a blocked count; otherwise SIMULATED
// (READY is a separate explicit gate before execution).
async function simulateSteps(steps, probe) {
  const updated = [];
  for (const step of steps) {
    const { verdict, existsAlready, message } = await probe(step);
    updated.push({
      ID: step.ID,
      Status: verdict,
      ExistsAlready: Boolean(existsAlready),
      SimulationMessage: String(message || '').slice(0, 1000)
    });
  }
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
  withPlanTrkorr,
  TRKORR_STEP_TYPES,
  deriveActivationSteps,
  deriveActivationEffort,
  simulateSteps,
  mockSimulationProbe,
  isActivationTargetEnvironment
};
