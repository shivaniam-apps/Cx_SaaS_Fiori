import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  LOCAL_CLIENT_PORTS,
  localClientOrigins,
  corsOriginsFrom,
  devOnlySettings,
  isCloudFoundry,
  isProductionProfile,
  assessStartupConfig,
  noDestinationMessage
} = require('../srv/srv/utils/config-hardening.js');
const { DEFAULT_DESTINATION, callS4Destination } = require('../srv/srv/utils/s4-http-client.js');
const { checkTargetSystemConnection, fetchPagedEntity } = require('../srv/srv/utils/s4-fiori-adapter.js');

// ---------------------------------------------------------------------------
// S11: configuration hardening - no hardcoded destination, local CORS default
// on the worktree port slots, dev-only variables warned about / refused in CF.
// ---------------------------------------------------------------------------

const CF_ENV = { VCAP_APPLICATION: '{"application_name":"adoptops-srv"}' };

describe('config hardening: CORS default (pure)', () => {
  it('defaults to the five local client port slots on localhost and 127.0.0.1', () => {
    expect(LOCAL_CLIENT_PORTS).to.deep.equal([5273, 5283, 5293, 5303, 5313]);
    const origins = localClientOrigins();
    expect(origins).to.have.length(10);
    expect(origins).to.include.members(['http://localhost:5273', 'http://127.0.0.1:5293', 'http://localhost:5313']);
    expect(origins.join(',')).to.not.match(/5173/);
    expect(corsOriginsFrom(undefined)).to.deep.equal(origins);
    expect(corsOriginsFrom('  ,, ')).to.deep.equal(origins);
  });

  it('takes CORS_ORIGINS verbatim when set, trimmed and without empties', () => {
    expect(corsOriginsFrom(' https://adoptops.example.com , http://localhost:5273,')).to.deep.equal(['https://adoptops.example.com', 'http://localhost:5273']);
    expect(corsOriginsFrom('*')).to.deep.equal(['*']);
  });
});

describe('config hardening: dev-only variables (pure)', () => {
  it('finds the direct-access variables under any of the three prefixes', () => {
    const found = devOnlySettings({ ADOPTOPS_S4_URL_OVERRIDES: 'X=http://x', ADOPS_S4_DIRECT_USER: 'u', S4_DIRECT_PASSWORD: 'p', S4_DIRECT_INSECURE_TLS: 'on', OTHER: '1' });
    expect(found.map((f) => f.key)).to.deep.equal(['ADOPTOPS_S4_URL_OVERRIDES', 'ADOPS_S4_DIRECT_USER', 'S4_DIRECT_PASSWORD', 'S4_DIRECT_INSECURE_TLS']);
    expect(devOnlySettings({ ADOPTOPS_S4_URL_OVERRIDES: '' })).to.deep.equal([]);
    expect(devOnlySettings({})).to.deep.equal([]);
  });

  it('detects Cloud Foundry and the production profile', () => {
    expect(isCloudFoundry(CF_ENV)).to.equal(true);
    expect(isCloudFoundry({})).to.equal(false);
    expect(isProductionProfile({ NODE_ENV: 'production' }, [])).to.equal(true);
    expect(isProductionProfile({}, ['production'])).to.equal(true);
    expect(isProductionProfile({ NODE_ENV: 'development' }, ['development'])).to.equal(false);
  });

  it('warns locally, refuses in Cloud Foundry', () => {
    const local = assessStartupConfig({ env: { ADOPTOPS_S4_URL_OVERRIDES: 'X=http://x', ADOPTOPS_S4_DIRECT_USER: 'u', CORS_ORIGINS: 'http://localhost:5273' }, profiles: ['development'] });
    expect(local.refused).to.equal(false);
    expect(local.findings.map((f) => f.level)).to.deep.equal(['warn', 'warn']);
    expect(local.findings[0].message).to.match(/never set it in a deployed instance/);

    const hybrid = assessStartupConfig({ env: { NODE_ENV: 'production', ADOPTOPS_S4_URL_OVERRIDES: 'X=http://x', CORS_ORIGINS: 'x' }, profiles: ['hybrid'] });
    expect(hybrid.refused, 'the local hybrid scripts run with NODE_ENV=production on purpose').to.equal(false);
    expect(hybrid.findings[0].message).to.match(/under the production profile/);

    const cf = assessStartupConfig({ env: { ...CF_ENV, ADOPTOPS_S4_DIRECT_INSECURE_TLS: 'on', CORS_ORIGINS: 'https://app' }, profiles: ['production'] });
    expect(cf.refused).to.equal(true);
    expect(cf.findings[0]).to.include({ level: 'refuse', variable: 'ADOPTOPS_S4_DIRECT_INSECURE_TLS' });
    expect(cf.findings[0].message).to.match(/refused in CF/);
  });

  it('mock S/4 is the normal local mode: refused in CF only, never nagged about locally', () => {
    const local = assessStartupConfig({ env: { ADOPTOPS_MOCK_S4: 'true', CORS_ORIGINS: 'x' }, profiles: ['development'] });
    expect(local.findings).to.deep.equal([]);
    const cf = assessStartupConfig({ env: { ...CF_ENV, ADOPTOPS_MOCK_S4: 'true', CORS_ORIGINS: 'x' }, profiles: [] });
    expect(cf.refused).to.equal(true);
  });

  it('warns about an unset CORS_ORIGINS only where the local default is wrong', () => {
    expect(assessStartupConfig({ env: {}, profiles: ['development'] }).findings).to.deep.equal([]);
    const cf = assessStartupConfig({ env: CF_ENV, profiles: [] });
    expect(cf.refused).to.equal(false);
    expect(cf.findings.map((f) => f.variable)).to.deep.equal(['CORS_ORIGINS']);
    const production = assessStartupConfig({ env: { NODE_ENV: 'production' }, profiles: [] });
    expect(production.findings.map((f) => f.variable)).to.deep.equal(['CORS_ORIGINS']);
  });
});

