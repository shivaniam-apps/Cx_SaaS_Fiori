import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Title } from '@ui5/webcomponents-react/Title';
import { Text } from '@ui5/webcomponents-react/Text';
import { Button } from '@ui5/webcomponents-react/Button';
import { Table } from '@ui5/webcomponents-react/Table';
import { TableHeaderRow } from '@ui5/webcomponents-react/TableHeaderRow';
import { TableHeaderCell } from '@ui5/webcomponents-react/TableHeaderCell';
import { TableRow } from '@ui5/webcomponents-react/TableRow';
import { TableCell } from '@ui5/webcomponents-react/TableCell';
import { Input } from '@ui5/webcomponents-react/Input';
import { Select } from '@ui5/webcomponents-react/Select';
import { Option } from '@ui5/webcomponents-react/Option';
import { CheckBox } from '@ui5/webcomponents-react/CheckBox';
import { Tag } from '@ui5/webcomponents-react/Tag';
import { BusyIndicator } from '@ui5/webcomponents-react/BusyIndicator';
import { IllustratedMessage } from '@ui5/webcomponents-react/IllustratedMessage';
import { MessageStrip } from '@ui5/webcomponents-react/MessageStrip';
import { Panel } from '@ui5/webcomponents-react/Panel';
import {
  listExtractionRuns,
  queryTransactionUsage,
  queryTransactionUsers,
  getServiceErrorMessage
} from '../services/fioriService.js';

const EMPTY_FILTERS = { search: '', lineOfBusiness: '', customOnly: false };

function KpiTile({ label, value }) {
  return (
    <div style={{
      flex: '1 1 9rem', minWidth: '9rem', padding: 'var(--adops-card-padding)',
      border: 'var(--adops-card-border)', borderRadius: 'var(--adops-card-radius)',
      background: 'var(--adops-card-background)'
    }}>
      <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)', fontSize: '0.8rem' }}>{label}</Text>
      <br />
      <Text style={{ fontSize: '1.4rem', fontWeight: 700 }}>{value}</Text>
    </div>
  );
}

