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

// S6's 404 fallback and A9's metadata read log through it; A6 had removed
// an unused logger from this file, so main referenced LOG without defining it.
const LOG = require('@sap/cds').log('s4-fiori-adapter');


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
      { status: 502, remoteStatus: Number(result.status) || 0 }
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

// --- Inventory readers (S8): USR02 and AGR_* through the ZADO read unit ------

// USR02-UFLAG -> the two-letter lock status the landscape shows.
function lockStatusOf(flag) {
  const value = Number(flag) || 0;
  if (value === 0) return '';
  if (value === 128) return 'PW';                 // too many failed logons
  if (value === 32 || value === 64) return 'AD';  // locked by administrator
  return 'LK';
}

function mapUserInventory(row) {
  return {
    UserKey: row.UserKey ?? row.Bname,
    UserType: String(row.UserType ?? row.Ustyp ?? '').slice(0, 1),
    UserGroup: row.UserGroup ?? row.Class ?? '',
    ValidFrom: row.ValidFrom || null,
    ValidTo: row.ValidTo || null,
    LockStatus: row.LockStatus ?? lockStatusOf(row.LockFlag ?? row.Uflag),
    LastLogonOn: row.LastLogonOn || row.Trdat || null,
    RoleCount: Number(row.RoleCount ?? 0)
  };
}

function mapRoleInventory(row) {
  return {
    RoleName: row.RoleName ?? row.AgrName,
    RoleText: row.RoleText ?? '',
    RoleType: row.RoleType || 'SINGLE',
    ParentRole: row.ParentRole ?? row.ParentAgr ?? '',
    IsSapDelivered: row.IsSapDelivered === true || row.IsSapDelivered === 'X' || /^SAP_/.test(String(row.RoleName ?? row.AgrName ?? '')),
    MenuTcodeCount: Number(row.MenuTcodeCount ?? 0),
    AuthTcodeCount: Number(row.AuthTcodeCount ?? 0),
    UserCount: Number(row.UserCount ?? 0),
    ChangedOn: row.ChangedOn || row.ChangeDat || null
  };
}

// S10: ZADO_C_TRANSPORT_STATUS (E070 as seen by the answering system).
function mapTransportStatus(row) {
  return {
    Trkorr: row.Trkorr ?? row.trkorr,
    RequestType: row.RequestType ?? row.Trfunction ?? '',
    RequestStatus: row.RequestStatus ?? row.Trstatus ?? '',
    Owner: row.Owner ?? row.As4user ?? '',
    TargetSystem: row.TargetSystem ?? row.Tarsystem ?? '',
    ParentRequest: row.ParentRequest ?? row.Strkorr ?? '',
    ChangedOn: row.ChangedOn || row.As4date || null,
    ChangedAt: row.ChangedAt || row.As4time || null,
    Description: row.Description ?? row.As4text ?? '',
    ObjectCount: Number(row.ObjectCount ?? 0),
    SystemId: row.SystemId ?? '',
    Client: row.Client ?? ''
  };
}

function mapRoleUser(row) {
  return {
    RoleName: row.RoleName ?? row.AgrName,
    UserKey: row.UserKey ?? row.Uname,
    ValidFrom: row.ValidFrom || row.FromDat || null,
    ValidTo: row.ValidTo || row.ToDat || null
  };
}

