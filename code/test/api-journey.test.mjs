// API coverage of the product journey (roadmap A12): every PublicService,
// AdminService and CoreService action or function is exercised over HTTP
// through the shared cds.test server in mock-S/4 mode, in the order the
// product runs them: extraction -> proposals -> wave -> plan -> simulate ->
// execute -> transport -> manifest, plus the administrative and self-service
// endpoints around it. Role gates are asserted where the CDS declares them;
// the auth matrix itself is public-service-auth.test.mjs.
//
// Background tasks are real: the task runner inside the server claims and
// executes them (mock adapters). The poll interval is shortened before the
// server starts so a suite run does not wait three seconds per task.
process.env.ADOPTOPS_TASK_POLL_MS ??= '150';

import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { cds, test, as, json, expectInMemoryDb } from './helpers/cds-http-test.mjs';

const { SELECT, INSERT, DELETE } = cds.ql;

const FIORI = '/fiori';
const ADMIN = '/catalog/AdminService';
const CORE = '/core';

// --- helpers -----------------------------------------------------------------

async function call(user, service, name, body = {}) {
  return test.axios.post(`${service}/${name}`, body, json(user));
}

// OData V4 function call: name(param=value,...). UUIDs and numbers unquoted,
// strings quoted.
function fnUrl(service, name, params = {}) {
  const parts = Object.entries(params).map(([key, value]) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return `${key}=${value}`;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))) return `${key}=${value}`;
    return `${key}='${String(value).replace(/'/g, "''")}'`;
  }).filter(Boolean);
  return `${service}/${name}(${parts.join(',')})`;
}

async function fn(user, service, name, params) {
  return test.axios.get(fnUrl(service, name, params), as(user));
}

// Actions and functions that return LargeString carry JSON in `value`.
function payload(response) {
  const data = response.data;
  if (data && typeof data === 'object' && typeof data.value === 'string') return JSON.parse(data.value);
  if (typeof data === 'string') return JSON.parse(data);
  return data;
}

function expectStatus(response, status, label = '') {
  expect(response.status, `${label} ${JSON.stringify(response.data)}`).to.equal(status);
  return response;
}

const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTask(user, taskId, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const response = await fn(user, FIORI, 'getTaskStatus', { taskId });
    expectStatus(response, 200, 'getTaskStatus');
    if (TERMINAL.includes(response.data.status)) return response.data;
    if (Date.now() > until) throw new Error(`task ${taskId} still ${response.data.status} (${response.data.phase})`);
    await wait(100);
  }
}

