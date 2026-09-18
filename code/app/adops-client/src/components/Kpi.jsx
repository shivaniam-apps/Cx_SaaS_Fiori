import { Text } from '@ui5/webcomponents-react/Text';

const VALUE_COLOR = {
  Negative: 'var(--sapNegativeTextColor, #bb0000)',
  Critical: 'var(--sapCriticalTextColor, #e9730c)',
  Positive: 'var(--sapPositiveTextColor, #107e3e)',
  Information: 'var(--sapInformativeTextColor, #0a6ed1)'
};

// Compact KPI tile for page-level strips (waves, activation runs, cockpit).
// Figures come from server summaries over the full filter scope - never from
// counting the rows currently loaded (performance.md). Optional `design`
// colours the value (semantic state), optional `onClick` turns the tile into
// a keyboard-reachable link to the slice the figure counts (fiori-ux.md,
// Navigation: the target must open with the same filter applied).
export function Kpi({ label, value, design, onClick, title }) {
  const interactive = typeof onClick === 'function';
  const activate = (event) => {
    if (!interactive) return;
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onClick(event);
  };
  return (
    <div
      role={interactive ? 'link' : undefined}
      tabIndex={interactive ? 0 : undefined}
      title={title}
      onClick={interactive ? activate : undefined}
      onKeyDown={interactive ? activate : undefined}
      style={{
        flex: '1 1 8rem', minWidth: '8rem', padding: 'var(--adops-card-padding)',
        border: 'var(--adops-card-border)', borderRadius: 'var(--adops-card-radius)',
        background: 'var(--adops-card-background)',
        cursor: interactive ? 'pointer' : undefined
      }}
    >
      <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)', fontSize: '0.8rem' }}>{label}</Text>
      <br />
      <Text style={{ fontSize: '1.4rem', fontWeight: 700, color: VALUE_COLOR[design] }}>{value}</Text>
    </div>
  );
}

export default Kpi;
