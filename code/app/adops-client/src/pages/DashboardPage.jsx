import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Title } from '@ui5/webcomponents-react/Title';
import { Text } from '@ui5/webcomponents-react/Text';
import { Button } from '@ui5/webcomponents-react/Button';
import { Select } from '@ui5/webcomponents-react/Select';
import { Option } from '@ui5/webcomponents-react/Option';
import { Label } from '@ui5/webcomponents-react/Label';
import { BusyIndicator } from '@ui5/webcomponents-react/BusyIndicator';
import { MessageStrip } from '@ui5/webcomponents-react/MessageStrip';
import { listTargetSystems, queryDashboardSummary, getServiceErrorMessage } from '../services/fioriService.js';
import { formatTimestamp } from '../features/activation-runs/runModel.js';
import Kpi from '../components/Kpi.jsx';
import { JOURNEY, journeyWithCards, isEmptyLandscape, nextStep, systemOptions } from '../features/dashboard/dashboardModel.js';

function StageCard({ stage, index, children }) {
  return (
    <section
      aria-label={`${index + 1}. ${stage.label}`}
      style={{
        padding: 'var(--adops-card-padding)',
        border: 'var(--adops-card-border)', borderRadius: 'var(--adops-card-radius)',
        background: 'var(--adops-card-background)', boxShadow: 'var(--adops-card-shadow)'
      }}
    >
      <Text style={{ fontWeight: 600 }}>{`${index + 1}. ${stage.label}`}</Text>
      <br />
      <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)' }}>{stage.hint}</Text>
      {children}
    </section>
  );
}

// Adoption Cockpit: the journey strip carries one KPI strip per stage, fed
// by a single server summary (queryDashboardSummary) so the page never
// downloads the underlying tables (performance.md, Dashboard). Every tile
// opens the list that counts it with the same filter applied.
export function DashboardPage({ userInfo }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const systemId = searchParams.get('system') || '';

  const [systems, setSystems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const greeting = userInfo?.givenName || userInfo?.user || '';

  useEffect(() => {
    let cancelled = false;
    listTargetSystems()
      .then((rows) => { if (!cancelled) setSystems(rows); })
      .catch(() => { /* the scope select degrades to "all systems"; the summary read reports errors */ });
    return () => { cancelled = true; };
  }, [reloadToken]);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    queryDashboardSummary(systemId || undefined)
      .then((result) => { if (!cancelled) { setSummary(result); setError(''); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e, 'The cockpit summary could not be loaded.')); });
    return () => { cancelled = true; };
  }, [systemId, reloadToken]);

  // The system select is page SCOPE (like the run select on Usage Insight):
  // it applies immediately and lives in the URL so the tiles' links carry it.
  const selectSystem = (value) => setSearchParams(value ? { system: value } : {}, { replace: true });

  const stages = journeyWithCards(summary, { targetSystemId: systemId });
  const empty = summary ? isEmptyLandscape(summary) : false;
  const step = summary ? nextStep(summary) : null;
  const scopeLabel = systemOptions(systems, systemId).find((o) => o.id === systemId)?.label || '';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
        <div>
          <Title level="H2">Adoption Cockpit</Title>
          {greeting ? <Text>Welcome, {greeting}.</Text> : null}
        </div>
        <span style={{ display: 'inline-flex', gap: 'var(--adops-space-xs)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'grid', gap: 'var(--adops-space-xs)', minWidth: '16rem' }}>
            <Label>Target system</Label>
            <Select onChange={(e) => selectSystem(e.detail.selectedOption.dataset.value || '')}>
              <Option data-value="" selected={systemId === ''}>All target systems</Option>
              {systemOptions(systems, systemId).map((o) => (
                <Option key={o.id} data-value={o.id} selected={systemId === o.id}>{o.label}</Option>
              ))}
            </Select>
          </div>
          <Button design="Transparent" icon="refresh" onClick={() => setReloadToken((t) => t + 1)}>Refresh</Button>
        </span>
      </div>

      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip>
      ) : null}

      {step ? (
        <MessageStrip design="Information" hideCloseButton style={{ marginTop: 'var(--adops-space-sm)' }}>
          Next: {step.text}{' '}
          <Button design="Transparent" onClick={() => navigate(step.to)}>Open</Button>
        </MessageStrip>
      ) : null}

      {!summary && !error ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--adops-space-md)', marginTop: 'var(--adops-space-lg)' }}>
          {(empty || !summary ? JOURNEY.map((stage) => ({ ...stage, cards: [] })) : stages).map((stage, index) => (
            <StageCard key={stage.key} stage={stage} index={index}>
              {stage.cards.length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-sm)' }}>
                  {stage.cards.map((card) => (
                    <Kpi
                      key={card.key}
                      label={card.label}
                      value={card.value.toLocaleString()}
                      design={card.design}
                      title={`Open ${card.label.toLowerCase()}`}
                      onClick={() => navigate(card.to)}
                    />
                  ))}
                </div>
              ) : null}
            </StageCard>
          ))}
          {summary ? (
            <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)', fontSize: '0.8rem' }}>
              {scopeLabel ? `Scope ${scopeLabel} · ` : 'All target systems · '}
              figures as of {formatTimestamp(summary.GeneratedAt)}
              {summary.Scope?.AnalysisRunIds?.length > 1 ? ` · proposals span the current analysis run of ${summary.Scope.AnalysisRunIds.length} systems` : ''}
            </Text>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default DashboardPage;
