import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Title } from '@ui5/webcomponents-react/Title';
import { Button } from '@ui5/webcomponents-react/Button';
import { Table } from '@ui5/webcomponents-react/Table';
import { TableHeaderRow } from '@ui5/webcomponents-react/TableHeaderRow';
import { TableHeaderCell } from '@ui5/webcomponents-react/TableHeaderCell';
import { TableRow } from '@ui5/webcomponents-react/TableRow';
import { TableCell } from '@ui5/webcomponents-react/TableCell';
import { Dialog } from '@ui5/webcomponents-react/Dialog';
import { Label } from '@ui5/webcomponents-react/Label';
import { Select } from '@ui5/webcomponents-react/Select';
import { Option } from '@ui5/webcomponents-react/Option';
import { DatePicker } from '@ui5/webcomponents-react/DatePicker';
import { Tag } from '@ui5/webcomponents-react/Tag';
import { ProgressIndicator } from '@ui5/webcomponents-react/ProgressIndicator';
import { BusyIndicator } from '@ui5/webcomponents-react/BusyIndicator';
import { IllustratedMessage } from '@ui5/webcomponents-react/IllustratedMessage';
import { MessageStrip } from '@ui5/webcomponents-react/MessageStrip';
import {
  listTargetSystems,
  listExtractionRuns,
  runUsageExtraction,
  getTaskStatus,
  getServiceErrorMessage,
  TERMINAL_TASK_STATES
} from '../services/fioriService.js';
import useRunPolling from '../hooks/useRunPolling.js';

const RUN_TAG_DESIGN = {
  COMPLETED: 'Positive',
  RUNNING: 'Information',
  QUEUED: 'Neutral',
  PARTIAL: 'Critical',
  FAILED: 'Negative',
  CANCELLED: 'Neutral'
};

function isoDaysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

