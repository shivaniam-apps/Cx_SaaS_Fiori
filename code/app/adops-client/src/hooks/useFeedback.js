import { useCallback, useState } from 'react';
import { routeFeedback } from '../features/ui/feedback.js';

// Page-level action feedback with one entry point. `notify({ design, text })`
// routes Positive / Information notices to the toast (render <AdopsToast
// message={toast} onClose={clearToast} />) and Critical / Negative ones to
// the inline strip (render `notice` as a MessageStrip with onClose=
// clearNotice). A new notice replaces the previous one on its channel and
// clears the other, so the page never shows two verdicts for one action.
export function useFeedback() {
  const [notice, setNotice] = useState(null);   // { design, text } for the strip
  const [toast, setToast] = useState('');       // text for the toast

  const notify = useCallback((next) => {
    const { toast: text, strip } = routeFeedback(next);
    setToast(text);
    setNotice(strip);
  }, []);
  const clearNotice = useCallback(() => setNotice(null), []);
  const clearToast = useCallback(() => setToast(''), []);

  return { notice, toast, notify, clearNotice, clearToast };
}

export default useFeedback;
