#!/usr/bin/env node
// ---------------------------------------------------------------------------
// One-shot repair for a wave inflated by a seeder rerun: removes duplicate
// members (same FioriId, keeps the first) and deletes all but the OLDEST
// activation plan. Read-only against everything else.
//
// Usage (backend running):  node scripts/cleanup-wave-duplicates.js [waveName]
// ---------------------------------------------------------------------------
const BASE = process.env.ADOPS_BASE || 'http://localhost:4104';
const waveName = process.argv[2] || 'Wave 1';
const auth = 'Basic ' + Buffer.from('alice:').toString('base64');
const H = { 'Content-Type': 'application/json', Authorization: auth };
const unwrap = (d) => (typeof d?.value === 'string' ? JSON.parse(d.value) : d);

async function call(method, path, body) {
  const response = await fetch(`${BASE}/fiori/${path}`, {
    method, headers: H, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (response.status >= 400) throw new Error(`${method} ${path} -> ${response.status}: ${(data?.error?.message || text).slice(0, 200)}`);
  return unwrap(data);
}

(async () => {
  const waves = await call('GET', 'queryAdoptionWaves()');
  const wave = (waves.Items || []).find((w) => w.Name === waveName);
  if (!wave) throw new Error(`Wave "${waveName}" not found.`);
  const detail = await call('GET', `readAdoptionWave(waveId=${wave.ID})`);

  // Dedupe members by FioriId (first occurrence wins - list is rank-ordered).
  const seen = new Set();
  const duplicates = [];
  for (const p of detail.Proposals || []) {
    if (seen.has(p.FioriId)) duplicates.push(p);
    else seen.add(p.FioriId);
  }
  if (duplicates.length) {
    await call('POST', 'removeProposalsFromWave', { waveId: wave.ID, proposalIds: duplicates.map((p) => p.ID) });
    console.log(`removed ${duplicates.length} duplicate member(s): ${duplicates.map((p) => p.FioriId).join(', ')}`);
  } else {
    console.log('no duplicate members.');
  }

  // Keep the oldest plan, delete the rest (composition cascades the steps).
  const plans = [...(detail.Plans || [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const plan of plans.slice(1)) {
    const del = await fetch(`${BASE}/fiori/ActivationPlans(${plan.ID})`, { method: 'DELETE', headers: H });
    console.log(`deleted plan ${plan.ID} (${plan.StepCount} steps) -> ${del.status}`);
  }
  if (plans.length) console.log(`kept plan ${plans[0].ID} (${plans[0].StepCount} steps, ${plans[0].Status}).`);

  const after = await call('GET', `readAdoptionWave(waveId=${wave.ID})`);
  console.log(`wave now: ${after.Proposals.length} member(s), ${after.Plans.length} plan(s).`);
})().catch((e) => { console.error('CLEANUP FAILED:', e.message); process.exit(1); });
