import { expect } from 'chai';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { test, cds, expectInMemoryDb, as, json, REFUSED } from './helpers/cds-http-test.mjs';

const require = createRequire(import.meta.url);
const { INSERT, SELECT } = cds.ql;
const {
  VERIFY_KIND,
  VERDICT,
  IMPORT_STATUS,
  verificationReadFor,
  roleNamesFor,
  importStatusFrom,
  buildVerification,
  mockReaders,
  verifyTransportImport,
  importRowFrom,
  operatorRowFrom
} = require('../srv/srv/utils/transport-verification.js');
const { buildActivationManifest } = require('../srv/srv/utils/activation-manifest.js');
const { deriveActivationSteps } = require('../srv/srv/utils/activation-plan.js');
const { mapTransportStatus, fetchTransportStatus, fetchRolesByName } = require('../srv/srv/utils/s4-fiori-adapter.js');

// ---------------------------------------------------------------------------
// S10: transport verification on follow-on systems (QA, PROD).
// ---------------------------------------------------------------------------

const PROPOSALS = [
  { ID: 'p1', FioriId: 'F3893', BusinessRoleId: 'SAP_BR_INTERNAL_SALES_REP' },
  { ID: 'p2', FioriId: 'F0842A', BusinessRoleId: 'SAP_BR_PURCHASER' }
];
const QAS = { ID: 'qas', displayName: 'RD1 Quality', systemId: 'RD1', client: '200', environment: 'QAS' };

// The planner's steps plus the user-assignment step the manifest knows
// (client-local, emitted once wave user populations are planned): every
// verification kind is covered.
function manifestFixture(planStatus = 'COMPLETED') {
  const { steps } = deriveActivationSteps({ proposals: PROPOSALS, waveName: 'Wave 1' });
  const role = steps.find((s) => s.StepType === 'CREATE_PFCG_ROLE');
  const assign = {
    SequenceNo: steps.length + 1, StepType: 'ASSIGN_ROLE_TO_USERS', ObjectName: role.ObjectName, StepGroup: 'ROLE',
    Transportable: false, LocalReplay: true, ObjectKeyJson: JSON.stringify({ role: role.ObjectName, users: [] })
  };
  return buildActivationManifest({
    plan: { ID: 'plan-1', Name: 'Activation of Wave 1', Status: planStatus, ExecutedBy: 'alice' },
    steps: [...steps, assign].map((s) => ({ ...s, Status: 'SUCCESS' })),
    wave: { ID: 'w1', Name: 'Wave 1' },
    targetSystem: { displayName: 'RD1 Development', systemId: 'RD1', client: '100' },
    transport: { TransportRequestId: 'RD1K900123', Status: 'RELEASED', Description: 'Wave 1' }
  });
}

describe('transport verification: read specs (pure)', () => {
  it('maps every manifest entry to a read-unit check or MANUAL', () => {
    const manifest = manifestFixture();
    const entries = [...manifest.transportable, ...manifest.localReplay];
    expect(entries.length).to.be.at.least(12);
    const kinds = new Map(entries.map((e) => [e.stepType, verificationReadFor(e).kind]));
    expect(kinds.get('CREATE_PFCG_ROLE')).to.equal(VERIFY_KIND.ROLE_EXISTS);
    expect(kinds.get('ADD_SPACE_TO_ROLE')).to.equal(VERIFY_KIND.ROLE_EXISTS);
    expect(kinds.get('GENERATE_PROFILE')).to.equal(VERIFY_KIND.ROLE_EXISTS);
    expect(kinds.get('ASSIGN_ROLE_TO_USERS')).to.equal(VERIFY_KIND.ROLE_HAS_USERS);
    expect(kinds.get('ADD_TO_TRANSPORT')).to.equal(VERIFY_KIND.TRANSPORT_IMPORTED);
    expect(kinds.get('APPEND_TO_TRANSPORT')).to.equal(VERIFY_KIND.TRANSPORT_IMPORTED);
    for (const type of ['ACTIVATE_ICF_NODE', 'ACTIVATE_ODATA_SERVICE', 'RUN_TASK_LIST', 'CREATE_SPACE', 'CREATE_PAGE', 'ASSIGN_PAGE_TO_SPACE']) {
      expect(kinds.get(type), type).to.equal(VERIFY_KIND.MANUAL);
    }
  });

  it('takes the role from the planner key and falls back to the object name', () => {
    expect(verificationReadFor({ stepType: 'CREATE_PFCG_ROLE', object: 'ignored', objectKey: { role: 'z_ado_wave_1' } }).roleName).to.equal('Z_ADO_WAVE_1');
    expect(verificationReadFor({ stepType: 'CREATE_PFCG_ROLE', object: 'Z_OLD_PLAN', objectKey: null }).roleName).to.equal('Z_OLD_PLAN');
    const names = roleNamesFor(manifestFixture());
    expect(names.length).to.be.at.least(1);
    expect(new Set(names).size).to.equal(names.length);
    for (const name of names) expect(name).to.match(/^Z_/);
  });

  it('derives the import status from the TransportStatus read', () => {
    expect(importStatusFrom({ supported: false, row: null }, QAS)).to.include({ status: IMPORT_STATUS.UNKNOWN });
    expect(importStatusFrom({ supported: true, row: null, error: 'boom' }, QAS).detail).to.match(/boom/);
    expect(importStatusFrom({ supported: true, row: null }, QAS)).to.include({ status: IMPORT_STATUS.PENDING });
    expect(importStatusFrom({ supported: true, row: { RequestStatus: 'R', ObjectCount: 7 } }, QAS)).to.include({ status: IMPORT_STATUS.IMPORTED });
    expect(importStatusFrom({ supported: true, row: { RequestStatus: 'R', ObjectCount: 7 } }, QAS).detail).to.match(/7 object/);
    // A modifiable request is the source system answering, not an import.
    const source = importStatusFrom({ supported: true, row: { RequestStatus: 'D' } }, QAS);
    expect(source.status).to.equal(IMPORT_STATUS.PENDING);
    expect(source.detail).to.match(/source system/);
  });
});

