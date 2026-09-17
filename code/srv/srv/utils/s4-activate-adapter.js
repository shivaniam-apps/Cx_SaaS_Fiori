const cds = require('@sap/cds');
const { callS4Destination, safeResponseData, boundActionNameCandidates, serviceRootFromPath } = require('./s4-http-client.js');

const LOG = cds.log('s4-activate-adapter');

// ---------------------------------------------------------------------------
// Live step executor: the CAP side of the ZIF_ADO_ACT_STEP contract, talking
// to the DEV-only ICF node served by ZCL_ADO_ACT_HTTP.
//
//   GET  <root>  -> identity probe { service, version, system, client }
//   POST <root>  -> { stepType, objectKeyJson } -> step result (camelCase)
//
// The service root comes from TargetSystems.activationRootPath (the persisted
// override) with the shipped default below. Transport-level retries are OFF
// (maxAttempts 1): a write must never be replayed by the HTTP layer - step
// re-attempts belong to the engine's resume flow, where verify-first turns a
// replay into SKIPPED.
// ---------------------------------------------------------------------------

const DEFAULT_ACTIVATE_ROOT = '/sap/bc/zado_act';
const STEP_TIMEOUT_MS = 180000; // task lists and profile generation are slow
const CONTRACT_STATES = ['SUCCESS', 'WARNING', 'FAILED', 'SKIPPED'];

// The RAP OData V4 write service (ZADO_ACTIVATE_O4): its root path lives
// under /sap/opu/odata4/, the write happens through a bound static action on
// the Activate entity set. A /sap/bc/... root means the classic ICF handler
// (ZCL_ADO_ACT_HTTP). One adapter, two transports, chosen by the root shape.
const ODATA_ROOT_MARKER = '/sap/opu/odata4/';
const ODATA_ACTION_NAME = 'executeStep';
const ODATA_ENTITY_SET = 'Activate';

function activateRootFor(targetSystem) {
  const override = String(targetSystem?.activationRootPath || '').trim();
  return override || DEFAULT_ACTIVATE_ROOT;
}

function isODataRoot(path) {
  return String(path || '').toLowerCase().includes(ODATA_ROOT_MARKER);
}

// Defensive mapping of the remote payload onto the executor contract. An
// unexpected shape becomes a FAILED result (never an exception): the engine
// then records it on the step and stops per StopOnError.
function mapRemoteStepResult(data) {
  const status = String(data?.status || '').toUpperCase();
  if (!CONTRACT_STATES.includes(status)) {
    return {
      status: 'FAILED',
      existsAlready: false,
      trkorr: '',
      messages: [{
        type: 'E',
        message: `Activation service returned an invalid step result: ${safeResponseData(data) || '(empty)'}`
      }]
    };
  }
  return {
    status,
    existsAlready: Boolean(data.existsAlready),
    trkorr: String(data.trkorr || '').trim(),
    messages: Array.isArray(data.messages)
      ? data.messages.map((m) => ({
          type: String(m.type || 'I').slice(0, 1).toUpperCase(),
          message: String(m.message || '')
        }))
      : []
  };
}

function transportFailure(path, response) {
  // Non-2xx is a transport/service failure, not a step verdict: surface it as
  // FAILED with the diagnostic body so the run monitor shows the cause.
  return {
    status: 'FAILED',
    existsAlready: false,
    trkorr: '',
    messages: [{
      type: 'E',
      message: `Activation service ${path} answered ${response.status}: ${safeResponseData(response.data) || '(no body)'}`
    }]
  };
}

// ---------------------------------------------------------------------------
// Read-side state probe (simulateActivationPlan): same transport and key as
// a step execution, with probe=true; ZCL_ADO_ACT_PROBE answers
// { verdict, existsAlready, message } without a LUW. Verdicts are the
// simulation statuses of ActivationSteps; anything else (transport failure,
// foreign payload) becomes SIMULATED_BLOCKED so a plan never claims a state
// it could not read.
// ---------------------------------------------------------------------------

