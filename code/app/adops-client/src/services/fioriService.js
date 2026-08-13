import axios from 'axios';

// PublicService (/fiori) API layer. Thin: HTTP + OData unwrapping + error
// normalisation only; derivation belongs in features modules, aggregation
// belongs in CAP (architecture.md).
const http = axios.create({ timeout: 120000 });

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

export async function checkConnection(destinationName, path) {
  return postAction('checkTargetSystemConnection', { destinationName, path: path || null });
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

export async function createActivationPlan(waveId, name) {
  const response = await http.post('/fiori/createActivationPlan', { waveId, name: name || null });
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

export const TERMINAL_TASK_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