describe('API journey (mock S/4)', function () {
  this.timeout(90000);

  const ids = {};

  before(async () => {
    expectInMemoryDb();

    const dev = await test.axios.post(`${FIORI}/TargetSystems`, {
      displayName: 'Journey DEV', destinationName: 'JRN_DEV_100', systemId: 'JRN', client: '100', environment: 'DEV'
    }, json('alice'));
    expectStatus(dev, 201, 'register DEV');
    ids.dev = dev.data.ID;

    const prd = await test.axios.post(`${FIORI}/TargetSystems`, {
      displayName: 'Journey PRD', destinationName: 'JRN_PRD_100', systemId: 'JRP', client: '100', environment: 'PRD'
    }, json('alice'));
    expectStatus(prd, 201, 'register PRD');
    ids.prd = prd.data.ID;
  });

  // The journey users carry no tenant, so their rows are GLOBAL and visible
  // to every tenant. tenant-scope.test.mjs (same server, runs later) counts
  // access requests per tenant, so the one filed here is removed again.
  after(async () => {
    if (ids.accessRequest) await DELETE.from('adops.db.AccessRequests').where({ ID: ids.accessRequest });
  });

  // ---------------------------------------------------------------------------
  describe('connectivity and discovery', () => {
    it('checkTargetSystemConnection persists the per-endpoint verdict on the registered system', async () => {
      const response = await call('carol', FIORI, 'checkTargetSystemConnection', {
        destinationName: 'JRN_DEV_100', targetSystemId: ids.dev
      });
      expectStatus(response, 200, 'check');
      expect(response.data.Ok).to.equal(true);
      expect(response.data.Stage).to.equal('OK');
      expect(response.data.Endpoints.map((e) => e.Endpoint)).to.include.members(['USAGE', 'ACTIVATE']);

      const row = await SELECT.one.from('adops.db.TargetSystems').where({ ID: ids.dev });
      expect(row.lastCheckStatus).to.equal('OK');
      expect(row.lastCheckedAt).to.be.a('string');
      expect(JSON.parse(row.lastCheckEndpointsJson).map((e) => e.Endpoint)).to.include('ACTIVATE');
    });

    it('checkTargetSystemConnection refuses a call without a destination name', async () => {
      expectStatus(await call('carol', FIORI, 'checkTargetSystemConnection', {}), 400, 'no destination');
    });

    it('getBackendCapabilities answers 404 for an unknown system and a JSON document for a known one', async () => {
      expectStatus(await fn('carol', FIORI, 'getBackendCapabilities', { targetSystemId: randomUUID() }), 404, 'unknown');
      const known = await fn('carol', FIORI, 'getBackendCapabilities', { targetSystemId: ids.dev });
      expectStatus(known, 200, 'known');
      expect(payload(known)).to.be.an('object');
    });
  });

  // ---------------------------------------------------------------------------
  describe('extraction and background tasks', () => {
    it('runUsageExtraction validates the system and the period', async () => {
      expectStatus(await call('carol', FIORI, 'runUsageExtraction', {
        targetSystemId: randomUUID(), periodFrom: '2026-01-01', periodTo: '2026-03-31'
      }), 404, 'unknown system');
      expectStatus(await call('carol', FIORI, 'runUsageExtraction', { targetSystemId: ids.dev }), 400, 'no period');
    });

    it('runUsageExtraction queues a task that the runner completes into a COMPLETED, pseudonymised run', async () => {
      const response = await call('carol', FIORI, 'runUsageExtraction', {
        targetSystemId: ids.dev, periodFrom: '2026-01-01', periodTo: '2026-03-31'
      });
      expectStatus(response, 200, 'run');
      expect(response.data.taskId).to.be.a('string');
      expect(response.data.objectId).to.be.a('string');
      expect(response.data.status).to.equal('QUEUED');
      ids.extractionTask = response.data.taskId;
      ids.run = response.data.objectId;

      const done = await waitForTask('carol', ids.extractionTask);
      expect(done.status, done.errorText).to.equal('SUCCEEDED');
      expect(done.objectType).to.equal('ExtractionRuns');
      expect(done.pollAfterMs).to.equal(0);

      const run = await SELECT.one.from('adops.db.ExtractionRuns').where({ ID: ids.run });
      expect(run.Status).to.equal('COMPLETED');
      expect(JSON.parse(run.SourcesJson)).to.deep.equal(['ST03N', 'USR02', 'AGR']);
      expect(run.Pseudonymised).to.equal(true);
      expect(run.RequestedBy).to.equal('carol');
    });

    it('getTaskStatus answers 404 for an unknown task', async () => {
      expectStatus(await fn('carol', FIORI, 'getTaskStatus', { taskId: randomUUID() }), 404, 'unknown task');
    });

    it('listActiveTasks returns only open tasks in the status shape', async () => {
      const response = await fn('carol', FIORI, 'listActiveTasks', { targetSystemId: ids.dev });
      expectStatus(response, 200, 'list');
      const items = response.data.value;
      expect(items).to.be.an('array');
      for (const item of items) {
        expect(item).to.include.keys('taskId', 'taskType', 'status', 'pollAfterMs');
        expect(['QUEUED', 'CLAIMED', 'RUNNING']).to.include(item.status);
      }
      expect(items.map((t) => t.taskId)).to.not.include(ids.extractionTask);
    });

    it('cancelTask on a finished task changes nothing and reports the final status', async () => {
      const response = await call('carol', FIORI, 'cancelTask', { taskId: ids.extractionTask });
      expectStatus(response, 200, 'cancel');
      expect(response.data.status).to.equal('SUCCEEDED');
      const row = await SELECT.one.from('adops.db.BackgroundTasks').where({ ID: ids.extractionTask });
      expect(row.CancelRequested).to.equal(false);
      expectStatus(await call('carol', FIORI, 'cancelTask', { taskId: randomUUID() }), 404, 'unknown');
    });

    it('queryUsageOverview reports the run counts', async () => {
      const response = await fn('carol', FIORI, 'queryUsageOverview', { extractionRunId: ids.run });
      expectStatus(response, 200, 'overview');
      const overview = payload(response);
      expect(overview.runId).to.equal(ids.run);
      expect(overview.status).to.equal('COMPLETED');
      expect(overview.transactionRowCount).to.be.greaterThan(0);
      expectStatus(await fn('carol', FIORI, 'queryUsageOverview', { extractionRunId: randomUUID() }), 404, 'unknown run');
    });

    it('queryTransactionUsage pages deterministically with a summary and cumulative share', async () => {
      const first = await call('carol', FIORI, 'queryTransactionUsage', { extractionRunId: ids.run, top: 5, skip: 0 });
      expectStatus(first, 200, 'page 1');
      const page = payload(first);
      expect(page.Items).to.have.length(5);
      expect(page.HasMore).to.equal(true);
      expect(page.Summary.totalTcodes).to.be.greaterThan(5);
      expect(page.Summary.totalExecutions).to.be.greaterThan(0);
      const executions = page.Items.map((i) => i.ExecutionCount);
      expect([...executions].sort((a, b) => b - a)).to.deep.equal(executions, 'default sort is executions desc');
      const cumulative = page.Items.map((i) => i.CumulativePercent);
      for (let i = 1; i < cumulative.length; i += 1) expect(cumulative[i]).to.be.at.least(cumulative[i - 1]);

      const second = payload(await call('carol', FIORI, 'queryTransactionUsage', { extractionRunId: ids.run, top: 5, skip: 5, includeSummary: false }));
      expect(second.Summary).to.equal(null);
      expect(second.Items.map((i) => i.ID)).to.not.include.members(page.Items.map((i) => i.ID));
    });

    it('queryTransactionUsage filters and sorts on request, and rejects a missing run id', async () => {
      const custom = payload(await call('carol', FIORI, 'queryTransactionUsage', { extractionRunId: ids.run, customOnly: true, top: 50 }));
      for (const item of custom.Items) expect(item.IsCustom, item.TransactionCode).to.equal(true);

      const byCode = payload(await call('carol', FIORI, 'queryTransactionUsage', {
        extractionRunId: ids.run, sortField: 'TransactionCode', sortDirection: 'asc', top: 10
      }));
      const codes = byCode.Items.map((i) => i.TransactionCode);
      expect([...codes].sort()).to.deep.equal(codes);
      expect(byCode.Items.every((i) => i.CumulativePercent === 0)).to.equal(true, 'cumulative only for the default sort');

      const searched = payload(await call('carol', FIORI, 'queryTransactionUsage', { extractionRunId: ids.run, search: codes[0].slice(0, 2).toLowerCase() }));
      expect(searched.Items.length).to.be.greaterThan(0);
      for (const item of searched.Items) expect(item.TransactionCode).to.include(codes[0].slice(0, 2));

      expectStatus(await call('carol', FIORI, 'queryTransactionUsage', {}), 400, 'no run');
      const empty = payload(await call('carol', FIORI, 'queryTransactionUsage', { extractionRunId: randomUUID() }));
      expect(empty.Items).to.deep.equal([]);
      expect(empty.Count).to.equal(0);
      expect(empty.HasMore).to.equal(false);
      expect(empty.Summary).to.equal(null);
    });

    it('importUsageExtract validates the file and imports a minimal offline extract as a run', async () => {
      expectStatus(await call('carol', FIORI, 'importUsageExtract', { targetSystemId: randomUUID(), payload: '{}' }), 404, 'unknown system');
      expectStatus(await call('carol', FIORI, 'importUsageExtract', { targetSystemId: ids.dev, payload: 'not json' }), 400, 'not json');
      expectStatus(await call('carol', FIORI, 'importUsageExtract', { targetSystemId: ids.dev, payload: JSON.stringify({ format: 'other' }) }), 400, 'wrong format');

      const extract = {
        format: 'adops-usage-extract', system: 'JRN', periodFrom: '2026-01-01', periodTo: '2026-01-31',
        transactions: [
          { tcode: 'VA01', text: 'Create Sales Order', component: 'SD-SLS', executions: 120, dialogSteps: 480, users: 7, respMs: 60000 },
          { tcode: 'ZCUST1', text: 'Custom report', component: 'Z', executions: 5, dialogSteps: 10, users: 1, respMs: 900 }
        ],
        userTcodes: [{ user: 'USER1', tcode: 'VA01', executions: 100, dialogSteps: 400 }]
      };
      const response = await call('carol', FIORI, 'importUsageExtract', { targetSystemId: ids.dev, payload: JSON.stringify(extract) });
      expectStatus(response, 200, 'import');
      const result = payload(response);
      expect(result).to.be.an('object');
      const importedId = result.runId || result.extractionRunId || result.ID;
      expect(importedId, JSON.stringify(result)).to.be.a('string');
      const run = await SELECT.one.from('adops.db.ExtractionRuns').where({ ID: importedId });
      expect(run.Status).to.equal('COMPLETED');
      expect(run.Title).to.include('file import');
      const usage = payload(await call('carol', FIORI, 'queryTransactionUsage', { extractionRunId: importedId }));
      expect(usage.Items.map((i) => i.TransactionCode).sort()).to.deep.equal(['VA01', 'ZCUST1']);
      ids.importedRun = importedId;
    });
  });

  // ---------------------------------------------------------------------------
  describe('proposals (Approver decisions)', () => {
    it('generateProposals needs a completed extraction run', async () => {
      expectStatus(await call('carol', FIORI, 'generateProposals', { extractionRunId: randomUUID() }), 404, 'unknown run');
      const queuedId = randomUUID();
      await INSERT.into('adops.db.ExtractionRuns').entries({
        ID: queuedId, targetSystem_ID: ids.dev, TenantId: 'GLOBAL', Title: 'still queued', Status: 'QUEUED',
        PeriodFrom: '2026-01-01', PeriodTo: '2026-01-31'
      });
      const response = await call('carol', FIORI, 'generateProposals', { extractionRunId: queuedId });
      expectStatus(response, 400, 'queued run');
      expect(response.data.error.message).to.include('QUEUED');
    });

    it('generateProposals runs the analysis task and produces ranked proposals', async () => {
      const response = await call('carol', FIORI, 'generateProposals', { extractionRunId: ids.run, scoringProfile: 'BALANCED' });
      expectStatus(response, 200, 'generate');
      ids.analysis = response.data.objectId;
      const done = await waitForTask('carol', response.data.taskId);
      expect(done.status, done.errorText).to.equal('SUCCEEDED');
      const analysis = await SELECT.one.from('adops.db.AnalysisRuns').where({ ID: ids.analysis });
      expect(analysis.Status).to.equal('COMPLETED');
      expect(analysis.ScoringProfile).to.equal('BALANCED');

      const list = payload(await call('carol', FIORI, 'queryProposals', { analysisRunId: ids.analysis, top: 500 }));
      expect(list.Count).to.be.greaterThan(2);
      const ranks = list.Items.map((p) => p.Rank);
      expect([...ranks].sort((a, b) => a - b)).to.deep.equal(ranks);
      // Every proposal starts undecided: NEW/IN_REVIEW (open) or SUPERSEDED
      // (no Fiori equivalent) - never approved, rejected or deferred.
      expect(list.Summary.open + list.Summary.noEquivalent).to.equal(list.Count);
      expect(list.Summary.approved + list.Summary.rejected + list.Summary.deferred).to.equal(0);
      ids.proposals = list.Items.filter((p) => p.ReviewStatus === 'NEW').map((p) => p.ID);
      expect(ids.proposals.length).to.be.at.least(5);
    });

    it('queryProposals pages and rejects a missing analysis id', async () => {
      const page = payload(await call('carol', FIORI, 'queryProposals', { analysisRunId: ids.analysis, top: 2, includeSummary: false }));
      expect(page.Items).to.have.length(2);
      expect(page.HasMore).to.equal(true);
      expect(page.Summary).to.equal(null);
      expectStatus(await call('carol', FIORI, 'queryProposals', {}), 400, 'no analysis');
    });

    it('readProposal returns the proposal with its evidence and comments', async () => {
      const response = await fn('carol', FIORI, 'readProposal', { proposalId: ids.proposals[0] });
      expectStatus(response, 200, 'read');
      const detail = payload(response);
      expect(detail.proposal.ID).to.equal(ids.proposals[0]);
      expect(detail.evidence).to.be.an('array');
      expect(detail.comments).to.be.an('array');
      expectStatus(await fn('carol', FIORI, 'readProposal', { proposalId: randomUUID() }), 404, 'unknown');
    });

    it('a Member cannot decide; an Approver approves and the decision is audited', async () => {
      expectStatus(await call('carol', FIORI, 'approveProposal', { proposalId: ids.proposals[0] }), 403, 'member');
      const response = await call('bob', FIORI, 'approveProposal', { proposalId: ids.proposals[0], notes: 'fits wave 1' });
      expectStatus(response, 200, 'approve');
      expect(response.data.ReviewStatus).to.equal('APPROVED');
      expect(response.data.DecidedBy).to.equal('bob');
      expect(response.data.DecisionNotes).to.equal('fits wave 1');
      const audit = await SELECT.one.from('adops.db.AuditEvents')
        .where({ EventType: 'PROPOSAL_APPROVED', ObjectId: ids.proposals[0] });
      expect(audit, 'audit event').to.exist;
      expect(audit.UserId).to.equal('bob');
      expect(audit.AfterValue).to.equal('APPROVED');
      expectStatus(await call('bob', FIORI, 'approveProposal', { proposalId: randomUUID() }), 404, 'unknown');
    });

    it('a rejection requires a reason; deferral carries the target wave label', async () => {
      expectStatus(await call('bob', FIORI, 'rejectProposal', { proposalId: ids.proposals[1] }), 400, 'no reason');
      const rejected = await call('bob', FIORI, 'rejectProposal', { proposalId: ids.proposals[1], notes: 'no equivalent in scope' });
      expectStatus(rejected, 200, 'reject');
      expect(rejected.data.ReviewStatus).to.equal('REJECTED');

      const deferred = await call('bob', FIORI, 'deferProposal', { proposalId: ids.proposals[2], notes: 'later', targetWave: 'Wave 2' });
      expectStatus(deferred, 200, 'defer');
      expect(deferred.data.ReviewStatus).to.equal('DEFERRED');
      expect(deferred.data.TargetWave).to.equal('Wave 2');
    });

    it('bulkDecideProposals validates the decision and counts decided versus skipped rows', async () => {
      expectStatus(await call('bob', FIORI, 'bulkDecideProposals', { proposalIds: [ids.proposals[3]], decision: 'MAYBE' }), 400, 'bad decision');
      const response = await call('bob', FIORI, 'bulkDecideProposals', {
        proposalIds: [ids.proposals[3], ids.proposals[4] || ids.proposals[3], randomUUID()], decision: 'APPROVED', notes: 'bulk'
      });
      expectStatus(response, 200, 'bulk');
      const result = payload(response);
      expect(result.skipped).to.equal(1);
      expect(result.decided).to.equal(ids.proposals[4] ? 2 : 1);
      const row = await SELECT.one.from('adops.db.AppProposals').where({ ID: ids.proposals[3] });
      expect(row.ReviewStatus).to.equal('APPROVED');
    });

    it('addProposalComment stores a bounded note visible on readProposal', async () => {
      expectStatus(await call('carol', FIORI, 'addProposalComment', { proposalId: ids.proposals[0], commentText: '  ' }), 400, 'empty');
      expectStatus(await call('carol', FIORI, 'addProposalComment', { proposalId: randomUUID(), commentText: 'x' }), 404, 'unknown');
      const response = await call('carol', FIORI, 'addProposalComment', { proposalId: ids.proposals[0], commentText: 'Checked with the SD team.' });
      expectStatus(response, 200, 'comment');
      expect(response.data.Author).to.equal('carol');
      expect(response.data.CommentType).to.equal('NOTE');
      const detail = payload(await fn('carol', FIORI, 'readProposal', { proposalId: ids.proposals[0] }));
      expect(detail.comments.map((c) => c.CommentText)).to.include('Checked with the SD team.');
    });

    it('queryProposals filters by review status and the summary matches', async () => {
      const approved = payload(await call('carol', FIORI, 'queryProposals', { analysisRunId: ids.analysis, reviewStatus: 'APPROVED', top: 500 }));
      expect(approved.Items.length).to.be.at.least(2);
      for (const item of approved.Items) expect(item.ReviewStatus).to.equal('APPROVED');
      expect(approved.Summary.approved).to.equal(approved.Items.length);
      expect(approved.Summary.rejected).to.equal(1);
      expect(approved.Summary.deferred).to.equal(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('adoption waves', () => {
    it('createAdoptionWave validates name and system and refuses duplicates', async () => {
      expectStatus(await call('bob', FIORI, 'createAdoptionWave', { targetSystemId: ids.dev, name: '  ' }), 400, 'no name');
      expectStatus(await call('bob', FIORI, 'createAdoptionWave', { targetSystemId: randomUUID(), name: 'Wave X' }), 404, 'unknown system');
      const response = await call('bob', FIORI, 'createAdoptionWave', { targetSystemId: ids.dev, name: 'Wave 1', description: 'Sales first' });
      expectStatus(response, 200, 'create');
      expect(response.data.Status).to.equal('PLANNED');
      ids.wave = response.data.ID;
      expectStatus(await call('bob', FIORI, 'createAdoptionWave', { targetSystemId: ids.dev, name: 'Wave 1' }), 409, 'duplicate');
      const empty = await call('bob', FIORI, 'createAdoptionWave', { targetSystemId: ids.dev, name: 'Wave empty' });
      expectStatus(empty, 200, 'second wave');
      ids.emptyWave = empty.data.ID;
    });

    it('assignProposalsToWave links members and the wave read rolls them up', async () => {
      const approved = payload(await call('carol', FIORI, 'queryProposals', { analysisRunId: ids.analysis, reviewStatus: 'APPROVED', top: 500 })).Items;
      ids.approved = approved.map((p) => p.ID);
      const response = await call('bob', FIORI, 'assignProposalsToWave', { waveId: ids.wave, proposalIds: [...ids.approved, ids.proposals[1]] });
      expectStatus(response, 200, 'assign');
      expect(payload(response).changed).to.equal(ids.approved.length + 1);
      expectStatus(await call('bob', FIORI, 'assignProposalsToWave', { waveId: randomUUID(), proposalIds: ids.approved }), 404, 'unknown wave');
      expect(payload(await call('bob', FIORI, 'assignProposalsToWave', { waveId: ids.wave, proposalIds: [] })).changed).to.equal(0);

      const detail = payload(await fn('carol', FIORI, 'readAdoptionWave', { waveId: ids.wave }));
      expect(detail.Wave.ID).to.equal(ids.wave);
      expect(detail.Proposals.map((p) => p.ID)).to.include.members(ids.approved);
      expect(detail.Rollup.approved).to.equal(ids.approved.length);
      expect(detail.Rollup.rejected).to.equal(1);
      expect(detail.Rollup.appCount).to.equal(ids.approved.length + 1);
      expect(detail.Plans).to.deep.equal([]);
      expectStatus(await fn('carol', FIORI, 'readAdoptionWave', { waveId: randomUUID() }), 404, 'unknown');
    });

    it('removeProposalsFromWave unlinks only members of that wave', async () => {
      const response = await call('bob', FIORI, 'removeProposalsFromWave', { waveId: ids.wave, proposalIds: [ids.proposals[1], ids.proposals[2]] });
      expectStatus(response, 200, 'remove');
      expect(payload(response).changed).to.equal(1, 'the deferred proposal was never a member');
      const list = payload(await fn('carol', FIORI, 'queryAdoptionWaves', { targetSystemId: ids.dev }));
      const wave = list.Items.find((w) => w.ID === ids.wave);
      expect(wave.Rollup.appCount).to.equal(ids.approved.length);
      expect(wave.Rollup.rejected).to.equal(0);
      expect(list.Items.find((w) => w.ID === ids.emptyWave).Rollup).to.equal(null);
    });

    it('a decision with a wave label links the wave row as well', async () => {
      const response = await call('bob', FIORI, 'approveProposal', { proposalId: ids.proposals[2], notes: 'moved up', targetWave: 'Wave 1' });
      expectStatus(response, 200, 'approve into wave');
      expect(response.data.wave_ID).to.equal(ids.wave);
      ids.approved.push(ids.proposals[2]);
    });

    it('deleting a wave unlinks its proposals instead of deleting them', async () => {
      const scratch = await call('bob', FIORI, 'createAdoptionWave', { targetSystemId: ids.dev, name: 'Wave scratch' });
      expectStatus(scratch, 200, 'scratch wave');
      await call('bob', FIORI, 'assignProposalsToWave', { waveId: scratch.data.ID, proposalIds: [ids.proposals[1]] });
      const deleted = await test.axios.delete(`${FIORI}/AdoptionWaves(${scratch.data.ID})`, as('bob'));
      expect(deleted.status, JSON.stringify(deleted.data)).to.equal(204);
      const row = await SELECT.one.from('adops.db.AppProposals').where({ ID: ids.proposals[1] });
      expect(row).to.exist;
      expect(row.wave_ID).to.equal(null);
    });
  });

  // ---------------------------------------------------------------------------
  describe('activation plans (Activator)', () => {
    it('createActivationPlan validates wave, approvals, role and target environment', async () => {
      expectStatus(await call('dave', FIORI, 'createActivationPlan', { waveId: randomUUID() }), 404, 'unknown wave');
      expectStatus(await call('dave', FIORI, 'createActivationPlan', { waveId: ids.emptyWave }), 400, 'no approvals');
      expectStatus(await call('bob', FIORI, 'createActivationPlan', { waveId: ids.wave }), 403, 'approver');
      const prd = await call('dave', FIORI, 'createActivationPlan', { waveId: ids.wave, targetSystemId: ids.prd });
      expectStatus(prd, 400, 'PRD target');
      expect(prd.data.error.message).to.include('development systems only');
      expectStatus(await call('dave', FIORI, 'createActivationPlan', { waveId: ids.wave, targetSystemId: randomUUID() }), 404, 'unknown target');
    });

    it('createActivationPlan derives a DRAFT plan with steps for the wave on the DEV system', async () => {
      const response = await call('dave', FIORI, 'createActivationPlan', { waveId: ids.wave, name: 'Journey plan' });
      expectStatus(response, 200, 'create plan');
      const { Plan, Steps, TargetSystem, Wave, Runs } = payload(response);
      expect(Plan.Status).to.equal('DRAFT');
      expect(Plan.Name).to.equal('Journey plan');
      expect(Plan.StepCount).to.equal(Steps.length);
      expect(Steps.length).to.be.greaterThan(3);
      expect(Steps.map((s) => s.SequenceNo)).to.deep.equal(Steps.map((_, i) => i + 1));
      expect(TargetSystem.ID).to.equal(ids.dev);
      expect(Wave.ID).to.equal(ids.wave);
      expect(Runs).to.deep.equal([]);
      ids.plan = Plan.ID;
      ids.steps = Steps;
    });

    it('readActivationPlan and queryActivationPlans expose the plan without step keys', async () => {
      expectStatus(await fn('carol', FIORI, 'readActivationPlan', { planId: randomUUID() }), 404, 'unknown plan');
      const detail = payload(await fn('carol', FIORI, 'readActivationPlan', { planId: ids.plan }));
      expect(detail.Plan.ID).to.equal(ids.plan);
      expect(detail.Steps).to.have.length(ids.steps.length);

      const list = payload(await fn('carol', FIORI, 'queryActivationPlans', { targetSystemId: ids.dev }));
      const row = list.Items.find((p) => p.ID === ids.plan);
      expect(row, 'plan listed').to.exist;
      expect(row).to.not.have.property('Steps');
      expect(list.Summary).to.be.an('object');
      const total = Object.values(list.Summary).filter((v) => typeof v === 'number').reduce((a, b) => a + b, 0);
      expect(total).to.be.at.least(list.Count);
    });

    it('executeActivationPlan refuses a DRAFT plan until it is simulated', async () => {
      const response = await call('dave', FIORI, 'executeActivationPlan', { planId: ids.plan });
      expectStatus(response, 400, 'draft');
      expect(response.data.error.message).to.include('Simulate');
      expectStatus(await call('dave', FIORI, 'executeActivationPlan', { planId: randomUUID() }), 404, 'unknown');
    });

    it('simulateActivationPlan gives every step a verdict and marks the plan SIMULATED', async () => {
      expectStatus(await call('dave', FIORI, 'simulateActivationPlan', { planId: randomUUID() }), 404, 'unknown');
      expectStatus(await call('bob', FIORI, 'simulateActivationPlan', { planId: ids.plan }), 403, 'approver');
      const response = await call('dave', FIORI, 'simulateActivationPlan', { planId: ids.plan });
      expectStatus(response, 200, 'simulate');
      const { Plan, Steps } = payload(response);
      expect(Plan.Status).to.equal('SIMULATED');
      expect(Plan.SimulatedBy).to.equal('dave');
      for (const step of Steps) {
        expect(step.Status, `${step.StepType} ${step.ObjectName}`).to.match(/^SIMULATED_/);
        expect(step.SimulationMessage).to.be.a('string').and.not.equal('');
      }
    });

    it('executeActivationPlan queues one execution task, idempotently while it is open', async () => {
      // The mock execution finishes faster than a second HTTP call arrives,
      // so the "still open" path is exercised with a live-looking task row
      // (fresh heartbeat: the runner leaves it alone) that the handler must
      // hand back instead of enqueuing a duplicate.
      const now = new Date().toISOString();
      const openId = randomUUID();
      await INSERT.into('adops.db.BackgroundTasks').entries({
        ID: openId, TenantId: 'GLOBAL', targetSystem_ID: ids.dev, TaskType: 'ACTIVATION_EXECUTION',
        ObjectType: 'ActivationPlans', ObjectId: ids.plan, Status: 'RUNNING', Phase: 'pretend',
        QueuedAt: now, ClaimedAt: now, HeartbeatAt: now, ClaimedBy: 'test', AttemptCount: 1, MaxAttempts: 1
      });
      const whileOpen = await call('dave', FIORI, 'executeActivationPlan', { planId: ids.plan });
      expectStatus(whileOpen, 200, 'while open');
      expect(whileOpen.data.taskId).to.equal(openId);
      expect(whileOpen.data.status).to.equal('RUNNING');
      await DELETE.from('adops.db.BackgroundTasks').where({ ID: openId });

      const first = await call('dave', FIORI, 'executeActivationPlan', { planId: ids.plan });
      expectStatus(first, 200, 'execute');
      ids.runTask = first.data.taskId;
      expect(ids.runTask).to.not.equal(openId);

      const done = await waitForTask('dave', ids.runTask, 30000);
      expect(done.status, done.errorText).to.equal('SUCCEEDED');
      const plan = await SELECT.one.from('adops.db.ActivationPlans').where({ ID: ids.plan });
      expect(plan.Status).to.equal('COMPLETED');
      expect(plan.ExecutedBy).to.equal('dave');
      expect(plan.transportRequest_ID, 'transport row linked').to.be.a('string');

      const finished = await call('dave', FIORI, 'executeActivationPlan', { planId: ids.plan });
      expectStatus(finished, 400, 'completed plan');
      expect(finished.data.error.message).to.include('COMPLETED');
    });

    it('the run monitor reads the run, its steps, logs and step messages', async () => {
      expectStatus(await fn('carol', FIORI, 'readActivationRun', { runId: randomUUID() }), 404, 'unknown run');
      const detail = payload(await fn('carol', FIORI, 'readActivationRun', { runId: ids.runTask }));
      expect(detail.Run.Status).to.equal('SUCCEEDED');
      expect(detail.Run).to.not.have.property('ResultJson');
      expect(detail.Plan.ID).to.equal(ids.plan);
      expect(detail.Steps).to.have.length(ids.steps.length);
      for (const step of detail.Steps) expect(['SUCCESS', 'WARNING', 'SKIPPED'], `${step.StepType}`).to.include(step.Status);
      expect(detail.Logs.length).to.be.greaterThan(0);
      expect(detail.TargetSystem.ID).to.equal(ids.dev);

      const list = payload(await fn('carol', FIORI, 'queryActivationRuns', { targetSystemId: ids.dev }));
      expect(list.Items.map((r) => r.ID)).to.include(ids.runTask);
      expect(list.Summary).to.be.an('object');

      const transportStep = detail.Steps.find((s) => s.StepType === 'ADD_TO_TRANSPORT');
      const messages = payload(await fn('carol', FIORI, 'readActivationStepMessages', { stepId: transportStep.ID }));
      expect(messages.StepId).to.equal(transportStep.ID);
      expect(messages.Messages).to.be.an('array');
      expectStatus(await fn('carol', FIORI, 'readActivationStepMessages', { stepId: randomUUID() }), 404, 'unknown step');
      ids.runSteps = detail.Steps;
    });

    it('readActivationManifest renders the plan for QA/PROD replay', async () => {
      expectStatus(await fn('carol', FIORI, 'readActivationManifest', { planId: randomUUID() }), 404, 'unknown');
      const { Manifest, Markdown } = payload(await fn('carol', FIORI, 'readActivationManifest', { planId: ids.plan }));
      expect(Manifest).to.be.an('object');
      expect(Markdown).to.be.a('string').and.include('Journey plan');
    });

    it('operator skip and rollback are gated by the step state and the Activator role', async () => {
      expectStatus(await fn('dave', FIORI, 'readActivationPlan', { planId: ids.plan }), 200);
      expectStatus(await call('dave', FIORI, 'skipActivationStep', { stepId: randomUUID(), reason: 'x' }), 404, 'unknown step');
      expectStatus(await call('dave', FIORI, 'rollbackActivationStep', { stepId: randomUUID(), reason: 'x' }), 404, 'unknown step');
      const done = ids.runSteps.find((s) => s.Status === 'SUCCESS');
      expectStatus(await call('bob', FIORI, 'skipActivationStep', { stepId: done.ID, reason: 'x' }), 403, 'approver');
      const skip = await call('dave', FIORI, 'skipActivationStep', { stepId: done.ID, reason: 'already done' });
      expectStatus(skip, 400, 'nothing to skip');
      expect(skip.data.error.message).to.include('nothing to skip');

      const role = ids.runSteps.find((s) => s.StepType === 'CREATE_PFCG_ROLE' && s.Status === 'SUCCESS');
      expect(role, 'a successful role step').to.exist;
      const rollback = await call('dave', FIORI, 'rollbackActivationStep', { stepId: role.ID, reason: 'wrong role name' });
      expectStatus(rollback, 200, 'rollback');
      const result = payload(rollback);
      expect(result.StepId).to.equal(role.ID);
      expect(result.StepStatus).to.equal('ROLLED_BACK');
      expect(result.PlanStatus).to.not.equal('COMPLETED');
    });
  });

  // ---------------------------------------------------------------------------
  describe('transports', () => {
    it('queryTransportRequests labels the plan, wave and system in one pass', async () => {
      const list = payload(await fn('carol', FIORI, 'queryTransportRequests', { targetSystemId: ids.dev }));
      const plan = await SELECT.one.from('adops.db.ActivationPlans').where({ ID: ids.plan });
      const row = list.Items.find((t) => t.ID === plan.transportRequest_ID);
      expect(row, 'transport listed').to.exist;
      expect(row.PlanName).to.equal('Journey plan');
      expect(row.WaveName).to.equal('Wave 1');
      expect(row.TargetSystemName).to.equal('Journey DEV (DEV)');
      expect(row.Status).to.equal('MODIFIABLE');
      expect(row.TransportRequestId).to.match(/^[A-Z0-9]{3}K9\d{5}$/);
      ids.transport = row.ID;
    });

    it('releaseTransport simulates without changing state, then releases once', async () => {
      expectStatus(await call('dave', FIORI, 'releaseTransport', { transportId: randomUUID() }), 404, 'unknown');
      expectStatus(await call('carol', FIORI, 'releaseTransport', { transportId: ids.transport }), 403, 'member');

      const simulated = payload(await call('dave', FIORI, 'releaseTransport', { transportId: ids.transport, simulate: true }));
      expect(simulated.Simulated).to.equal(true);
      expect(simulated.Status).to.equal('MODIFIABLE');
      expect(simulated.StepStatus).to.equal('SUCCESS');

      const released = payload(await call('dave', FIORI, 'releaseTransport', { transportId: ids.transport }));
      expect(released.Status).to.equal('RELEASED');
      const row = await SELECT.one.from('adops.db.TransportRequests').where({ ID: ids.transport });
      expect(row.ReleasedBy).to.equal('dave');
      expect(row.ReleasedAt).to.be.a('string');
      expect(row.ReleaseLogText).to.include('released');

      const again = payload(await call('dave', FIORI, 'releaseTransport', { transportId: ids.transport }));
      expect(again.Status).to.equal('RELEASED');
      expect(again.Messages[0].message).to.include('already released');
    });

    it('releaseTransport refuses a row without a TRKORR', async () => {
      const id = randomUUID();
      await INSERT.into('adops.db.TransportRequests').entries({ ID: id, targetSystem_ID: ids.dev, TenantId: 'GLOBAL', Status: 'MODIFIABLE' });
      const response = await call('dave', FIORI, 'releaseTransport', { transportId: id });
      expectStatus(response, 400, 'no trkorr');
      expect(response.data.error.message).to.include('TRKORR');
    });
  });

  // ---------------------------------------------------------------------------
  describe('AdminService', () => {
    it('is closed to non-administrators', async () => {
      expectStatus(await fn('carol', ADMIN, 'getBtpAccountInfo'), 403, 'member');
      expectStatus(await fn('bob', ADMIN, 'getBtpAccountInfo'), 403, 'approver');
    });

    it('reports the BTP account as unavailable and lists no destinations without a binding', async () => {
      const account = await fn('alice', ADMIN, 'getBtpAccountInfo');
      expectStatus(account, 200, 'account');
      expect(payload(account)).to.deep.equal({ Available: false, Subdomain: '', TenantId: '', Region: '' });
      const destinations = await fn('alice', ADMIN, 'listBtpDestinations');
      expect(destinations.status, 'fails cleanly without a destination binding').to.be.at.least(400);
      expect(destinations.data.error?.message).to.be.a('string');
    });

    it('testS4Destination stays a lax proxy and checkTargetSystemConnection a verdict', async () => {
      expectStatus(await call('alice', ADMIN, 'testS4Destination', {}), 400, 'no destination');
      const proxied = payload(await call('alice', ADMIN, 'testS4Destination', { destinationName: 'JRN_DEV_100', path: '/anything' }));
      expect(proxied.ok).to.equal(true);
      expect(proxied.status).to.equal(200);
      expect(proxied.data.message).to.include('mocked');
      expectStatus(await call('alice', ADMIN, 'checkTargetSystemConnection', {}), 400, 'no destination');
      const verdict = await call('alice', ADMIN, 'checkTargetSystemConnection', { destinationName: 'JRN_DEV_100' });
      expectStatus(verdict, 200, 'verdict');
      expect(verdict.data.Ok).to.equal(true);
    });

    it('upsertOverlayMapping creates a CUSTOMER row once and updates it in place; suppress marks it', async () => {
      const input = { transactionCode: 'ZJRN1', fioriId: 'F9999', appTitle: 'Journey app', mappingType: 'DIRECT', coveragePercent: 80, lineOfBusiness: 'SD', persona: 'Sales rep', valueRationale: 'pilot' };
      const created = await call('alice', ADMIN, 'upsertOverlayMapping', input);
      expectStatus(created, 200, 'create');
      expect(created.data.MappingKey).to.equal('ZJRN1::F9999');
      expect(created.data.Origin).to.equal('CUSTOMER');
      expect(created.data.Revision).to.equal(1);
      expect(created.data.Active).to.equal(true);

      const updated = await call('alice', ADMIN, 'upsertOverlayMapping', { ...input, appTitle: 'Journey app v2' });
      expectStatus(updated, 200, 'update');
      expect(updated.data.ID).to.equal(created.data.ID);
      expect(updated.data.AppTitle).to.equal('Journey app v2');
      const rows = await SELECT.from('adops.db.AppMappingOverlay').where({ MappingKey: 'ZJRN1::F9999' });
      expect(rows).to.have.length(1);

      expectStatus(await call('alice', ADMIN, 'suppressOverlayMapping', { ID: randomUUID(), reason: 'x' }), 404, 'unknown');
      const suppressed = await call('alice', ADMIN, 'suppressOverlayMapping', { ID: created.data.ID, reason: 'not licensed' });
      expectStatus(suppressed, 200, 'suppress');
      expect(suppressed.data.Suppressed).to.equal(true);
      expect(suppressed.data.SuppressReason).to.equal('not licensed');
    });

    it('runTelemetryCleanup answers the cleanup counters', async () => {
      const response = await call('alice', ADMIN, 'runTelemetryCleanup', {});
      expectStatus(response, 200, 'cleanup');
      expect(response.data).to.include.keys('usageDeleted', 'performanceDeleted', 'errorsDeleted');
      expect(response.data.usageDeleted).to.be.a('number');
    });

    it('purgeExtractionRun removes the imported run with its snapshots and usage rows', async () => {
      expectStatus(await call('alice', ADMIN, 'purgeExtractionRun', { runId: randomUUID() }), 404, 'unknown');
      const before = await SELECT.from('adops.db.UsageSnapshots').where({ extractionRun_ID: ids.importedRun });
      expect(before.length).to.be.greaterThan(0);
      const response = await call('alice', ADMIN, 'purgeExtractionRun', { runId: ids.importedRun });
      expectStatus(response, 200, 'purge');
      expect(response.data.snapshotsDeleted).to.equal(before.length);
      expect(response.data.transactionsDeleted).to.equal(2);
      expect(await SELECT.one.from('adops.db.ExtractionRuns').where({ ID: ids.importedRun })).to.equal(undefined);
      expect(await SELECT.from('adops.db.TransactionUsage').where({ snapshot_ID: { in: before.map((s) => s.ID) } })).to.have.length(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('CoreService (self-service)', () => {
    it('userInfo reflects the caller and the role scopes', async () => {
      const response = await fn('carol', CORE, 'userInfo');
      expectStatus(response, 200, 'userInfo');
      expect(response.data.user).to.equal('carol');
      expect(response.data.tier).to.equal('basic');
      expect(response.data.scopes).to.include({ authenticated: true, Member: true, Approver: false, Activator: false, Admin: false });
      const admin = await fn('alice', CORE, 'userInfo');
      expect(admin.data.scopes).to.include({ Admin: true, Activator: true });
    });

    it('a user without any role reaches CoreService but not PublicService', async () => {
      expectStatus(await fn('eve', CORE, 'userInfo'), 200, 'core');
      expectStatus(await test.axios.get(`${FIORI}/TargetSystems`, as('eve')), 403, 'fiori');
    });

    it('getTelemetrySettings returns the effective flags and thresholds', async () => {
      const response = await fn('carol', CORE, 'getTelemetrySettings');
      expectStatus(response, 200, 'settings');
      expect(response.data).to.include.keys('feedbackEnabled', 'usageEnabled', 'crashReportingEnabled', 'performanceEnabled', 'slowRouteThresholdMs');
      expect(response.data.feedbackEnabled).to.equal(true);
    });

    it('submitPilotFeedback validates and files a NEW item that an Administrator triages', async () => {
      expectStatus(await call('carol', CORE, 'submitPilotFeedback', { description: 'no title' }), 400, 'no title');
      expectStatus(await call('carol', CORE, 'submitPilotFeedback', { title: 't', description: 'd', category: 'NONSENSE' }), 400, 'bad category');
      const response = await call('carol', CORE, 'submitPilotFeedback', {
        category: 'USABILITY', title: 'Filter is hard to find', description: 'The usage filter hides behind a menu.', impact: 'MEDIUM', route: '/usage'
      });
      expectStatus(response, 200, 'submit');
      expect(response.data.status).to.equal('NEW');
      expect(response.data.referenceNumber).to.be.a('string').and.not.equal('');

      expectStatus(await call('carol', ADMIN, 'updateFeedbackTriage', { ID: response.data.ID, status: 'PLANNED' }), 403, 'member');
      expectStatus(await call('alice', ADMIN, 'updateFeedbackTriage', { ID: randomUUID(), status: 'PLANNED' }), 404, 'unknown');
      expectStatus(await call('alice', ADMIN, 'updateFeedbackTriage', { ID: response.data.ID, status: 'WHENEVER' }), 400, 'bad status');
      const triaged = await call('alice', ADMIN, 'updateFeedbackTriage', { ID: response.data.ID, status: 'UNDER_REVIEW', assignedTo: 'alice', adminNotes: 'looking' });
      expectStatus(triaged, 200, 'triage');
      expect(triaged.data.Status).to.equal('UNDER_REVIEW');
      expect(triaged.data.AssignedTo).to.equal('alice');
    });
  });

  // ---------------------------------------------------------------------------
  describe('access requests end to end', () => {
    it('submitAccessRequest validates, files once and lists for the requester', async () => {
      expectStatus(await call('carol', CORE, 'submitAccessRequest', { requestedArea: 'kitchen', requestedRole: 'Admin', justification: 'x' }), 400, 'bad area');
      expectStatus(await call('carol', CORE, 'submitAccessRequest', { requestedArea: 'settings', requestedRole: 'Owner', justification: 'x' }), 400, 'bad role');
      expectStatus(await call('carol', CORE, 'submitAccessRequest', { requestedArea: 'settings', requestedRole: 'Admin' }), 400, 'no justification');
      expectStatus(await call('carol', CORE, 'submitAccessRequest', { requestedArea: 'settings', requestedRole: 'Admin', justification: 'x', urgency: 'NOW' }), 400, 'bad urgency');

      const first = await call('carol', CORE, 'submitAccessRequest', { requestedArea: 'product-insights', requestedRole: 'Admin', justification: 'I triage feedback for the pilot.', urgency: 'HIGH' });
      expectStatus(first, 200, 'submit');
      expect(first.data.status).to.equal('PENDING');
      expect(first.data.referenceNumber).to.match(/^AR/);
      ids.accessRequest = first.data.ID;
      const again = await call('carol', CORE, 'submitAccessRequest', { requestedArea: 'product-insights', requestedRole: 'Admin', justification: 'resubmitted' });
      expect(again.data.ID, 'pending duplicate returns the same request').to.equal(ids.accessRequest);

      const mine = await fn('carol', CORE, 'getMyAccessRequests');
      expectStatus(mine, 200, 'mine');
      const row = mine.data.value.find((r) => r.ID === ids.accessRequest);
      expect(row).to.include({ requestedArea: 'product-insights', requestedRole: 'Admin', status: 'PENDING' });
      const audit = await SELECT.one.from('adops.db.AuditEvents').where({ EventType: 'ACCESS_REQUEST_SUBMITTED', ObjectId: ids.accessRequest });
      expect(audit, 'submission audited').to.exist;
    });

    it('the Administrator sees the summary and decides; the grant falls back to MANUAL without XSUAA', async () => {
      const summary = await fn('alice', ADMIN, 'queryAccessRequestSummary');
      expectStatus(summary, 200, 'summary');
      expect(summary.data.Pending).to.be.at.least(1);
      expect(summary.data.Total).to.equal(summary.data.Pending + summary.data.Approved + summary.data.Declined + summary.data.Other);

      expectStatus(await call('carol', ADMIN, 'decideAccessRequest', { ID: ids.accessRequest, decision: 'APPROVE' }), 403, 'member');
      expectStatus(await call('alice', ADMIN, 'decideAccessRequest', { ID: randomUUID(), decision: 'APPROVE' }), 404, 'unknown');
      expectStatus(await call('alice', ADMIN, 'decideAccessRequest', { ID: ids.accessRequest, decision: 'MAYBE' }), 400, 'bad decision');

      const decided = await call('alice', ADMIN, 'decideAccessRequest', { ID: ids.accessRequest, decision: 'approve', decisionNotes: 'ok for the pilot', grantRole: true });
      expectStatus(decided, 200, 'approve');
      expect(decided.data.Status).to.equal('APPROVED');
      expect(decided.data.GrantStatus).to.equal('MANUAL');
      expect(decided.data.DecidedBy).to.equal('alice');

      const twice = await call('alice', ADMIN, 'decideAccessRequest', { ID: ids.accessRequest, decision: 'DECLINE' });
      expectStatus(twice, 400, 'already decided');
      const mine = await fn('carol', CORE, 'getMyAccessRequests');
      expect(mine.data.value.find((r) => r.ID === ids.accessRequest)).to.include({ status: 'APPROVED', grantStatus: 'MANUAL' });
      const audit = await SELECT.one.from('adops.db.AuditEvents').where({ EventType: 'ACCESS_REQUEST_APPROVED', ObjectId: ids.accessRequest });
      expect(audit.AfterValue).to.equal('APPROVED/MANUAL');
    });
  });
});
