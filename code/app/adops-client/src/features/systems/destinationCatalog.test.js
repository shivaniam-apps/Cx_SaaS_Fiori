import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDestinationCatalog,
  draftFromDestination,
  normalizeDestination,
  DESTINATION_STATUS
} from './destinationCatalog.js';

test('classifies destinations against registered systems and sorts by name', () => {
  const destinations = [
    { Name: 'B', Type: 'HTTP', ProxyType: 'OnPremise', URL: 'http://b' },
    { Name: 'A', Type: 'HTTP', ProxyType: 'Internet', URL: 'http://a' },
    { Name: 'C', Type: 'HTTP' }
  ];
  const systems = [
    { destinationName: 'A', active: true },
    { destinationName: 'C', active: false }
  ];
  const catalog = buildDestinationCatalog(destinations, systems);
  assert.deepEqual(catalog.map((d) => d.name), ['A', 'B', 'C']);
  assert.equal(catalog.find((d) => d.name === 'A').status, DESTINATION_STATUS.EXPOSED);
  assert.equal(catalog.find((d) => d.name === 'B').status, DESTINATION_STATUS.AVAILABLE);
  assert.equal(catalog.find((d) => d.name === 'C').status, DESTINATION_STATUS.MAPPED);
  assert.equal(catalog.find((d) => d.name === 'A').system.active, true);
});

test('normalizes raw BTP fields and skips nameless records', () => {
  assert.equal(normalizeDestination({}), null);
  const catalog = buildDestinationCatalog(
    [
      { Name: 'S4', Description: 'S/4', Type: 'HTTP', ProxyType: 'OnPremise', URL: 'http://s4', Authentication: 'BasicAuthentication', 'sap-client': '400' },
      {}
    ],
    []
  );
  assert.equal(catalog.length, 1);
  assert.deepEqual({ ...catalog[0] }, {
    name: 'S4',
    description: 'S/4',
    type: 'HTTP',
    proxyType: 'OnPremise',
    authentication: 'BasicAuthentication',
    url: 'http://s4',
    client: '400',
    status: 'Available',
    system: null
  });
});

test('draftFromDestination prefills routing identity, display name and client only', () => {
  const empty = { displayName: '', destinationName: '', systemId: '', client: '', environment: 'DEV', s4Release: '' };
  const draft = draftFromDestination(
    normalizeDestination({ Name: 'BAS-RD1-400', Description: 'RD1', 'sap-client': '400' }),
    empty
  );
  assert.equal(draft.destinationName, 'BAS-RD1-400');
  assert.equal(draft.displayName, 'RD1');
  assert.equal(draft.client, '400');
  assert.equal(draft.environment, 'DEV');
  assert.equal(draft.systemId, '');
});
