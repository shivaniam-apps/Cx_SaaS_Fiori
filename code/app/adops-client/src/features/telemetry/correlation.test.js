import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRELATION_HEADER,
  CORRELATION_ID_MAX_LENGTH,
  REPORT_LIMITS,
  normalizeCorrelationId,
  newCorrelationId,
  createCorrelationContext,
  featureFromRoute,
  buildRenderErrorReport
} from './correlation.js';

test('the header name and length match the server contract (srv/server.js)', () => {
  assert.equal(CORRELATION_HEADER, 'x-correlation-id');
  assert.equal(CORRELATION_ID_MAX_LENGTH, 64);
});

test('normalizeCorrelationId trims, bounds and never returns null', () => {
  assert.equal(normalizeCorrelationId('  abc  '), 'abc');
  assert.equal(normalizeCorrelationId('x'.repeat(100)).length, 64);
  assert.equal(normalizeCorrelationId(null), '');
  assert.equal(normalizeCorrelationId(undefined), '');
});

test('newCorrelationId uses the injected generator and falls back when it yields nothing', () => {
  assert.equal(newCorrelationId(() => 'fixed-id'), 'fixed-id');
  assert.ok(newCorrelationId(() => '').length > 0);
  assert.ok(newCorrelationId().length > 0);
  assert.ok(newCorrelationId().length <= 64);
});

test('a context mints one id per request and adopts the id the server echoes', () => {
  let n = 0;
  const context = createCorrelationContext({ random: () => `req-${++n}` });
  assert.equal(context.sessionId, 'req-1');
  assert.equal(context.nextRequestId(), 'req-2');
  assert.equal(context.lastCorrelationId, 'req-2');
  assert.equal(context.adoptResponseHeaders({ 'x-correlation-id': 'server-side' }), 'server-side');
  assert.equal(context.adoptResponseHeaders({}), 'server-side');
  assert.equal(context.adoptResponseHeaders(null), 'server-side');
  assert.equal(context.adoptResponseHeaders({ get: (name) => (name === 'x-correlation-id' ? 'from-getter' : '') }), 'from-getter');
  const fixed = createCorrelationContext({ sessionId: 'session-A' });
  assert.equal(fixed.sessionId, 'session-A');
});

test('featureFromRoute takes the first path segment and ignores hash and query', () => {
  assert.equal(featureFromRoute('#/activation/abc-123'), 'activation');
  assert.equal(featureFromRoute('/usage/view?x=1'), 'usage');
  assert.equal(featureFromRoute('/'), '');
  assert.equal(featureFromRoute(''), '');
  assert.equal(featureFromRoute(undefined), '');
});

test('buildRenderErrorReport produces the recordClientError payload, clamped, and never throws', () => {
  const error = new Error('Cannot read properties of undefined');
  error.stack = 'x'.repeat(5000);
  const report = buildRenderErrorReport({
    error,
    componentStack: '\n    at Page\n    at Route',
    route: '#/activation/abc?tab=steps',
    sessionId: 'sess',
    correlationId: '  corr  ',
    appVersion: '0.1.0',
    browserInfo: 'Mozilla/5.0 test'
  });
  assert.equal(report.errorType, 'RENDER_ERROR');
  assert.equal(report.severity, 'FATAL');
  assert.equal(report.errorMessage, 'Cannot read properties of undefined');
  assert.equal(report.stackTrace.length, REPORT_LIMITS.stackTrace);
  assert.equal(report.route, '/activation/abc?tab=steps');
  assert.equal(report.feature, 'activation');
  assert.equal(report.correlationId, 'corr');
  assert.equal(report.sessionId, 'sess');
  assert.equal(report.httpStatus, null);

  const bare = buildRenderErrorReport({ error: 'plain string' });
  assert.equal(bare.errorMessage, 'plain string');
  assert.equal(bare.route, '/');
  assert.equal(bare.feature, '');
  const empty = buildRenderErrorReport();
  assert.equal(empty.errorMessage, 'Unknown render error');
  assert.equal(empty.stackTrace, '');
});