describe('transport verification: verdicts (pure)', () => {
  const manifest = manifestFixture();
  const roleName = roleNamesFor(manifest)[0];
  const imported = { status: IMPORT_STATUS.IMPORTED, detail: 'known with status R' };

  it('verifies roles and the transport, leaves the rest MANUAL, and counts add up', () => {
    const verification = buildVerification({
      manifest,
      roles: [{ RoleName: roleName, UserCount: 3, MenuTcodeCount: 5 }],
      importStatus: imported,
      targetSystem: QAS,
      checkedAt: '2026-09-18T08:00:00.000Z'
    });
    const byType = (type) => verification.items.find((i) => i.stepType === type);
    expect(byType('CREATE_PFCG_ROLE')).to.include({ verdict: VERDICT.VERIFIED, kind: VERIFY_KIND.ROLE_EXISTS });
    expect(byType('ADD_SPACE_TO_ROLE').detail).to.match(/Menu node not readable/);
    expect(byType('GENERATE_PROFILE').detail).to.match(/regenerate after import/);
    expect(byType('ASSIGN_ROLE_TO_USERS')).to.include({ verdict: VERDICT.VERIFIED });
    expect(byType('ADD_TO_TRANSPORT')).to.include({ verdict: VERDICT.VERIFIED, transportable: true });
    expect(byType('ACTIVATE_ICF_NODE')).to.include({ verdict: VERDICT.MANUAL, transportable: false });
    expect(byType('ACTIVATE_ICF_NODE').detail).to.match(/SICF/);
    const { verified, notFound, manual, unknown } = verification.counts;
    expect(verified + notFound + manual + unknown).to.equal(verification.items.length);
    expect(unknown).to.equal(0);
    expect(verification.targetSystem).to.deep.equal({ id: 'qas', name: 'RD1 Quality', environment: 'QAS' });
    expect(verification.importStatus).to.equal(IMPORT_STATUS.IMPORTED);
    // Ordered by sequence, like the manifest.
    const sequences = verification.items.map((i) => i.sequence);
    expect(sequences).to.deep.equal([...sequences].sort((a, b) => a - b));
  });

  it('reports NOT_FOUND for missing roles, unassigned roles and a pending transport', () => {
    const verification = buildVerification({
      manifest,
      roles: [{ RoleName: roleName, UserCount: 0 }],
      importStatus: { status: IMPORT_STATUS.PENDING, detail: 'not known (no E070 row)' },
      targetSystem: QAS
    });
    const byType = (type) => verification.items.find((i) => i.stepType === type);
    expect(byType('CREATE_PFCG_ROLE').verdict).to.equal(VERDICT.VERIFIED);
    expect(byType('ASSIGN_ROLE_TO_USERS')).to.include({ verdict: VERDICT.NOT_FOUND });
    expect(byType('ASSIGN_ROLE_TO_USERS').detail).to.match(/client-local/);
    expect(byType('ADD_TO_TRANSPORT')).to.include({ verdict: VERDICT.NOT_FOUND });

    const missing = buildVerification({ manifest, roles: [], importStatus: imported, targetSystem: QAS });
    expect(missing.items.find((i) => i.stepType === 'CREATE_PFCG_ROLE')).to.include({ verdict: VERDICT.NOT_FOUND });
    expect(missing.items.find((i) => i.stepType === 'CREATE_PFCG_ROLE').detail).to.match(/AGR_DEFINE/);
  });

  it('degrades to UNKNOWN when a read fails, never to a false NOT_FOUND', () => {
    const verification = buildVerification({
      manifest,
      roles: [],
      rolesError: 'RoleInventory read failed with status 500',
      importStatus: { status: IMPORT_STATUS.UNKNOWN, detail: 'no TransportStatus entity' },
      targetSystem: QAS
    });
    for (const item of verification.items.filter((i) => i.kind !== VERIFY_KIND.MANUAL)) {
      expect(item.verdict, item.stepType).to.equal(VERDICT.UNKNOWN);
    }
    expect(verification.counts.notFound).to.equal(0);
    expect(verification.counts.unknown).to.be.greaterThan(0);
  });
});

