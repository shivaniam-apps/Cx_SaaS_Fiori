import { Text } from '@ui5/webcomponents-react/Text';

// Compact KPI tile for page-level strips (waves, activation runs). Figures
// come from server summaries over the full filter scope - never from counting
// the rows currently loaded (performance.md).
export function Kpi({ label, value }) {
  return (
    <div style={{
      flex: '1 1 8rem', minWidth: '8rem', padding: 'var(--adops-card-padding)',
      border: 'var(--adops-card-border)', borderRadius: 'var(--adops-card-radius)',
      background: 'var(--adops-card-background)'
    }}>
      <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)', fontSize: '0.8rem' }}>{label}</Text>
      <br />
      <Text style={{ fontSize: '1.4rem', fontWeight: 700 }}>{value}</Text>
    </div>
  );
}

export default Kpi;
