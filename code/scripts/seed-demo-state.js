#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AdoptOps demo-state seeder. Rebuilds the full pilot state on a fresh
// database through the app's own APIs:
//   target system -> extract import -> proposals -> Wave 1 (top 4 approved)
//   -> activation plan -> simulation.
//
// Usage (backend must be running, e.g. `npm run srv:sqlite:nowatch`):
//   node seed-demo-state.js <extract.json> <destinationName> [displayName]
// Example:
//   node seed-demo-state.js ./adops_usage_RD1_20260201_20260731.json RD1_DEST "RD1 Development"
//
// Re-runnable: refuses to duplicate an existing system/wave of the same name.
// ---------------------------------------------------------------------------
const fs = require('node:fs');

const BASE = process.env.ADOPS_BASE || 'http://localhost:4104';
const [extractPath, destinationName, displayNameArg] = process.argv.slice(2);
const displayName = displayNameArg || 'RD1 Development';
if (!extractPath || !destinationName) {
  console.error('Usage: node seed-demo-state.js <extract.json> <destinationName> [displayName]');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from('alice:').toString('base64');
const H = { 'Content-Type': 'application/json', Authorization: auth };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (d) => (typeof d?.value === 'string' ? JSON.parse(d.value) : d);

async function call(method, path, body) {
  const response = await fetch(`${BASE}/fiori/${path}`, {
    method, headers: H, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (response.status >= 400) {
    throw new Error(`${method} ${path} -> ${response.status}: ${(data?.error?.message || text).slice(0, 300)}`);
  }
  return unwrap(data);
}

(async () => {
  // 1. Target system (idempotent by displayName).
  const systems = await call('GET', `TargetSystems?$filter=displayName eq '${displayName.replace(/'/g, "''")}'`);
  let system = (systems.value || [])[0];
  if (system) {
    console.log(`target system exists: ${system.ID} (${system.displayName})`);
  } else {
    system = await call('POST', 'TargetSystems', {
      displayName,
      destinationName,
      systemId: 'RD1',
      client: '100',
      environment: 'DEV',
      active: true,
      isDefault: true,
      identifiedUsageAllowed: true
    });
    console.log(`target system created: ${system.ID} (destination ${destinationName})`);
  }

  // Idempotency gate: a populated Wave 1 means import/analysis/approvals
  // already ran - a rerun must not create a second proposal set (the label
  // resolution would pull the duplicates into the wave).
  const waves = unwrap(await call('GET', 'queryAdoptionWaves()'));
  let wave = (waves.Items || []).find((w) => w.Name === 'Wave 1');

  if (wave && (wave.Rollup?.approved || 0) > 0) {
    console.log(`wave exists with ${wave.Rollup.approved} approved member(s) - skipping import/analysis/approvals.`);
  } else {
    // 2. Import the extract file.
    const payload = fs.readFileSync(extractPath, 'utf8');
    const imported = await call('POST', 'importUsageExtract', { targetSystemId: system.ID, payload });
    console.log(`extract imported: run ${imported.runId} | ${imported.transactions} transactions, ${imported.userRows} user rows (skipped ${imported.skippedTransactions}/${imported.skippedUserRows} background rows)`);

    // 3. Generate proposals and wait for the analysis task.
    const handle = await call('POST', 'generateProposals', { extractionRunId: imported.runId, scoringProfile: 'BALANCED' });
    const analysisRunId = handle.objectId;
    for (let i = 0; i < 60; i++) {
      await wait(2000);
      const status = await call('GET', `getTaskStatus(taskId=${handle.taskId})`);
      if (status.status === 'SUCCEEDED') break;
      if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(status.status)) {
        throw new Error(`Analysis task ended ${status.status}: ${status.errorText || ''}`);
      }
    }
    const proposals = await call('POST', 'queryProposals', { analysisRunId, top: 30 });
    console.log(`proposals: ${proposals.Count} generated`);

    // 4. Approve the top 4 into the Wave 1 label.
    const top4 = proposals.Items.filter((p) => p.Rank <= 4);
    for (const p of top4) {
      if (p.ReviewStatus === 'APPROVED') continue;
      await call('POST', 'approveProposal', {
        proposalId: p.ID,
        notes: 'Wave 1: high-usage core business apps (seeded).',
        targetWave: 'Wave 1'
      });
      console.log(`approved: rank ${p.Rank} ${p.FioriId} ${p.AppTitle}`);
    }

    // 5. Wave 1 (adopts the labelled approvals).
    if (!wave) {
      wave = await call('POST', 'createAdoptionWave', {
        targetSystemId: system.ID,
        name: 'Wave 1',
        description: 'Core SD/MM/LE apps with the highest real usage (seeded).',
        targetDate: '2026-10-01',
        adoptLabelled: true
      });
      console.log(`wave created: ${wave.ID}`);
    }
  }

  // 6. Plan + simulation (skipped when the wave already has a plan).
  const detail = unwrap(await call('GET', `readAdoptionWave(waveId=${wave.ID})`));
  if ((detail.Plans || []).length) {
    console.log(`plan exists: ${detail.Plans[0].ID} (${detail.Plans[0].StepCount} steps, ${detail.Plans[0].Status}) - skipping plan creation.`);
  } else {
    const plan = await call('POST', 'createActivationPlan', { waveId: wave.ID, targetSystemId: system.ID });
    console.log(`plan created: ${plan.Plan.ID} (${plan.Steps.length} steps, target ${plan.TargetSystem?.displayName})`);
    const simulated = await call('POST', 'simulateActivationPlan', { planId: plan.Plan.ID });
    console.log(`simulated: ${simulated.Plan.Status} | ok ${simulated.Plan.SucceededCount} warn ${simulated.Plan.WarningCount} blocked ${simulated.Plan.FailedCount}`);
  }

  console.log('\nDone. Open the app: Waves -> Wave 1 -> plan is ready to execute.');
})().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