export function UsageInsightPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const runFromUrl = searchParams.get('run') || '';

  const [runs, setRuns] = useState([]);
  const [runId, setRunId] = useState(runFromUrl);
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Filter bar contract (fiori-ux.md): draft edits, only Go commits.
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [drill, setDrill] = useState(null); // { transaction, users, loading }

  useEffect(() => {
    let cancelled = false;
    listExtractionRuns()
      .then((rows) => {
        if (cancelled) return;
        const usable = rows.filter((r) => ['COMPLETED', 'PARTIAL'].includes(r.Status));
        setRuns(usable);
        if (!runFromUrl && usable.length) setRunId(usable[0].ID);
      })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e, 'Could not load extraction runs.')); });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!runId) return undefined;
    let cancelled = false;
    setLoading(true);
    queryTransactionUsage({
      extractionRunId: runId,
      search: applied.search || null,
      lineOfBusiness: applied.lineOfBusiness || null,
      customOnly: applied.customOnly,
      top: 200,
      includeSummary: true
    })
      .then((result) => { if (!cancelled) { setPage(result); setError(''); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e, 'Could not query transaction usage.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [runId, applied]);

  const lineOfBusinessOptions = useMemo(() => {
    const set = new Set((page?.Items || []).map((item) => item.LineOfBusiness).filter(Boolean));
    return ['', ...Array.from(set).sort()];
  }, [page]);

  const openDrill = async (item) => {
    setDrill({ transaction: item, users: null, loading: true });
    try {
      const users = await queryTransactionUsers(runId, item.TransactionCode);
      setDrill({ transaction: item, users, loading: false });
    } catch (e) {
      setDrill({ transaction: item, users: [], loading: false, error: getServiceErrorMessage(e) });
    }
  };

  const summary = page?.Summary;
  // The 80% Pareto cut: first row whose cumulative share crosses 80.
  const paretoIndex = useMemo(() => {
    const items = page?.Items || [];
    return items.findIndex((item) => Number(item.CumulativePercent) >= 80);
  }, [page]);

  return (
    <div>
      <Title level="H2">Usage Insight</Title>

      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>
          {error}
        </MessageStrip>
      ) : null}

      {/* Scope + filter bar (draft/apply contract) */}
      <div style={{
        display: 'flex', gap: 'var(--adops-space-sm)', alignItems: 'flex-end', flexWrap: 'wrap',
        marginTop: 'var(--adops-space-md)', padding: 'var(--adops-space-sm)',
        border: 'var(--adops-card-border)', borderRadius: 'var(--adops-card-radius)',
        background: 'var(--adops-card-background)'
      }}>
        <div>
          <Text style={{ fontSize: '0.75rem', fontWeight: 600 }}>Extraction run</Text>
          <br />
          <Select onChange={(e) => {
            const value = e.detail.selectedOption.dataset.value;
            setRunId(value);
            setSearchParams(value ? { run: value } : {});
            setDrill(null);
          }}>
            {runs.map((run) => (
              <Option key={run.ID} data-value={run.ID} selected={runId === run.ID}>{run.Title}</Option>
            ))}
          </Select>
        </div>
        <div>
          <Text style={{ fontSize: '0.75rem', fontWeight: 600 }}>Transaction</Text>
          <br />
          <Input
            placeholder="e.g. VA01"
            value={draft.search}
            onInput={(e) => setDraft({ ...draft, search: e.target.value })}
          />
        </div>
        <div>
          <Text style={{ fontSize: '0.75rem', fontWeight: 600 }}>Line of business</Text>
          <br />
          <Select onChange={(e) => setDraft({ ...draft, lineOfBusiness: e.detail.selectedOption.dataset.value })}>
            {lineOfBusinessOptions.map((lob) => (
              <Option key={lob || 'all'} data-value={lob} selected={draft.lineOfBusiness === lob}>
                {lob || 'All'}
              </Option>
            ))}
          </Select>
        </div>
        <CheckBox
          text="Custom (Y/Z) only"
          checked={draft.customOnly}
          onChange={(e) => setDraft({ ...draft, customOnly: e.target.checked })}
        />
        <Button design="Emphasized" onClick={() => setApplied(draft)}>Go</Button>
        <Button design="Transparent" onClick={() => { setDraft(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); }}>
          Clear
        </Button>
      </div>

      {summary ? (
        <div style={{ display: 'flex', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)', flexWrap: 'wrap' }}>
          <KpiTile label="Transactions used" value={summary.totalTcodes?.toLocaleString?.() ?? summary.totalTcodes} />
          <KpiTile label="Executions" value={Number(summary.totalExecutions).toLocaleString()} />
          <KpiTile label="Rows shown" value={`${page.Items.length}${page.HasMore ? '+' : ''}`} />
          <KpiTile label="80% of usage sits in" value={paretoIndex >= 0 ? `${paretoIndex + 1} transactions` : '—'} />
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--adops-space-md)', marginTop: 'var(--adops-space-md)', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          {loading ? (
            <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
          ) : !page || page.Items.length === 0 ? (
            <IllustratedMessage
              name="NoData"
              titleText="No usage rows"
              subtitleText={runs.length ? 'Adjust the filters or pick another run.' : 'Run an extraction first.'}
            />
          ) : (
            <Table
              headerRow={
                <TableHeaderRow sticky>
                  <TableHeaderCell><span>Transaction</span></TableHeaderCell>
                  <TableHeaderCell><span>Description</span></TableHeaderCell>
                  <TableHeaderCell><span>Module</span></TableHeaderCell>
                  <TableHeaderCell><span>Executions</span></TableHeaderCell>
                  <TableHeaderCell><span>Users</span></TableHeaderCell>
                  <TableHeaderCell><span>Avg resp. ms</span></TableHeaderCell>
                  <TableHeaderCell><span>Share %</span></TableHeaderCell>
                  <TableHeaderCell><span>Cumulative %</span></TableHeaderCell>
                </TableHeaderRow>
              }
            >
              {page.Items.map((item, index) => (
                <TableRow
                  key={item.ID}
                  interactive
                  onClick={() => openDrill(item)}
                  style={paretoIndex >= 0 && index <= paretoIndex
                    ? { background: 'var(--sapInformationBackground, #e6f2f9)' }
                    : undefined}
                >
                  <TableCell>
                    <span style={{ fontWeight: 600 }}>
                      {item.TransactionCode}
                      {item.IsCustom ? <Tag design="Critical" style={{ marginLeft: '0.4rem' }}>custom</Tag> : null}
                    </span>
                  </TableCell>
                  <TableCell><span>{item.TransactionText}</span></TableCell>
                  <TableCell><span>{item.LineOfBusiness}</span></TableCell>
                  <TableCell><span>{Number(item.ExecutionCount).toLocaleString()}</span></TableCell>
                  <TableCell><span>{item.DistinctUserCount}</span></TableCell>
                  <TableCell><span>{Math.round(item.AvgResponseTimeMs)}</span></TableCell>
                  <TableCell><span>{item.SharePercent}</span></TableCell>
                  <TableCell>
                    <span style={{ fontWeight: Number(item.CumulativePercent) <= 80 ? 700 : 400 }}>
                      {item.CumulativePercent || '—'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          )}
        </div>

        {drill ? (
          <Panel
            headerText={`${drill.transaction.TransactionCode} — users running it`}
            style={{ flex: '0 0 24rem', maxWidth: '24rem' }}
          >
            <div style={{ marginBottom: 'var(--adops-space-xs)' }}>
              <Button design="Transparent" onClick={() => setDrill(null)}>Close</Button>
            </div>
            {drill.loading ? (
              <BusyIndicator active delay={100} style={{ display: 'block' }} />
            ) : drill.error ? (
              <MessageStrip design="Negative" hideCloseButton>{drill.error}</MessageStrip>
            ) : drill.users.length === 0 ? (
              <Text>No per-user rows for this transaction in the selected run.</Text>
            ) : (
              <>
                <MessageStrip design="Information" hideCloseButton style={{ marginBottom: 'var(--adops-space-xs)' }}>
                  User identifiers are pseudonymised. Identified mode is an audited
                  per-system opt-in in Settings.
                </MessageStrip>
                <Table
                  headerRow={
                    <TableHeaderRow>
                      <TableHeaderCell><span>User</span></TableHeaderCell>
                      <TableHeaderCell><span>Executions</span></TableHeaderCell>
                      <TableHeaderCell><span>Last used</span></TableHeaderCell>
                    </TableHeaderRow>
                  }
                >
                  {drill.users.map((user) => (
                    <TableRow key={user.ID}>
                      <TableCell><span style={{ fontFamily: 'monospace' }}>{String(user.UserKey).slice(0, 12)}…</span></TableCell>
                      <TableCell><span>{Number(user.ExecutionCount).toLocaleString()}</span></TableCell>
                      <TableCell><span>{user.LastUsedOn}</span></TableCell>
                    </TableRow>
                  ))}
                </Table>
              </>
            )}
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

export default UsageInsightPage;