describe('config hardening: no default destination', () => {
  it('has no hardcoded destination name - only what the operator sets', () => {
    const fromEnv = process.env.ADOPTOPS_S4_DESTINATION || process.env.ADOPS_S4_DESTINATION || process.env.S4_DESTINATION || '';
    expect(DEFAULT_DESTINATION).to.equal(fromEnv);
    expect(DEFAULT_DESTINATION).to.not.equal('S4H_2023');
  });

  it('names the system in the message when it has one', () => {
    expect(noDestinationMessage({ displayName: 'RD1 Development' })).to.match(/"RD1 Development" has no BTP destination/);
    expect(noDestinationMessage(null)).to.match(/ADOPTOPS_S4_DESTINATION is unset/);
    expect(noDestinationMessage({})).to.match(/no default destination/);
  });

  it('callS4Destination refuses an empty destination before any lookup, even in mock mode', async () => {
    let error;
    try {
      await callS4Destination({ destinationName: '', path: '/sap/opu/odata4/x' });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.an('error');
    expect(error).to.include({ status: 400, code: 'NO_DESTINATION' });
    expect(error.message).to.match(/no default destination/);
  });

  it('adapter reads fail with the system name; the connection check answers a DESTINATION verdict', async function () {
    if (DEFAULT_DESTINATION) this.skip(); // an operator default is set in this shell

    let error;
    try {
      await fetchPagedEntity({ targetSystem: { ID: 't', displayName: 'Lab without destination' }, entitySet: 'UsagePeriods' });
    } catch (e) {
      error = e;
    }
    expect(error).to.include({ status: 400, code: 'NO_DESTINATION' });
    expect(error.message).to.match(/"Lab without destination" has no BTP destination/);

    const verdict = await checkTargetSystemConnection({ destinationName: '', targetSystem: { displayName: 'Lab without destination' } });
    expect(verdict).to.include({ Ok: false, Stage: 'DESTINATION', HttpStatus: 0 });
    expect(verdict.Message).to.match(/has no BTP destination/);
    expect(verdict.Endpoints).to.deep.equal([]);
  });
});
