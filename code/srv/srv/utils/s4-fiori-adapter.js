const cds = require('@sap/cds');
const {
  DEFAULT_DESTINATION,
  DEFAULT_S4_SERVICE_ROOT,
  appendQuery,
  callS4Destination,
  cloudConnectorLocationId,
  resolveDestination,
  safeResponseData,
  shouldMockSap,
  unwrapODataPayload
} = require('./s4-http-client.js');
const { probeActivateService, activateRootFor, isODataRoot } = require('./s4-activate-adapter.js');
const { isActivationTargetEnvironment } = require('./activation-plan.js');

const LOG = cds.log('s4-fiori-adapter');

// ---------------------------------------------------------------------------
// Domain layer over the ZADO_USAGE_O4 OData V4 service. Owns entity paths,
// row mappers (field names per the verified API matrix,
// docu/06-s4-integration/api-matrix.md), paging and probes. Everything
// transport-y lives in s4-http-client.js.
// ---------------------------------------------------------------------------

function serviceRoot(targetSystem) {
  const root = String(targetSystem?.serviceRootPath || DEFAULT_S4_SERVICE_ROOT).trim();
  return root.replace(/\/+$/, '');
}

function destinationNameOf(targetSystem) {
  return String(targetSystem?.destinationName || DEFAULT_DESTINATION).trim();
}

function entityPath(targetSystem, entitySet) {
  return `${serviceRoot(targetSystem)}/${entitySet}`;
}

function trimConnectionCheckMessage(value) {
  return String(value || '').trim().slice(0, 500);
}

// ---------------------------------------------------------------------------
// Per-endpoint connection verdicts. A destination fronts two ZADO endpoints:
// the usage read service (every system) and the activation write unit, which
// ships to DEV only (CLAUDE.md safety contract). The check therefore reports
// one verdict per endpoint, and what counts as healthy for ACTIVATE depends
// on the environment: reachable on DEV/SANDBOX, unpublished on QA/PROD.
// ---------------------------------------------------------------------------

const ENDPOINT_USAGE = 'USAGE';
const ENDPOINT_ACTIVATE = 'ACTIVATE';
const PROBE_TIMEOUT_MS = 15000; // the user is waiting; a dead tunnel must answer fast

// Pure: judge the activation probe (probeActivateService result, or the
// error that prevented it) against the environment.
function activationEndpointVerdict({ environment, probe, error }) {
  const expected = isActivationTargetEnvironment(environment);
  const env = String(environment || '').trim().toUpperCase() || 'non-DEV';
  const base = {
    Endpoint: ENDPOINT_ACTIVATE,
    Ok: false,
    Stage: 'SERVICE',
    HttpStatus: Number(probe?.status) || 0,
    Path: String(probe?.path || ''),
    Transport: String(probe?.transport || ''),
    Message: ''
  };
  const identity = probe?.system ? ` (${probe.system}/${probe.client}, v${probe.version || 0})` : '';

  if (error) {
    return expected
      ? { ...base, Message: trimConnectionCheckMessage(`Activation service unreachable: ${error}`) }
      : { ...base, Ok: true, Stage: 'UNPUBLISHED', Message: trimConnectionCheckMessage(`Activation service not reachable on this ${env} system, as required outside DEV (${error}).`) };
  }
  if (probe?.ok) {
    return expected
      ? { ...base, Ok: true, Stage: 'OK', Message: `Activation write unit reachable${identity}.` }
      : { ...base, Stage: 'EXPOSED', Message: `Activation write unit is reachable on a ${env} system${identity} - it must stay unpublished outside DEV. Remove the SICF node or service binding.` };
  }
  return expected
    ? { ...base, Message: `Activation service at ${base.Path} answered ${base.HttpStatus || 'nothing'} - publish the DEV-only node (ZCL_ADO_ACT_HTTP) or correct activationRootPath.` }
    : { ...base, Ok: true, Stage: 'UNPUBLISHED', Message: `Activation service not published on this ${env} system (status ${base.HttpStatus || 'none'}), as required outside DEV.` };
}

