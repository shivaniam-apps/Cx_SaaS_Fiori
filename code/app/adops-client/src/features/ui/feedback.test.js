import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isToastFeedback, routeFeedback, releaseFeedbackText, isReleaseSuccess } from './feedback.js';

test('success and confirmation notices become toasts, problems stay strips', () => {
  assert.equal(isToastFeedback({ design: 'Positive', text: 'x' }), true);
  assert.equal(isToastFeedback({ design: 'Information', text: 'x' }), true);
  assert.equal(isToastFeedback({ design: 'Critical', text: 'x' }), false);
  assert.equal(isToastFeedback({ design: 'Negative', text: 'x' }), false);
  assert.equal(isToastFeedback(null), false);
});

test('routeFeedback sets exactly one channel', () => {
  assert.deepEqual(routeFeedback({ design: 'Positive', text: ' Saved. ' }), { toast: 'Saved.', strip: null });
  assert.deepEqual(routeFeedback({ design: 'Critical', text: 'Grant failed' }), { toast: '', strip: { design: 'Critical', text: 'Grant failed' } });
  assert.deepEqual(routeFeedback({ text: 'no design' }), { toast: '', strip: { design: 'Negative', text: 'no design' } });
  assert.deepEqual(routeFeedback({ design: 'Positive', text: '' }), { toast: '', strip: null });
  assert.deepEqual(routeFeedback(null), { toast: '', strip: null });
});

test('release feedback text and success predicate', () => {
  assert.equal(releaseFeedbackText('A4HK900001', { Status: 'RELEASED', Messages: [{ message: 'Released.' }, { message: ' ' }] }), 'Release for A4HK900001: Released.');
  assert.equal(releaseFeedbackText('A4HK900001', { Simulated: true, Status: 'MODIFIABLE' }), 'Release simulation for A4HK900001: MODIFIABLE');
  assert.equal(releaseFeedbackText('', {}), 'Release for the transport: done');
  assert.equal(isReleaseSuccess({ Status: 'RELEASED' }), true);
  assert.equal(isReleaseSuccess({ Simulated: true, Status: 'RELEASE_FAILED' }), true);
  assert.equal(isReleaseSuccess({ Status: 'RELEASE_FAILED' }), false);
  assert.equal(isReleaseSuccess(undefined), false);
});