describe('transport verification: run and rows', () => {
  const transport = { ID: 't1', TransportRequestId: 'RD1K900123', Status: 'RELEASED', Owner: 'ALICE', ObjectCount: 4 };

  it('mock readers: a released transport has arrived with its roles, others have not', async () => {
    const released = await verifyTransportImport({ transport, targetSystem: QAS, manifest: manifestFixture(), readers: mockReaders({ transport }) });
    expect(released.importStatus.status).to.equal(IMPORT_STATUS.IMPORTED);
    expect(released.transportStatus.row).to.include({ Trkorr: 'RD1K900123', RequestStatus: 'R', ObjectCount: 4 });
    expect(released.verification.counts.verified).to.be.greaterThan(0);
    expect(released.verification.items.find((i) => i.stepType === 'ASSIGN_ROLE_TO_USERS').verdict).to.equal(VERDICT.NOT_FOUND);

    const modifiable = { ...transport, Status: 'MODIFIABLE' };
    const pending = await verifyTransportImport({ transport: modifiable, targetSystem: QAS, manifest: manifestFixture(), readers: mockReaders({ transport: modifiable }) });
    expect(pending.importStatus.status).to.equal(IMPORT_STATUS.PENDING);
    expect(pending.verification.counts.verified).to.equal(0);
  });

  it('a throwing reader degrades its verdicts and the run still answers', async () => {
    const readers = {
      readTransportStatus: async () => { throw new Error('destination timeout'); },
      readRoles: async () => { throw new Error('RoleInventory 500'); }
    };
    const result = await verifyTransportImport({ transport, targetSystem: QAS, manifest: manifestFixture(), readers });
    expect(result.importStatus.status).to.equal(IMPORT_STATUS.UNKNOWN);
    expect(result.importStatus.detail).to.match(/destination timeout/);
    expect(result.verification.counts.unknown).to.be.greaterThan(0);
    expect(result.verification.counts.verified).to.equal(0);
  });

  it('a transport without a plan verifies the import only', async () => {
    const result = await verifyTransportImport({ transport, targetSystem: QAS, manifest: null, readers: mockReaders({ transport }) });
    expect(result.importStatus.status).to.equal(IMPORT_STATUS.IMPORTED);
    expect(result.verification).to.equal(null);
    const row = importRowFrom({ result, checkedBy: 'dave' });
    expect(row).to.include({ ImportStatus: 'IMPORTED', Source: 'READ_UNIT', RequestStatus: 'R', ObjectCount: 4, CheckedBy: 'dave' });
    expect(row.ImportedAt).to.equal(result.checkedAt);
    expect(row.VerifiedAt).to.equal(null);
    expect(row.VerificationJson).to.equal(null);
  });

  it('builds the persisted rows for a verification and for an operator record', async () => {
    const result = await verifyTransportImport({ transport, targetSystem: QAS, manifest: manifestFixture(), readers: mockReaders({ transport }) });
    const row = importRowFrom({ result, checkedBy: 'dave' });
    expect(row.VerifiedAt).to.equal(result.checkedAt);
    expect(row.VerifiedCount).to.equal(result.verification.counts.verified);
    expect(row.ManualCount).to.equal(result.verification.counts.manual);
    expect(JSON.parse(row.VerificationJson).items.length).to.equal(result.verification.items.length);
    expect(row.Note.length).to.be.at.most(500);

    const failed = operatorRowFrom({ status: 'IMPORT_FAILED', note: ' RC 8 on the import step ', checkedBy: 'dave' });
    expect(failed).to.include({ ImportStatus: 'IMPORT_FAILED', Source: 'OPERATOR', Note: 'RC 8 on the import step', ImportedAt: null });
    const imported = operatorRowFrom({ status: 'IMPORTED', note: '', checkedBy: 'dave' });
    expect(imported.ImportedAt).to.equal(imported.CheckedAt);
  });
});

