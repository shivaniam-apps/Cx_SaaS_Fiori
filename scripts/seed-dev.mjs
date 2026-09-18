#!/usr/bin/env node
// Seed a fresh (mock-mode) worktree database with the whole Activate journey
// through the PUBLIC actions, exactly as the UI would: target system ->
// usage extraction -> proposals -> wave -> approvals -> activation plan ->
// simulate -> execute. Nothing is written to the database directly, so the
// seed exercises the same validations, audit rows and task runner as a user.
//
//   node scripts/seed-dev.mjs --port 4114            # this worktree's CAP port
//   node scripts/seed-dev.mjs --port 4114 --approve 8 --no-activate
//
// Refuses to run against a server that is not in mock mode
// (ADOPTOPS_MOCK_S4=true): the journey ends in an activation EXECUTE, which
// must never hit a real S/4HANA system from a seed script.
//
// Options
//   --port <n>          CAP port (default: env PORT or 4104)
//   --user <id>         mocked user (default alice = all roles)
//   --destination <d>   destination name of the seeded system (default MOCK_RD1_DEV);
//                       an existing system on that destination is reused
//   --approve <n>       how many top-ranked proposals to approve (default 5)
//   --no-activate       stop after the approvals (no plan / simulate / execute)
//   --months <n>        extraction window length in months (default 3)

import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.PORT || 4104);
const BASE = `http://localhost:${PORT}`;
const USER = args.user || 'alice';
const DESTINATION = args.destination || 'MOCK_RD1_DEV';
const APPROVE = Math.max(1, Number(args.approve || 5));
const ACTIVATE = !args['no-activate'];
const MONTHS = Math.max(1, Number(args.months || 3));
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

const auth = `Basic ${Buffer.from(`${USER}:`).toString('base64')}`;

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = data?.error?.message || (typeof data === 'string' ? data.slice(0, 300) : response.statusText);
    throw new Error(`${method} ${path} -> ${response.status}: ${message}`);
  }
  return data;
}

// Functions returning LargeString answer { value: "<json>" }.
const unwrap = (data) => (typeof data?.value === 'string' ? JSON.parse(data.value) : data?.value ?? data);

const log = (msg) => process.stdout.write(`[seed-dev] ${msg}\n`);
const isoDate = (d) => d.toISOString().slice(0, 10);

async function waitForTask(handle, label) {
  let status = null;
  for (let i = 0; i < 300; i += 1) {
    status = await call('GET', `/fiori/getTaskStatus(taskId=${handle.taskId})`);
    if (TERMINAL.has(String(status.status).toUpperCase())) break;
    await new Promise((r) => setTimeout(r, Number(status.pollAfterMs) || 1500));
  }
  if (String(status?.status).toUpperCase() !== 'SUCCEEDED') {
    throw new Error(`${label} ended ${status?.status}: ${status?.errorText || status?.phase || 'no detail'}`);
  }
  log(`${label} succeeded (task ${String(handle.taskId).slice(0, 8)}, object ${status.objectId}).`);
  return status;
}