async function probeActivationEndpoint({ targetSystem }) {
  if (shouldMockSap()) {
    const expected = isActivationTargetEnvironment(targetSystem?.environment);
    const path = activateRootFor(targetSystem);
    const verdict = activationEndpointVerdict({
      environment: targetSystem?.environment,
      probe: {
        ok: expected, status: expected ? 200 : 404, path,
        transport: isODataRoot(path) ? 'odata' : 'icf',
        system: targetSystem?.systemId || 'MCK', client: targetSystem?.client || '100', version: 1
      }
    });
    return { ...verdict, Message: `${verdict.Message} [mock]` };
  }
  try {
    const probe = await probeActivateService({ targetSystem });
    return activationEndpointVerdict({ environment: targetSystem?.environment, probe });
  } catch (error) {
    return activationEndpointVerdict({ environment: targetSystem?.environment, error: error.message });
  }
}

// Structured connectivity verdict for the Target Systems "Test Connection"
// action. Unlike the generic testS4Destination proxy (whose consumers parse
// whatever payload comes back), a non-2xx S/4 answer here is a FAILED check:
// the test exists to catch wrong service paths, authorization problems and
// tunnel outages, so it must never report success for them.
//
// With a registered targetSystem the activation endpoint is probed too and
// the rollup (Ok/Stage/Message) reflects both endpoints; Endpoints carries
// the per-endpoint detail the Target Systems page shows.
async function checkTargetSystemConnection({ destinationName = DEFAULT_DESTINATION, path, targetSystem, req } = {}) {
  const startedAt = Date.now();
  const finish = (partial) => ({
    Ok: false,
    Stage: 'DESTINATION',
    HttpStatus: 0,
    Message: '',
    LatencyMs: Date.now() - startedAt,
    DestinationName: destinationName,
    Path: '',
    ResolvedLocationId: '',
    TestedAt: new Date().toISOString(),
    Endpoints: [],
    ...partial
  });
  const readPath = String(path || `${DEFAULT_S4_SERVICE_ROOT}/UsagePeriods`).trim();

  // Rollup over the endpoint verdicts: usage failure is a SERVICE stage, an
  // activation finding is its own ACTIVATION stage (the usage path is fine,
  // the write unit is missing on DEV or exposed on QA/PROD).
  const rollup = (usage, activate, extra) => {
    const endpoints = activate ? [usage, activate] : [usage];
    if (!usage.Ok) {
      return finish({ ...extra, Stage: 'SERVICE', HttpStatus: usage.HttpStatus, Message: usage.Message, Endpoints: endpoints });
    }
    if (activate && !activate.Ok) {
      return finish({ ...extra, Stage: 'ACTIVATION', HttpStatus: usage.HttpStatus, Message: activate.Message, Endpoints: endpoints });
    }
    return finish({
      ...extra,
      Ok: true,
      Stage: 'OK',
      HttpStatus: usage.HttpStatus,
      Message: activate
        ? `Destination, usage service and activation endpoint verified (${activate.Stage === 'UNPUBLISHED' ? 'write unit unpublished, as required' : 'write unit reachable'}).`
        : 'Destination, service path and authorization verified.',
      Endpoints: endpoints
    });
  };

  if (shouldMockSap()) {
    const usage = {
      Endpoint: ENDPOINT_USAGE, Ok: true, Stage: 'OK', HttpStatus: 200, Path: readPath, Transport: 'odata',
      Message: 'Mock mode: usage service check simulated as successful.'
    };
    const activate = targetSystem ? await probeActivationEndpoint({ targetSystem }) : null;
    return rollup(usage, activate, { Path: readPath });
  }

  let config = {};
  try {
    const resolved = await resolveDestination(destinationName);
    config = resolved.destinationConfiguration || {};
  } catch (error) {
    return finish({ Message: trimConnectionCheckMessage(`Destination could not be resolved: ${error.message}`) });
  }

  // Read-only surface, never persisted (sap-backend.md): shown so admins can
  // see which Cloud Connector location the destination routes through.
  const resolvedLocationId = cloudConnectorLocationId(config);

  // $top=1 with $count proves service path, authorization and data access in
  // one round trip while keeping the payload a single row. ($count alone can
  // succeed on an entity whose row reads fail - see sap-backend.md.)
  const probePath = appendQuery(readPath, { '$top': 1, '$count': 'true' });
  const usage = { Endpoint: ENDPOINT_USAGE, Ok: false, Stage: 'SERVICE', HttpStatus: 0, Path: readPath, Transport: 'odata', Message: '' };
  try {
    // Retrying a dead tunnel only delays the answer the user is waiting on.
    const result = await callS4Destination({ destinationName, path: probePath, req, timeoutMs: PROBE_TIMEOUT_MS, maxAttempts: 1 });
    usage.HttpStatus = Number(result.status) || 0;
    if (result.ok) {
      usage.Ok = true;
      usage.Stage = 'OK';
      usage.HttpStatus = usage.HttpStatus || 200;
      usage.Message = 'Usage service path and authorization verified.';
    } else {
      usage.Message = trimConnectionCheckMessage(safeResponseData(result.data) || `S/4 responded with status ${result.status}.`);
    }
  } catch (error) {
    usage.Message = trimConnectionCheckMessage(error.message);
  }

  // The activation probe needs the environment to judge its result, so it
  // runs only for a registered system (an ad-hoc destination test stays a
  // usage-only check).
  const activate = targetSystem ? await probeActivationEndpoint({ targetSystem: { ...targetSystem, destinationName } }) : null;
  return rollup(usage, activate, { Path: readPath, ResolvedLocationId: resolvedLocationId });
}