describe('transport verification: adapter reads (mock-S4 on)', () => {
  it('maps the ZADO_C_TRANSPORT_STATUS row and degrades raw E070 aliases', () => {
    expect(mapTransportStatus({ Trkorr: 'RD1K900123', RequestType: 'K', RequestStatus: 'R', Owner: 'ALICE', ObjectCount: '3', SystemId: 'RD1', Client: '200' }))
      .to.include({ Trkorr: 'RD1K900123', RequestType: 'K', RequestStatus: 'R', Owner: 'ALICE', ObjectCount: 3, SystemId: 'RD1', Client: '200' });
    expect(mapTransportStatus({ trkorr: 'X', Trstatus: 'D', As4user: 'BOB' })).to.include({ Trkorr: 'X', RequestStatus: 'D', Owner: 'BOB', ObjectCount: 0 });
  });

  it('answers an empty TRKORR without a call and does not throw on the mock payload', async () => {
    expect(await fetchTransportStatus({ targetSystem: { destinationName: 'X' }, trkorr: '' })).to.deep.equal({ supported: true, row: null });
    // With mock-S4 on, callS4Destination answers ok:true with a generic
    // payload; the read must survive whatever rows come back.
    const status = await fetchTransportStatus({ targetSystem: { destinationName: 'RD1_QAS' }, trkorr: 'RD1K900123' });
    expect(status.supported).to.equal(true);
    const roles = await fetchRolesByName({ targetSystem: { destinationName: 'RD1_QAS' }, roleNames: ['Z_ADO_A', 'z_ado_a', ''] });
    expect(roles).to.be.an('array');
  });
});

