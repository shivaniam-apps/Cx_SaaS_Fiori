import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_PAGE_SIZE,
  EMPTY_FILTER,
  odataString,
  buildAuditFilter,
  hasActiveFilter,
  eventTypeLabel,
  changeLabel,
  objectLabel,
  isChainedEvent,
  hasMore,
  chainVerdictSummary,
  optionList,
  CHAIN_STATUS_DESIGN,
  SEVERITY_DESIGN
} from './auditModel.js';

test('odataString escapes single quotes and never emits null', () => {
  assert.equal(odataString("O'Brien"), "'O''Brien'");
  assert.equal(odataString(null), "''");
  assert.equal(odataString(42), "'42'");
});

test('buildAuditFilter combines exact and contains clauses, trims, and stays empty when unset', () => {
  assert.equal(buildAuditFilter(EMPTY_FILTER), '');
  assert.equal(buildAuditFilter(undefined), '');
  assert.equal(hasActiveFilter({ eventType: ' ' }), false);
  const filter = buildAuditFilter({
    eventType: ' PROPOSAL_APPROVED ', objectType: 'AppProposals', severity: 'warning', objectName: "F38'93", userId: 'ali'
  });
  assert.equal(
    filter,
    "EventType eq 'PROPOSAL_APPROVED' and ObjectType eq 'AppProposals' and Severity eq 'WARNING' and contains(ObjectName,'F38''93') and contains(UserId,'ali')"
  );
  assert.equal(buildAuditFilter({ userId: 'alice' }), "contains(UserId,'alice')");
  assert.equal(hasActiveFilter({ userId: 'alice' }), true);
});

test('labels: event type, change and object', () => {
  assert.equal(eventTypeLabel('PROPOSAL_APPROVED'), 'Proposal approved');
  assert.equal(eventTypeLabel('ACTIVATION_STEP_SUCCESS'), 'Activation step success');
  assert.equal(eventTypeLabel(''), '');
  assert.equal(eventTypeLabel(null), '');
  assert.equal(changeLabel({ BeforeValue: 'PSEUDONYMISED', AfterValue: 'IDENTIFIED' }), 'PSEUDONYMISED → IDENTIFIED');
  assert.equal(changeLabel({ AfterValue: 'APPROVED' }), '— → APPROVED');
  assert.equal(changeLabel({}), '');
  assert.equal(objectLabel({ ObjectType: 'ActivationSteps', ObjectName: 'F3893' }), 'ActivationSteps · F3893');
  assert.equal(objectLabel({ ObjectType: 'AppProposals' }), 'AppProposals');
  assert.equal(objectLabel({}), '');
});

test('chained rows, paging and design maps', () => {
  assert.equal(isChainedEvent({ Sequence: 1 }), true);
  assert.equal(isChainedEvent({ Sequence: 0 }), true);
  assert.equal(isChainedEvent({ Sequence: null }), false);
  assert.equal(isChainedEvent({}), false);
  assert.equal(hasMore(150, AUDIT_PAGE_SIZE), true);
  assert.equal(hasMore(100, 100), false);
  assert.equal(hasMore(undefined, 0), false);
  assert.equal(CHAIN_STATUS_DESIGN.BROKEN, 'Negative');
  assert.equal(SEVERITY_DESIGN.WARNING, 'Critical');
});

test('chainVerdictSummary shapes the verdict for the strip and cards', () => {
  assert.equal(chainVerdictSummary(null), null);
  const summary = chainVerdictSummary({
    Status: 'OK', ChainedEvents: 4, UnchainedEvents: 20, LastSequence: 4, HeadConsistent: true,
    FirstBrokenSequence: null, Message: '4 chained events verified.', CheckedAt: '2026-09-17T09:48:25Z'
  });
  assert.equal(summary.design, 'Positive');
  assert.deepEqual(summary.cards.map((c) => [c.key, c.value]), [['CHAINED', 4], ['LEGACY', 20], ['LAST', 4], ['HEAD', 'consistent']]);
  assert.equal(summary.brokenAt, null);
  const broken = chainVerdictSummary({ Status: 'BROKEN', FirstBrokenSequence: 3, HeadConsistent: false });
  assert.equal(broken.design, 'Negative');
  assert.equal(broken.brokenAt, 3);
  assert.equal(broken.cards.at(-1).value, 'stale');
  assert.equal(chainVerdictSummary({ Status: 'WEIRD' }).design, 'Neutral');
});

test('optionList sorts distinct values and keeps the applied one', () => {
  const rows = [{ EventType: 'PROPOSAL_APPROVED' }, { EventType: 'ACTIVATION_STEP_SUCCESS' }, { EventType: '' }, { EventType: 'PROPOSAL_APPROVED' }];
  assert.deepEqual(optionList(rows, 'EventType'), ['ACTIVATION_STEP_SUCCESS', 'PROPOSAL_APPROVED']);
  assert.deepEqual(optionList(rows, 'EventType', 'ZZZ_OLD'), ['ACTIVATION_STEP_SUCCESS', 'PROPOSAL_APPROVED', 'ZZZ_OLD']);
  assert.deepEqual(optionList(undefined, 'EventType'), []);
});
