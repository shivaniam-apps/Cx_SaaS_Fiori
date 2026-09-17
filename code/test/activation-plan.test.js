import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  waveTechnicalKey,
  objectKey,
  withPlanTrkorr,
  TRKORR_STEP_TYPES,
  deriveActivationSteps,
  deriveActivationEffort,
  simulateSteps,
  mockSimulationProbe,
  isActivationTargetEnvironment
} = require('../srv/srv/utils/activation-plan.js');
const fixture = require('./fixtures/activation-object-keys.json');

describe('isActivationTargetEnvironment', () => {
  it('refuses QA/PROD-like environments in any casing', () => {
    for (const env of ['QAS', 'qa', 'PRD', 'prod', 'Production', 'PREPROD', 'pre-prod', ' prd ']) {
      expect(isActivationTargetEnvironment(env), env).to.equal(false);
    }
  });

  it('permits DEV, SANDBOX and unclassified systems', () => {
    for (const env of ['DEV', 'dev', 'SANDBOX', '', null, undefined, 'TRAINING']) {
      expect(isActivationTargetEnvironment(env), String(env)).to.equal(true);
    }
  });
});

const PROPOSALS = [
  { ID: 'p1', FioriId: 'F3893', BusinessRoleId: 'SAP_BR_INTERNAL_SALES_REP' },
  { ID: 'p2', FioriId: 'F0842A', BusinessRoleId: 'SAP_BR_PURCHASER' },
  { ID: 'p3', FioriId: 'F0797', BusinessRoleId: 'SAP_BR_INTERNAL_SALES_REP' }
];

describe('waveTechnicalKey', () => {
  it('compresses wave names into SAP-safe keys', () => {
    expect(waveTechnicalKey('Wave 1')).to.equal('W1');
    expect(waveTechnicalKey('Core SD/MM')).to.equal('CORE_SD_MM');
    expect(waveTechnicalKey('wave 2 - finance')).to.equal('W2_FINANCE');
  });

  it('bounds length and never returns an empty key', () => {
    expect(waveTechnicalKey('A very long descriptive wave name indeed').length).to.be.at.most(12);
    expect(waveTechnicalKey('')).to.equal('WAVE');
    expect(waveTechnicalKey('///')).to.equal('WAVE');
  });
});

