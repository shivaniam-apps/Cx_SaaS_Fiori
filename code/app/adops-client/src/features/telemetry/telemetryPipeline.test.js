import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetryQueue } from './queue.js';
import {
  SLOW_ROUTE_MS,
  SLOW_API_MS,
  SEVERE_API_MS,
  ROUTE_RENDER_DISCARD_MS,
  isTelemetryEndpoint,
  classifyApiTiming,
  classifyRouteRender,
  apiOperationName,
  buildUsageEvent,
  buildPerformanceEvent
} from './performancePolicy.js';

test('takeBatch drains bounded batches and leaves the remainder queued', () => {
  const queue = createTelemetryQueue({ maxBatchSize: 2 });
  for (let i = 0; i < 5; i += 1) queue.enqueueUsage({ eventName: `E${i}` }, 1000);
  const batch = queue.takeBatch(1000);
  assert.deepEqual(batch.usageEvents.map((e) => e.eventName), ['E0', 'E1']);
  assert.equal(batch.performanceEvents.length, 0);
  assert.equal(queue.size(), 3);
});

test('takeBatch returns null when empty and discards expired events', () => {
  const queue = createTelemetryQueue({ maxEventAgeMs: 1000 });
  assert.equal(queue.takeBatch(0), null);
  queue.enqueueUsage({ eventName: 'OLD' }, 0);
  queue.enqueuePerformance({ operationName: 'FRESH' }, 1500);
  const batch = queue.takeBatch(2000);
  assert.equal(batch.usageEvents.length, 0);
  assert.deepEqual(batch.performanceEvents.map((e) => e.operationName), ['FRESH']);
});

test('the queue drops the oldest events at capacity instead of growing', () => {
  const queue = createTelemetryQueue({ maxQueueSize: 3 });
  for (let i = 0; i < 6; i += 1) queue.enqueueUsage({ eventName: `E${i}` }, 1000);
  assert.deepEqual(queue.takeBatch(1000).usageEvents.map((e) => e.eventName), ['E3', 'E4', 'E5']);
});

test('flush failure requeues with exponential backoff, then drops after the retry budget', () => {
  const queue = createTelemetryQueue({ maxRetries: 2, backoffBaseMs: 100 });
  queue.enqueueUsage({ eventName: 'A' }, 1000);
  const first = queue.takeBatch(1000);
  assert.equal(queue.onFlushFailure(first, 1000), 100);
  assert.equal(queue.size(), 1);
  const second = queue.takeBatch(1100);
  assert.equal(queue.onFlushFailure(second, 1100), 200);
  const third = queue.takeBatch(1300);
  assert.equal(queue.onFlushFailure(third, 1300), null);
  assert.equal(queue.pendingRetries(), 0);
  queue.enqueueUsage({ eventName: 'B' }, 2000);
  assert.equal(queue.onFlushFailure(queue.takeBatch(2000), 2000), 100);
  queue.onFlushSuccess();
  assert.equal(queue.pendingRetries(), 0);
});

test('telemetry endpoints are never observed by the pipeline itself', () => {
  assert.equal(isTelemetryEndpoint('/core/recordTelemetryBatch'), true);
  assert.equal(isTelemetryEndpoint('http://localhost:5283/core/recordClientError'), true);
  assert.equal(isTelemetryEndpoint('/core/getTelemetrySettings()'), true);
  assert.equal(isTelemetryEndpoint('/core/userInfo()'), false);
  assert.equal(isTelemetryEndpoint('/fiori/queryActivationPlans()'), false);
  assert.equal(isTelemetryEndpoint(undefined), false);
});

test('API timing policy records only threshold-crossing operations, with tenant overrides', () => {
  assert.equal(classifyApiTiming({ durationMs: SLOW_API_MS - 1 }), null);
  assert.deepEqual(classifyApiTiming({ durationMs: SLOW_API_MS }), { outcome: 'SLOW', thresholdMs: SLOW_API_MS });
  assert.deepEqual(classifyApiTiming({ durationMs: SEVERE_API_MS }), { outcome: 'SEVERE', thresholdMs: SEVERE_API_MS });
  assert.deepEqual(classifyApiTiming({ durationMs: SEVERE_API_MS + 1, failed: true }), { outcome: 'FAILED', thresholdMs: SEVERE_API_MS });
  assert.equal(classifyApiTiming({ durationMs: 100, failed: true }), null);
  assert.equal(classifyApiTiming({ durationMs: Number.NaN }), null);
  assert.deepEqual(classifyApiTiming({ durationMs: 600 }, { slowApiThresholdMs: 500, severeApiThresholdMs: 800 }), { outcome: 'SLOW', thresholdMs: 500 });
  // A severe threshold below the slow one is clamped up, never inverted.
  assert.deepEqual(classifyApiTiming({ durationMs: 600 }, { slowApiThresholdMs: 500, severeApiThresholdMs: 100 }), { outcome: 'SEVERE', thresholdMs: 500 });
  assert.deepEqual(classifyApiTiming({ durationMs: SLOW_API_MS }, { slowApiThresholdMs: 0 }), { outcome: 'SLOW', thresholdMs: SLOW_API_MS });
});

test('route render policy records only slow renders and discards tab-suspension noise', () => {
  assert.equal(classifyRouteRender(SLOW_ROUTE_MS - 1), null);
  assert.deepEqual(classifyRouteRender(SLOW_ROUTE_MS), { outcome: 'SLOW', thresholdMs: SLOW_ROUTE_MS });
  assert.deepEqual(classifyRouteRender(900, { slowRouteThresholdMs: 800 }), { outcome: 'SLOW', thresholdMs: 800 });
  assert.equal(classifyRouteRender(ROUTE_RENDER_DISCARD_MS + 1), null);
  assert.equal(classifyRouteRender(undefined), null);
});

test('operation names drop query strings and key values', () => {
  assert.equal(apiOperationName('get', '/fiori/readActivationPlan(planId=abc-123)?x=1'), 'GET /fiori/readActivationPlan()');
  assert.equal(apiOperationName('POST', '/fiori/executeActivationPlan'), 'POST /fiori/executeActivationPlan');
  assert.equal(apiOperationName(undefined, `/fiori/${'x'.repeat(200)}`).length, 120);
});

test('usage and performance rows are bounded and reject unstorable input', () => {
  const now = new Date('2026-09-17T10:00:00Z');
  const usage = buildUsageEvent({ eventName: 'PAGE_VIEWED', eventCategory: 'NAVIGATION', route: '#/activation', feature: 'activation', durationMs: -1, metadataJson: 'm'.repeat(3000), now });
  assert.equal(usage.timestamp, '2026-09-17T10:00:00.000Z');
  assert.equal(usage.durationMs, null);
  assert.equal(usage.metadataJson.length, 2000);
  assert.equal(usage.action, '');
  assert.equal(buildUsageEvent({ eventName: '' }), null);

  const perf = buildPerformanceEvent({ source: 'api', operationName: 'GET /fiori/x', routeOrEndpoint: '/fiori/x', durationMs: 3200.6, thresholdMs: 3000, outcome: 'SLOW', now });
  assert.equal(perf.source, 'API');
  assert.equal(perf.durationMs, 3201);
  assert.equal(perf.thresholdMs, 3000);
  assert.equal(buildPerformanceEvent({ source: 'weird', operationName: 'ROUTE_RENDER', durationMs: 10, now }).source, 'CLIENT');
  assert.equal(buildPerformanceEvent({ operationName: '', durationMs: 10 }), null);
  assert.equal(buildPerformanceEvent({ operationName: 'X', durationMs: Number.NaN }), null);
});
