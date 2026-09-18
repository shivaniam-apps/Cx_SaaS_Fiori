// Alert Notification client and the task-failure hook (roadmap T4).
// The transport and the binding are injected; no network, no service.
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const cds = require('@sap/cds');
const alerts = require('../srv/srv/utils/alert-notification.js');
const { registerTaskHandler, enqueueTask, pollOnce, stopTaskRunner } = require('../srv/srv/utils/task-runner.js');

const { SELECT, UPDATE } = cds.ql;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BINDING = {
  url: 'https://ans.example.test/',
  client_id: 'client',
  client_secret: 'secret',
  oauth_url: 'https://auth.example.test/oauth/token?grant_type=client_credentials'
};

// Records every call; answers the token endpoint and the producer endpoint.
function fakeFetch({ tokenStatus = 200, eventStatus = 202, expiresIn = 3600, fail = false } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (fail) throw new Error('network down');
    if (String(url).includes('/oauth/token')) {
      return { ok: tokenStatus < 400, status: tokenStatus, json: async () => ({ access_token: 'tok-1', expires_in: expiresIn }), text: async () => '' };
    }
    return { ok: eventStatus < 400, status: eventStatus, json: async () => ({}), text: async () => (eventStatus >= 400 ? 'refused by ANS' : '') };
  };
  return { calls, impl };
}

const TASK = {
  ID: 'task-1', TaskType: 'USAGE_EXTRACTION', ObjectType: 'ExtractionRuns', ObjectId: 'run-1', Status: 'FAILED',
  ErrorText: 'S/4 answered 503', Phase: 'Reading ST03N', AttemptCount: 2, MaxAttempts: 2, TenantId: 'tenant-a',
  targetSystem_ID: 'sys-1', RequestedBy: 'carol', CorrelationId: 'corr-1'
};

