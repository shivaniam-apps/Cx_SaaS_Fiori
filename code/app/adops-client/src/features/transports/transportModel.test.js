import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  importStatusTag,
  verdictTag,
  importSummaryLine,
  followOnSystemsFor,
  defaultFollowOnSystem,
  transportRoute,
  routeLabel,
  canVerifyImport,
  canRecordImport,
  verificationSummary,
  verificationRows,
  verificationDesign,
  RECORDABLE_IMPORT_STATUSES,
  formatStamp
} from './transportModel.js';

const DEV = { ID: 'dev', displayName: 'RD1 Development', environment: 'DEV' };
const QAS = { ID: 'qas', displayName: 'RD1 Quality', environment: 'QAS' };
const PRD = { ID: 'prd', displayName: 'RD1 Production', environment: 'PRD' };
const SANDBOX = { ID: 'sbx', displayName: 'Sandbox', environment: 'SANDBOX' };
const released = { ID: 't1', TransportRequestId: 'RD1K900123', Status: 'RELEASED', targetSystem_ID: 'dev', Imports: [] };

test('status tags map every server status and tolerate unknown ones', () => {
  assert.deepEqual(importStatusTag('IMPORTED'), { label: 'Imported', design: 'Positive' });
  assert.deepEqual(importStatusTag('IMPORT_FAILED'), { label: 'Import failed', design: 'Negative' });
  assert.deepEqual(importStatusTag('PENDING'), { label: 'Not imported', design: 'Information' });
  assert.deepEqual(importStatusTag('UNKNOWN'), { label: 'Unknown', design: 'Critical' });
  assert.deepEqual(importStatusTag(undefined), { label: 'Unchecked', design: 'Neutral' });
  assert.deepEqual(verdictTag('VERIFIED'), { label: 'Verified', design: 'Positive' });
  assert.deepEqual(verdictTag('NOT_FOUND'), { label: 'Not found', design: 'Negative' });
  assert.equal(verdictTag('MANUAL').design, 'Information');
  assert.equal(verdictTag('SOMETHING').design, 'Neutral');
  assert.deepEqual(RECORDABLE_IMPORT_STATUSES.map((s) => s.value), ['IMPORTED', 'IMPORT_FAILED', 'PENDING']);
});

test('import summary line names the system, the status, the source and the check', () => {
  const line = importSummaryLine({
    TargetSystemName: 'RD1 Quality (QAS)', ImportStatus: 'IMPORTED', Source: 'READ_UNIT', CheckedAt: '2026-09-18T08:00:00.000Z', CheckedBy: 'dave'
  });
  assert.equal(line, 'RD1 Quality (QAS): Imported · 2026-09-18 08:00 by dave');
  const recorded = importSummaryLine({ TargetSystemName: 'RD1 Production (PRD)', ImportStatus: 'IMPORT_FAILED', Source: 'OPERATOR', CheckedAt: '2026-09-18T09:30:00.000Z' });
  assert.equal(recorded, 'RD1 Production (PRD): Import failed (recorded) · 2026-09-18 09:30');
  assert.equal(importSummaryLine({}), 'Follow-on system: Unchecked');
  assert.equal(formatStamp(null), '');
});

test('follow-on systems exclude the source and read QA before PROD', () => {
  const systems = followOnSystemsFor(released, [PRD, SANDBOX, DEV, QAS]);
  assert.deepEqual(systems.map((s) => s.ID), ['qas', 'prd', 'sbx']);
  assert.deepEqual(followOnSystemsFor(released, [DEV]), []);
  assert.deepEqual(followOnSystemsFor(released, null), []);
});

test('the default follow-on system is the first one not yet checked', () => {
  assert.equal(defaultFollowOnSystem(released, [DEV, QAS, PRD]).ID, 'qas');
  const checkedQas = { ...released, Imports: [{ targetSystem_ID: 'qas', ImportStatus: 'IMPORTED' }] };
  assert.equal(defaultFollowOnSystem(checkedQas, [DEV, QAS, PRD]).ID, 'prd');
  const allChecked = { ...released, Imports: [{ targetSystem_ID: 'qas' }, { targetSystem_ID: 'prd' }] };
  assert.equal(defaultFollowOnSystem(allChecked, [DEV, QAS, PRD]).ID, 'qas');
  assert.equal(defaultFollowOnSystem(released, [DEV]), null);
});

