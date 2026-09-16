// Append-only, hash-chained audit log (roadmap A4).
//
// Drives the real services over HTTP with the mocked users (alice = all
// roles, carol = Member) and the database service directly, so the three
// acceptance checks fail here rather than in a customer system:
//   1. UPDATE/DELETE on AuditEvents are refused - over OData on both services
//      and for CQN issued from inside the server.
//   2. verifyAuditChain() answers OK for a clean chain and BROKEN, with the
//      first offending Sequence, once a row is altered behind the guard.
//   3. Toggling identifiedUsageAllowed on a target system emits an event.
//
// The CAP server, the in-memory database pin and the mocked-user helpers are
// shared with the other HTTP suites via test/helpers/cds-http-test.mjs. The
// database is shared too, so chain positions are asserted relative to the
// rows already present, never as absolute numbers.
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { cds, test, as, json, REFUSED, expectInMemoryDb } from './helpers/cds-http-test.mjs';

const require = createRequire(import.meta.url);
const { appendAuditEvent, verifyAuditChain, computeAuditHash, GENESIS_HASH } = require('../srv/srv/utils/audit-chain.js');
const { IDENTIFIED_USAGE_EVENT_TYPE } = require('../srv/srv/utils/target-system-audit.js');

const HEX64 = /^[0-9a-f]{64}$/;

async function auditRows(where) {
  return SELECT.from('adops.db.AuditEvents').where(where).orderBy('Sequence asc');
}

// cds.ql statements are thenables without .catch(); await them and return the error.
async function rejectionOf(statement) {
  try {
    await statement;
    return undefined;
  } catch (error) {
    return error;
  }
}

// Raw SQL: no CQN target, so the database guard cannot see it - by design.
const rawSql = (sql) => cds.db.run(sql);