function mapRoleTransaction(row) {
  return {
    RoleName: row.RoleName ?? row.AgrName,
    TransactionCode: row.TransactionCode ?? row.Tcode ?? row.Low,
    Source: row.Source || 'MENU'
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

// Extraction parameters travel as CDS entity parameters of
// ZADO_C_USER_TX_USAGE (S6): the reader keeps only the top-N users per
// transaction above the execution threshold BEFORE rows leave ABAP. OData V4
// addresses a parameterized entity as <set>(P_...=...)/Set.
const DEFAULT_TOP_USERS_PER_TCODE = 20;
const DEFAULT_MIN_EXECUTIONS = 1;

function extractionParameters({ topUsersPerTcode, minExecutions } = {}) {
  const top = Number.isFinite(Number(topUsersPerTcode)) ? Math.max(0, Math.trunc(Number(topUsersPerTcode))) : DEFAULT_TOP_USERS_PER_TCODE;
  const min = Number.isFinite(Number(minExecutions)) ? Math.max(1, Math.trunc(Number(minExecutions))) : DEFAULT_MIN_EXECUTIONS;
  return { topUsersPerTcode: top, minExecutions: min };
}

// A9: the tenant travels as a third parameter, P_TenantId, when the add-on
// declares it. Its presence is read from $metadata (parseEntityParameterNames)
// because a parameterized entity must be addressed with exactly the
// parameters it declares: a two-parameter path 404s on a three-parameter
// entity and vice versa.
function formatParameterValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function buildParameterisedEntityPath(basePath, parameters) {
  const entries = Object.entries(parameters || {}).filter(([, value]) => value !== undefined);
  if (!entries.length) return basePath;
  return `${basePath}(${entries.map(([name, value]) => `${name}=${formatParameterValue(value)}`).join(',')})/Set`;
}

function userTransactionUsageEntity(params, { tenantId } = {}) {
  const { topUsersPerTcode, minExecutions } = extractionParameters(params);
  return buildParameterisedEntityPath('UserTransactionUsage', {
    P_TopUsers: topUsersPerTcode,
    P_MinExecutions: minExecutions,
    ...(tenantId !== undefined ? { P_TenantId: String(tenantId || 'GLOBAL') } : {})
  });
}

// Parameter names of a parameterized entity from the service $metadata: the
// "<EntitySet>Parameters" entity type lists them. Read once per destination
// and service root; never in mock mode; empty when unreadable, in which case
// the S6 two-parameter path and its 404 fallback decide.
const USAGE_PARAMETER_TTL_MS = 10 * 60 * 1000;
const usageParameterCache = new Map();

function parseEntityParameterNames(metadataText, entitySet) {
  const text = typeof metadataText === 'string' ? metadataText : '';
  const block = text.match(new RegExp(`<EntityType\\b[^>]*\\bName="${entitySet}Parameters"[^>]*>([\\s\\S]*?)</EntityType>`, 'i'));
  const names = new Set();
  if (!block) return names;
  for (const match of block[1].matchAll(/<Property\b[^>]*\bName="([^"]+)"/gi)) names.add(match[1]);
  return names;
}

async function usageEntityParameters({ targetSystem, entitySet, req }) {
  if (shouldMockSap()) return new Set();
  const cacheKey = `${destinationNameOf(targetSystem)}::${serviceRoot(targetSystem)}::${entitySet}`;
  const hit = usageParameterCache.get(cacheKey);
  if (hit && Date.now() - hit.at < USAGE_PARAMETER_TTL_MS) return hit.names;

  let names = new Set();
  try {
    const metadata = await callS4Destination({
      destinationName: destinationNameOf(targetSystem),
      path: `${serviceRoot(targetSystem)}/$metadata`,
      headers: { Accept: 'application/xml, text/xml' },
      req,
      timeoutMs: 30000
    });
    if (metadata.ok) names = parseEntityParameterNames(metadata.data, entitySet);
  } catch (error) {
    LOG.warn(`Could not read $metadata for ${entitySet}; assuming the S6 parameter set. ${error.message}`);
    return names;
  }
  usageParameterCache.set(cacheKey, { at: Date.now(), names });
  return names;
}

async function fetchUserTransactionUsagePage({ targetSystem, periodFrom, periodTo, topUsersPerTcode, minExecutions, tenantId, top = 1000, skip = 0, req }) {
  const filters = [];
  if (periodFrom) filters.push(`PeriodFrom ge ${periodFrom}`);
  if (periodTo) filters.push(`PeriodTo le ${periodTo}`);
  const page = {
    filter: filters.join(' and ') || undefined,
    orderBy: 'TransactionCode asc,UserKey asc',
    top,
    skip,
    req
  };

  // A9: pass the tenant only to an add-on whose metadata declares P_TenantId.
  const supported = await usageEntityParameters({ targetSystem, entitySet: 'UserTransactionUsage', req });
  const tenantScope = supported.has('P_TenantId') ? { tenantId } : {};

  let result;
  let parametersApplied = true;
  try {
    result = await fetchPagedEntity({ targetSystem, entitySet: userTransactionUsageEntity({ topUsersPerTcode, minExecutions }, tenantScope), ...page });
  } catch (error) {
    // An add-on without the parameterized entity (older than S6) answers
    // 404 on the parameter path: fall back to the plain set, where the
    // reader defaults apply, and tell the caller so the run log says so.
    if (error?.remoteStatus !== 404) throw error;
    LOG.warn(`UserTransactionUsage parameters not supported by ${targetSystem?.displayName || targetSystem?.destinationName || 'target'} (404 on the parameterized entity) - reader defaults apply.`);
    parametersApplied = false;
    result = await fetchPagedEntity({ targetSystem, entitySet: 'UserTransactionUsage', ...page });
  }
  return { ...result, parametersApplied, rows: result.rows.map(mapUserTransactionUsage) };
}

// Inventory pages: the ZADO providers page at the database in their own
// deterministic order (real user id / role name), so no $orderby travels -
// the exposed UserKey is a hash and sorting by it would not match the
// provider's window order.
const INVENTORY_PAGE_SIZE = 2000;

async function fetchInventoryPage({ targetSystem, entitySet, filter, mapRow, top = INVENTORY_PAGE_SIZE, skip = 0, req }) {
  const page = await fetchPagedEntity({ targetSystem, entitySet, filter, top, skip, req });
  return { ...page, rows: page.rows.map(mapRow) };
}

async function fetchUserInventoryPage({ targetSystem, top, skip, req }) {
  return fetchInventoryPage({ targetSystem, entitySet: 'UserInventory', mapRow: mapUserInventory, top, skip, req });
}

async function fetchRoleInventoryPage({ targetSystem, top, skip, req }) {
  return fetchInventoryPage({ targetSystem, entitySet: 'RoleInventory', mapRow: mapRoleInventory, top, skip, req });
}

async function fetchRoleUsersPage({ targetSystem, top, skip, req }) {
  return fetchInventoryPage({ targetSystem, entitySet: 'RoleUsers', mapRow: mapRoleUser, top, skip, req });
}

// One source per read (MENU = AGR_TCODES, AUTH = AGR_1251 S_TCODE): the
// provider pages one table per request.
async function fetchRoleTransactionsPage({ targetSystem, source = 'MENU', top, skip, req }) {
  return fetchInventoryPage({
    targetSystem, entitySet: 'RoleTransactions', filter: `Source eq '${source}'`, mapRow: mapRoleTransaction, top, skip, req
  });
}

// S10: the request as the follow-on system sees it. An add-on older than
// S10 has no TransportStatus entity and answers 404: reported as
// { supported: false } so the caller records UNKNOWN instead of failing.
function odataLiteral(value) {
  return String(value ?? '').replace(/'/g, "''");
}

async function fetchTransportStatus({ targetSystem, trkorr, req }) {
  const key = String(trkorr || '').trim().toUpperCase();
  if (!key) return { supported: true, row: null };
  try {
    const page = await fetchPagedEntity({
      targetSystem, entitySet: 'TransportStatus', filter: `Trkorr eq '${odataLiteral(key)}'`, top: 1, req, timeoutMs: 30000
    });
    const row = page.rows.length ? mapTransportStatus(page.rows[0]) : null;
    return { supported: true, row };
  } catch (error) {
    if (error?.remoteStatus !== 404) throw error;
    LOG.warn(`TransportStatus not exposed by ${targetSystem?.displayName || targetSystem?.destinationName || 'target'} (404) - add-on older than S10.`);
    return { supported: false, row: null };
  }
}

// S10: RoleInventory rows for a set of role names (one OR-filter per
// chunk, so a wave with many roles stays a handful of reads).
const ROLE_NAME_CHUNK = 40;

async function fetchRolesByName({ targetSystem, roleNames, req }) {
  const names = [...new Set((roleNames || []).map((n) => String(n || '').trim().toUpperCase()).filter(Boolean))];
  const rows = [];
  for (let i = 0; i < names.length; i += ROLE_NAME_CHUNK) {
    const chunk = names.slice(i, i + ROLE_NAME_CHUNK);
    const filter = chunk.map((n) => `RoleName eq '${odataLiteral(n)}'`).join(' or ');
    const page = await fetchInventoryPage({ targetSystem, entitySet: 'RoleInventory', filter, mapRow: mapRoleInventory, top: chunk.length, req });
    rows.push(...page.rows);
  }
  return rows;
}

module.exports = {
  checkTargetSystemConnection,
  activationEndpointVerdict,
  getBackendCapabilities,
  fetchPagedEntity,
  extractionParameters,
  userTransactionUsageEntity,
  usageEntityParameters,
  parseEntityParameterNames,
  buildParameterisedEntityPath,
  fetchUsagePeriods,
  fetchTransactionUsagePage,
  fetchUserTransactionUsagePage,
  INVENTORY_PAGE_SIZE,
  fetchUserInventoryPage,
  fetchRoleInventoryPage,
  fetchRoleUsersPage,
  fetchRoleTransactionsPage,
  fetchTransportStatus,
  fetchRolesByName,
  // Exported for contract tests: the mappers ARE the ABAP<->CAP contract.
  mapTransactionUsage,
  mapUserTransactionUsage,
  mapUsagePeriod,
  mapUserInventory,
  mapRoleInventory,
  mapRoleUser,
  mapRoleTransaction,
  mapTransportStatus,
  lockStatusOf
};