test('a configured transport route wins over the environment order and is cycle-safe', () => {
  // Route DEV -> SANDBOX -> PRD (QAS deliberately outside the route).
  const dev = { ...DEV, followOnSystem_ID: 'sbx' };
  const sbx = { ...SANDBOX, followOnSystem_ID: 'prd' };
  const prd = { ...PRD, followOnSystem_ID: 'dev' }; // cycle back to the source
  const systems = [prd, QAS, dev, sbx];
  assert.deepEqual(transportRoute('dev', systems).map((s) => s.ID), ['sbx', 'prd']);
  assert.deepEqual(transportRoute('qas', systems), [], 'no route configured from QAS');
  assert.deepEqual(transportRoute('nope', systems), []);
  assert.equal(routeLabel(released, systems), 'RD1 Development (DEV) -> Sandbox (SANDBOX) -> RD1 Production (PRD)');
  assert.equal(routeLabel(released, [DEV, QAS]), '');
  assert.equal(defaultFollowOnSystem(released, systems).ID, 'sbx', 'first hop of the route');
  const sbxChecked = { ...released, Imports: [{ targetSystem_ID: 'sbx' }] };
  assert.equal(defaultFollowOnSystem(sbxChecked, systems).ID, 'prd', 'next unchecked hop');
  const allChecked = { ...released, Imports: [{ targetSystem_ID: 'sbx' }, { targetSystem_ID: 'prd' }] };
  assert.equal(defaultFollowOnSystem(allChecked, systems).ID, 'sbx', 'route exhausted: first hop again');
  // A dangling followOnSystem_ID (system removed) ends the route quietly.
  assert.deepEqual(transportRoute('dev', [{ ...DEV, followOnSystem_ID: 'gone' }]), []);
});

test('verification is offered for released requests with a follow-on system; recording needs an Activator', () => {
  assert.equal(canVerifyImport(released, [DEV, QAS]), true);
  assert.equal(canVerifyImport({ ...released, Status: 'MODIFIABLE' }, [DEV, QAS]), false);
  assert.equal(canVerifyImport(released, [DEV]), false);
  assert.equal(canRecordImport(released, true), true);
  assert.equal(canRecordImport(released, false), false);
  assert.equal(canRecordImport({ ...released, TransportRequestId: '' }, true), false);
});

test('verification summary and design reflect the counts, in either shape', () => {
  assert.equal(verificationSummary({ verified: 3, notFound: 1, manual: 6, unknown: 0 }), '3 verified · 1 not found · 6 manual');
  assert.equal(verificationSummary({ VerifiedCount: 2, NotFoundCount: 0, ManualCount: 0, UnknownCount: 4 }), '2 verified · 4 unknown');
  assert.equal(verificationSummary(null), '');
  assert.equal(verificationDesign({ counts: { verified: 3, notFound: 1 } }), 'Critical');
  assert.equal(verificationDesign({ counts: { verified: 3, unknown: 1 } }), 'Critical');
  assert.equal(verificationDesign({ counts: { verified: 3, manual: 6 } }), 'Positive');
  assert.equal(verificationDesign({ counts: { manual: 6 } }), 'Information');
  assert.equal(verificationDesign(null), 'Information');
});

test('verification rows list transported content first, then replay, each by sequence', () => {
  const rows = verificationRows({
    items: [
      { sequence: 5, stepType: 'ACTIVATE_ICF_NODE', transportable: false, verdict: 'MANUAL' },
      { sequence: 10, stepType: 'CREATE_PFCG_ROLE', transportable: true, verdict: 'VERIFIED' },
      { sequence: 1, stepType: 'RUN_TASK_LIST', transportable: false, verdict: 'MANUAL' },
      { sequence: 6, stepType: 'ADD_TO_TRANSPORT', transportable: true, verdict: 'VERIFIED' }
    ]
  });
  assert.deepEqual(rows.map((r) => `${r.section}:${r.sequence}`), ['Transported:6', 'Transported:10', 'Replay:1', 'Replay:5']);
  assert.deepEqual(verificationRows(null), []);
});