describe('deriveActivationSteps', () => {
  const { steps, spaceId, pageId, roleName } = deriveActivationSteps({ proposals: PROPOSALS, waveName: 'Wave 1' });

  it('produces the designed group sequence with one service pair per app', () => {
    const groups = steps.map((s) => s.StepGroup);
    expect(groups).to.deep.equal([
      'FOUNDATION',
      'SERVICE', 'SERVICE', 'SERVICE',           // ACTIVATE_ODATA_SERVICE x3
      'SERVICE', 'SERVICE', 'SERVICE',           // ACTIVATE_ICF_NODE x3
      'TRANSPORT',                               // ADD_TO_TRANSPORT (create) before the first transportable write
      'CONTENT', 'CONTENT', 'CONTENT',
      'ROLE', 'ROLE', 'ROLE',
      'TRANSPORT'                                // APPEND_TO_TRANSPORT (verify-first append)
    ]);
    expect(steps.filter((s) => s.StepType === 'ACTIVATE_ODATA_SERVICE').map((s) => s.ObjectName))
      .to.deep.equal(['F3893', 'F0842A', 'F0797']);
  });

  it('derives wave-scoped object names', () => {
    expect(spaceId).to.equal('ZADO_W1');
    expect(pageId).to.equal('ZADO_W1_P1');
    expect(roleName).to.equal('Z_ADO_W1');
  });

  it('flags per the verified API matrix: ICF irreversible, gateway/ICF local replay, content/role transportable', () => {
    for (const s of steps.filter((x) => x.StepType === 'ACTIVATE_ICF_NODE')) {
      expect(s.Reversible, s.ObjectName).to.equal(false);
      expect(s.LocalReplay).to.equal(true);
      expect(s.Transportable).to.equal(false);
    }
    for (const s of steps.filter((x) => ['CONTENT', 'ROLE', 'TRANSPORT'].includes(x.StepGroup))) {
      expect(s.Transportable, s.StepType).to.equal(true);
      expect(s.LocalReplay).to.equal(false);
    }
  });

  it('wires dependsOn: services on foundation, space and role on the request, page on space, append on profile', () => {
    const byType = (t) => steps.filter((s) => s.StepType === t);
    const foundation = byType('RUN_TASK_LIST')[0];
    const transport = byType('ADD_TO_TRANSPORT')[0];
    for (const s of byType('ACTIVATE_ODATA_SERVICE')) expect(s.dependsOn_ID).to.equal(foundation.ID);
    expect(transport.dependsOn_ID).to.equal(null);
    expect(byType('CREATE_SPACE')[0].dependsOn_ID).to.equal(transport.ID);
    expect(byType('CREATE_PFCG_ROLE')[0].dependsOn_ID).to.equal(transport.ID);
    expect(byType('CREATE_PAGE')[0].dependsOn_ID).to.equal(byType('CREATE_SPACE')[0].ID);
    expect(byType('APPEND_TO_TRANSPORT')[0].dependsOn_ID).to.equal(byType('GENERATE_PROFILE')[0].ID);
  });

  it('threads the plan TRKORR into the keys that write on the request, and only those', () => {
    const role = steps.find((s) => s.StepType === 'CREATE_PFCG_ROLE');
    const append = steps.find((s) => s.StepType === 'APPEND_TO_TRANSPORT');
    const space = steps.find((s) => s.StepType === 'CREATE_SPACE');
    expect(JSON.parse(role.ObjectKeyJson).trkorr).to.equal('');
    expect(JSON.parse(withPlanTrkorr(role, ' RD1K900042 ').ObjectKeyJson).trkorr).to.equal('RD1K900042');
    expect(JSON.parse(withPlanTrkorr(append, 'RD1K900042').ObjectKeyJson)).to.deep.equal({
      trkorr: 'RD1K900042', objects: [{ pgmid: 'R3TR', object: 'ACGR', objName: 'Z_ADO_W1' }]
    });
    expect(withPlanTrkorr(space, 'RD1K900042')).to.equal(space);
    expect(withPlanTrkorr(role, '')).to.equal(role);
    expect(TRKORR_STEP_TYPES).to.deep.equal(['CREATE_PFCG_ROLE', 'APPEND_TO_TRANSPORT']);
  });

  it('deduplicates reference roles and carries proposal links on app steps', () => {
    const role = steps.find((s) => s.StepType === 'CREATE_PFCG_ROLE');
    expect(JSON.parse(role.ObjectKeyJson).referenceRoles)
      .to.deep.equal(['SAP_BR_INTERNAL_SALES_REP', 'SAP_BR_PURCHASER']);
    for (const s of steps.filter((x) => x.ObjectType === 'FIORI_APP')) {
      expect(s.proposal_ID).to.be.a('string');
    }
  });

  it('numbers steps sequentially from 1 and starts them all PENDING', () => {
    expect(steps.map((s) => s.SequenceNo)).to.deep.equal(steps.map((_, i) => i + 1));
    expect(new Set(steps.map((s) => s.Status))).to.deep.equal(new Set(['PENDING']));
  });
});

describe('deriveActivationEffort', () => {
  it('matches the single-app plan the template would build (O4 acceptance)', () => {
    const effort = deriveActivationEffort({ fioriId: 'F3893', bspApplication: 'nw_aps_lim_app', businessRoleId: 'SAP_BR_AP_ACCOUNTANT' });
    const { steps } = deriveActivationSteps({ proposals: [PROPOSALS[0]], waveName: 'anything' });
    expect(effort.activationStepCount).to.equal(steps.length);
    expect(effort.newRolesNeeded).to.equal(steps.filter((s) => s.StepType === 'CREATE_PFCG_ROLE').length);
    expect(effort.appStepCount + effort.sharedStepCount).to.equal(effort.activationStepCount);
    expect(effort.localReplayStepCount + effort.transportableStepCount).to.equal(effort.activationStepCount);
  });

  it('is the same for every app today and needs no inputs', () => {
    expect(deriveActivationEffort()).to.deep.equal(deriveActivationEffort({ fioriId: 'F0842A' }));
    expect(deriveActivationEffort()).to.include({ activationStepCount: 11, appStepCount: 2, sharedStepCount: 9, newRolesNeeded: 1, irreversibleStepCount: 2 });
  });
});

