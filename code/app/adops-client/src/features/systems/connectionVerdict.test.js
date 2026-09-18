import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionSummary, endpointBadges, CONNECTION_STAGE } from './connectionVerdict.js';

const DEV_ENDPOINTS = [
  { Endpoint: 'USAGE', Ok: true, Stage: 'OK', Message: 'usage fine' },
  { Endpoint: 'ACTIVATE', Ok: true, Stage: 'OK', Message: 'write unit reachable' }
];

test('summary prefers the live verdict over the persisted row', () => {
  const system = { lastCheckStatus: 'SERVICE' };
  assert.deepEqual(connectionSummary(system, null), { status: 'SERVICE', label: 'Service failed', design: 'Negative' });
  assert.deepEqual(connectionSummary(system, { Ok: true, Stage: 'OK' }), { status: 'OK', label: 'Connected', design: 'Positive' });
  assert.deepEqual(connectionSummary(system, { Ok: false, Stage: 'ACTIVATION' }), { status: 'ACTIVATION', label: 'Activation check failed', design: 'Negative' });
});

test('summary is Untested without any verdict and tolerates unknown stages', () => {
  assert.equal(connectionSummary({}, null).label, 'Untested');
  assert.equal(connectionSummary({ lastCheckStatus: 'WEIRD' }, null).label, 'Service failed');
  assert.equal(CONNECTION_STAGE.ACTIVATION, 'ACTIVATION');
});

test('badges come from the live verdict, else from the persisted JSON', () => {
  const live = endpointBadges({}, { Ok: true, Endpoints: DEV_ENDPOINTS });
  assert.deepEqual(live.map((b) => b.label), ['Usage ok', 'Activation ok']);
  assert.deepEqual(live.map((b) => b.design), ['Positive', 'Positive']);

  const persisted = endpointBadges({ lastCheckEndpointsJson: JSON.stringify([
    { Endpoint: 'USAGE', Ok: true, Stage: 'OK' },
    { Endpoint: 'ACTIVATE', Ok: true, Stage: 'UNPUBLISHED', Message: 'as required' }
  ]) }, null);
  assert.deepEqual(persisted.map((b) => [b.label, b.design]), [['Usage ok', 'Positive'], ['Activation unpublished', 'Information']]);
  assert.equal(persisted[1].message, 'as required');
});

test('an exposed write unit on QA/PROD and a failed endpoint get distinct designs', () => {
  const badges = endpointBadges({}, { Endpoints: [
    { Endpoint: 'USAGE', Ok: false, Stage: 'SERVICE' },
    { Endpoint: 'ACTIVATE', Ok: false, Stage: 'EXPOSED' }
  ] });
  assert.deepEqual(badges.map((b) => [b.label, b.design]), [['Usage failed', 'Negative'], ['Activation exposed', 'Critical']]);
});

test('the optional catalog endpoint reads as a neutral badge when not published (S9)', () => {
  const badges = endpointBadges({}, { Endpoints: [
    { Endpoint: 'USAGE', Ok: true, Stage: 'OK' },
    { Endpoint: 'ACTIVATE', Ok: true, Stage: 'OK' },
    { Endpoint: 'CATALOG', Ok: true, Stage: 'MISSING', Message: 'not published' }
  ] });
  assert.deepEqual(badges.map((b) => [b.label, b.design]), [['Usage ok', 'Positive'], ['Activation ok', 'Positive'], ['Catalog not published', 'Neutral']]);
  assert.deepEqual(endpointBadges({}, { Endpoints: [{ Endpoint: 'CATALOG', Ok: true, Stage: 'OK' }] }).map((b) => b.label), ['Catalog ok']);
});

test('broken or missing persisted JSON yields no badges', () => {
  assert.deepEqual(endpointBadges({ lastCheckEndpointsJson: 'not json' }, null), []);
  assert.deepEqual(endpointBadges({}, null), []);
  assert.deepEqual(endpointBadges({ lastCheckEndpointsJson: '{"Endpoint":"USAGE"}' }, null), []);
});
