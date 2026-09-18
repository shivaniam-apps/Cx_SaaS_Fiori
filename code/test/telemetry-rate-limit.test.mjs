// Telemetry ingestion rate limiting (roadmap A13): per-user limits per
// minute with a tenant ceiling, feedback refused with 429, passive
// telemetry dropped silently. Unit level for the windowing, HTTP level
// through the shared cds.test server for the three ingestion actions.
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { cds, test, json, expectInMemoryDb } from './helpers/cds-http-test.mjs';

const require = createRequire(import.meta.url);
const {
  checkTelemetryRateLimit, retryAfterSeconds, configuredTelemetryLimits, resetTelemetryRateLimits, WINDOW_MS
} = require('../srv/srv/utils/telemetry-rate-limit.js');

const { SELECT, DELETE } = cds.ql;
const CORE = '/core';
const ENV = ['ADOPTOPS_TELEMETRY_FEEDBACK_PER_MINUTE', 'ADOPTOPS_TELEMETRY_ERRORS_PER_MINUTE', 'ADOPTOPS_TELEMETRY_BATCHES_PER_MINUTE', 'ADOPTOPS_TELEMETRY_TENANT_MULTIPLIER'];

function withLimits(values) {
  for (const name of ENV) delete process.env[name];
  Object.assign(process.env, values);
}

