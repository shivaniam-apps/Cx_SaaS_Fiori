import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  waveTechnicalKey,
  deriveActivationSteps,
  simulateSteps,
  mockSimulationProbe
} = require('../srv/srv/utils/activation-plan.js');

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
      'CONTENT', 'CONTENT', 'CONTENT',
      'ROLE', 'ROLE', 'ROLE',
      'TRANSPORT'
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

  it('wires dependsOn: services on foundation, page on space, transport on profile', () => {
    const byType = (t) => steps.filter((s) => s.StepType === t);
    const foundation = byType('RUN_TASK_LIST')[0];
    for (const s of byType('ACTIVATE_ODATA_SERVICE')) expect(s.dependsOn_ID).to.equal(foundation.ID);
    expect(byType('CREATE_PAGE')[0].dependsOn_ID).to.equal(byType('CREATE_SPACE')[0].ID);
    expect(byType('ADD_TO_TRANSPORT')[0].dependsOn_ID).to.equal(byType('GENERATE_PROFILE')[0].ID);
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

describe('simulateSteps with the mock probe', () => {
  const { steps } = deriveActivationSteps({ proposals: PROPOSALS, waveName: 'Wave 1' });
  const { steps: verdicts, rollup } = simulateSteps(steps, mockSimulationProbe);

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

  it('is deterministic', () => {
    const again = simulateSteps(steps, mockSimulationProbe);
    expect(again.steps).to.deep.equal(verdicts);
    expect(again.rollup).to.deep.equal(rollup);
  });
});
