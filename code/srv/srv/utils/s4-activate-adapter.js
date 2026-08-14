const cds = require('@sap/cds');
const { callS4Destination, safeResponseData } = require('./s4-http-client.js');

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

function activateRootFor(targetSystem) {
  const override = String(targetSystem?.activationRootPath || '').trim();
  return override || DEFAULT_ACTIVATE_ROOT;
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

async function executeStepRemote({ targetSystem, step }) {
  const path = activateRootFor(targetSystem);
  const response = await callS4Destination({
    destinationName: targetSystem.destinationName,
    path,
    method: 'POST',
    body: {
      stepType: step.StepType,
      objectKeyJson: step.ObjectKeyJson || '{}'
    },
    timeoutMs: STEP_TIMEOUT_MS,
    maxAttempts: 1
  });

  if (!response.ok) {
    // Non-2xx is a transport/service failure, not a step verdict: surface it
    // as FAILED with the diagnostic body so the run monitor shows the cause.
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
  return mapRemoteStepResult(response.data);
}

// Existence/identity probe for connection checks (never writes).
async function probeActivateService({ targetSystem }) {
  const path = activateRootFor(targetSystem);
  const response = await callS4Destination({
    destinationName: targetSystem.destinationName,
    path,
    method: 'GET',
    timeoutMs: 15000
  });
  const info = response.ok && response.data && typeof response.data === 'object' ? response.data : {};
  return {
    ok: Boolean(response.ok && info.service === 'adoptops-activate'),
    status: response.status,
    path,
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
  mapRemoteStepResult,
  executeStepRemote,
  probeActivateService,
  liveStepExecutorFor
};