describe('append-only hash-chained audit log', function () {
  this.timeout(30000);

  let systemId;

  before(async () => {
    expectInMemoryDb();

    const created = await test.axios.post('/fiori/TargetSystems', {
      displayName: 'RD1 Development', destinationName: 'RD1_DEV', systemId: 'RD1', client: '100', environment: 'DEV'
    }, json('alice'));
    expect(created.status, JSON.stringify(created.data)).to.equal(201);
    systemId = created.data.ID;
    expect(created.data.identifiedUsageAllowed).to.equal(false);
  });

  describe('identified usage opt-in is audited', () => {
    it('emits IDENTIFIED_USAGE_CHANGED when an Admin enables identified usage', async () => {
      const patched = await test.axios.patch(`/fiori/TargetSystems(${systemId})`, { identifiedUsageAllowed: true }, json('alice'));
      expect(patched.status, JSON.stringify(patched.data)).to.equal(200);

      const events = await auditRows({ EventType: IDENTIFIED_USAGE_EVENT_TYPE, ObjectId: systemId });
      expect(events.length).to.equal(1);
      const [event] = events;
      expect(event.BeforeValue).to.equal('PSEUDONYMISED');
      expect(event.AfterValue).to.equal('IDENTIFIED');
      expect(event.UserId).to.equal('alice');
      expect(event.Source).to.equal('PublicService');
      expect(event.TargetSystem).to.equal('RD1/100');
      expect(event.Severity).to.equal('WARNING');
      expect(event.Sequence).to.be.at.least(1);
      const [previous] = await auditRows({ TenantId: 'GLOBAL', Sequence: event.Sequence - 1 });
      expect(event.PrevHash).to.equal(previous ? previous.Hash : GENESIS_HASH);
      expect(event.Hash).to.match(HEX64);
      expect(computeAuditHash(event)).to.equal(event.Hash);
    });

    it('stays quiet when the flag is re-sent unchanged or not sent at all', async () => {
      const same = await test.axios.patch(`/fiori/TargetSystems(${systemId})`, { identifiedUsageAllowed: true }, json('alice'));
      expect(same.status).to.equal(200);
      const other = await test.axios.patch(`/fiori/TargetSystems(${systemId})`, { timeZone: 'Europe/Berlin' }, json('alice'));
      expect(other.status).to.equal(200);

      const events = await auditRows({ EventType: IDENTIFIED_USAGE_EVENT_TYPE, ObjectId: systemId });
      expect(events.length).to.equal(1);
    });

    it('audits the switch back to pseudonymised through AdminService as well', async () => {
      const patched = await test.axios.patch(`/catalog/AdminService/TargetSystems(${systemId})`, { identifiedUsageAllowed: false }, json('alice'));
      expect(patched.status, JSON.stringify(patched.data)).to.equal(200);

      const events = await auditRows({ EventType: IDENTIFIED_USAGE_EVENT_TYPE, ObjectId: systemId });
      expect(events.length).to.equal(2);
      expect(events[1].BeforeValue).to.equal('IDENTIFIED');
      expect(events[1].AfterValue).to.equal('PSEUDONYMISED');
      expect(events[1].Source).to.equal('AdminService');
      expect(events[1].Severity).to.equal('INFO');
      expect(events[1].Sequence).to.be.greaterThan(events[0].Sequence);
    });

    it('audits a system that is registered with the opt-in already set', async () => {
      const created = await test.axios.post('/fiori/TargetSystems', {
        displayName: 'RD1 Production', destinationName: 'RD1_PRD', systemId: 'RD1', client: '300', environment: 'PRD',
        identifiedUsageAllowed: true
      }, json('alice'));
      expect(created.status, JSON.stringify(created.data)).to.equal(201);

      const events = await auditRows({ EventType: IDENTIFIED_USAGE_EVENT_TYPE, ObjectId: created.data.ID });
      expect(events.length).to.equal(1);
      expect(events[0].AfterValue).to.equal('IDENTIFIED');
      expect(events[0].ObjectName).to.equal('RD1 Production');
    });
  });

  describe('append-only enforcement', () => {
    let eventId;

    before(async () => {
      const [event] = await auditRows({ TenantId: 'GLOBAL', Sequence: 1 });
      eventId = event.ID;
    });

    it('refuses OData PATCH, DELETE and POST on both projections, even for an Admin', async () => {
      for (const base of ['/fiori/AuditEvents', '/catalog/AdminService/AuditEvents']) {
        const patch = await test.axios.patch(`${base}(${eventId})`, { Message: 'edited' }, json('alice'));
        expect(REFUSED, `PATCH ${base} -> ${patch.status}`).to.include(patch.status);
        const del = await test.axios.delete(`${base}(${eventId})`, as('alice'));
        expect(REFUSED, `DELETE ${base} -> ${del.status}`).to.include(del.status);
        const post = await test.axios.post(base, { EventType: 'FORGED', Message: 'forged' }, json('alice'));
        expect(REFUSED, `POST ${base} -> ${post.status}`).to.include(post.status);
      }
      const rows = await auditRows({ ID: eventId });
      expect(rows[0].Message).to.not.equal('edited');
      expect((await auditRows({ EventType: 'FORGED' })).length).to.equal(0);
    });

    it('keeps the projections readable for an Admin and hides them from a Member on AdminService', async () => {
      const admin = await test.axios.get('/catalog/AdminService/AuditEvents?$top=1', as('alice'));
      expect(admin.status).to.equal(200);
      expect(admin.data.value[0]).to.include.keys('Sequence', 'PrevHash', 'Hash');
      const member = await test.axios.get('/catalog/AdminService/AuditEvents?$top=1', as('carol'));
      expect(member.status).to.equal(403);
      const publicRead = await test.axios.get('/fiori/AuditEvents?$top=1', as('carol'));
      expect(publicRead.status).to.equal(200);
    });

    it('refuses UPDATE, DELETE and UPSERT issued from inside the server', async () => {
      const update = await rejectionOf(UPDATE('adops.db.AuditEvents').set({ Message: 'edited' }).where({ ID: eventId }));
      expect(update?.message, 'UPDATE').to.match(/append-only/);

      const del = await rejectionOf(DELETE.from('adops.db.AuditEvents').where({ ID: eventId }));
      expect(del?.message, 'DELETE').to.match(/append-only/);

      const upsert = await rejectionOf(UPSERT.into('adops.db.AuditEvents').entries({ ID: eventId, Message: 'edited' }));
      expect(upsert?.message, 'UPSERT').to.match(/append-only/);

      const rows = await auditRows({ ID: eventId });
      expect(rows.length).to.equal(1);
      expect(rows[0].Message).to.not.equal('edited');
    });
  });

  describe('chain verification', () => {
    it('answers OK over the events written so far, contiguous from 1', async () => {
      const response = await test.axios.get('/catalog/AdminService/verifyAuditChain()', as('alice'));
      expect(response.status, JSON.stringify(response.data)).to.equal(200);
      const verdict = response.data;
      expect(verdict.Status).to.equal('OK');
      expect(verdict.TenantId).to.equal('GLOBAL');
      expect(verdict.HeadConsistent).to.equal(true);
      expect(verdict.FirstBrokenSequence).to.equal(null);
      expect(verdict.LastHash).to.match(HEX64);

      const rows = await auditRows({ TenantId: 'GLOBAL' });
      expect(verdict.ChainedEvents).to.equal(rows.length);
      expect(verdict.LastSequence).to.equal(rows.length);
      rows.forEach((row, index) => expect(row.Sequence).to.equal(index + 1));
    });

    it('is an Admin function: a Member is refused', async () => {
      const response = await test.axios.get('/catalog/AdminService/verifyAuditChain()', as('carol'));
      expect(response.status).to.equal(403);
    });

    it('never forks the sequence under concurrent appends', async () => {
      const before = (await auditRows({ TenantId: 'GLOBAL' })).length;
      const rows = await Promise.all(Array.from({ length: 25 }, (_, i) => appendAuditEvent({
        EventType: 'TEST_CONCURRENT', ObjectType: 'Test', ObjectName: `event ${i}`, Source: 'audit-chain.test'
      })));
      const sequences = rows.map((r) => r.Sequence).sort((a, b) => a - b);
      expect(new Set(sequences).size).to.equal(25);
      expect(sequences[0]).to.equal(before + 1);
      expect(sequences[24]).to.equal(before + 25);

      const verdict = await verifyAuditChain({ tenantId: 'GLOBAL' });
      expect(verdict.Status, verdict.Message).to.equal('OK');
      expect(verdict.ChainedEvents).to.equal(before + 25);
    });

    it('keeps tenants on separate chains', async () => {
      const first = await appendAuditEvent({ TenantId: 'T2', EventType: 'TEST_TENANT', Source: 'audit-chain.test' });
      const second = await appendAuditEvent({ TenantId: 'T2', EventType: 'TEST_TENANT', Source: 'audit-chain.test' });
      expect(first.Sequence).to.equal(1);
      expect(first.PrevHash).to.equal(GENESIS_HASH);
      expect(second.Sequence).to.equal(2);
      expect(second.PrevHash).to.equal(first.Hash);
      const verdict = await verifyAuditChain({ tenantId: 'T2' });
      expect(verdict.Status).to.equal('OK');
      expect(verdict.ChainedEvents).to.equal(2);
    });

    it('clamps oversized fields instead of failing the write', async () => {
      const row = await appendAuditEvent({
        EventType: 'TEST_CLAMP', Source: 'audit-chain.test',
        Message: 'm'.repeat(2000), SAPResponse: 'r'.repeat(5000), ObjectName: 'n'.repeat(400)
      });
      expect(row.Message.length).to.equal(500);
      expect(row.SAPResponse.length).to.equal(1000);
      expect(row.ObjectName.length).to.equal(160);
      const stored = await auditRows({ ID: row.ID });
      expect(computeAuditHash(stored[0])).to.equal(stored[0].Hash);
    });

    it('reports rows written before the chain existed as unchained, not broken', async () => {
      await INSERT.into('adops.db.AuditEvents').entries({
        ID: cds.utils.uuid(), TenantId: 'GLOBAL', Timestamp: new Date().toISOString(),
        EventType: 'LEGACY_EVENT', Source: 'audit-chain.test'
      });
      const verdict = await verifyAuditChain({ tenantId: 'GLOBAL' });
      expect(verdict.Status, verdict.Message).to.equal('OK');
      expect(verdict.UnchainedEvents).to.equal(1);
      expect(verdict.Message).to.match(/1 legacy event/);
    });

    // Raw SQL bypasses the CQN guard by design (a DBA with table access can
    // always do that); the chain exists so the next verification tells.
    it('detects a row altered behind the guard and names the first broken Sequence', async () => {
      const target = (await auditRows({ TenantId: 'GLOBAL', Sequence: 3 }))[0];
      expect(target, 'fixture: Sequence 3 must exist').to.exist;
      await rawSql(`UPDATE adops_db_AuditEvents SET Message = 'tampered' WHERE ID = '${target.ID}'`);

      const verdict = await verifyAuditChain({ tenantId: 'GLOBAL' });
      expect(verdict.Status).to.equal('BROKEN');
      expect(verdict.FirstBrokenSequence).to.equal(3);
      expect(verdict.HeadConsistent).to.equal(false);
      expect(verdict.Message).to.match(/Hash of Sequence 3/);

      const overHttp = await test.axios.get('/catalog/AdminService/verifyAuditChain()', as('alice'));
      expect(overHttp.status).to.equal(200);
      expect(overHttp.data.Status).to.equal('BROKEN');
      expect(overHttp.data.FirstBrokenSequence).to.equal(3);

      // Later suites sharing this database must not inherit a broken chain.
      await rawSql(`UPDATE adops_db_AuditEvents SET Message = '${String(target.Message || '').replace(/'/g, "''")}' WHERE ID = '${target.ID}'`);
      expect((await verifyAuditChain({ tenantId: 'GLOBAL' })).Status).to.equal('OK');
    });

    it('detects a row removed behind the guard as a sequence gap', async () => {
      const target = (await auditRows({ TenantId: 'T2', Sequence: 1 }))[0];
      await rawSql(`DELETE FROM adops_db_AuditEvents WHERE ID = '${target.ID}'`);
      const verdict = await verifyAuditChain({ tenantId: 'T2' });
      expect(verdict.Status).to.equal('BROKEN');
      expect(verdict.FirstBrokenSequence).to.equal(2);
      expect(verdict.Message).to.match(/expected Sequence 1, found 2/);
    });
  });
});
