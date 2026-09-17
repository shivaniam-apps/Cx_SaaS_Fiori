// Safety defaults of the S/4 transport layer (roadmap A7).
//
// Direct (URL-override) HTTPS calls verify certificates unless the operator
// opts out explicitly; the opt-out is a lab-only switch and never the
// default. The helper is pure apart from reading the environment, so the
// checks run without any network.
import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { directTlsOptions, directAgentFor } = require('../srv/srv/utils/s4-http-client.js');

const FLAG_NAMES = ['S4_DIRECT_INSECURE_TLS', 'ADOPTOPS_S4_DIRECT_INSECURE_TLS', 'ADOPS_S4_DIRECT_INSECURE_TLS'];

function withEnv(values, fn) {
  const saved = Object.fromEntries(FLAG_NAMES.map((name) => [name, process.env[name]]));
  for (const name of FLAG_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const name of FLAG_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

describe('direct S/4 TLS verification (A7 safety default)', () => {
  it('verifies certificates by default: no rejectUnauthorized override', () => {
    withEnv({}, () => {
      expect(directTlsOptions('https://s4.example.com:44300')).to.deep.equal({});
    });
  });

  it('treats anything but an explicit on/true/yes/1 as verification on', () => {
    for (const value of ['off', 'false', 'no', '0', '', 'ON_LATER']) {
      withEnv({ S4_DIRECT_INSECURE_TLS: value }, () => {
        expect(directTlsOptions('https://s4.example.com'), `value "${value}"`).to.deep.equal({});
      });
    }
  });

  it('disables verification only on an explicit opt-in, with the product prefix honoured', () => {
    withEnv({ S4_DIRECT_INSECURE_TLS: 'on' }, () => {
      expect(directTlsOptions('https://s4.example.com')).to.deep.equal({ rejectUnauthorized: false });
    });
    withEnv({ ADOPTOPS_S4_DIRECT_INSECURE_TLS: 'true' }, () => {
      expect(directTlsOptions('https://s4.example.com')).to.deep.equal({ rejectUnauthorized: false });
    });
  });

  it('never touches plain http, even when the opt-in is set', () => {
    withEnv({ S4_DIRECT_INSECURE_TLS: 'on' }, () => {
      expect(directTlsOptions('http://vhcala4hci:50000')).to.deep.equal({});
    });
  });

  it('builds a verifying https agent by default and an insecure one only on opt-in', () => {
    withEnv({}, () => {
      const agent = directAgentFor('https://a7-default.example.com');
      expect(agent.options.rejectUnauthorized).to.equal(undefined);
      expect(agent.options.keepAlive).to.equal(true);
    });
    withEnv({ S4_DIRECT_INSECURE_TLS: 'on' }, () => {
      const agent = directAgentFor('https://a7-optin.example.com');
      expect(agent.options.rejectUnauthorized).to.equal(false);
    });
  });
});