export function ExtractionsPage() {
  const navigate = useNavigate();
  const [systems, setSystems] = useState([]);
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [draft, setDraft] = useState({
    targetSystemId: '',
    periodFrom: isoDaysAgo(180),
    periodTo: isoDaysAgo(1),
    granularity: 'MONTH'
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([listTargetSystems(), listExtractionRuns()])
      .then(([systemRows, runRows]) => {
        if (cancelled) return;
        setSystems(systemRows);
        setRuns(runRows);
        setError('');
        if (!draft.targetSystemId && systemRows.length) {
          setDraft((d) => ({ ...d, targetSystemId: systemRows[0].ID }));
        }
      })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e, 'Could not load extractions.')); });
    return () => { cancelled = true; };
  }, [reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live progress on the most recently started task; on terminal status,
  // refresh only the affected list.
  const polling = useRunPolling({
    id: activeTaskId,
    fetchStatus: getTaskStatus,
    isTerminal: (status) => TERMINAL_TASK_STATES.includes(status?.status)
  });

  useEffect(() => {
    if (polling.status && TERMINAL_TASK_STATES.includes(polling.status.status)) {
      setReloadToken((t) => t + 1);
    }
  }, [polling.status?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const systemNames = useMemo(
    () => Object.fromEntries(systems.map((s) => [s.ID, s.displayName])),
    [systems]
  );

  const startExtraction = async () => {
    setStarting(true);
    try {
      const handle = await runUsageExtraction({
        targetSystemId: draft.targetSystemId,
        sources: ['ST03N'],
        periodFrom: draft.periodFrom,
        periodTo: draft.periodTo,
        granularity: draft.granularity,
        topUsersPerTcode: 20,
        minExecutions: 1
      });
      setActiveTaskId(handle.taskId);
      setDialogOpen(false);
      setReloadToken((t) => t + 1);
    } catch (e) {
      setError(getServiceErrorMessage(e, 'Could not start the extraction.'));
    } finally {
      setStarting(false);
    }
  };

  const live = polling.status;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level="H2">Extractions</Title>
        <Button design="Emphasized" icon="database" disabled={!systems.length} onClick={() => setDialogOpen(true)}>
          New Extraction
        </Button>
      </div>

      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>
          {error}
        </MessageStrip>
      ) : null}

      {live && !TERMINAL_TASK_STATES.includes(live.status) ? (
        <div style={{
          marginTop: 'var(--adops-space-md)', padding: 'var(--adops-card-padding)',
          border: 'var(--adops-card-border)', borderRadius: 'var(--adops-card-radius)',
          background: 'var(--adops-card-background)'
        }}>
          <Label>{live.phase || 'Running'}{polling.isStale ? ' (connection lost — showing last known state)' : ''}</Label>
          <ProgressIndicator
            value={live.progressPercent || 0}
            displayValue={live.totalItems ? `${live.processedItems}/${live.totalItems}` : `${live.progressPercent || 0}%`}
            style={{ marginTop: 'var(--adops-space-xs)' }}
          />
        </div>
      ) : null}

      {!runs ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '10vh' }} />
      ) : runs.length === 0 ? (
        <IllustratedMessage
          name="NoData"
          titleText="No extractions yet"
          subtitleText="Run the first usage extraction to pull the real transaction pattern from the backend."
        />
      ) : (
        <Table
          style={{ marginTop: 'var(--adops-space-md)' }}
          headerRow={
            <TableHeaderRow sticky>
              <TableHeaderCell><span>Title</span></TableHeaderCell>
              <TableHeaderCell><span>System</span></TableHeaderCell>
              <TableHeaderCell><span>Period</span></TableHeaderCell>
              <TableHeaderCell><span>Status</span></TableHeaderCell>
              <TableHeaderCell><span>Transactions</span></TableHeaderCell>
              <TableHeaderCell><span>User rows</span></TableHeaderCell>
              <TableHeaderCell><span>Actions</span></TableHeaderCell>
            </TableHeaderRow>
          }
        >
          {runs.map((run) => (
            <TableRow key={run.ID}>
              <TableCell><span style={{ fontWeight: 600 }}>{run.Title}</span></TableCell>
              <TableCell><span>{systemNames[run.targetSystem_ID] || '—'}</span></TableCell>
              <TableCell><span>{run.PeriodFrom} → {run.PeriodTo}</span></TableCell>
              <TableCell><Tag design={RUN_TAG_DESIGN[run.Status] || 'Neutral'}>{run.Status}</Tag></TableCell>
              <TableCell><span>{run.TransactionRowCount ?? '—'}</span></TableCell>
              <TableCell><span>{run.UserRowCount ?? '—'}</span></TableCell>
              <TableCell>
                <Button
                  design="Transparent"
                  icon="bar-chart"
                  disabled={run.Status !== 'COMPLETED' && run.Status !== 'PARTIAL'}
                  onClick={() => navigate(`/usage/transactions?run=${run.ID}`)}
                >
                  Open Usage Insight
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      )}

      <Dialog open={dialogOpen} headerText="New Usage Extraction" onClose={() => setDialogOpen(false)}>
        <div style={{ display: 'grid', gap: 'var(--adops-space-sm)', padding: 'var(--adops-space-sm)', minWidth: '22rem' }}>
          <Label for="ex-system" required>Target system</Label>
          <Select id="ex-system" onChange={(e) => setDraft({ ...draft, targetSystemId: e.detail.selectedOption.dataset.value })}>
            {systems.map((system) => (
              <Option key={system.ID} data-value={system.ID} selected={draft.targetSystemId === system.ID}>
                {system.displayName}
              </Option>
            ))}
          </Select>
          <Label for="ex-from">Period from</Label>
          <DatePicker
            id="ex-from"
            formatPattern="yyyy-MM-dd"
            value={draft.periodFrom}
            onChange={(e) => setDraft({ ...draft, periodFrom: e.detail.value })}
          />
          <Label for="ex-to">Period to</Label>
          <DatePicker
            id="ex-to"
            formatPattern="yyyy-MM-dd"
            value={draft.periodTo}
            onChange={(e) => setDraft({ ...draft, periodTo: e.detail.value })}
          />
          <Label for="ex-gran">Granularity</Label>
          <Select id="ex-gran" onChange={(e) => setDraft({ ...draft, granularity: e.detail.selectedOption.dataset.value })}>
            {['MONTH', 'WEEK', 'DAY'].map((granularity) => (
              <Option key={granularity} data-value={granularity} selected={draft.granularity === granularity}>
                {granularity}
              </Option>
            ))}
          </Select>
          <MessageStrip design="Information" hideCloseButton>
            Sources: ST03N transaction and user profiles. User identifiers are pseudonymised unless
            this system was explicitly switched to identified mode.
          </MessageStrip>
        </div>
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button design="Emphasized" disabled={!draft.targetSystemId || starting} onClick={startExtraction}>
            {starting ? 'Starting…' : 'Start Extraction'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export default ExtractionsPage;
