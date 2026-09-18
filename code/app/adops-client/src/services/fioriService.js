import axios from 'axios';
import { installCorrelation } from './httpCorrelation.js';

// PublicService (/fiori) API layer. Thin: HTTP + OData unwrapping + error
// normalisation only; derivation belongs in features modules, aggregation
// belongs in CAP (architecture.md).
const http = installCorrelation(axios.create({ timeout: 120000 }));

export function getServiceErrorMessage(error, fallback) {
  const data = error?.response?.data;
  return (
    data?.error?.message ||
    (typeof data === 'string' && data.slice(0, 300)) ||
    error?.message ||
    fallback ||
    'The request failed.'
  );
}

function unwrapOData(data) {
  if (Array.isArray(data?.value)) return data.value;
  return data;
}

async function getEntity(path, params) {
  // Manual serialization: axios' default encodes spaces as '+', which CAP's
  // OData parser rejects inside $orderby/$filter. %20 works everywhere.
  const query = Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key.startsWith('$') ? key : encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const response = await http.get(`/fiori/${path}${query ? `?${query}` : ''}`);
  return unwrapOData(response.data);
}

async function postAction(name, body) {
  const response = await http.post(`/fiori/${name}`, body || {});
  return response.data;
}

async function getFunction(nameWithArgs) {
  const response = await http.get(`/fiori/${nameWithArgs}`);
  return response.data;
}

// --- Target systems ---------------------------------------------------------

export async function listTargetSystems() {
  return getEntity('TargetSystems', { $orderby: 'displayName' });
}

export async function createTargetSystem(system) {
  const response = await http.post('/fiori/TargetSystems', system);
  return response.data;
}

export async function updateTargetSystem(id, patch) {
  const response = await http.patch(`/fiori/TargetSystems(${id})`, patch);
  return response.data;
}

export async function checkConnection(destinationName, path, targetSystemId) {
  return postAction('checkTargetSystemConnection', { destinationName, path: path || null, targetSystemId: targetSystemId || null });
}

// Bounded, server-filtered read of the identified-usage audit trail for the
// Settings page (AuditEvents is read-only on PublicService).
export async function listIdentifiedUsageAuditEvents(top = 20) {
  return getEntity('AuditEvents', {
    $filter: "EventType eq 'IDENTIFIED_USAGE_CHANGED'",
    $orderby: 'Sequence desc',
    $top: top
  });
}

// --- Extractions -------------------------------------------------------------

export async function listExtractionRuns() {
  return getEntity('ExtractionRuns', { $orderby: 'createdAt desc', $top: 50 });
}

export async function runUsageExtraction(request) {
  return postAction('runUsageExtraction', request);
}

