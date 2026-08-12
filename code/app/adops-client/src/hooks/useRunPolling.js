import { useEffect, useRef, useState } from 'react';

// One polling hook for every long-running flow. Contract (fiori-ux/plan):
// - stops itself on a terminal status
// - pauses while document.hidden
// - backs off x1.5 to a 15s ceiling while nothing changes
// - NEVER clears last-known state on a failed poll - flips isStale instead
export function useRunPolling({ id, fetchStatus, isTerminal, baseIntervalMs = 2000 }) {
  const [state, setState] = useState({ status: null, isStale: false, error: null });
  const timerRef = useRef(null);
  const intervalRef = useRef(baseIntervalMs);
  const lastSerializedRef = useRef('');

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    intervalRef.current = baseIntervalMs;
    lastSerializedRef.current = '';

    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) {
        timerRef.current = setTimeout(tick, intervalRef.current);
        return;
      }
      try {
        const status = await fetchStatus(id);
        if (cancelled) return;
        const serialized = JSON.stringify(status);
        if (serialized === lastSerializedRef.current) {
          intervalRef.current = Math.min(15000, intervalRef.current * 1.5);
        } else {
          intervalRef.current = baseIntervalMs;
          lastSerializedRef.current = serialized;
        }
        setState({ status, isStale: false, error: null });
        if (!isTerminal(status)) {
          timerRef.current = setTimeout(tick, intervalRef.current);
        }
      } catch (error) {
        if (cancelled) return;
        // Keep the last known status; just mark it stale.
        setState((previous) => ({ ...previous, isStale: true, error }));
        timerRef.current = setTimeout(tick, Math.min(15000, intervalRef.current * 1.5));
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}

export default useRunPolling;
