import { Title } from '@ui5/webcomponents-react/Title';
import { Text } from '@ui5/webcomponents-react/Text';

const JOURNEY = [
  { key: 'connect', label: 'Connect', hint: 'Register the S/4HANA system' },
  { key: 'extract', label: 'Extract', hint: 'Pull the real usage pattern' },
  { key: 'analyse', label: 'Analyse', hint: 'Score Fiori app candidates' },
  { key: 'review', label: 'Review', hint: 'Approve, reject or defer' },
  { key: 'activate', label: 'Activate', hint: 'Ship it, captured in a TR' }
];

// Dashboard v1: the journey strip only. KPI strip, top-unaddressed
// transactions and the decision funnel land with Phase 1/2 data.
export function DashboardPage({ userInfo }) {
  const greeting = userInfo?.givenName || userInfo?.user || '';
  return (
    <div>
      <Title level="H2">Adoption Cockpit</Title>
      {greeting ? <Text>Welcome, {greeting}.</Text> : null}
      <div
        style={{
          display: 'flex',
          gap: 'var(--adops-space-md)',
          marginTop: 'var(--adops-space-lg)',
          flexWrap: 'wrap'
        }}
      >
        {JOURNEY.map((stage, index) => (
          <div
            key={stage.key}
            style={{
              flex: '1 1 10rem',
              minWidth: '10rem',
              padding: 'var(--adops-card-padding)',
              border: 'var(--adops-card-border)',
              borderRadius: 'var(--adops-card-radius)',
              background: 'var(--adops-card-background)',
              boxShadow: 'var(--adops-card-shadow)'
            }}
          >
            <Text style={{ fontWeight: 600 }}>{`${index + 1}. ${stage.label}`}</Text>
            <br />
            <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)' }}>{stage.hint}</Text>
          </div>
        ))}
      </div>
    </div>
  );
}

export default DashboardPage;