export async function importUsageExtract(targetSystemId, payload) {
  const response = await http.post('/fiori/importUsageExtract', { targetSystemId, payload });
  const value = response.data?.value ?? response.data;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export async function getTaskStatus(taskId) {
  return getFunction(`getTaskStatus(taskId=${taskId})`);
}

export async function cancelTask(taskId) {
  return postAction('cancelTask', { taskId });
}

// --- Usage reads --------------------------------------------------------------

export async function queryTransactionUsage(request) {
  return postAction('queryTransactionUsage', request);
}

export async function queryTransactionUsers(extractionRunId, transactionCode) {
  // Server-side filtered read; the run's snapshots scope the rows via the
  // run id on the extraction. Paged and ordered by executions.
  return getEntity('UserTransactionUsage', {
    $filter: `TransactionCode eq '${String(transactionCode).replace(/'/g, "''")}'`,
    $orderby: 'ExecutionCount desc',
    $top: 50,
    $count: true
  });
}

// --- User & Role Landscape (S8 inventory) -----------------------------------
// Bounded, server-filtered, server-sorted pages plus server-side groupby for
// the KPI strip. `filter` is a ready $filter expression scoped to one
// extraction run (features/landscape/landscapeModel). The page never reads
// an inventory table without a run scope.

const INVENTORY_ENTITIES = new Set(['UserInventory', 'RoleInventory', 'RoleUsers', 'RoleTransactions']);

function inventoryEntity(entity) {
  if (!INVENTORY_ENTITIES.has(entity)) throw new Error(`Unknown inventory entity: ${entity}`);
  return entity;
}

export async function queryInventoryPage(entity, { filter, orderby, top = 100, skip = 0, select } = {}) {
  const query = Object.entries({
    $select: select,
    $filter: filter,
    $orderby: orderby,
    $top: String(top),
    $skip: skip ? String(skip) : '',
    $count: 'true'
  })
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  const response = await http.get(`/fiori/${inventoryEntity(entity)}?${query}`);
  const items = unwrapOData(response.data);
  return { items, count: Number(response.data?.['@odata.count'] ?? items.length) };
}

// Counts per distinct value of `field` over the same filter scope as the
// list: [{ <field>: value, count: n }].
export async function queryInventoryGroups(entity, filter, field) {
  const apply = `filter(${filter})/groupby((${field}),aggregate($count as count))`;
  const response = await http.get(`/fiori/${inventoryEntity(entity)}?$apply=${encodeURIComponent(apply)}`);
  return unwrapOData(response.data);
}

// --- Proposals ---------------------------------------------------------------

export async function listAnalysisRuns() {
  return getEntity('AnalysisRuns', { $orderby: 'createdAt desc', $top: 50 });
}

export async function generateProposals(request) {
  return postAction('generateProposals', request);
}

function parseJsonActionResult(data) {
  const value = data?.value ?? data;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export async function queryProposals(request) {
  const response = await http.post('/fiori/queryProposals', request);
  return parseJsonActionResult(response.data);
}

export async function readProposal(proposalId) {
  const response = await http.get(`/fiori/readProposal(proposalId=${proposalId})`);
  return parseJsonActionResult(response.data);
}

// kind: approveProposal | rejectProposal | deferProposal
export async function decideProposal(kind, proposalId, notes, targetWave) {
  return postAction(kind, { proposalId, notes: notes || null, targetWave: targetWave || null });
}

// --- Adoption waves -----------------------------------------------------------

export async function queryAdoptionWaves(targetSystemId) {
  const path = targetSystemId ? `queryAdoptionWaves(targetSystemId=${targetSystemId})` : 'queryAdoptionWaves()';
  const response = await http.get(`/fiori/${path}`);
  return parseJsonActionResult(response.data);
}

export async function readAdoptionWave(waveId) {
  const response = await http.get(`/fiori/readAdoptionWave(waveId=${waveId})`);
  return parseJsonActionResult(response.data);
}

export async function createAdoptionWave(request) {
  return postAction('createAdoptionWave', request);
}

export async function deleteAdoptionWave(waveId) {
  await http.delete(`/fiori/AdoptionWaves(${waveId})`);
}

export async function assignProposalsToWave(waveId, proposalIds) {
  const response = await http.post('/fiori/assignProposalsToWave', { waveId, proposalIds });
  return parseJsonActionResult(response.data);
}

export async function removeProposalsFromWave(waveId, proposalIds) {
  const response = await http.post('/fiori/removeProposalsFromWave', { waveId, proposalIds });
  return parseJsonActionResult(response.data);
}

// --- Activation planning ------------------------------------------------------

export async function createActivationPlan(waveId, name, targetSystemId) {
  const response = await http.post('/fiori/createActivationPlan', {
    waveId,
    name: name || null,
    targetSystemId: targetSystemId || null
  });
  return parseJsonActionResult(response.data);
}

export async function simulateActivationPlan(planId) {
  const response = await http.post('/fiori/simulateActivationPlan', { planId });
  return parseJsonActionResult(response.data);
}

export async function readActivationPlan(planId) {
  const response = await http.get(`/fiori/readActivationPlan(planId=${planId})`);
  return parseJsonActionResult(response.data);
}

export async function executeActivationPlan(planId) {
  return postAction('executeActivationPlan', { planId });
}

// Cross-wave plan list: labels, latest run and a status summary over the
// full filter scope in one response.
export async function queryActivationPlans(targetSystemId) {
  const path = targetSystemId
    ? `queryActivationPlans(targetSystemId=${targetSystemId})`
    : 'queryActivationPlans()';
  const response = await http.get(`/fiori/${path}`);
  return parseJsonActionResult(response.data);
}

export async function readActivationStepMessages(stepId) {
  const response = await http.get(`/fiori/readActivationStepMessages(stepId=${stepId})`);
  return parseJsonActionResult(response.data);
}

// Operator decisions on a single step; both answer { StepStatus,
// OperatorAction, PlanStatus, Result } for the notice, the page re-reads.
export async function skipActivationStep(stepId, reason) {
  const response = await http.post('/fiori/skipActivationStep', { stepId, reason: reason || null });
  return parseJsonActionResult(response.data);
}

export async function rollbackActivationStep(stepId, reason) {
  const response = await http.post('/fiori/rollbackActivationStep', { stepId, reason: reason || null });
  return parseJsonActionResult(response.data);
}

// --- Activation runs (monitor) ------------------------------------------------

export async function queryActivationRuns(targetSystemId) {
  const path = targetSystemId
    ? `queryActivationRuns(targetSystemId=${targetSystemId})`
    : 'queryActivationRuns()';
  const response = await http.get(`/fiori/${path}`);
  return parseJsonActionResult(response.data);
}

// The single poll target while a run is active: task status + plan + steps +
// task logs in one response.
export async function readActivationRun(runId) {
  const response = await http.get(`/fiori/readActivationRun(runId=${runId})`);
  return parseJsonActionResult(response.data);
}

// --- Transports ---------------------------------------------------------------

export async function queryTransportRequests(targetSystemId) {
  const path = targetSystemId
    ? `queryTransportRequests(targetSystemId=${targetSystemId})`
    : 'queryTransportRequests()';
  const response = await http.get(`/fiori/${path}`);
  return parseJsonActionResult(response.data);
}

export async function releaseTransport(transportId, simulate) {
  const response = await http.post('/fiori/releaseTransport', { transportId, simulate: Boolean(simulate) });
  return parseJsonActionResult(response.data);
}

export async function readActivationManifest(planId) {
  const response = await http.get(`/fiori/readActivationManifest(planId=${planId})`);
  return parseJsonActionResult(response.data);
}

export const TERMINAL_TASK_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
