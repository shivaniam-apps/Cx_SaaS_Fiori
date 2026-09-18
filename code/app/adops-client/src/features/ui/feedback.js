// Pure routing of action feedback (fiori-ux.md, Destructive Actions):
// success / confirmation feedback is a transient MessageToast, because the
// follow-up list reload wipes an inline strip; warnings and failures stay
// as MessageStrips next to the affected content. Dependency-free: runs
// under node --test.

const TOAST_DESIGNS = new Set(['Positive', 'Information']);

// A notice is { design, text }. Positive and Information notices are shown
// as a toast; Critical and Negative (and unknown designs) as a strip.
export function isToastFeedback(notice) {
  return TOAST_DESIGNS.has(String(notice?.design || '').trim());
}

// Splits a notice into what the page renders: exactly one of the two is
// set. An empty notice yields neither.
export function routeFeedback(notice) {
  const text = String(notice?.text ?? '').trim();
  if (!text) return { toast: '', strip: null };
  return isToastFeedback(notice)
    ? { toast: text, strip: null }
    : { toast: '', strip: { design: notice.design || 'Negative', text } };
}

// Transport release outcome (releaseTransport payload) as one sentence.
export function releaseFeedbackText(trkorr, result) {
  const messages = (result?.Messages || []).map((m) => String(m?.message || '').trim()).filter(Boolean).join(' ');
  return `${result?.Simulated ? 'Release simulation' : 'Release'} for ${trkorr || 'the transport'}: ${messages || result?.Status || 'done'}`;
}

export function isReleaseSuccess(result) {
  return Boolean(result?.Simulated) || String(result?.Status || '').toUpperCase() === 'RELEASED';
}
