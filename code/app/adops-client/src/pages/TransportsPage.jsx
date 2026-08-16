import { useEffect, useState } from 'react';
import { Title } from '@ui5/webcomponents-react/Title';
import { Text } from '@ui5/webcomponents-react/Text';
import { Button } from '@ui5/webcomponents-react/Button';
import { Table } from '@ui5/webcomponents-react/Table';
import { TableHeaderRow } from '@ui5/webcomponents-react/TableHeaderRow';
import { TableHeaderCell } from '@ui5/webcomponents-react/TableHeaderCell';
import { TableRow } from '@ui5/webcomponents-react/TableRow';
import { TableCell } from '@ui5/webcomponents-react/TableCell';
import { Tag } from '@ui5/webcomponents-react/Tag';
import { BusyIndicator } from '@ui5/webcomponents-react/BusyIndicator';
import { IllustratedMessage } from '@ui5/webcomponents-react/IllustratedMessage';
import { MessageStrip } from '@ui5/webcomponents-react/MessageStrip';
import { Dialog } from '@ui5/webcomponents-react/Dialog';
import { fetchUserInfo } from '../services/coreService.js';
import { hasActivatorAccess } from '../features/auth/memberAccess.js';
import {
  queryTransportRequests,
  releaseTransport,
  getServiceErrorMessage
} from '../services/fioriService.js';

const STATUS_DESIGN = {
  MODIFIABLE: 'Information',
  RELEASING: 'Critical',
  RELEASED: 'Positive',
  RELEASE_FAILED: 'Negative'
};

export function TransportsPage() {
  const [userInfo, setUserInfo] = useState(null);
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(null); // transport row
  const [lastResult, setLastResult] = useState(null);         // { transportId, ...payload }
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchUserInfo()
      .then((info) => { if (!cancelled) setUserInfo(info); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    queryTransportRequests()
      .then((result) => { if (!cancelled) { setItems(result.Items); setError(''); } })
      .catch((e) => { if (!cancelled) setError(getServiceErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [reloadToken]);

  const runRelease = async (transport, simulate) => {
    try {
      setBusy(true);
      const result = await releaseTransport(transport.ID, simulate);
      setLastResult({ transportId: transport.ID, trkorr: transport.TransportRequestId, ...result });
      setConfirmRelease(null);
      if (!simulate) setReloadToken((t) => t + 1);
    } catch (e) {
      setError(getServiceErrorMessage(e));
      setConfirmRelease(null);
    } finally {
      setBusy(false);
    }
  };

  const activator = hasActivatorAccess(userInfo);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--adops-space-sm)' }}>
        <Title level="H2">Transports</Title>
        <Button design="Transparent" icon="refresh" onClick={() => setReloadToken((t) => t + 1)}>Refresh</Button>
      </div>

      {error ? (
        <MessageStrip design="Negative" style={{ marginTop: 'var(--adops-space-sm)' }} onClose={() => setError('')}>{error}</MessageStrip>
      ) : null}

      {lastResult ? (
        <MessageStrip
          design={['RELEASED'].includes(lastResult.Status) || lastResult.Simulated ? 'Positive' : 'Negative'}
          style={{ marginTop: 'var(--adops-space-sm)' }}
          onClose={() => setLastResult(null)}
        >
          {lastResult.Simulated ? 'Release simulation' : 'Release'} for {lastResult.trkorr}:{' '}
          {(lastResult.Messages || []).map((m) => m.message).join(' ') || lastResult.Status}
        </MessageStrip>
      ) : null}

      {!items ? (
        <BusyIndicator active delay={200} style={{ display: 'block', marginTop: '6vh' }} />
      ) : items.length === 0 ? (
        <IllustratedMessage
          name="NoData"
          titleText="No transport requests yet"
          subtitleText="Executing an activation plan creates the transport that carries its content."
        />
      ) : (
        <div style={{ marginTop: 'var(--adops-space-md)' }}>
          <Table
            headerRow={
              <TableHeaderRow sticky>
                <TableHeaderCell><span>Request</span></TableHeaderCell>
                <TableHeaderCell><span>Description</span></TableHeaderCell>
                <TableHeaderCell><span>Wave / Plan</span></TableHeaderCell>
                <TableHeaderCell><span>System</span></TableHeaderCell>
                <TableHeaderCell><span>Status</span></TableHeaderCell>
                <TableHeaderCell><span>Released</span></TableHeaderCell>
                <TableHeaderCell><span></span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {items.map((row) => (
              <TableRow key={row.ID}>
                <TableCell><span style={{ fontWeight: 600 }}>{row.TransportRequestId}</span></TableCell>
                <TableCell><span>{row.Description}</span></TableCell>
                <TableCell><span>{[row.WaveName, row.PlanName].filter(Boolean).join(' / ') || '—'}</span></TableCell>
                <TableCell><span>{row.TargetSystemName || '—'}</span></TableCell>
                <TableCell><Tag design={STATUS_DESIGN[row.Status] || 'Neutral'}>{row.Status}</Tag></TableCell>
                <TableCell>
                  <span>{row.ReleasedAt ? `${String(row.ReleasedAt).slice(0, 16).replace('T', ' ')}${row.ReleasedBy ? ` by ${row.ReleasedBy}` : ''}` : '—'}</span>
                </TableCell>
                <TableCell>
                  {activator && ['MODIFIABLE', 'RELEASE_FAILED'].includes(row.Status) ? (
                    <span style={{ display: 'inline-flex', gap: 'var(--adops-space-xs)' }}>
                      <Button design="Transparent" icon="simulate" disabled={busy} onClick={() => runRelease(row, true)}>
                        Check
                      </Button>
                      <Button design="Emphasized" icon="cargo-train" disabled={busy} onClick={() => setConfirmRelease(row)}>
                        Release
                      </Button>
                    </span>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      )}

      <Dialog
        open={Boolean(confirmRelease)}
        headerText="Release Transport Request"
        onClose={() => setConfirmRelease(null)}
      >
        {confirmRelease ? (
          <div style={{ padding: 'var(--adops-space-sm)', minWidth: '22rem' }}>
            <Text>
              Release {confirmRelease.TransportRequestId} ("{confirmRelease.Description}") on{' '}
              {confirmRelease.TargetSystemName || 'the target system'}? Releasing hands the request to the
              transport route and cannot be undone. Run Check first for the release checks without releasing.
            </Text>
          </div>
        ) : null}
        <div slot="footer" style={{ display: 'flex', gap: 'var(--adops-space-xs)', justifyContent: 'flex-end', width: '100%' }}>
          <Button design="Transparent" onClick={() => setConfirmRelease(null)}>Cancel</Button>
          <Button design="Negative" disabled={busy} onClick={() => runRelease(confirmRelease, false)}>Release</Button>
        </div>
      </Dialog>
    </div>
  );
}

export default TransportsPage;
