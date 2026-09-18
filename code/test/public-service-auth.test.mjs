// PublicService write authorization (roadmap A3).
//
// Every /fiori projection is read-only over OData; business writes go through
// the role-gated actions. This suite drives the real service over HTTP with
// the mocked users (alice = all roles, bob = Approver+Member, dave =
// Activator+Member, carol = Member) so a regression that reopens a direct
// PATCH/POST path fails here, not in a customer system.
//
// The CAP server, the in-memory database pin and the mocked-user helpers are
// shared with the other HTTP suites via test/helpers/cds-http-test.mjs (one
// cds.test server per mocha process).
import { expect } from 'chai';
import { test, as, json, REFUSED, expectInMemoryDb } from './helpers/cds-http-test.mjs';

describe('PublicService write authorization', function () {
  this.timeout(30000);

  let systemId;

  before(async () => {
    // Never let this suite touch the developer's sqlite file.
    expectInMemoryDb();

    // Admin registers the target system every other check hangs off.
    const created = await test.axios.post('/fiori/TargetSystems', {
      // Distinct destination: the audit-chain suite registers RD1_DEV in the
      // same in-memory db, and a destination is unique per tenant (O11).
      displayName: 'RD1 Development', destinationName: 'RD1_DEV_AUTH', systemId: 'RD1', client: '100', environment: 'DEV'
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
