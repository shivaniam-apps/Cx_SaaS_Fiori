import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashRouteFor, normaliseBase } from './deepLink.js';

test('normaliseBase treats relative and empty bases as the root', () => {
  assert.equal(normaliseBase('./'), '/');
  assert.equal(normaliseBase(''), '/');
  assert.equal(normaliseBase(undefined), '/');
  assert.equal(normaliseBase('/'), '/');
  assert.equal(normaliseBase('/adops'), '/adops/');
  assert.equal(normaliseBase('/adops/'), '/adops/');
});

test('a path-form deep link becomes the hash route, query kept', () => {
  assert.equal(hashRouteFor({ pathname: '/audit-log', search: '', hash: '' }, './'), '/#/audit-log');
  assert.equal(hashRouteFor({ pathname: '/transports', search: '?status=OPEN', hash: '' }, '/'), '/#/transports?status=OPEN');
  assert.equal(hashRouteFor({ pathname: '/landscape/roles', search: '?run=1', hash: '' }, '/'), '/#/landscape/roles?run=1');
});

test('nothing changes for the app root or an existing hash route', () => {
  assert.equal(hashRouteFor({ pathname: '/', search: '', hash: '' }, './'), null);
  assert.equal(hashRouteFor({ pathname: '/index.html', search: '', hash: '' }, './'), null);
  assert.equal(hashRouteFor({ pathname: '/', search: '', hash: '#/audit-log' }, './'), null);
  assert.equal(hashRouteFor({ pathname: '/audit-log', search: '', hash: '#/dashboard' }, './'), null, 'a hash route wins over the path');
  assert.equal(hashRouteFor({ pathname: '', search: '', hash: '' }, './'), null);
  assert.equal(hashRouteFor(null, './'), null);
});

test('a mounted base path is stripped and kept in the result', () => {
  assert.equal(hashRouteFor({ pathname: '/adops/audit-log', search: '', hash: '' }, '/adops/'), '/adops/#/audit-log');
  assert.equal(hashRouteFor({ pathname: '/adops/', search: '', hash: '' }, '/adops/'), null);
  assert.equal(hashRouteFor({ pathname: '/adops/index.html', search: '?x=1', hash: '' }, '/adops'), null);
  // A path outside the base is still translated relative to the base.
  assert.equal(hashRouteFor({ pathname: '/audit-log', search: '', hash: '' }, '/adops/'), '/adops/#/audit-log');
});
