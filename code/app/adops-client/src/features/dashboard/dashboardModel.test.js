import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNEY,
  linkTo,
  stageCards,
  journeyWithCards,
  isEmptyLandscape,
  nextStep,
  systemOptions
} from './dashboardModel.js';

const RUN = '33333333-3333-4333-8333-333333333332';
const SYS = '11111111-1111-4111-8111-111111111111';

const SUMMARY = {
  Scope: { TargetSystemId: null, AnalysisRunIds: [RUN] },
  Systems: { Total: 2, Healthy: 1, Attention: 1, Unchecked: 0, Other: 0 },
  Extractions: { Total: 3, Active: 0, Completed: 2, Partial: 1, Failed: 0, Other: 0 },
  Analyses: { Total: 2, Active: 0, Completed: 2, Failed: 0, Other: 0 },
  Proposals: { Total: 10, Open: 4, Approved: 3, Rejected: 1, Deferred: 1, NoPath: 1, Other: 0 },
  Waves: { Total: 1, Planned: 0, InProgress: 1, Completed: 0, OnHold: 0, Other: 0 },
  Plans: { Total: 2, Draft: 0, Ready: 1, Executing: 0, Completed: 1, Attention: 0, Other: 0 },
  Runs: { Total: 3, Active: 1, Succeeded: 1, Failed: 1, Cancelled: 0, Other: 0 },
  Transports: { Total: 2, Open: 1, Released: 1, Failed: 0, Other: 0 }
};

test('linkTo drops empty params and encodes values', () => {
  assert.equal(linkTo('/proposals', {}), '/proposals');
  assert.equal(linkTo('/proposals', { run: '', status: 'OPEN' }), '/proposals?status=OPEN');
  assert.equal(linkTo('/x', { a: 'b c', d: null }), '/x?a=b%20c');
});

test('stageCards lays the summary out along the journey with the click-through slice', () => {
  const cards = stageCards(SUMMARY, {});
  assert.deepEqual(Object.keys(cards), JOURNEY.map((s) => s.key));
  const open = cards.review.find((c) => c.key === 'PROPOSALS_OPEN');
  assert.equal(open.value, 4);
  assert.equal(open.to, `/proposals?run=${RUN}&status=OPEN`);
  assert.equal(open.design, 'Critical');
  const failed = cards.activate.find((c) => c.key === 'RUNS_FAILED');
  assert.equal(failed.to, '/activation-runs?status=FAILED');
  assert.equal(failed.design, 'Negative');
  const transports = cards.activate.find((c) => c.key === 'TRANSPORTS_OPEN');
  assert.equal(transports.to, '/transports?status=OPEN');
  assert.equal(transports.design, undefined);
  // Partition members sum to the entity total.
  const systemCards = cards.connect.filter((c) => c.key !== 'SYSTEMS');
  assert.equal(systemCards.reduce((sum, c) => sum + c.value, 0), SUMMARY.Systems.Total);
});

test('a target-system scope travels into the run and transport links', () => {
  const cards = stageCards(SUMMARY, { targetSystemId: SYS });
  assert.equal(cards.activate.find((c) => c.key === 'RUNS_ACTIVE').to, `/activation-runs?system=${SYS}&status=ACTIVE`);
  assert.equal(cards.activate.find((c) => c.key === 'TRANSPORTS_FAILED').to, `/transports?system=${SYS}&status=FAILED`);
});

test('proposal links carry the run only when exactly one is in scope', () => {
  const two = { ...SUMMARY, Scope: { AnalysisRunIds: ['a', 'b'] } };
  assert.equal(stageCards(two).review.find((c) => c.key === 'PROPOSALS').to, '/proposals');
  assert.equal(stageCards({}).review.find((c) => c.key === 'PROPOSALS_OPEN').to, '/proposals?status=OPEN');
});

test('journeyWithCards keeps the journey order and tolerates a missing summary', () => {
  const journey = journeyWithCards(null);
  assert.deepEqual(journey.map((s) => s.key), ['connect', 'extract', 'analyse', 'review', 'activate']);
  assert.ok(journey.every((s) => s.cards.length > 0 && s.cards.every((c) => c.value === 0)));
});

test('isEmptyLandscape and nextStep follow the journey', () => {
  assert.equal(isEmptyLandscape(null), true);
  assert.equal(isEmptyLandscape(SUMMARY), false);
  assert.deepEqual(nextStep({}), { text: 'Register your first S/4HANA target system.', to: '/systems' });
  assert.equal(nextStep({ Systems: { Total: 1 }, Extractions: { Total: 1, Completed: 0, Partial: 0 } }).to, '/extractions');
  assert.equal(nextStep({ Systems: { Total: 1 }, Extractions: { Completed: 1 }, Analyses: { Completed: 0 } }).to, '/proposals');
  assert.equal(nextStep(SUMMARY).to, `/proposals?run=${RUN}&status=OPEN`);
  assert.match(nextStep(SUMMARY).text, /4 proposals/);
  const done = { ...SUMMARY, Proposals: { ...SUMMARY.Proposals, Open: 0 }, Runs: { ...SUMMARY.Runs, Failed: 0 }, Transports: { ...SUMMARY.Transports, Open: 0 } };
  assert.equal(nextStep(done), null);
  assert.equal(nextStep({ ...done, Runs: { Failed: 2 } }).to, '/activation-runs?status=FAILED');
});

test('systemOptions labels systems and keeps an applied id that is not listed', () => {
  assert.deepEqual(systemOptions([{ ID: 'a', displayName: 'RD1', environment: 'DEV' }, { ID: 'b', displayName: 'RQ1' }], 'a'), [
    { id: 'a', label: 'RD1 (DEV)' },
    { id: 'b', label: 'RQ1' }
  ]);
  assert.deepEqual(systemOptions([], 'zzz'), [{ id: 'zzz', label: 'zzz' }]);
});
