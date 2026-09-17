// Pure telemetry queue: batching, size bounds, event expiry and bounded retry
// with exponential backoff. Timers and transport live in
// services/telemetryService.js - this module only manages state, so it tests
// deterministically with injected clocks under node --test. Batch bounds
// mirror the server caps (MAX_*_EVENTS_PER_BATCH = 50 in
// feedback-telemetry-handlers.js).

export function createTelemetryQueue({
  maxQueueSize = 200,
  maxBatchSize = 50,
  maxRetries = 3,
  backoffBaseMs = 5000,
  maxEventAgeMs = 10 * 60 * 1000
} = {}) {
  let usage = [];
  let performance = [];
  let retryCount = 0;

  const dropExpired = (entries, now) => entries.filter((entry) => now - entry.enqueuedAt <= maxEventAgeMs);

  // Oldest events drop first when the queue is full: recent activity is more
  // diagnostic than stale history, and business work must never block on
  // telemetry backpressure.
  const push = (entries, event, now) => {
    entries.push({ event, enqueuedAt: now });
    while (entries.length > maxQueueSize) entries.shift();
  };

  return {
    enqueueUsage(event, now = Date.now()) {
      push(usage, event, now);
    },
    enqueuePerformance(event, now = Date.now()) {
      push(performance, event, now);
    },
    size() {
      return usage.length + performance.length;
    },
    // Removes and returns the next batch (bounded, expired events discarded).
    takeBatch(now = Date.now()) {
      usage = dropExpired(usage, now);
      performance = dropExpired(performance, now);
      if (!usage.length && !performance.length) return null;

      const usageEvents = usage.slice(0, maxBatchSize);
      const performanceEvents = performance.slice(0, maxBatchSize);
      usage = usage.slice(usageEvents.length);
      performance = performance.slice(performanceEvents.length);
      return {
        usageEvents: usageEvents.map((entry) => entry.event),
        performanceEvents: performanceEvents.map((entry) => entry.event),
        entries: { usageEvents, performanceEvents }
      };
    },
    // A delivered batch resets the backoff.
    onFlushSuccess() {
      retryCount = 0;
    },
    // Failed batches are requeued at the front until the retry budget is
    // spent; returns the backoff delay for the next attempt, or null when the
    // batch must be dropped (telemetry never retries forever).
    onFlushFailure(batch, now = Date.now()) {
      retryCount += 1;
      if (retryCount > maxRetries) {
        retryCount = 0;
        return null;
      }
      usage = [...dropExpired(batch.entries.usageEvents, now), ...usage].slice(0, maxQueueSize);
      performance = [...dropExpired(batch.entries.performanceEvents, now), ...performance].slice(0, maxQueueSize);
      return backoffBaseMs * 2 ** (retryCount - 1);
    },
    pendingRetries() {
      return retryCount;
    }
  };
}