describe('simulateSteps with the mock probe', () => {
  const { steps } = deriveActivationSteps({ proposals: PROPOSALS, waveName: 'Wave 1' });
  let verdicts;
  let rollup;
  before(async () => {
    ({ steps: verdicts, rollup } = await simulateSteps(steps, mockSimulationProbe));
  });

  it('is verify-first: the foundation task list is found already executed', () => {
    const foundation = verdicts[0];
    expect(foundation.Status).to.equal('SIMULATED_OK');
    expect(foundation.ExistsAlready).to.equal(true);
  });

  it('warns on every irreversible ICF step and passes the rest', () => {
    const icf = steps.map((s, i) => ({ s, v: verdicts[i] })).filter((x) => x.s.StepType === 'ACTIVATE_ICF_NODE');
    for (const { v } of icf) expect(v.Status).to.equal('SIMULATED_WARN');
    expect(rollup.WarningCount).to.equal(icf.length);
    expect(rollup.FailedCount).to.equal(0);
    expect(rollup.SucceededCount + rollup.WarningCount).to.equal(steps.length);
  });

  it('counts ExistsAlready steps as skippable', () => {
    expect(rollup.SkippedCount).to.equal(1);
  });

  it('is deterministic', async () => {
    const again = await simulateSteps(steps, mockSimulationProbe);
    expect(again.steps).to.deep.equal(verdicts);
    expect(again.rollup).to.deep.equal(rollup);
  });

  it('awaits an async (live) probe one step at a time and counts BLOCKED as failed', async () => {
    const order = [];
    const liveLike = async (step) => {
      order.push(step.SequenceNo);
      if (step.StepType === 'CREATE_SPACE') return { verdict: 'SIMULATED_BLOCKED', existsAlready: false, message: 'no executor' };
      if (step.StepType === 'CREATE_PFCG_ROLE') return { verdict: 'SIMULATED_OK', existsAlready: true, message: 'role exists' };
      return { verdict: 'SIMULATED_OK', existsAlready: false, message: 'ok' };
    };
    const result = await simulateSteps(steps, liveLike);
    expect(order).to.deep.equal(steps.map((s) => s.SequenceNo));
    expect(result.rollup.FailedCount).to.equal(1);
    expect(result.rollup.SkippedCount).to.equal(1);
    expect(result.steps.find((v) => v.Status === 'SIMULATED_BLOCKED').SimulationMessage).to.equal('no executor');
  });
});

// The fixture is the ObjectKeyJson contract with the ABAP dispatcher
// (activation-key-contract.test.js checks the ABAP side against it).
describe('ObjectKeyJson: the planner emits the shared fixture shapes', () => {
  const { steps } = deriveActivationSteps(fixture.input);

  it('matches the fixture key for every planned step type, and plans nothing else', () => {
    for (const [stepType, key] of Object.entries(fixture.planned)) {
      const step = steps.find((s) => s.StepType === stepType);
      expect(step, stepType).to.exist;
      expect(JSON.parse(step.ObjectKeyJson), stepType).to.deep.equal(key);
    }
    expect(new Set(steps.map((s) => s.StepType))).to.deep.equal(new Set(Object.keys(fixture.planned)));
  });

  it('builds the non-planner variants (release, user assignment) from the same source', () => {
    for (const [name, entry] of Object.entries(fixture.other)) {
      expect(objectKey(entry.stepType, entry.params), name).to.deep.equal(entry.key);
    }
  });

  it('resolves the ICF node from the catalog BSP application and leaves it empty otherwise', () => {
    const icf = steps.filter((s) => s.StepType === 'ACTIVATE_ICF_NODE').map((s) => JSON.parse(s.ObjectKeyJson));
    expect(icf).to.deep.equal([
      { fioriId: 'F3893', url: '/sap/bc/ui5_ui5/sap/sd_so_manv2', icfName: 'sd_so_manv2' },
      { fioriId: 'F0842A', url: '', icfName: '' }
    ]);
  });

  it('bounds SAP text fields (AGR_TITLE 80, AS4TEXT 60)', () => {
    const long = 'x'.repeat(100);
    expect(objectKey('CREATE_PFCG_ROLE', { role: 'Z', text: long, referenceRoles: [] }).text).to.have.length(80);
    expect(objectKey('ADD_TO_TRANSPORT', { text: long }).text).to.have.length(60);
  });

  it('refuses unknown step types instead of emitting an empty key', () => {
    expect(() => objectKey('NOT_A_STEP', {})).to.throw(/NOT_A_STEP/);
  });
});