describe('alert notification', function () {
  this.timeout(20000);

  afterEach(() => alerts.configureAlerting(null));

  describe('buildTaskFailureEvent (pure)', () => {
    it('builds the documented resource event from a task row', () => {
      const event = alerts.buildTaskFailureEvent(TASK, { appName: 'adops-basic-srv-dev', instance: '1', now: new Date('2026-09-18T10:00:00Z') });
      expect(event.eventType).to.equal(alerts.EVENT_TASK_FAILED);
      expect(event).to.include({ severity: 'ERROR', category: 'ALERT', priority: 1, eventTimestamp: Math.floor(Date.parse('2026-09-18T10:00:00Z') / 1000) });
      expect(event.subject).to.equal('AdoptOps USAGE_EXTRACTION FAILED: ExtractionRuns run-1');
      expect(event.body).to.include('S/4 answered 503');
      expect(event.body).to.include('attempts 2/2');
      expect(event.body).to.include('Tenant: tenant-a');
      expect(event.body).to.include('Correlation id: corr-1');
      expect(event.resource).to.deep.include({ resourceName: 'adops-basic-srv-dev', resourceType: 'cf-application', resourceInstance: '1' });
      expect(event.resource.tags).to.deep.equal({ taskId: 'task-1', taskType: 'USAGE_EXTRACTION', taskStatus: 'FAILED', tenant: 'tenant-a', objectType: 'ExtractionRuns', objectId: 'run-1' });
      expect(event.tags['ans:correlationId']).to.equal('corr-1');
    });

    it('tolerates a sparse row and bounds the text fields', () => {
      const event = alerts.buildTaskFailureEvent({ ID: 'x', ErrorText: 'e'.repeat(5000) });
      expect(event.subject).to.equal('AdoptOps task FAILED: object');
      expect(event.body.length).to.be.at.most(4000);
      expect(event.resource.tags.tenant).to.equal('GLOBAL');
      expect(alerts.buildTaskFailureEvent({ ID: 'y' }).body).to.include('no error text');
    });
  });

  describe('sendAlert', () => {
    it('is a logged no-op without a binding and reports unbound', async () => {
      alerts.configureAlerting({ binding: null, fetch: () => { throw new Error('must not be called'); } });
      expect(alerts.isAlertingBound()).to.equal(false);
      const result = await alerts.sendAlert(alerts.buildTaskFailureEvent(TASK));
      expect(result).to.deep.equal({ sent: false, reason: 'unbound' });
    });

    it('fetches a client-credentials token once and posts the event to the producer API', async () => {
      const { calls, impl } = fakeFetch();
      alerts.configureAlerting({ binding: BINDING, fetch: impl });
      expect(alerts.isAlertingBound()).to.equal(true);

      const first = await alerts.alertTaskFailure(TASK);
      expect(first).to.deep.equal({ sent: true, status: 202 });
      expect(calls).to.have.length(2);
      expect(calls[0].url).to.equal('https://auth.example.test/oauth/token?grant_type=client_credentials');
      expect(calls[0].init.headers.Authorization).to.equal(`Basic ${Buffer.from('client:secret').toString('base64')}`);
      expect(calls[1].url).to.equal(`https://ans.example.test${alerts.PRODUCER_PATH}`);
      expect(calls[1].init.method).to.equal('POST');
      expect(calls[1].init.headers.Authorization).to.equal('Bearer tok-1');
      const posted = JSON.parse(calls[1].init.body);
      expect(posted.eventType).to.equal(alerts.EVENT_TASK_FAILED);
      expect(posted.subject).to.include('USAGE_EXTRACTION FAILED');

      const second = await alerts.alertTaskFailure(TASK);
      expect(second.sent).to.equal(true);
      expect(calls, 'token reused within its lifetime').to.have.length(3);
      expect(calls[2].url).to.include(alerts.PRODUCER_PATH);
    });

    it('adds grant_type when the binding url lacks it and supports basic credentials', async () => {
      const { calls, impl } = fakeFetch();
      alerts.configureAlerting({ binding: { ...BINDING, oauth_url: 'https://auth.example.test/oauth/token' }, fetch: impl });
      await alerts.sendAlert(alerts.buildTaskFailureEvent(TASK));
      expect(calls[0].url).to.equal('https://auth.example.test/oauth/token?grant_type=client_credentials');

      const basic = fakeFetch();
      alerts.configureAlerting({ binding: { url: 'https://ans.example.test', username: 'u', password: 'p' }, fetch: basic.impl });
      const result = await alerts.sendAlert(alerts.buildTaskFailureEvent(TASK));
      expect(result.sent).to.equal(true);
      expect(basic.calls).to.have.length(1);
      expect(basic.calls[0].init.headers.Authorization).to.equal(`Basic ${Buffer.from('u:p').toString('base64')}`);
    });

    it('never throws: refused events, token failures, broken bindings and network errors become results', async () => {
      const refused = fakeFetch({ eventStatus: 400 });
      alerts.configureAlerting({ binding: BINDING, fetch: refused.impl });
      expect(await alerts.sendAlert(alerts.buildTaskFailureEvent(TASK))).to.deep.equal({ sent: false, status: 400, reason: 'refused' });

      const noToken = fakeFetch({ tokenStatus: 401 });
      alerts.configureAlerting({ binding: BINDING, fetch: noToken.impl });
      const tokenResult = await alerts.sendAlert(alerts.buildTaskFailureEvent(TASK));
      expect(tokenResult.sent).to.equal(false);
      expect(tokenResult.reason).to.include('401');

      alerts.configureAlerting({ binding: { url: 'https://ans.example.test' }, fetch: fakeFetch().impl });
      expect((await alerts.sendAlert(alerts.buildTaskFailureEvent(TASK))).reason).to.include('neither OAuth');

      alerts.configureAlerting({ binding: { client_id: 'c', client_secret: 's', oauth_url: 'https://a/t' }, fetch: fakeFetch().impl });
      expect((await alerts.sendAlert(alerts.buildTaskFailureEvent(TASK))).reason).to.include('no url');

      const down = fakeFetch({ fail: true });
      alerts.configureAlerting({ binding: BINDING, fetch: down.impl });
      expect((await alerts.sendAlert(alerts.buildTaskFailureEvent(TASK))).reason).to.equal('network down');
    });
  });

  describe('task runner hook', () => {
    before(async () => {
      const model = await cds.load(fileURLToPath(new URL('../db', import.meta.url)));
      await cds.deploy(model).to('sqlite::memory:');
    });
    after(() => stopTaskRunner());

    it('raises one alert when a task exhausts its attempts, none while it is requeued', async () => {
      const { calls, impl } = fakeFetch();
      alerts.configureAlerting({ binding: BINDING, fetch: impl });
      registerTaskHandler('ALERT_PROBE', async () => { throw new Error('probe failure'); });
      const task = await enqueueTask({ taskType: 'ALERT_PROBE', targetSystemId: randomUUID(), objectType: 'Probe', objectId: 'p-1', requestedBy: 'tester', payload: {} });
      await UPDATE('adops.db.BackgroundTasks').set({ MaxAttempts: 2 }).where({ ID: task.ID });

      let row;
      for (let i = 0; i < 40; i += 1) {
        await pollOnce();
        row = await SELECT.one.from('adops.db.BackgroundTasks').where({ ID: task.ID });
        if (row.Status === 'FAILED') break;
        await wait(50);
      }
      expect(row.Status).to.equal('FAILED');
      expect(row.AttemptCount).to.equal(2);

      const posted = calls.filter((c) => c.url.includes(alerts.PRODUCER_PATH)).map((c) => JSON.parse(c.init.body));
      expect(posted, 'one alert for the terminal failure only').to.have.length(1);
      expect(posted[0].resource.tags.taskId).to.equal(task.ID);
      expect(posted[0].body).to.include('probe failure');
      expect(posted[0].body).to.include('attempts 2/2');
    });

    it('a broken alert transport does not change the task outcome', async () => {
      alerts.configureAlerting({ binding: BINDING, fetch: fakeFetch({ fail: true }).impl });
      registerTaskHandler('ALERT_PROBE_2', async () => { throw new Error('still failing'); });
      const task = await enqueueTask({ taskType: 'ALERT_PROBE_2', targetSystemId: randomUUID(), objectType: 'Probe', objectId: 'p-2', requestedBy: 'tester', payload: {} });
      await UPDATE('adops.db.BackgroundTasks').set({ MaxAttempts: 1 }).where({ ID: task.ID });
      let row;
      for (let i = 0; i < 40; i += 1) {
        await pollOnce();
        row = await SELECT.one.from('adops.db.BackgroundTasks').where({ ID: task.ID });
        if (row.Status === 'FAILED') break;
        await wait(50);
      }
      expect(row.Status).to.equal('FAILED');
      expect(row.ErrorText).to.equal('still failing');
    });
  });
});
