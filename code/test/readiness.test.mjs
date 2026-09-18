// Readiness endpoint (roadmap A11): /readyz answers 200 only when the
// database answers; /healthz stays the plain liveness check.
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { cds, test, expectInMemoryDb } from './helpers/cds-http-test.mjs';

const require = createRequire(import.meta.url);
const { checkReadiness, checkDatabase } = require('../srv/srv/utils/readiness.js');

describe('readiness', function () {
  this.timeout(30000);

  before(() => expectInMemoryDb());

  describe('GET /readyz', () => {
    it('answers 200 with a passing database check on a healthy server', async () => {
      const response = await test.axios.get('/readyz', { validateStatus: () => true });
      expect(response.status, JSON.stringify(response.data)).to.equal(200);
      expect(response.data.status).to.equal('ok');
      expect(response.data.checks.db.ok).to.equal(true);
      expect(response.data.checks.db.ms).to.be.a('number');
    });

    it('keeps /healthz as the plain liveness answer', async () => {
      const response = await test.axios.get('/healthz', { validateStatus: () => true });
      expect(response.status).to.equal(200);
      expect(response.data).to.equal('OK');
    });

    it('answers 503 while the database does not answer', async () => {
      const original = cds.db.run;
      cds.db.run = async () => { throw new Error('connection refused'); };
      try {
        const response = await test.axios.get('/readyz', { validateStatus: () => true });
        expect(response.status).to.equal(503);
        expect(response.data.status).to.equal('unavailable');
        expect(response.data.checks.db.ok).to.equal(false);
        expect(response.data.checks.db.error).to.include('connection refused');
      } finally {
        cds.db.run = original;
      }
    });
  });

  describe('checkDatabase', () => {
    it('reports a timeout instead of hanging on a stalled database', async () => {
      const db = { run: () => new Promise(() => {}) };
      const result = await checkDatabase({ db, timeoutMs: 20, databaseLess: false });
      expect(result.ok).to.equal(false);
      expect(result.error).to.include('timeout');
    });

    it('fails when no database service is connected', async () => {
      const result = await checkDatabase({ db: null, databaseLess: false });
      expect(result.ok).to.equal(false);
      expect(result.error).to.include('not connected');
    });

    it('skips the probe on the database-less tier', async () => {
      const result = await checkDatabase({ db: null, databaseLess: true });
      expect(result).to.include({ ok: true, skipped: true });
      const readiness = await checkReadiness({ db: null, databaseLess: true });
      expect(readiness.status).to.equal('ok');
    });

    it('never throws: a rejecting probe becomes a failed check', async () => {
      const db = { run: async () => { throw new Error('boom'); } };
      const readiness = await checkReadiness({ db, databaseLess: false });
      expect(readiness.status).to.equal('unavailable');
      expect(readiness.checks.db.error).to.equal('boom');
    });
  });
});
