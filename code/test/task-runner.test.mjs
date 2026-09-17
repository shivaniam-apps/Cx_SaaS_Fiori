import { expect } from 'chai';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cds = require('@sap/cds');
const {
  registerTaskHandler,
  enqueueTask,
  requestCancel,
  pollOnce,
  stopTaskRunner
} = require('../srv/srv/utils/task-runner.js');

const { SELECT, UPDATE } = cds.ql;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForStatus(taskId, statuses, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const row = await SELECT.one.from('adops.db.BackgroundTasks').where({ ID: taskId });
    if (row && statuses.includes(row.Status)) return row;
    if (Date.now() > until) throw new Error(`Task ${taskId} did not reach ${statuses} (is ${row?.Status})`);
    await wait(50);
  }
}

describe('task runner state machine', function () {
  this.timeout(20000);

  before(async () => {
    const model = await cds.load(fileURLToPath(new URL('../db', import.meta.url)));
    await cds.deploy(model).to('sqlite::memory:');
  });

  after(() => stopTaskRunner());

  it('claims, runs and completes a task with progress', async () => {
    registerTaskHandler('USAGE_EXTRACTION', async ({ reportProgress }) => {
      await reportProgress({ phase: 'Collecting', processedItems: 5, totalItems: 10 });
      return { rows: 10 };
    });

    const task = await enqueueTask({ taskType: 'USAGE_EXTRACTION', requestedBy: 'tester' });
    await pollOnce();
    const done = await waitForStatus(task.ID, ['SUCCEEDED']);
    expect(done.ProgressPercent).to.equal(100);
    expect(JSON.parse(done.ResultJson).result).to.deep.equal({ rows: 10 });
    expect(done.ClaimedBy).to.be.a('string');
  });

  it('cancels at a handler-observed boundary', async () => {
    registerTaskHandler('ANALYSIS', async ({ isCancelRequested }) => {
      for (let i = 0; i < 100; i++) {
        if (await isCancelRequested()) return { stoppedAt: i };
        await wait(20);
      }
      return { stoppedAt: -1 };
    });

    const task = await enqueueTask({ taskType: 'ANALYSIS' });
    await pollOnce();
    await waitForStatus(task.ID, ['RUNNING']);
    await requestCancel(task.ID);
    const done = await waitForStatus(task.ID, ['CANCELLED']);
    expect(done.Status).to.equal('CANCELLED');
  });

  it('requeues a failed read task once, then succeeds', async () => {
    let calls = 0;
    registerTaskHandler('CATALOG_DERIVATION', async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient S/4 hiccup');
      return { ok: true };
    });

    const task = await enqueueTask({ taskType: 'CATALOG_DERIVATION' });
    await pollOnce();
    await waitForStatus(task.ID, ['QUEUED', 'SUCCEEDED']); // first attempt failed -> requeued
    await pollOnce();
    const done = await waitForStatus(task.ID, ['SUCCEEDED']);
    expect(calls).to.equal(2);
    expect(done.AttemptCount).to.equal(2);
  });

  it('never retries ACTIVATION_EXECUTION', async () => {
    let calls = 0;
    registerTaskHandler('ACTIVATION_EXECUTION', async () => {
      calls += 1;
      throw new Error('step 3 failed');
    });

    const task = await enqueueTask({ taskType: 'ACTIVATION_EXECUTION' });
    await pollOnce();
    const done = await waitForStatus(task.ID, ['FAILED']);
    expect(calls).to.equal(1);
    expect(done.MaxAttempts).to.equal(1);
    expect(done.ErrorText).to.contain('step 3 failed');
  });

  it('serialises tasks against the same target system', async () => {
    let releaseFirst;
    let invocation = 0;
    const firstRunning = new Promise((resolve) => {
      registerTaskHandler('TRANSPORT_RELEASE', async () => {
        invocation += 1;
        if (invocation === 1) {
          resolve();
          await new Promise((r) => { releaseFirst = r; });
        }
        return {};
      });
    });

    const system = '11111111-2222-3333-4444-555555555555';
    const first = await enqueueTask({ taskType: 'TRANSPORT_RELEASE', targetSystemId: system });
    await pollOnce();
    await firstRunning;

    const second = await enqueueTask({ taskType: 'TRANSPORT_RELEASE', targetSystemId: system });
    await pollOnce();
    const blocked = await SELECT.one.from('adops.db.BackgroundTasks').where({ ID: second.ID });
    expect(blocked.Status).to.equal('QUEUED'); // same system: must wait

    releaseFirst();
    await waitForStatus(first.ID, ['SUCCEEDED']);
    await pollOnce();
    await waitForStatus(second.ID, ['SUCCEEDED']);
  });

  it('reclaims a task whose worker went silent', async () => {
    registerTaskHandler('USAGE_EXTRACTION', async () => ({ ok: true }));
    const task = await enqueueTask({ taskType: 'USAGE_EXTRACTION' });
    // Simulate another instance that claimed and died: stale heartbeat.
    await UPDATE('adops.db.BackgroundTasks')
      .set({
        Status: 'RUNNING',
        ClaimedBy: 'dead-instance',
        AttemptCount: 1,
        HeartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
      })
      .where({ ID: task.ID });

    await pollOnce(); // reclaim pass requeues it, then a claim may run it
    const row = await waitForStatus(task.ID, ['QUEUED', 'CLAIMED', 'RUNNING', 'SUCCEEDED']);
    expect(['QUEUED', 'CLAIMED', 'RUNNING', 'SUCCEEDED']).to.include(row.Status);
    await pollOnce();
    const done = await waitForStatus(task.ID, ['SUCCEEDED']);
    expect(done.AttemptCount).to.equal(2);
  });
});