describe('transport verification: service actions', () => {
  let devId;
  let qasId;
  let transportId;
  let planId;

  before(async () => {
    expectInMemoryDb();
    const dev = await test.axios.post('/fiori/TargetSystems', {
      displayName: 'RD1 Development (S10)', destinationName: 'RD1_DEV_S10', systemId: 'RD1', client: '100', environment: 'DEV'
    }, json('alice'));
    expect(dev.status, JSON.stringify(dev.data)).to.equal(201);
    devId = dev.data.ID;
    const qas = await test.axios.post('/fiori/TargetSystems', {
      displayName: 'RD1 Quality (S10)', destinationName: 'RD1_QAS_S10', systemId: 'RD1', client: '200', environment: 'QAS'
    }, json('alice'));
    expect(qas.status, JSON.stringify(qas.data)).to.equal(201);
    qasId = qas.data.ID;

    // A completed plan with its released transport, seeded directly (the
    // projections are read-only): what the Transports page lists.
    planId = randomUUID();
    transportId = randomUUID();
    const { steps } = deriveActivationSteps({ proposals: PROPOSALS, waveName: 'Wave S10' });
    await INSERT.into('adops.db.ActivationPlans').entries({
      ID: planId, TenantId: 'GLOBAL', Name: 'Activation of Wave S10', Status: 'COMPLETED', targetSystem_ID: devId,
      transportRequest_ID: transportId, StepCount: steps.length
    });
    await INSERT.into('adops.db.ActivationSteps').entries(steps.map((s) => ({ ...s, plan_ID: planId, TenantId: 'GLOBAL', Status: 'SUCCESS' })));
    await INSERT.into('adops.db.TransportRequests').entries({
      ID: transportId, TenantId: 'GLOBAL', targetSystem_ID: devId, plan_ID: planId, TransportRequestId: 'RD1K900777',
      RequestType: 'K', Description: 'Wave S10', Status: 'RELEASED', ReleasedAt: new Date().toISOString(), ReleasedBy: 'dave'
    });
  });

  it('refuses the source system and unknown rows', async () => {
    const source = await test.axios.post('/fiori/verifyTransportImport', { transportId, targetSystemId: devId }, json('carol'));
    expect(source.status).to.equal(400);
    expect(JSON.stringify(source.data)).to.match(/source system/);
    const missing = await test.axios.post('/fiori/verifyTransportImport', { transportId: randomUUID(), targetSystemId: qasId }, json('carol'));
    expect(missing.status).to.equal(404);
  });

  it('verifies on the follow-on system and persists one row per transport and system', async () => {
    const first = await test.axios.post('/fiori/verifyTransportImport', { transportId, targetSystemId: qasId }, json('carol'));
    expect(first.status, JSON.stringify(first.data)).to.equal(200);
    const payload = JSON.parse(first.data.value);
    expect(payload.Import).to.include({ ImportStatus: 'IMPORTED', Source: 'READ_UNIT', RequestStatus: 'R', CheckedBy: 'carol' });
    expect(payload.TransportStatus).to.include({ Trkorr: 'RD1K900777', RequestStatus: 'R' });
    expect(payload.Verification.counts.verified).to.be.greaterThan(0);
    expect(payload.Verification.items.length).to.be.at.least(12);
    expect(payload.Import.Verification.items.length).to.equal(payload.Verification.items.length);
    expect(payload.Import).to.not.have.property('VerificationJson');

    const second = await test.axios.post('/fiori/verifyTransportImport', { transportId, targetSystemId: qasId }, json('carol'));
    expect(second.status).to.equal(200);
    const rows = await SELECT.from('adops.db.TransportImports').where({ transport_ID: transportId, targetSystem_ID: qasId });
    expect(rows.length).to.equal(1);
    expect(rows[0].VerifiedCount).to.equal(payload.Verification.counts.verified);

    const audit = await SELECT.from('adops.db.AuditEvents').where({ EventType: 'TRANSPORT_IMPORT_CHECKED', ObjectId: transportId });
    expect(audit.length).to.equal(2);
    expect(audit[1].BeforeValue).to.equal('IMPORTED');
  });

  it('lists the imports and the follow-on systems on the transports read', async () => {
    const list = await test.axios.get(`/fiori/queryTransportRequests(targetSystemId=${devId})`, as('carol'));
    expect(list.status, JSON.stringify(list.data)).to.equal(200);
    const payload = JSON.parse(list.data.value);
    const row = payload.Items.find((r) => r.ID === transportId);
    expect(row.Imports.length).to.equal(1);
    expect(row.Imports[0]).to.include({ ImportStatus: 'IMPORTED', targetSystem_ID: qasId });
    expect(row.Imports[0].TargetSystemName).to.match(/RD1 Quality \(S10\) \(QAS\)/);
    expect(row.Imports[0]).to.not.have.property('VerificationJson');
    expect(payload.FollowOnSystems.map((s) => s.ID)).to.include.members([devId, qasId]);

    const read = await test.axios.get(`/fiori/readTransportImport(transportId=${transportId},targetSystemId=${qasId})`, as('carol'));
    expect(read.status).to.equal(200);
    expect(JSON.parse(read.data.value).Import.Verification.counts.verified).to.be.greaterThan(0);
  });

  it('lets an Activator record the runbook outcome, keeps the last verification, refuses a Member', async () => {
    const asMember = await test.axios.post('/fiori/recordTransportImport', { transportId, targetSystemId: qasId, status: 'IMPORT_FAILED', note: 'RC 8' }, json('carol'));
    expect(REFUSED).to.include(asMember.status);

    const bad = await test.axios.post('/fiori/recordTransportImport', { transportId, targetSystemId: qasId, status: 'DONE', note: '' }, json('dave'));
    expect(bad.status).to.equal(400);

    const recorded = await test.axios.post('/fiori/recordTransportImport', { transportId, targetSystemId: qasId, status: 'import_failed', note: 'RC 8 on the DDIC step' }, json('dave'));
    expect(recorded.status, JSON.stringify(recorded.data)).to.equal(200);
    const payload = JSON.parse(recorded.data.value);
    expect(payload.Import).to.include({ ImportStatus: 'IMPORT_FAILED', Source: 'OPERATOR', Note: 'RC 8 on the DDIC step', CheckedBy: 'dave' });
    expect(payload.Import.Verification.items.length).to.be.at.least(12);

    const audit = await SELECT.one.from('adops.db.AuditEvents').where({ EventType: 'TRANSPORT_IMPORT_RECORDED', ObjectId: transportId });
    expect(audit).to.include({ BeforeValue: 'IMPORTED', AfterValue: 'IMPORT_FAILED', Severity: 'WARN' });
  });
});