// System identity + data-source availability from the add-on's
// ZADO_C_SYSTEM_INFO custom entity (single row), plus the activation
// endpoint verdict so one capability read answers "can this system be
// activated from here" without a separate connection check.
async function getBackendCapabilities({ targetSystem, req }) {
  const ActivationEndpoint = await probeActivationEndpoint({ targetSystem });
  if (shouldMockSap()) {
    return {
      mocked: true,
      SystemId: targetSystem?.systemId || 'MCK',
      Client: targetSystem?.client || '100',
      S4Release: '2023',
      SapUi5Version: '1.120',
      CollectorRunning: true,
      AddOnVersion: '0.1.0-mock',
      ActivationEndpoint
    };
  }

  const result = await callS4Destination({
    destinationName: destinationNameOf(targetSystem),
    path: entityPath(targetSystem, 'SystemInfo'),
    req,
    timeoutMs: 20000
  });
  if (!result.ok) {
    throw Object.assign(
      new Error(`SystemInfo read failed with status ${result.status}: ${safeResponseData(result.data)}`),
      { status: 502 }
    );
  }
  const [row] = unwrapODataPayload(result.data);
  return { ...(row || {}), ActivationEndpoint };
}

// ---------------------------------------------------------------------------
// Paged reads. All ZADO list entities are read with $top/$skip/$count and a
// deterministic tie-broken $orderby, or paging skips rows.
// ---------------------------------------------------------------------------

async function fetchPagedEntity({ targetSystem, entitySet, filter, orderBy, top = 500, skip = 0, req, timeoutMs = 120000 }) {
  const path = appendQuery(entityPath(targetSystem, entitySet), {
    '$filter': filter || undefined,
    '$orderby': orderBy || undefined,
    '$top': top,
    '$skip': skip || undefined,
    '$count': 'true'
  });

  const result = await callS4Destination({
    destinationName: destinationNameOf(targetSystem),
    path,
    req,
    timeoutMs
  });

  if (!result.ok) {
    throw Object.assign(
      new Error(`${entitySet} read failed with status ${result.status}: ${safeResponseData(result.data)}`),
      { status: 502 }
    );
  }

  const rows = unwrapODataPayload(result.data);
  const count = Number(result.data?.['@odata.count']);
  return {
    rows,
    totalCount: Number.isFinite(count) ? count : null,
    hasMore: Number.isFinite(count) ? skip + rows.length < count : rows.length === top
  };
}

// Row mappers: ZADO OData property names -> adops.db columns. The ABAP CDS
// views alias the SWNC fields (ACCOUNT/ENTRY_ID/RESPTI...) into these names;
// keeping the mapping here means an ABAP rename is a one-file fix.

function mapUsagePeriod(row) {
  return {
    PeriodType: row.PeriodType,
    PeriodStart: row.PeriodStart,
    InstanceName: row.InstanceName,
    TaskType: row.TaskType
  };
}