const PROBE_VERDICTS = ['SIMULATED_OK', 'SIMULATED_WARN', 'SIMULATED_BLOCKED'];

function mapRemoteProbeResult(data) {
  let verdict = String(data?.verdict || '').toUpperCase();
  if (verdict && !verdict.startsWith('SIMULATED_')) verdict = `SIMULATED_${verdict}`;
  if (verdict === 'SIMULATED_WARNING') verdict = 'SIMULATED_WARN';
  if (!PROBE_VERDICTS.includes(verdict)) {
    return {
      verdict: 'SIMULATED_BLOCKED',
      existsAlready: false,
      message: `Activation service returned an invalid probe result: ${safeResponseData(data) || '(empty)'}`
    };
  }
  return {
    verdict,
    existsAlready: data.existsAlready === true || data.existsAlready === 'X' || data.existsAlready === 'true',
    message: String(data.message || '')
  };
}

function probeFailure(path, response) {
  return {
    verdict: 'SIMULATED_BLOCKED',
    existsAlready: false,
    message: `State probe via ${path} answered ${response.status}: ${safeResponseData(response.data) || '(no body)'}`
  };
}

// One failure/result mapping per mode so both transports share it.
const failureFor = (probe, path, response) => (probe ? probeFailure(path, response) : transportFailure(path, response));
const resultFor = (probe, data) => (probe ? mapRemoteProbeResult(data) : mapRemoteStepResult(data));
const invalidPayload = (probe, message) => (probe
  ? { verdict: 'SIMULATED_BLOCKED', existsAlready: false, message }
  : { status: 'FAILED', existsAlready: false, trkorr: '', messages: [{ type: 'E', message }] });

// ICF handler transport: POST { stepType, objectKeyJson, probe } -> result.
async function executeStepViaIcf({ targetSystem, step, path, probe = false }) {
  const response = await callS4Destination({
    destinationName: targetSystem.destinationName,
    path,
    method: 'POST',
    body: { stepType: step.StepType, objectKeyJson: step.ObjectKeyJson || '{}', probe: Boolean(probe) },
    timeoutMs: STEP_TIMEOUT_MS,
    maxAttempts: 1
  });
  if (!response.ok) return failureFor(probe, path, response);
  return resultFor(probe, response.data);
}

// A RAP static action with result [1] <abstract entity> can serialize over
// OData V4 as the bare structure, a { value: {...} } wrapper, a
// { value: [ {...} ] } collection, or the V2-style { d: ... } - and the
// ResultJson field casing can vary. Find the string wherever it sits.
function extractResultJson(body) {
  const candidates = [
    body,
    body?.value,
    Array.isArray(body?.value) ? body.value[0] : undefined,
    body?.d,
    Array.isArray(body?.d?.results) ? body.d.results[0] : body?.d?.results
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const key = Object.keys(candidate).find((k) => k.toLowerCase() === 'resultjson');
    if (key && typeof candidate[key] === 'string') return candidate[key];
  }
  return undefined;
}

