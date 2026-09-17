import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_TYPES,
  buildClientErrorReport,
  createReportGate,
  shouldCaptureApiFailure,
  describeRejection
} from './errorReporting.js';
import { buildRenderErrorReport } from './correlation.js';

test('buildClientErrorReport clamps, defaults and derives the feature from the route', () => {
  const error = new Error('boom');
  error.stack = 's'.repeat(5000);
  const report = buildClientErrorReport({
    errorType: 'API_FAILURE', severity: 'WARNING', error, route: '#/activation/abc?x=1',
    endpointPath: '/fiori/queryActivationPlans()', httpMethod: 'get', httpStatus: 502,
    sessionId: 'sess', correlationId: ' corr ', appVersion: '0.1.0', browserInfo: 'UA'
  });
  assert.equal(report.errorType, 'API_FAILURE');
  assert.equal(report.severity, 'WARNING');
  assert.equal(report.errorMessage, 'boom');
  assert.equal(report.stackTrace.length, 4000);
  assert.equal(report.route, '/activation/abc?x=1');
  assert.equal(report.feature, 'activation');
  assert.equal(report.httpMethod, 'GET');
  assert.equal(report.httpStatus, 502);
  assert.equal(report.correlationId, 'corr');
  assert.equal(report.componentStack, '');

  const bare = buildClientErrorReport({ errorType: 'NOT_A_TYPE', severity: 'LOUD', message: 'text only', httpStatus: '500' });
  assert.equal(bare.errorType, 'WINDOW_ERROR');
  assert.equal(bare.severity, 'ERROR');
  assert.equal(bare.errorMessage, 'text only');
  assert.equal(bare.httpStatus, null);
  assert.equal(bare.endpointPath, null);
  assert.equal(bare.httpMethod, null);
  assert.equal(buildClientErrorReport().errorMessage, 'Unknown client error');
  assert.ok(ERROR_TYPES.includes('UNHANDLED_REJECTION'));
});

test('buildRenderErrorReport stays the RENDER_ERROR / FATAL specialisation', () => {
  const report = buildRenderErrorReport({ error: new Error('render'), componentStack: 'at Page', route: '#/settings', sessionId: 's', correlationId: 'c' });
  assert.equal(report.errorType, 'RENDER_ERROR');
  assert.equal(report.severity, 'FATAL');
  assert.equal(report.componentStack, 'at Page');
  assert.equal(report.feature, 'settings');
  assert.equal(buildRenderErrorReport().errorMessage, 'Unknown render error');
  assert.equal(buildRenderErrorReport({ error: 'plain' }).route, '/');
});

test('the report gate dedupes identical errors per window and caps a session', () => {
  const gate = createReportGate({ maxReportsPerSession: 3, dedupeWindowMs: 1000 });
  const a = { errorType: 'WINDOW_ERROR', errorMessage: 'x is undefined' };
  assert.equal(gate.shouldReport(a, 0), true);
  assert.equal(gate.shouldReport(a, 500), false);
  assert.equal(gate.shouldReport(a, 1500), true);
  assert.equal(gate.shouldReport({ errorType: 'API_FAILURE', errorMessage: 'x', endpointPath: '/a', httpStatus: 500 }, 1500), true);
  assert.equal(gate.reportedCount(), 3);
  assert.equal(gate.shouldReport({ errorType: 'API_FAILURE', errorMessage: 'y' }, 9000), false);
});

test('API-failure policy captures network errors and 5xx, never 4xx or the telemetry endpoints', () => {
  assert.equal(shouldCaptureApiFailure({ status: undefined, url: '/fiori/queryActivationPlans()' }), true);
  assert.equal(shouldCaptureApiFailure({ status: 503, url: '/fiori/x' }), true);
  assert.equal(shouldCaptureApiFailure({ status: 404, url: '/fiori/x' }), false);
  assert.equal(shouldCaptureApiFailure({ status: 400, url: '/fiori/x' }), false);
  assert.equal(shouldCaptureApiFailure({ status: 500, url: '/core/recordClientError' }), false);
  assert.equal(shouldCaptureApiFailure({ status: undefined, url: '/core/recordTelemetryBatch' }), false);
  assert.equal(shouldCaptureApiFailure(), true);
});

test('describeRejection keeps Errors and stringifies the rest', () => {
  const err = new Error('rejected');
  assert.deepEqual(describeRejection(err), { error: err, message: 'rejected' });
  assert.equal(describeRejection('nope').message, 'nope');
  assert.equal(describeRejection(undefined).message, 'Unhandled promise rejection');
  assert.equal(describeRejection({ message: 'obj' }).message, 'obj');
  assert.equal(describeRejection({ code: 42 }).message, '{"code":42}');
  const wrapped = describeRejection({ error: err });
  assert.equal(wrapped.error, err);
  assert.equal(wrapped.message, 'rejected');
});