describe('telemetry rate limiting', function () {
  this.timeout(30000);

  beforeEach(() => resetTelemetryRateLimits());
  afterEach(() => {
    withLimits({});
    resetTelemetryRateLimits();
  });

  // The probe users carry no tenant, so their rows are GLOBAL and visible to
  // every tenant; tenant-scope.test.mjs (same server, runs later) counts
  // telemetry per tenant, so everything written here is removed again.
  after(async () => {
    await DELETE.from('adops.db.PilotFeedback').where({ Title: 'Rate limit probe' });
    await DELETE.from('adops.db.ClientErrorReports').where({ ErrorMessage: 'rate limited crash' });
    await DELETE.from('adops.db.UsageEvents').where({ SessionId: 'rl-session' });
  });

  describe('checkTelemetryRateLimit (pure windowing)', () => {
    it('allows up to the per-user limit per fixed window, then refuses with a retry hint', () => {
      withLimits({ ADOPTOPS_TELEMETRY_FEEDBACK_PER_MINUTE: '2' });
      const t0 = 1_000_000;
      const args = { stream: 'feedback', tenant: 'T', user: 'u1', now: t0 };
      expect(checkTelemetryRateLimit(args)).to.include({ allowed: true, remaining: 1 });
      expect(checkTelemetryRateLimit({ ...args, now: t0 + 10 })).to.include({ allowed: true, remaining: 0 });
      const refused = checkTelemetryRateLimit({ ...args, now: t0 + 20 });
      expect(refused).to.include({ allowed: false, scope: 'user', limit: 2, firstExceeded: true });
      expect(refused.retryAfterMs).to.equal(WINDOW_MS - 20);
      expect(retryAfterSeconds(refused)).to.equal(60);
      expect(checkTelemetryRateLimit({ ...args, now: t0 + 30 }).firstExceeded).to.equal(false, 'only the first refusal is flagged');
      expect(checkTelemetryRateLimit({ ...args, now: t0 + WINDOW_MS }).allowed).to.equal(true, 'a new window starts');
    });

    it('keeps users, tenants and streams apart', () => {
      withLimits({ ADOPTOPS_TELEMETRY_ERRORS_PER_MINUTE: '1' });
      const now = 5_000_000;
      expect(checkTelemetryRateLimit({ stream: 'errors', tenant: 'A', user: 'u', now }).allowed).to.equal(true);
      expect(checkTelemetryRateLimit({ stream: 'errors', tenant: 'A', user: 'u', now }).allowed).to.equal(false);
      expect(checkTelemetryRateLimit({ stream: 'errors', tenant: 'A', user: 'v', now }).allowed).to.equal(true, 'other user');
      expect(checkTelemetryRateLimit({ stream: 'errors', tenant: 'B', user: 'u', now }).allowed).to.equal(true, 'other tenant');
      expect(checkTelemetryRateLimit({ stream: 'batches', tenant: 'A', user: 'u', now }).allowed).to.equal(true, 'other stream');
    });

    it('applies the tenant ceiling across users', () => {
      withLimits({ ADOPTOPS_TELEMETRY_BATCHES_PER_MINUTE: '2', ADOPTOPS_TELEMETRY_TENANT_MULTIPLIER: '1' });
      const now = 9_000_000;
      expect(checkTelemetryRateLimit({ stream: 'batches', tenant: 'T', user: 'a', now }).allowed).to.equal(true);
      expect(checkTelemetryRateLimit({ stream: 'batches', tenant: 'T', user: 'b', now }).allowed).to.equal(true);
      const refused = checkTelemetryRateLimit({ stream: 'batches', tenant: 'T', user: 'c', now });
      expect(refused).to.include({ allowed: false, scope: 'tenant', limit: 2, firstExceeded: true });
    });

    it('disables a stream with 0 and reports the configured limits', () => {
      withLimits({ ADOPTOPS_TELEMETRY_FEEDBACK_PER_MINUTE: '0' });
      for (let i = 0; i < 50; i += 1) expect(checkTelemetryRateLimit({ stream: 'feedback', tenant: 'T', user: 'u' }).allowed).to.equal(true);
      expect(configuredTelemetryLimits()).to.include({ feedbackPerMinute: 0, errorsPerMinute: 30, batchesPerMinute: 20, tenantMultiplier: 20, windowMs: WINDOW_MS });
      expect(() => checkTelemetryRateLimit({ stream: 'nope', tenant: 'T', user: 'u' })).to.throw(/Unknown telemetry stream/);
    });
  });

  describe('over HTTP', () => {
    before(() => expectInMemoryDb());

    it('submitPilotFeedback answers 429 with a retry hint once the user limit is reached', async () => {
      withLimits({ ADOPTOPS_TELEMETRY_FEEDBACK_PER_MINUTE: '2' });
      const body = { category: 'GENERAL', title: 'Rate limit probe', description: 'one of several', impact: 'LOW' };
      for (let i = 0; i < 2; i += 1) {
        const ok = await test.axios.post(`${CORE}/submitPilotFeedback`, body, json('dave'));
        expect(ok.status, JSON.stringify(ok.data)).to.equal(200);
      }
      const refused = await test.axios.post(`${CORE}/submitPilotFeedback`, body, json('dave'));
      expect(refused.status).to.equal(429);
      expect(refused.data.error.message).to.match(/Too many feedback submissions - try again in \d+ seconds/);
      const other = await test.axios.post(`${CORE}/submitPilotFeedback`, body, json('bob'));
      expect(other.status, 'another user is not affected').to.equal(200);
      const rows = await SELECT.from('adops.db.PilotFeedback').where({ Title: 'Rate limit probe' });
      expect(rows).to.have.length(3);
    });

    it('recordClientError drops reports silently beyond the limit', async () => {
      withLimits({ ADOPTOPS_TELEMETRY_ERRORS_PER_MINUTE: '1' });
      const body = { errorType: 'WINDOW_ERROR', errorMessage: 'rate limited crash', route: '/x', severity: 'ERROR' };
      const first = await test.axios.post(`${CORE}/recordClientError`, body, json('dave'));
      expect(first.status).to.equal(200);
      expect(first.data.received).to.equal(true);
      const second = await test.axios.post(`${CORE}/recordClientError`, body, json('dave'));
      expect(second.status, 'never an error for passive telemetry').to.equal(200);
      expect(second.data).to.include({ received: false, occurrenceCount: 0 });
      const row = await SELECT.one.from('adops.db.ClientErrorReports').where({ ErrorMessage: 'rate limited crash' });
      expect(row.OccurrenceCount, 'the dropped report was not counted').to.equal(1);
    });

    it('recordTelemetryBatch accepts nothing beyond the limit', async () => {
      withLimits({ ADOPTOPS_TELEMETRY_BATCHES_PER_MINUTE: '1' });
      const body = {
        sessionId: 'rl-session', appVersion: 'test',
        usageEvents: [{ timestamp: new Date().toISOString(), eventName: 'rl_probe', eventCategory: 'test', route: '/x', feature: 'f', action: 'a', outcome: 'ok' }]
      };
      const first = await test.axios.post(`${CORE}/recordTelemetryBatch`, body, json('dave'));
      expect(first.status).to.equal(200);
      expect(first.data.acceptedUsage).to.equal(1);
      const second = await test.axios.post(`${CORE}/recordTelemetryBatch`, body, json('dave'));
      expect(second.status).to.equal(200);
      expect(second.data).to.include({ acceptedUsage: 0, acceptedPerformance: 0 });
      const rows = await SELECT.from('adops.db.UsageEvents').where({ SessionId: 'rl-session' });
      expect(rows).to.have.length(1);
    });
  });
});
