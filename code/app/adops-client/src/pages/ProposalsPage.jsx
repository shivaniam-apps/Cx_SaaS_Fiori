import { useEffect, useState } from 'react';
import { Title } from '@ui5/webcomponents-react/Title';
import { Text } from '@ui5/webcomponents-react/Text';
import { Button } from '@ui5/webcomponents-react/Button';
import { Table } from '@ui5/webcomponents-react/Table';
import { TableHeaderRow } from '@ui5/webcomponents-react/TableHeaderRow';
import { TableHeaderCell } from '@ui5/webcomponents-react/TableHeaderCell';
import { TableRow } from '@ui5/webcomponents-react/TableRow';
import { TableCell } from '@ui5/webcomponents-react/TableCell';
import { Select } from '@ui5/webcomponents-react/Select';
import { Option } from '@ui5/webcomponents-react/Option';
import { Tag } from '@ui5/webcomponents-react/Tag';
import { BusyIndicator } from '@ui5/webcomponents-react/BusyIndicator';
import { IllustratedMessage } from '@ui5/webcomponents-react/IllustratedMessage';
import { MessageStrip } from '@ui5/webcomponents-react/MessageStrip';
import { Panel } from '@ui5/webcomponents-react/Panel';
import { Dialog } from '@ui5/webcomponents-react/Dialog';
import { TextArea } from '@ui5/webcomponents-react/TextArea';
import { Label } from '@ui5/webcomponents-react/Label';
import { fetchUserInfo } from '../services/coreService.js';
import { hasApproverAccess } from '../features/auth/memberAccess.js';
import {
  listExtractionRuns,
  listAnalysisRuns,
  generateProposals,
  queryProposals,
  readProposal,
  decideProposal,
  getTaskStatus,
  getServiceErrorMessage,
  TERMINAL_TASK_STATES
} from '../services/fioriService.js';
import useRunPolling from '../hooks/useRunPolling.js';

const CONFIDENCE_DESIGN = { HIGH: 'Positive', MEDIUM: 'Critical', LOW: 'Negative' };
const STATUS_DESIGN = { NEW: 'Information', APPROVED: 'Positive', REJECTED: 'Negative', DEFERRED: 'Neutral', SUPERSEDED: 'Neutral' };

function Kpi({ label, value, emphasis }) {
  return (
    <div style={{
      flex: '1 1 8rem', minWidth: '8rem', padding: 'var(--adops-card-padding)',
      border: 'var(--adops-card-border)', borderRadius: 'var(--adops-card-radius)',
      background: 'var(--adops-card-background)'
    }}>
      <Text style={{ color: 'var(--sapNeutralTextColor, #6a6d70)', fontSize: '0.8rem' }}>{label}</Text>
      <br />
      <Text style={{ fontSize: '1.4rem', fontWeight: 700, color: emphasis ? 'var(--sapPositiveTextColor, #107e3e)' : undefined }}>
        {value}
      </Text>
    </div>
  );
}

