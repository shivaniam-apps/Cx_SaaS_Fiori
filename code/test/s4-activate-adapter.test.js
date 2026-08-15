import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_ACTIVATE_ROOT,
  activateRootFor,
  isODataRoot,
  mapRemoteStepResult,
  executeStepRemote,
  liveStepExecutorFor
} = require('../srv/srv/utils/s4-activate-adapter.js');

describe('activation transport mode selection', () => {
  it('routes /sap/opu/odata4 roots to OData and /sap/bc roots to ICF', () => {
    expect(isODataRoot('/sap/bc/zado_act')).to.equal(false);
    expect(isODataRoot(DEFAULT_ACTIVATE_ROOT)).to.equal(false);
    expect(isODataRoot('/sap/opu/odata4/sap/zado_activate_o4/srvd/sap/zado_activate_srv/0001/')).to.equal(true);
    expect(isODataRoot('')).to.equal(false);
  });
});

describe('s4 activate adapter (the CAP side of ZIF_ADO_ACT_STEP)', () => {
  it('resolves the service root from the target system override', () => {
    expect(activateRootFor({})).to.equal(DEFAULT_ACTIVATE_ROOT);
    expect(activateRootFor({ activationRootPath: '  ' })).to.equal(DEFAULT_ACTIVATE_ROOT);
    expect(activateRootFor({ activationRootPath: '/sap/bc/custom_act' })).to.equal('/sap/bc/custom_act');
  });

  it('maps a valid remote result onto the executor contract', () => {
    const result = mapRemoteStepResult({
      status: 'warning',
      existsAlready: 'X',
      trkorr: ' RD1K900042 ',
      messages: [{ type: 's', message: 'activated' }, { type: 'W', message: 'irreversible' }]
    });
    expect(result.status).to.equal('WARNING');
    expect(result.existsAlready).to.equal(true);
    expect(result.trkorr).to.equal('RD1K900042');
    expect(result.messages).to.deep.equal([
      { type: 'S', message: 'activated' },
      { type: 'W', message: 'irreversible' }
    ]);
  });

  it('turns an invalid or foreign payload into FAILED, never an exception', () => {
    for (const payload of [null, {}, { status: 'DONE' }, 'not json', { error: 'boom' }]) {
      const result = mapRemoteStepResult(payload);
      expect(result.status).to.equal('FAILED');
      expect(result.messages[0].type).to.equal('E');
    }
  });

  it('defaults missing message tables and normalises message types', () => {
    const result = mapRemoteStepResult({ status: 'SUCCESS' });
    expect(result.messages).to.deep.equal([]);
    const typed = mapRemoteStepResult({ status: 'SUCCESS', messages: [{ message: 'x' }] });
    expect(typed.messages[0].type).to.equal('I');
  });

  it('refuses to build a live executor without a destination', () => {
    expect(() => liveStepExecutorFor({})).to.throw(/destination/i);
    expect(() => liveStepExecutorFor({ destinationName: 'S4H_2023' })).to.not.throw();
  });

  it('treats the mocked transport payload as an invalid step result (defence in depth)', async () => {
    // With mock-S4 on, callS4Destination short-circuits to its mock payload;
    // the adapter must map that foreign shape to FAILED rather than
    // pretending a step succeeded.
    process.env.ADOPTOPS_MOCK_S4 = 'true';
    try {
      const result = await executeStepRemote({
        targetSystem: { destinationName: 'S4H_2023' },
        step: { StepType: 'CREATE_PFCG_ROLE', ObjectKeyJson: '{"role":"Z_X"}' }
      });
      expect(result.status).to.equal('FAILED');
      expect(result.messages[0].message).to.match(/invalid step result/i);
    } finally {
      delete process.env.ADOPTOPS_MOCK_S4;
    }
  });
});
