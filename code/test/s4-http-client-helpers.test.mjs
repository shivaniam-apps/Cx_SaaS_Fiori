// Pure helpers of the S/4 transport layer (roadmap A12): OData path and
// query shaping, payload unwrapping, destination routing identity, header
// derivation, secret redaction, CSRF detection and the per-destination
// concurrency gate. The TLS default is s4-http-client.test.mjs; the mocked
// end-to-end call is exercised by api-journey.test.mjs.
import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const client = require('../srv/srv/utils/s4-http-client.js');

describe('s4-http-client helpers', () => {
  describe('OData path shaping', () => {
    it('appendQuery encodes values, keeps $-options unencoded and skips empty values', () => {
      expect(client.appendQuery('/svc/Entity', { '$top': 5, '$filter': "Name eq 'A B'", empty: '', none: null, undef: undefined }))
        .to.equal("/svc/Entity?$top=5&$filter=Name%20eq%20'A%20B'");
      expect(client.appendQuery('/svc/Entity?$count=true', { 'sap-client': '100' })).to.equal('/svc/Entity?$count=true&sap-client=100');
      expect(client.appendQuery('/svc/Entity', {})).to.equal('/svc/Entity');
      expect(client.appendQuery('/svc/Entity', { 'a b': 'c&d' })).to.equal('/svc/Entity?a%20b=c%26d');
    });

    it('addODataTop adds a bound once and never doubles an existing $top', () => {
      expect(client.addODataTop('/svc/Entity')).to.equal('/svc/Entity?$top=50');
      expect(client.addODataTop('/svc/Entity', 7)).to.equal('/svc/Entity?$top=7');
      expect(client.addODataTop('/svc/Entity?$top=3', 50)).to.equal('/svc/Entity?$top=3');
      expect(client.addODataTop('/svc/Entity?%24top=3', 50)).to.equal('/svc/Entity?%24top=3');
      expect(client.addODataTop('/svc/Entity?$skip=10', 20)).to.equal('/svc/Entity?$skip=10&$top=20');
    });

    it('setODataQueryOption replaces the option whatever its spelling and keeps the rest', () => {
      const changed = client.setODataQueryOption('/svc/Entity?$top=3&$skip=10#frag', 'top', 99);
      expect(changed.startsWith('/svc/Entity?')).to.equal(true);
      expect(changed.endsWith('#frag')).to.equal(true);
      const params = new URLSearchParams(changed.slice(changed.indexOf('?') + 1, changed.indexOf('#')));
      expect(params.get('$top')).to.equal('99');
      expect(params.get('$skip')).to.equal('10');
      expect([...params.keys()].filter((k) => /top/i.test(k))).to.deep.equal(['$top']);

      const fresh = client.setODataQueryOption('/svc/Entity', '$count', true);
      expect(fresh).to.equal('/svc/Entity?$count=true');
      expect(client.setODataQueryOption('', 'top', 1)).to.equal('');
    });

    it('escapeODataString doubles single quotes and tolerates empty input', () => {
      expect(client.escapeODataString("O'Brien")).to.equal("O''Brien");
      expect(client.escapeODataString('')).to.equal('');
      expect(client.escapeODataString(null)).to.equal('');
      expect(client.escapeODataString(42)).to.equal('42');
    });

    it('serviceRootFromPath strips the query and the last segment', () => {
      expect(client.serviceRootFromPath('/sap/opu/odata4/sap/zado_usage_o4/srvd/sap/zado_usage_srv/0001/TransactionUsage?$top=1'))
        .to.equal('/sap/opu/odata4/sap/zado_usage_o4/srvd/sap/zado_usage_srv/0001/');
      expect(client.serviceRootFromPath('/svc/0001/$metadata')).to.equal('/svc/0001/');
      expect(client.serviceRootFromPath('/svc/0001/')).to.equal('/svc/');
      expect(client.serviceRootFromPath('Entity')).to.equal('/');
      expect(client.serviceRootFromPath('')).to.equal('/');
    });
  });

  describe('payload handling', () => {
    it('unwrapODataPayload accepts V4, V2 and bare shapes', () => {
      expect(client.unwrapODataPayload({ value: [1, 2] })).to.deep.equal([1, 2]);
      expect(client.unwrapODataPayload({ d: { results: [{ a: 1 }] } })).to.deep.equal([{ a: 1 }]);
      expect(client.unwrapODataPayload([3])).to.deep.equal([3]);
      expect(client.unwrapODataPayload({ single: true })).to.deep.equal([{ single: true }]);
      expect(client.unwrapODataPayload(null)).to.deep.equal([]);
      expect(client.unwrapODataPayload(undefined)).to.deep.equal([]);
    });

    it('safeResponseData masks secret-shaped fields and bounds the text', () => {
      const masked = client.safeResponseData({ user: 'x', Password: 'hunter2', authorization: 'Bearer abc', note: 'ok' });
      expect(masked).to.include('"Password":***');
      // The whole value is masked, quoted or bare (idea I35 closed by T6).
      expect(masked).to.include('"authorization":***');
      expect(masked).to.not.include('hunter2');
      expect(masked).to.not.include('Bearer');
      expect(masked).to.not.include('abc');
      expect(masked).to.include('"note":"ok"');
      expect(client.safeResponseData('x'.repeat(5000))).to.have.length(2000);
      expect(client.safeResponseData('')).to.equal('');
      expect(client.safeResponseData(null)).to.equal(null);
    });

    it('uniqueList drops empties and duplicates while keeping the first order', () => {
      expect(client.uniqueList(['a', '', 'b', 'a', null, 'c', 'b'])).to.deep.equal(['a', 'b', 'c']);
      expect(client.uniqueList([])).to.deep.equal([]);
    });

    it('responseHeader reads plain objects and Headers-like objects case-insensitively', () => {
      expect(client.responseHeader({ 'x-csrf-token': 'abc' }, 'X-CSRF-Token')).to.equal('abc');
      expect(client.responseHeader({ 'X-Custom': '1' }, 'X-Custom')).to.equal('1');
      expect(client.responseHeader(new Map([['x-csrf-token', 'fromMap']]), 'x-csrf-token')).to.equal('fromMap');
      expect(client.responseHeader(null, 'x')).to.equal('');
      expect(client.responseHeader({ a: '1' }, '')).to.equal('');
    });

    it('isCsrfRejectedResponse recognises the SAP 403 token challenge only', () => {
      expect(client.isCsrfRejectedResponse({ status: 403, headers: { 'x-csrf-token': 'Required' }, data: '' })).to.equal(true);
      expect(client.isCsrfRejectedResponse({ status: 403, headers: {}, data: { error: { message: 'CSRF token validation failed' } } })).to.equal(true);
      expect(client.isCsrfRejectedResponse({ status: 403, headers: {}, data: 'Not authorized' })).to.equal(false);
      expect(client.isCsrfRejectedResponse({ status: 200, headers: { 'x-csrf-token': 'Required' } })).to.equal(false);
      expect(client.isCsrfRejectedResponse(undefined)).to.equal(false);
    });
  });

  describe('destination identity and headers', () => {
    const onPrem = { Name: 'RD1_DEV_100', URL: 'http://rd1dev:44300', ProxyType: 'OnPremise', CloudConnectorLocationId: 'SCC_HQ', Authentication: 'BasicAuthentication', User: 'ADOPS_RFC', Password: 'p4ss' };

    it('readDestinationConfigurationProperty falls back across spellings and skips empty values', () => {
      expect(client.readDestinationConfigurationProperty(onPrem, 'URL')).to.equal('http://rd1dev:44300');
      expect(client.readDestinationConfigurationProperty({ url: 'x' }, 'URL', 'url')).to.equal('x');
      expect(client.readDestinationConfigurationProperty({ proxytype: 'Internet' }, 'ProxyType')).to.equal('Internet');
      expect(client.readDestinationConfigurationProperty({ LocationId: '' , locationId: 'L2' }, 'LocationId', 'locationId')).to.equal('L2');
      expect(client.readDestinationConfigurationProperty(null, 'URL')).to.equal('');
      expect(client.readDestinationConfigurationProperty({}, 'URL')).to.equal('');
    });

    it('cloudConnectorLocationId is read from the destination, never inferred', () => {
      expect(client.cloudConnectorLocationId(onPrem)).to.equal('SCC_HQ');
      expect(client.cloudConnectorLocationId({ locationId: ' L1 ' })).to.equal('L1');
      expect(client.cloudConnectorLocationId({ Name: 'SCC_HQ_SYSTEM', URL: 'http://x' })).to.equal('');
      expect(client.cloudConnectorLocationId(undefined)).to.equal('');
    });

    it('destinationRoutingIdentity normalises url, proxy type and location id', () => {
      expect(client.destinationRoutingIdentity(onPrem)).to.deep.equal({ url: 'http://rd1dev:44300', proxyType: 'onpremise', locationId: 'SCC_HQ' });
      expect(client.destinationRoutingIdentity({})).to.deep.equal({ url: '', proxyType: '', locationId: '' });
      expect(client.destinationRoutingIdentity()).to.deep.equal({ url: '', proxyType: '', locationId: '' });
    });

    it('basicHeaders builds the Basic header only for complete BasicAuthentication destinations', () => {
      const headers = client.basicHeaders(onPrem);
      expect(headers.Authorization).to.equal(`Basic ${Buffer.from('ADOPS_RFC:p4ss').toString('base64')}`);
      expect(client.basicHeaders({ ...onPrem, Password: '' })).to.deep.equal({});
      expect(client.basicHeaders({ ...onPrem, Authentication: 'NoAuthentication' })).to.deep.equal({});
    });

    it('authorizationHeaders forwards a resolved auth token under its declared header', () => {
      expect(client.authorizationHeaders({ authTokens: [{ type: 'Bearer', value: 'tok' }] })).to.deep.equal({ Authorization: 'Bearer tok' });
      expect(client.authorizationHeaders({ authTokens: [{ type: 'Basic', value: 'b64', http_header: { key: 'Authorization', value: 'Basic b64' } }] }))
        .to.deep.equal({ Authorization: 'Basic b64' });
      expect(client.authorizationHeaders({ authTokens: [{ type: 'Bearer', value: '' }] })).to.deep.equal({});
      expect(client.authorizationHeaders({})).to.deep.equal({});
    });

    it('redactDestination masks every secret-shaped key and leaves the rest', () => {
      const redacted = client.redactDestination({ ...onPrem, clientSecret: 's', passwd: 'q' });
      expect(redacted.Password).to.equal('***');
      expect(redacted.clientSecret).to.equal('***');
      expect(redacted.passwd).to.equal('***');
      expect(redacted.User).to.equal('ADOPS_RFC');
      expect(redacted.URL).to.equal(onPrem.URL);
      expect(onPrem.Password, 'input untouched').to.equal('p4ss');
    });
  });

  describe('request shaping', () => {
    it('preferRememberedShape moves the remembered candidate first and rememberShape stores its index', () => {
      const candidates = ['a', 'b', 'c'];
      expect(client.preferRememberedShape('unit-shape-1', candidates)).to.deep.equal(candidates);
      client.rememberShape('unit-shape-1', candidates, 'c');
      expect(client.preferRememberedShape('unit-shape-1', candidates)).to.deep.equal(['c', 'a', 'b']);
      client.rememberShape('unit-shape-1', candidates, 'zzz');
      expect(client.preferRememberedShape('unit-shape-1', candidates), 'unknown candidate changes nothing').to.deep.equal(['c', 'a', 'b']);
      client.rememberShape('unit-shape-2', candidates, 'a');
      expect(client.preferRememberedShape('unit-shape-2', candidates), 'index 0 is already first').to.deep.equal(candidates);
    });

    it('limitRequestConcurrency never runs more than the limit per key and drains its queue', async () => {
      let active = 0;
      let peak = 0;
      const operation = (result) => async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return result;
      };
      const results = await Promise.all([1, 2, 3, 4, 5].map((n) => client.limitRequestConcurrency('unit-gate', 2, operation(n))));
      expect(results).to.deep.equal([1, 2, 3, 4, 5]);
      expect(peak).to.equal(2);

      const failing = client.limitRequestConcurrency('unit-gate', 2, async () => { throw new Error('boom'); });
      await failing.then(() => { throw new Error('should reject'); }, (error) => expect(error.message).to.equal('boom'));
      expect(await client.limitRequestConcurrency('unit-gate', 2, async () => 'after failure')).to.equal('after failure');
    });

    it('connectivityProxyTroubleshootingHint speaks only for proxy hosts it recognises', () => {
      const local = client.connectivityProxyTroubleshootingHint({ proxyHost: 'localhost', proxyPort: 20003, destinationName: 'RD1', code: 'ECONNREFUSED' });
      expect(local).to.include('RD1');
      expect(local).to.include('localhost:20003');
      const internal = client.connectivityProxyTroubleshootingHint({ proxyHost: 'connectivityproxy.internal.cf.eu10.hana.ondemand.com', proxyPort: 20003, destinationName: 'RD1', code: 'ETIMEDOUT' });
      expect(internal).to.include('internal Cloud Foundry Connectivity proxy');
      expect(client.connectivityProxyTroubleshootingHint({ proxyHost: 'connectivityproxy.internal.cf.eu10.hana.ondemand.com', proxyPort: 20003, destinationName: 'RD1', code: 'E401' })).to.equal('');
      expect(client.connectivityProxyTroubleshootingHint({ proxyHost: 'example.org', proxyPort: 80, destinationName: 'RD1', code: 'ETIMEDOUT' })).to.equal('');
    });

    it('effectiveConnectivityProxyDetails reports an unbound service in the test process', () => {
      const details = client.effectiveConnectivityProxyDetails();
      expect(details.bound).to.equal(false);
      expect(details.host).to.equal('');
      expect(details.port).to.equal(null);
    });
  });
});
