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

// Structured connectivity verdict for the Target Systems "Test Connection"
// action. Unlike the generic testS4Destination proxy (whose consumers parse
// whatever payload comes back), a non-2xx S/4 answer here is a FAILED check:
// the test exists to catch wrong service paths, authorization problems and
// tunnel outages, so it must never report success for them.
async function checkTargetSystemConnection({ destinationName = DEFAULT_DESTINATION, path, req } = {}) {
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
    ...partial
  });

  if (shouldMockSap()) {
    return finish({
      Ok: true,
      Stage: 'OK',
      HttpStatus: 200,
      Path: path || `${DEFAULT_S4_SERVICE_ROOT}/UsagePeriods`,
      Message: 'Mock mode: connection check simulated as successful.'
    });
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

  const readPath = String(path || `${DEFAULT_S4_SERVICE_ROOT}/UsagePeriods`).trim();
  // $top=1 with $count proves service path, authorization and data access in
  // one round trip while keeping the payload a single row. ($count alone can
  // succeed on an entity whose row reads fail - see sap-backend.md.)
  const probePath = appendQuery(readPath, { '$top': 1, '$count': 'true' });

  let result;
  try {
    result = await callS4Destination({
      destinationName,
      path: probePath,
      req,
      // The user is waiting on this verdict; retrying a dead tunnel only
      // delays the answer.
      timeoutMs: 15000,
      maxAttempts: 1
    });
  } catch (error) {
    return finish({
      Stage: 'SERVICE',
      Path: readPath,
      ResolvedLocationId: resolvedLocationId,
      Message: trimConnectionCheckMessage(error.message)
    });
  }

  if (!result.ok) {
    return finish({
      Stage: 'SERVICE',
      Path: readPath,
      ResolvedLocationId: resolvedLocationId,
      HttpStatus: Number(result.status) || 0,
      Message: trimConnectionCheckMessage(safeResponseData(result.data) || `S/4 responded with status ${result.status}.`)
    });
  }

  return finish({
    Ok: true,
    Stage: 'OK',
    Path: readPath,
    ResolvedLocationId: resolvedLocationId,
    HttpStatus: Number(result.status) || 200,
    Message: 'Destination, service path and authorization verified.'
  });
}

// System identity + data-source availability from the add-on's
// ZADO_C_SYSTEM_INFO custom entity (single row).
async function getBackendCapabilities({ targetSystem, req }) {
  if (shouldMockSap()) {
    return {
      mocked: true,
      SystemId: targetSystem?.systemId || 'MCK',
      Client: targetSystem?.client || '100',
      S4Release: '2023',
      SapUi5Version: '1.120',
      CollectorRunning: true,
      AddOnVersion: '0.1.0-mock'
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
  return row || {};
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
  // Volume is bounded at the SOURCE: the add-on's parameterized view applies
  // top-N users per tcode above a threshold before rows ever leave ABAP.
  const params = {};
  if (topUsersPerTcode) params.p_top_users = topUsersPerTcode;
  if (minExecutions) params.p_min_executions = minExecutions;

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