export function ProposalsPage() {
  const [userInfo, setUserInfo] = useState(null);
  const [analysisRuns, setAnalysisRuns] = useState([]);
  const [extractionRuns, setExtractionRuns] = useState([]);
  const [analysisRunId, setAnalysisRunId] = useState('');
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [decision, setDecision] = useState(null); // {proposal, kind, notes}
  const [generatingTaskId, setGeneratingTaskId] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchUserInfo(), listAnalysisRuns(), listExtractionRuns()])
      .then(([info, runs, extractions]) => {
        if (cancelled) return;
        setUserInfo(info);
        setAnalysisRuns(runs);
        setExtractionRuns(extractions.filter((run) => ['COMPLETED', 'PARTIAL'].includes(run.Status)));
        const firstCompleted = runs.find((run) => run.Status === 'COMPLETED');
        if (firstCompleted) setAnalysisRunId((current) => current || firstCompleted.ID);
      })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [reloadToken]);

  useEffect(() => {
    if (!analysisRunId) return undefined;
    let cancelled = false;
    setLoading(true);
    queryProposals({ analysisRunId, top: 200, includeSummary: true })
      .then((result) => { if (!cancelled) { setPage(result); setError(''); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [analysisRunId, reloadToken]);

  const polling = useRunPolling({
    id: generatingTaskId,
    fetchStatus: getTaskStatus,
    isTerminal: (status) => TERMINAL_TASK_STATES.includes(status?.status)
  });
  useEffect(() => {
    if (polling.status && TERMINAL_TASK_STATES.includes(polling.status.status)) {
      setGeneratingTaskId(null);
      setReloadToken((t) => t + 1);
    }
  }, [polling.status?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const startAnalysis = async () => {
    const latest = extractionRuns[0];
    if (!latest) return;
    try {
      const handle = await generateProposals({ extractionRunId: latest.ID, scoringProfile: 'BALANCED' });
      setGeneratingTaskId(handle.taskId);
    } catch (e) {
      setError(getServiceErrorMessage(e));
    }
  };

  const openDetail = async (proposal) => {
    try {
      setDetail({ loading: true });
      setDetail({ loading: false, ...(await readProposal(proposal.ID)) });
    } catch (e) {
      setDetail({ loading: false, error: getServiceErrorMessage(e) });
    }
  };

  const submitDecision = async () => {
    const { proposal, kind, notes } = decision;
    try {
      await decideProposal(kind, proposal.ID, notes);
      setDecision(null);
      setDetail(null);
      setReloadToken((t) => t + 1);
    } catch (e) {
      setError(getServiceErrorMessage(e));
      setDecision(null);
    }
  };

  const approver = hasApproverAccess(userInfo);
  const summary = page?.Summary;
  const decisionValid = decision && (decision.kind !== 'rejectProposal' || decision.notes.trim());

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
        <Title level="H2">Proposals</Title>
        <div style={{ display: 'flex', gap: 'var(--adops-space-xs)', alignItems: 'center' }}>
          <Select onChange={(e) => setAnalysisRunId(e.detail.selectedOption.dataset.value)}>
            {analysisRuns.map((run) => (
              <Option key={run.ID} data-value={run.ID} selected={analysisRunId === run.ID}>
                {run.Title} ({run.Status})
              </Option>
            ))}
          </Select>
          <Button design="Emphasized" icon="lightbulb" disabled={!extractionRuns.length || Boolean(generatingTaskId)} onClick={startAnalysis}>
            {generatingTaskId ? 'Analysing…' : 'Generate Proposals'}
          </Button>
        </div>
      </div>

      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip>
      ) : null}

      {summary ? (
        <div style={{ display: 'flex', gap: 'var(--adops-space-sm)', marginTop: 'var(--adops-space-md)', flexWrap: 'wrap' }}>
          <Kpi label="Open" value={summary.open} />
          <Kpi label="Accepted" value={summary.approved} />
          <Kpi label="Rejected" value={summary.rejected} />
          <Kpi label="Deferred" value={summary.deferred} />
          <Kpi label="No Fiori path" value={summary.noEquivalent} />
          <Kpi label="GUI usage covered by accepted set" value={`${summary.approvedExecutionShare}%`} emphasis />
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--adops-space-md)', marginTop: 'var(--adops-space-md)', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          {loading ? (
            <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
          ) : !page || page.Items.length === 0 ? (
            <IllustratedMessage
              name="NoData"
              titleText="No proposals yet"
              subtitleText="Generate proposals from a completed extraction run."
            />
          ) : (
            <Table
              headerRow={
                <TableHeaderRow sticky>
                  <TableHeaderCell><span>#</span></TableHeaderCell>
                  <TableHeaderCell><span>Fiori App</span></TableHeaderCell>
                  <TableHeaderCell><span>Persona</span></TableHeaderCell>
                  <TableHeaderCell><span>Transactions</span></TableHeaderCell>
                  <TableHeaderCell><span>Users</span></TableHeaderCell>
                  <TableHeaderCell><span>Score</span></TableHeaderCell>
                  <TableHeaderCell><span>Coverage</span></TableHeaderCell>
                  <TableHeaderCell><span>Confidence</span></TableHeaderCell>
                  <TableHeaderCell><span>Status</span></TableHeaderCell>
                </TableHeaderRow>
              }
            >
              {page.Items.map((proposal) => (
                <TableRow key={proposal.ID} interactive onClick={() => openDetail(proposal)}>
                  <TableCell><span>{proposal.Rank}</span></TableCell>
                  <TableCell>
                    <span style={{ fontWeight: 600 }}>
                      {proposal.AppTitle}
                      {proposal.FioriId ? <span style={{ color: 'var(--sapNeutralTextColor)', fontWeight: 400 }}> {proposal.FioriId}</span> : null}
                    </span>
                  </TableCell>
                  <TableCell><span>{proposal.Persona || proposal.LineOfBusiness}</span></TableCell>
                  <TableCell><span>{proposal.MatchedTcodeCount}</span></TableCell>
                  <TableCell><span>{proposal.DistinctUserCount}</span></TableCell>
                  <TableCell><span style={{ fontWeight: 700 }}>{Math.round(proposal.Score)}</span></TableCell>
                  <TableCell><span>{proposal.CoveragePercent}%</span></TableCell>
                  <TableCell><Tag design={CONFIDENCE_DESIGN[proposal.Confidence] || 'Neutral'}>{proposal.Confidence}</Tag></TableCell>
                  <TableCell><Tag design={STATUS_DESIGN[proposal.ReviewStatus] || 'Neutral'}>{proposal.ReviewStatus === 'SUPERSEDED' ? 'NO PATH' : proposal.ReviewStatus}</Tag></TableCell>
                </TableRow>
              ))}
            </Table>
          )}
        </div>

        {detail ? (
          <Panel headerText={detail.proposal ? `${detail.proposal.AppTitle}` : 'Proposal'} style={{ flex: '0 0 26rem', maxWidth: '26rem' }}>
            <div style={{ marginBottom: 'var(--adops-space-xs)', display: 'flex', gap: 'var(--adops-space-xs)', flexWrap: 'wrap' }}>
              <Button design="Transparent" onClick={() => setDetail(null)}>Close</Button>
              {approver && detail.proposal && !['APPROVED', 'SUPERSEDED'].includes(detail.proposal.ReviewStatus) ? (
                <>
                  <Button design="Positive" onClick={() => setDecision({ proposal: detail.proposal, kind: 'approveProposal', notes: '' })}>Accept</Button>
                  <Button design="Negative" onClick={() => setDecision({ proposal: detail.proposal, kind: 'rejectProposal', notes: '' })}>Reject</Button>
                  <Button onClick={() => setDecision({ proposal: detail.proposal, kind: 'deferProposal', notes: '' })}>Defer</Button>
                </>
              ) : null}
            </div>
            {detail.loading ? <BusyIndicator active delay={100} style={{ display: 'block' }} /> : null}
            {detail.error ? <MessageStrip design="Negative" hideCloseButton>{detail.error}</MessageStrip> : null}
            {detail.proposal ? (
              <>
                <Text style={{ display: 'block', marginBottom: 'var(--adops-space-sm)' }}>{detail.proposal.RationaleText}</Text>
                {detail.proposal.BusinessRoleId ? (
                  <Text style={{ display: 'block', marginBottom: 'var(--adops-space-sm)', color: 'var(--sapNeutralTextColor)' }}>
                    Business role: {detail.proposal.BusinessRoleId}
                  </Text>
                ) : null}
                <Table
                  headerRow={
                    <TableHeaderRow>
                      <TableHeaderCell><span>Transaction</span></TableHeaderCell>
                      <TableHeaderCell><span>Executions</span></TableHeaderCell>
                      <TableHeaderCell><span>Share</span></TableHeaderCell>
                      <TableHeaderCell><span>Mapping</span></TableHeaderCell>
                    </TableHeaderRow>
                  }
                >
                  {(detail.evidence || []).map((row) => (
                    <TableRow key={row.ID}>
                      <TableCell><span style={{ fontWeight: 600 }}>{row.TransactionCode}</span></TableCell>
                      <TableCell><span>{Number(row.ExecutionCount).toLocaleString()}</span></TableCell>
                      <TableCell><span>{row.SharePercent}%</span></TableCell>
                      <TableCell><span>{row.MappingType}</span></TableCell>
                    </TableRow>
                  ))}
                </Table>
                {detail.proposal.DecidedBy ? (
                  <MessageStrip design="Information" hideCloseButton style={{ marginTop: 'var(--adops-space-sm)' }}>
                    {detail.proposal.ReviewStatus} by {detail.proposal.DecidedBy}
                    {detail.proposal.DecisionNotes ? ` — ${detail.proposal.DecisionNotes}` : ''}
                  </MessageStrip>
                ) : null}
              </>
            ) : null}
          </Panel>
        ) : null}
      </div>

      <Dialog
        open={Boolean(decision)}
        headerText={decision?.kind === 'approveProposal' ? 'Accept Proposal' : decision?.kind === 'rejectProposal' ? 'Reject Proposal' : 'Defer Proposal'}
        onClose={() => setDecision(null)}
      >
        {decision ? (
          <div style={{ display: 'grid', gap: 'var(--adops-space-sm)', padding: 'var(--adops-space-sm)', minWidth: '20rem' }}>
            <Text>{decision.proposal.AppTitle}</Text>
            <Label required={decision.kind === 'rejectProposal'}>
              {decision.kind === 'rejectProposal' ? 'Reason (required)' : 'Note (optional)'}
            </Label>
            <TextArea rows={3} value={decision.notes} onInput={(e) => setDecision({ ...decision, notes: e.target.value })} />
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setDecision(null)}>Cancel</Button>
          <Button design="Emphasized" disabled={!decisionValid} onClick={submitDecision}>Confirm</Button>
        </div>
      </Dialog>
    </div>
  );
}

export default ProposalsPage;