async function main() {
  log(`CAP ${BASE} as ${USER}; destination ${DESTINATION}; approve ${APPROVE}; activation ${ACTIVATE ? 'on' : 'off'}.`);

  // 1. Target system (reused by destination: one destination = one system).
  const existing = await call('GET', `/fiori/TargetSystems?$filter=destinationName%20eq%20'${encodeURIComponent(DESTINATION)}'&$top=1`);
  let system = existing?.value?.[0] || null;
  if (system) log(`Reusing target system "${system.displayName}" (${system.ID}).`);
  else {
    system = await call('POST', '/fiori/TargetSystems', {
      displayName: 'RD1 Development (seed)', destinationName: DESTINATION, systemId: 'RD1', client: '100',
      environment: 'DEV', s4Release: '2023'
    });
    log(`Registered target system "${system.displayName}" (${system.ID}).`);
  }

  // 2. Mock guard: never seed (and execute) against a real S/4HANA.
  const capabilities = unwrap(await call('GET', `/fiori/getBackendCapabilities(targetSystemId=${system.ID})`));
  if (capabilities?.mocked !== true) {
    throw new Error('This server is not in mock mode (ADOPTOPS_MOCK_S4=true); refusing to seed against a real S/4HANA. Use the sqlite dev-server script.');
  }

  // 3. Usage extraction with the inventory sources (fills the Landscape too).
  const to = new Date(); to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - MONTHS, 1));
  const extraction = await call('POST', '/fiori/runUsageExtraction', {
    targetSystemId: system.ID, sources: ['ST03N', 'USR02', 'AGR'], periodFrom: isoDate(from), periodTo: isoDate(to),
    granularity: 'MONTH', topUsersPerTcode: 20, minExecutions: 1
  });
  const extractionStatus = await waitForTask(extraction, 'Usage extraction');

  // 4. Proposals.
  const analysis = await call('POST', '/fiori/generateProposals', {
    extractionRunId: extractionStatus.objectId, scoringProfile: 'BALANCED', minExecutions: 1, includeAlreadyAdopted: false
  });
  const analysisStatus = await waitForTask(analysis, 'Proposal generation');
  const page = unwrap(await call('POST', '/fiori/queryProposals', {
    analysisRunId: analysisStatus.objectId, reviewStatus: 'OPEN', top: Math.max(APPROVE, 20), includeSummary: true
  }));
  const open = (page.Items || []).slice().sort((a, b) => Number(a.Rank || 0) - Number(b.Rank || 0));
  log(`${page.Summary?.open ?? open.length} open proposals; approving the top ${Math.min(APPROVE, open.length)}.`);
  if (!open.length) throw new Error('No open proposals were generated; nothing to approve.');

  // 5. Wave + approvals + membership.
  // Wave names are unique per system (409 otherwise): stamp to the second
  // and, should two seeds still collide, retry with a counter suffix.
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let wave = null;
  for (let attempt = 0; attempt < 5 && !wave; attempt += 1) {
    const name = `Seed wave ${stamp}${attempt ? ` #${attempt + 1}` : ''}`;
    try {
      wave = await call('POST', '/fiori/createAdoptionWave', {
        targetSystemId: system.ID, name, description: 'Seeded by scripts/seed-dev.mjs (mock mode).',
        targetDate: isoDate(new Date(Date.now() + 30 * 86400000)), adoptLabelled: false
      });
    } catch (error) {
      if (!/409/.test(error.message)) throw error;
    }
  }
  if (!wave) throw new Error('Could not find a free wave name for the seed.');
  const chosen = open.slice(0, APPROVE);
  for (const proposal of chosen) {
    await call('POST', '/fiori/approveProposal', { proposalId: proposal.ID, notes: 'Approved by seed-dev', targetWave: wave.Name });
  }
  await call('POST', '/fiori/assignProposalsToWave', { waveId: wave.ID, proposalIds: chosen.map((p) => p.ID) });
  log(`Wave "${wave.Name}" (${wave.ID}) with ${chosen.length} approved proposals: ${chosen.map((p) => p.FioriId || p.AppTitle).join(', ')}.`);

  let plan = null;
  let run = null;
  if (ACTIVATE) {
    // 6. Plan -> simulate -> execute (mock adapters: no S/4 writes).
    const created = unwrap(await call('POST', '/fiori/createActivationPlan', { waveId: wave.ID, name: `Activation of ${wave.Name}`, targetSystemId: system.ID }));
    plan = created.Plan;
    log(`Plan "${plan.Name}" (${plan.ID}) with ${plan.StepCount ?? created.Steps?.length ?? '?'} steps.`);
    const simulated = unwrap(await call('POST', '/fiori/simulateActivationPlan', { planId: plan.ID }));
    log(`Simulated: status ${simulated.Plan?.Status}${simulated.Plan?.FailedCount ? `, ${simulated.Plan.FailedCount} blocked` : ''}.`);
    const execution = await call('POST', '/fiori/executeActivationPlan', { planId: plan.ID });
    run = await waitForTask(execution, 'Activation execution');
  }

  const clientPort = PORT + 1169; // worktree slots: CAP 4104/4114/... <-> client 5273/5283/...
  log('Done. Open:');
  log(`  http://localhost:${clientPort}/#/dashboard?system=${system.ID}`);
  log(`  http://localhost:${clientPort}/#/landscape?run=${extractionStatus.objectId}`);
  log(`  http://localhost:${clientPort}/#/proposals?run=${analysisStatus.objectId}`);
  log(`  http://localhost:${clientPort}/#/waves/${wave.ID}`);
  if (plan) log(`  http://localhost:${clientPort}/#/activation/${plan.ID}`);
  if (run) log(`  http://localhost:${clientPort}/#/activation-runs/${run.taskId}`);
}

main().catch((error) => {
  process.stderr.write(`[seed-dev] FAILED: ${error.message}\n`);
  process.exit(1);
});
