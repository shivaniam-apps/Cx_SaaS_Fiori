import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  activationEndpointVerdict,
  checkTargetSystemConnection,
  getBackendCapabilities
} = require('../srv/srv/utils/s4-fiori-adapter.js');

// ---------------------------------------------------------------------------
// S1: the connection check covers both ZADO endpoints. The activation write
// unit is DEV-only, so its verdict is judged against the environment.
// ---------------------------------------------------------------------------

describe('activationEndpointVerdict (environment decides what healthy means)', () => {
  const reachable = { ok: true, status: 200, path: '/sap/bc/zado_act', transport: 'icf', system: 'RD1', client: '100', version: 1 };
  const missing = { ok: false, status: 404, path: '/sap/bc/zado_act', transport: 'icf' };

  it('DEV: reachable is OK, missing is a SERVICE failure', () => {
    const ok = activationEndpointVerdict({ environment: 'DEV', probe: reachable });
    expect(ok).to.include({ Endpoint: 'ACTIVATE', Ok: true, Stage: 'OK', Transport: 'icf', HttpStatus: 200 });
    expect(ok.Message).to.match(/RD1\/100/);

    const failed = activationEndpointVerdict({ environment: 'DEV', probe: missing });
    expect(failed).to.include({ Ok: false, Stage: 'SERVICE', HttpStatus: 404 });
    expect(failed.Message).to.match(/ZCL_ADO_ACT_HTTP|activationRootPath/);
  });

  it('PRD: missing is UNPUBLISHED (healthy), reachable is EXPOSED (safety finding)', () => {
    expect(activationEndpointVerdict({ environment: 'PRD', probe: missing })).to.include({ Ok: true, Stage: 'UNPUBLISHED' });
    const exposed = activationEndpointVerdict({ environment: 'QAS', probe: reachable });
    expect(exposed).to.include({ Ok: false, Stage: 'EXPOSED' });
    expect(exposed.Message).to.match(/must stay unpublished/);
  });

  it('treats an unknown environment like DEV and maps transport errors per environment', () => {
    expect(activationEndpointVerdict({ environment: '', probe: reachable }).Stage).to.equal('OK');
    expect(activationEndpointVerdict({ environment: 'DEV', error: 'ECONNRESET' })).to.include({ Ok: false, Stage: 'SERVICE' });
    expect(activationEndpointVerdict({ environment: 'PROD', error: 'ECONNRESET' })).to.include({ Ok: true, Stage: 'UNPUBLISHED' });
  });
});

describe('checkTargetSystemConnection reports per-endpoint verdicts (mock transport)', () => {
  before(() => { process.env.ADOPTOPS_MOCK_S4 = 'true'; });
  after(() => { delete process.env.ADOPTOPS_MOCK_S4; });

  it('probes usage only for an unregistered destination', async () => {
    const verdict = await checkTargetSystemConnection({ destinationName: 'S4H_2023' });
    expect(verdict).to.include({ Ok: true, Stage: 'OK' });
    expect(verdict.Endpoints.map((e) => e.Endpoint)).to.deep.equal(['USAGE']);
  });

  it('adds the activation endpoint for a registered DEV system', async () => {
    const verdict = await checkTargetSystemConnection({
      destinationName: 'S4H_2023',
      targetSystem: { ID: 't1', destinationName: 'S4H_2023', environment: 'DEV', systemId: 'RD1', client: '100' }
    });
    expect(verdict).to.include({ Ok: true, Stage: 'OK' });
    expect(verdict.Endpoints.map((e) => [e.Endpoint, e.Stage])).to.deep.equal([['USAGE', 'OK'], ['ACTIVATE', 'OK']]);
    expect(verdict.Message).to.match(/write unit reachable/);
  });

  it('reports UNPUBLISHED as healthy for a PRD system and keeps the rollup OK', async () => {
    const verdict = await checkTargetSystemConnection({
      destinationName: 'S4H_PRD',
      targetSystem: { ID: 't2', destinationName: 'S4H_PRD', environment: 'PRD' }
    });
    expect(verdict).to.include({ Ok: true, Stage: 'OK' });
    expect(verdict.Endpoints[1]).to.include({ Endpoint: 'ACTIVATE', Ok: true, Stage: 'UNPUBLISHED' });
    expect(verdict.Message).to.match(/unpublished, as required/);
  });

  it('exposes the activation verdict on the capability read too', async () => {
    const caps = await getBackendCapabilities({ targetSystem: { destinationName: 'S4H_2023', environment: 'DEV' } });
    expect(caps.ActivationEndpoint).to.include({ Endpoint: 'ACTIVATE', Stage: 'OK' });
  });
});
