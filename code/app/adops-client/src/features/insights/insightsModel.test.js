import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSIGHTS_VIEWS,
  resolveInsightsView,
  getInsightsViewPath,
  FEEDBACK_STATUSES,
  ERROR_STATUSES,
  EMPTY_FEEDBACK_FILTER,
  EMPTY_ERROR_FILTER,
  buildFeedbackFilter,
  buildErrorFilter,
  statusCards,
  humanize,
  hasMore,
  triageDraft,
  triagePayload,
  triageChanged,
  usageCards,
  performanceCards,
  windowLabel
} from './insightsModel.js';

test('tabs, ids and route resolution', () => {
  assert.deepEqual(INSIGHTS_VIEWS.map((v) => v.id), ['feedback', 'errors', 'usage', 'performance']);
  for (const view of INSIGHTS_VIEWS) {
    assert.ok(view.label && view.icon, view.id);
    assert.equal(resolveInsightsView(view.id), view.id);
  }
  for (const bad of [undefined, '', null, 'settings']) assert.equal(resolveInsightsView(bad), 'feedback');
  assert.equal(getInsightsViewPath('feedback'), '/product-insights');
  assert.equal(getInsightsViewPath('errors'), '/product-insights/errors');
  assert.equal(getInsightsViewPath('nope'), '/product-insights');
});

test('feedback and error filters combine exact and search clauses and stay empty when unset', () => {
  assert.equal(buildFeedbackFilter(EMPTY_FEEDBACK_FILTER), '');
  assert.equal(buildErrorFilter(EMPTY_ERROR_FILTER), '');
  assert.equal(buildFeedbackFilter(undefined), '');
  assert.equal(
    buildFeedbackFilter({ status: 'new', category: 'DEFECT', impact: 'high', search: "O'B" }),
    "Status eq 'NEW' and Category eq 'DEFECT' and Impact eq 'HIGH' and (contains(Title,'O''B') or contains(ReferenceNumber,'O''B') or contains(Feature,'O''B'))"
  );
  assert.equal(
    buildErrorFilter({ status: 'NEW', severity: 'fatal', errorType: 'RENDER_ERROR', search: 'dash' }),
    "Status eq 'NEW' and Severity eq 'FATAL' and ErrorType eq 'RENDER_ERROR' and (contains(ErrorMessage,'dash') or contains(Route,'dash') or contains(Feature,'dash'))"
  );
});

test('statusCards partition the grouped counts and add Other only for unknown statuses', () => {
  const cards = statusCards([{ Status: 'NEW', count: 3 }, { Status: 'closed', count: 1 }, { Status: 'WEIRD', count: 2 }], FEEDBACK_STATUSES);
  assert.equal(cards[0].key, 'TOTAL');
  assert.equal(cards[0].value, 6);
  assert.equal(cards.find((c) => c.key === 'NEW').value, 3);
  assert.equal(cards.find((c) => c.key === 'CLOSED').value, 1);
  assert.equal(cards.find((c) => c.key === 'UNDER_REVIEW').label, 'Under review');
  assert.equal(cards.at(-1).key, 'OTHER');
  assert.equal(cards.at(-1).value, 2);
  assert.equal(cards.slice(1).reduce((s, c) => s + c.value, 0), cards[0].value);
  const errorCards = statusCards([], ERROR_STATUSES);
  assert.equal(errorCards.length, 1 + ERROR_STATUSES.length);
  assert.equal(errorCards[0].value, 0);
  assert.equal(statusCards(undefined, ERROR_STATUSES)[0].value, 0);
});

test('humanize and paging helpers', () => {
  assert.equal(humanize('FEATURE_REQUEST'), 'Feature request');
  assert.equal(humanize(''), '');
  assert.equal(humanize(null), '');
  assert.equal(hasMore(101, 100), true);
  assert.equal(hasMore(100, 100), false);
  assert.equal(windowLabel(30), 'Last 30 days');
});

test('triage draft, payload and change detection', () => {
  const row = { ID: 'f1', Status: 'NEW', AssignedTo: '', AdminNotes: null, ResolutionNotes: null };
  const draft = triageDraft(row);
  assert.deepEqual(draft, { status: 'NEW', assignedTo: '', adminNotes: '', resolutionNotes: '' });
  assert.equal(triageChanged(row, draft), false);
  assert.equal(triageChanged(row, { ...draft, status: 'PLANNED' }), true);
  assert.equal(triageChanged(row, { ...draft, adminNotes: '  ' }), false);
  assert.equal(triageChanged(null, draft), false);
  assert.deepEqual(triagePayload('f1', { status: 'planned', assignedTo: ' bob ', adminNotes: ' note ', resolutionNotes: '' }), {
    ID: 'f1', status: 'PLANNED', assignedTo: 'bob', adminNotes: 'note', resolutionNotes: ''
  });
  assert.equal(triagePayload('f1', {}).status, 'NEW');
  assert.equal(triageDraft(null).status, 'NEW');
});

test('usage and performance cards tolerate empty summaries', () => {
  assert.deepEqual(usageCards(null).map((c) => c.value), [0, 0, 0, 0]);
  const usage = usageCards({ totalEvents: 12, activeUsers: 3, activeSessions: 5, byFeature: [{ feature: 'a' }, { feature: 'a' }, { feature: 'b' }] });
  assert.deepEqual(usage.map((c) => c.value), [12, 3, 5, 2]);
  assert.deepEqual(performanceCards(null).map((c) => c.value), [0, 0, '—', '—']);
  const perf = performanceCards({ totalEvents: 200, failedCount: 3, operations: [{ avgMs: 1234.4 }] });
  assert.deepEqual(perf.map((c) => c.value), [200, 3, '1.5%', '1,234 ms']);
});
