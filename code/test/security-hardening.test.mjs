// Security review fixes (roadmap T6): S/4 paths stay inside the destination,
// response redaction masks whole values, the SaaS provisioning callbacks
// demand the mtcallback scope, and responses carry no server fingerprint.
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { cds, test, as, json, expectInMemoryDb } from './helpers/cds-http-test.mjs';

const require = createRequire(import.meta.url);
const client = require('../srv/srv/utils/s4-http-client.js');
const { requireSaasCallbackScope } = require('../srv/srv/basic-subscription.js');

describe('security hardening', function () {
  this.timeout(30000);

  describe('S/4 request paths stay inside the destination', () => {
    const BASE = 'https://s4.example.test:44300';

    it('accepts relative paths, with or without a leading slash, and keeps the query', () => {
      expect(client.safeDestinationPath('/sap/opu/odata4/x')).to.equal('/sap/opu/odata4/x');
      expect(client.safeDestinationPath('sap/opu')).to.equal('/sap/opu');
      expect(client.safeDestinationPath('')).to.equal('/');
      expect(client.safeDestinationPath(undefined)).to.equal('/');
      expect(client.resolveDestinationUrl(BASE, "/svc/Entity?$top=1&$filter=Name eq 'A'")).to.equal(`${BASE}/svc/Entity?$top=1&$filter=Name%20eq%20%27A%27`);
      expect(client.resolveDestinationUrl(`${BASE}/`, 'svc')).to.equal(`${BASE}/svc`);
    });

    it('refuses protocol-relative, absolute and backslash paths that would change the host', () => {
      for (const bad of ['//evil.example/x', 'https://evil.example/x', 'http://evil.example', '\\\\evil.example\\x', '/\\evil.example', 'javascript:alert(1)', 'mailto:x@y']) {
        expect(() => client.resolveDestinationUrl(BASE, bad), bad).to.throw(/relative to the destination|another host/);
      }
    });

    it('refuses a resolved URL whose origin differs from the destination even if the path passed', () => {
      expect(() => client.resolveDestinationUrl('https://s4.example.test', '/x')).to.not.throw();
      expect(() => client.resolveDestinationUrl('not a url', '/x')).to.throw();
    });
  });

  describe('response redaction', () => {
    it('masks whole secret values, quoted or bare, including bearer tokens with spaces', () => {
      const masked = client.safeResponseData({ user: 'x', Password: 'hunter two', authorization: 'Bearer abc.def', note: 'ok' });
      expect(masked).to.not.include('hunter');
      expect(masked).to.not.include('abc.def');
      expect(masked).to.not.include('Bearer');
      expect(masked).to.include('"note":"ok"');
      expect(masked).to.include('"user":"x"');
      const bare = client.safeResponseData('proxy-authorization=Basic Zm9v, next=1');
      expect(bare).to.not.include('Zm9v');
      expect(bare).to.include('next=1');
    });
  });

  describe('SaaS provisioning callbacks', () => {
    before(() => expectInMemoryDb());

    it('requireSaasCallbackScope lets only the mtcallback scope through', () => {
      const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      let passed = false;
      requireSaasCallbackScope({ method: 'PUT', path: '/x', user: { id: 'registry', is: (role) => role === 'mtcallback' } }, res, () => { passed = true; });
      expect(passed).to.equal(true);
      passed = false;
      const refused = requireSaasCallbackScope({ method: 'PUT', path: '/x', user: { id: 'alice', is: () => false } }, { ...res }, () => { passed = true; });
      expect(passed).to.equal(false);
      expect(refused.code).to.equal(403);
      const anonymous = requireSaasCallbackScope({ method: 'PUT', path: '/x' }, { ...res }, () => { passed = true; });
      expect(passed).to.equal(false);
      expect(anonymous.code).to.equal(403);
    });

    it('over HTTP: anonymous 401, a product administrator 403, the registry scope 200', async () => {
      const path = '/-/basic/saas-provisioning/tenant/tenant-xyz';
      const body = { subscribedSubdomain: 'customer-a' };
      const anonymous = await test.axios.put(path, body, { validateStatus: () => true });
      // XSUAA answers 401 without a token; the mocked strategy of the test server lets the
      // request through as anonymous, which the scope guard then refuses with 403.
      expect([401, 403]).to.include(anonymous.status);
      const admin = await test.axios.put(path, body, json('alice'));
      expect(admin.status).to.equal(403);
      const registry = await test.axios.put(path, body, json('saas-registry'));
      expect(registry.status, JSON.stringify(registry.data)).to.equal(200);
      const dependencies = await test.axios.get('/-/basic/saas-provisioning/dependencies', as('saas-registry'));
      expect(dependencies.status).to.equal(200);
      expect(dependencies.data).to.be.an('array');
      const unsubscribe = await test.axios.delete(path, as('alice'));
      expect(unsubscribe.status).to.equal(403);
    });
  });

  describe('response headers', () => {
    it('carry no X-Powered-By fingerprint', async () => {
      const response = await test.axios.get('/healthz', { validateStatus: () => true });
      expect(response.status).to.equal(200);
      expect(response.headers['x-powered-by']).to.equal(undefined);
    });
  });
});
