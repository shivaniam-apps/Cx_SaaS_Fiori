// PublicService write authorization (roadmap A3).
//
// Every /fiori projection is read-only over OData; business writes go through
// the role-gated actions. This suite drives the real service over HTTP with
// the mocked users (alice = all roles, bob = Approver+Member, dave =
// Activator+Member, carol = Member) so a regression that reopens a direct
// PATCH/POST path fails here, not in a customer system.
//
// NODE_ENV=test makes shouldMockSap() short-circuit every S/4 call. It does
// NOT drop the [development] profile (cds keeps it active outside production),
// whose db points at the shared ../db.sqlite - so the database is forced
// in-memory explicitly below and asserted before any write.
process.env.NODE_ENV = 'test';
process.env.CDS_REQUIRES_DB_KIND = 'sqlite';
process.env.CDS_REQUIRES_DB_CREDENTIALS_URL = ':memory:';

import { expect } from 'chai';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cds = require('@sap/cds');

// Load-order independent: when another suite has already resolved cds.env,
// the process.env overrides above are ignored, so pin the db here as well.
cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'srv');
const test = cds.test(projectDir);

const as = (user) => ({ auth: { username: user, password: '' }, validateStatus: () => true });
const json = (user) => ({ ...as(user), headers: { 'content-type': 'application/json' } });

// @readonly answers 405 (method not allowed) in CAP 8; a role-based @restrict
// denial answers 403. Both mean "the write did not happen".
const REFUSED = [403, 405];

describe('PublicService write authorization', function () {
  this.timeout(30000);

  let systemId;

  before(async () => {
    // Never let this suite touch the developer's sqlite file.
    const url = String(cds.db?.options?.credentials?.url || '');
    expect(url, `database must be in-memory, got "${url}"`).to.match(/memory/);

    // Admin registers the target system every other check hangs off.
    const created = await test.axios.post('/fiori/TargetSystems', {
      displayName: 'RD1 Development', destinationName: 'RD1_DEV', systemId: 'RD1', client: '100', environment: 'DEV'
    }, json('alice'));
    expect(created.status, JSON.stringify(created.data)).to.equal(201);
    systemId = created.data.ID;
  });

  it('keeps every projection readable for a plain Member', async () => {
    for (const entity of ['TargetSystems', 'AppProposals', 'ActivationPlans', 'AdoptionWaves', 'TransportRequests', 'BackgroundTasks']) {
      const response = await test.axios.get(`/fiori/${entity}?$top=1`, as('carol'));
      expect(response.status, entity).to.equal(200);
    }
  });

  it('refuses direct writes to review, plan and execution state for every role', async () => {
    const id = '00000000-0000-0000-0000-000000000001';
    for (const user of ['carol', 'bob', 'dave', 'alice']) {
      const patch = await test.axios.patch(`/fiori/AppProposals(${id})`, { ReviewStatus: 'APPROVED' }, json(user));
      expect(REFUSED, `${user} PATCH AppProposals -> ${patch.status}`).to.include(patch.status);

      const plan = await test.axios.post('/fiori/ActivationPlans', { Name: 'rogue', Status: 'COMPLETED' }, json(user));
      expect(REFUSED, `${user} POST ActivationPlans -> ${plan.status}`).to.include(plan.status);

      const step = await test.axios.patch(`/fiori/ActivationSteps(${id})`, { Status: 'SUCCESS' }, json(user));
      expect(REFUSED, `${user} PATCH ActivationSteps -> ${step.status}`).to.include(step.status);

      const transport = await test.axios.patch(`/fiori/TransportRequests(${id})`, { Status: 'RELEASED' }, json(user));
      expect(REFUSED, `${user} PATCH TransportRequests -> ${transport.status}`).to.include(transport.status);
    }
  });

  it('lets only Admin register or edit target systems', async () => {
    const asMember = await test.axios.post('/fiori/TargetSystems', { displayName: 'rogue', environment: 'DEV' }, json('carol'));
    expect(asMember.status).to.equal(403);
    const asActivator = await test.axios.patch(`/fiori/TargetSystems(${systemId})`, { displayName: 'renamed by dave' }, json('dave'));
    expect(asActivator.status).to.equal(403);

    const asAdmin = await test.axios.patch(`/fiori/TargetSystems(${systemId})`, { displayName: 'RD1 Development (renamed)' }, json('alice'));
    expect(asAdmin.status).to.equal(200);
    const reread = await test.axios.get(`/fiori/TargetSystems(${systemId})`, as('carol'));
    expect(reread.data.displayName).to.equal('RD1 Development (renamed)');
  });

  it('routes wave creation through the Approver action and allows Approver/Activator deletes only', async () => {
    const direct = await test.axios.post('/fiori/AdoptionWaves', { Name: 'rogue wave' }, json('bob'));
    expect(REFUSED, `direct POST AdoptionWaves -> ${direct.status}`).to.include(direct.status);

    const asMember = await test.axios.post('/fiori/createAdoptionWave', { targetSystemId: systemId, name: 'Wave M' }, json('carol'));
    expect(asMember.status).to.equal(403);

    const created = await test.axios.post('/fiori/createAdoptionWave', { targetSystemId: systemId, name: 'Wave A' }, json('bob'));
    expect(created.status, JSON.stringify(created.data)).to.equal(200);
    const payload = typeof created.data.value === 'string' ? JSON.parse(created.data.value) : (created.data.value || created.data);
    const waveId = payload.Wave?.ID || payload.ID;
    expect(waveId, 'wave id').to.be.a('string');

    const memberDelete = await test.axios.delete(`/fiori/AdoptionWaves(${waveId})`, as('carol'));
    expect(memberDelete.status).to.equal(403);
    const approverDelete = await test.axios.delete(`/fiori/AdoptionWaves(${waveId})`, as('bob'));
    expect(approverDelete.status).to.equal(204);
  });

  it('keeps the Approver gate on decisions: Member is refused, Approver reaches the handler', async () => {
    const id = '00000000-0000-0000-0000-000000000002';
    const asMember = await test.axios.post('/fiori/approveProposal', { proposalId: id, notes: null, targetWave: null }, json('carol'));
    expect(asMember.status).to.equal(403);
    const asApprover = await test.axios.post('/fiori/approveProposal', { proposalId: id, notes: null, targetWave: null }, json('bob'));
    expect(asApprover.status, 'handler reached (proposal does not exist)').to.equal(404);
  });

  it('keeps the Activator gate on execution: Approver is refused, Activator reaches the handler', async () => {
    const id = '00000000-0000-0000-0000-000000000003';
    const asApprover = await test.axios.post('/fiori/executeActivationPlan', { planId: id }, json('bob'));
    expect(asApprover.status).to.equal(403);
    const asActivator = await test.axios.post('/fiori/executeActivationPlan', { planId: id }, json('dave'));
    expect(asActivator.status, 'handler reached (plan does not exist)').to.equal(404);
  });
});