// RAP OData V4 transport: POST the bound static action; the FQN is resolved
// from $metadata (like the read services' bound actions). The action returns
// the single result entity, whose ResultJson field carries the step-result
// JSON - same contract the ICF handler serializes.
async function executeStepViaOData({ targetSystem, step, path, probe = false }) {
  const serviceRoot = serviceRootFromPath(`${path.replace(/\/?$/, '/')}${ODATA_ENTITY_SET}`);
  const candidates = await boundActionNameCandidates({
    destinationName: targetSystem.destinationName,
    servicePath: serviceRoot,
    actionName: ODATA_ACTION_NAME
  });

  let lastResponse;
  for (const actionName of candidates) {
    const actionPath = `${serviceRoot}${ODATA_ENTITY_SET}/${actionName}`;
    const response = await callS4Destination({
      destinationName: targetSystem.destinationName,
      path: actionPath,
      method: 'POST',
      body: { StepType: step.StepType, ObjectKeyJson: step.ObjectKeyJson || '{}', Probe: Boolean(probe) },
      timeoutMs: STEP_TIMEOUT_MS,
      maxAttempts: 1
    });
    lastResponse = response;
    if (response.status === 404) continue; // wrong action FQN candidate - try next
    if (!response.ok) return failureFor(probe, actionPath, response);

    // Unwrap ResultJson across the shapes a RAP static action can return over
    // OData V4 (single object, value-wrapped, or value-array), then parse it
    // into the step-result (or probe) contract.
    const resultJson = extractResultJson(response.data);
    if (typeof resultJson !== 'string') {
      return invalidPayload(probe, `Activation action returned no ResultJson: ${safeResponseData(response.data) || '(empty)'}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(resultJson);
    } catch {
      return invalidPayload(probe, `Activation action ResultJson was not valid JSON: ${resultJson.slice(0, 200)}`);
    }
    return resultFor(probe, parsed);
  }
  return failureFor(probe, serviceRoot, lastResponse || { status: 0, data: 'no response' });
}

async function executeStepRemote({ targetSystem, step, probe = false }) {
  const path = activateRootFor(targetSystem);
  return isODataRoot(path)
    ? executeStepViaOData({ targetSystem, step, path, probe })
    : executeStepViaIcf({ targetSystem, step, path, probe });
}

// Read-only: the plan's steps are probed one by one against the DEV
// system's real state; nothing is written.
async function probeStepRemote({ targetSystem, step }) {
  return executeStepRemote({ targetSystem, step, probe: true });
}

// Probe with the signature simulateSteps expects (mirrors
// mockSimulationProbe); the caller awaits each verdict.
function liveSimulationProbeFor(targetSystem) {
  if (!targetSystem?.destinationName) {
    throw new Error('Live simulation needs a target system with a configured BTP destination.');
  }
  LOG.info(`Live simulation probe for ${targetSystem.displayName || targetSystem.ID} via ${activateRootFor(targetSystem)}`);
  return (step) => probeStepRemote({ targetSystem, step });
}

// Existence/identity probe for connection checks (never writes). ICF returns
// the identity JSON; OData V4 reachability is a 200 on $metadata.
async function probeActivateService({ targetSystem }) {
  const path = activateRootFor(targetSystem);
  if (isODataRoot(path)) {
    const metadataPath = `${serviceRootFromPath(`${path.replace(/\/?$/, '/')}x`)}$metadata`;
    const response = await callS4Destination({
      destinationName: targetSystem.destinationName, path: metadataPath, method: 'GET', timeoutMs: 15000
    });
    const hasAction = typeof response.data === 'string' && /Name="executeStep"/i.test(response.data);
    return { ok: Boolean(response.ok && hasAction), status: response.status, path: metadataPath, transport: 'odata' };
  }
  const response = await callS4Destination({
    destinationName: targetSystem.destinationName, path, method: 'GET', timeoutMs: 15000
  });
  const info = response.ok && response.data && typeof response.data === 'object' ? response.data : {};
  return {
    ok: Boolean(response.ok && info.service === 'adoptops-activate'),
    status: response.status,
    path,
    transport: 'icf',
    system: String(info.system || ''),
    client: String(info.client || ''),
    version: Number(info.version || 0)
  };
}

// Executor factory with the ZIF_ADO_ACT_STEP-shaped signature the engine
// expects; mirrors mockStepExecutor.
function liveStepExecutorFor(targetSystem) {
  if (!targetSystem?.destinationName) {
    throw new Error('Live execution needs a target system with a configured BTP destination.');
  }
  LOG.info(`Live activation executor for ${targetSystem.displayName || targetSystem.ID} via ${activateRootFor(targetSystem)}`);
  return ({ step }) => executeStepRemote({ targetSystem, step });
}

module.exports = {
  DEFAULT_ACTIVATE_ROOT,
  activateRootFor,
  isODataRoot,
  extractResultJson,
  mapRemoteStepResult,
  mapRemoteProbeResult,
  executeStepRemote,
  probeStepRemote,
  liveSimulationProbeFor,
  probeActivateService,
  liveStepExecutorFor
};