function mapTransactionUsage(row) {
  return {
    TransactionCode: row.TransactionCode ?? row.EntryId,
    TransactionText: row.TransactionText ?? '',
    ProgramName: row.ProgramName ?? '',
    ApplicationComponent: row.ApplicationComponent ?? '',
    PeriodFrom: row.PeriodFrom,
    PeriodTo: row.PeriodTo,
    ExecutionCount: Number(row.ExecutionCount ?? row.StepCount ?? 0),
    DialogStepCount: Number(row.DialogStepCount ?? 0),
    DistinctUserCount: Number(row.DistinctUserCount ?? 0),
    TotalResponseTimeMs: Number(row.TotalResponseTimeMs ?? 0),
    AvgResponseTimeMs: Number(row.AvgResponseTimeMs ?? 0),
    TotalCpuTimeMs: Number(row.TotalCpuTimeMs ?? 0),
    TotalDbTimeMs: Number(row.TotalDbTimeMs ?? 0),
    LastUsedOn: row.LastUsedOn || null
  };
}

function mapUserTransactionUsage(row) {
  return {
    UserKey: row.UserKey ?? row.Account,
    TransactionCode: row.TransactionCode ?? row.EntryId,
    PeriodFrom: row.PeriodFrom,
    PeriodTo: row.PeriodTo,
    ExecutionCount: Number(row.ExecutionCount ?? row.StepCount ?? 0),
    DialogStepCount: Number(row.DialogStepCount ?? 0),
    LastUsedOn: row.LastUsedOn || null
  };
}

async function fetchUsagePeriods({ targetSystem, req }) {
  const { rows } = await fetchPagedEntity({
    targetSystem,
    entitySet: 'UsagePeriods',
    orderBy: 'PeriodStart desc',
    top: 200,
    req,
    timeoutMs: 30000
  });
  return rows.map(mapUsagePeriod);
}

async function fetchTransactionUsagePage({ targetSystem, periodFrom, periodTo, top = 500, skip = 0, req }) {
  const filters = [];
  if (periodFrom) filters.push(`PeriodFrom ge ${periodFrom}`);
  if (periodTo) filters.push(`PeriodTo le ${periodTo}`);
  const page = await fetchPagedEntity({
    targetSystem,
    entitySet: 'TransactionUsage',
    filter: filters.join(' and ') || undefined,
    // Deterministic tiebreaker so paging never skips rows.
    orderBy: 'ExecutionCount desc,TransactionCode asc',
    top,
    skip,
    req
  });
  return { ...page, rows: page.rows.map(mapTransactionUsage) };
}

async function fetchUserTransactionUsagePage({ targetSystem, periodFrom, periodTo, topUsersPerTcode, minExecutions, top = 1000, skip = 0, req }) {
  const filters = [];
  if (periodFrom) filters.push(`PeriodFrom ge ${periodFrom}`);
  if (periodTo) filters.push(`PeriodTo le ${periodTo}`);
  // Volume is bounded at the SOURCE: ZCL_ADO_Q_USER_TX keeps only the top-N
  // users per tcode (default 20) before rows ever leave ABAP. Passing the N
  // over the wire becomes a view parameter in the persisted-snapshot
  // iteration; until then the requested values document intent.
  void topUsersPerTcode;
  void minExecutions;

  const page = await fetchPagedEntity({
    targetSystem,
    entitySet: 'UserTransactionUsage',
    filter: filters.join(' and ') || undefined,
    orderBy: 'TransactionCode asc,UserKey asc',
    top,
    skip,
    req
  });
  return { ...page, rows: page.rows.map(mapUserTransactionUsage) };
}

module.exports = {
  checkTargetSystemConnection,
  activationEndpointVerdict,
  getBackendCapabilities,
  fetchPagedEntity,
  fetchUsagePeriods,
  fetchTransactionUsagePage,
  fetchUserTransactionUsagePage,
  // Exported for contract tests: the mappers ARE the ABAP<->CAP contract.
  mapTransactionUsage,
  mapUserTransactionUsage,
  mapUsagePeriod
};
