// ---------------------------------------------------------------------------
// The recommendation engine - PURE. No cds, no I/O, no clock: everything it
// needs arrives as arguments (context.now included), so it is exhaustively
// unit-testable and two runs over the same inputs are identical.
//
// Design rules it encodes (docu/08-catalog-and-proposals):
// - Distinct users are a UNION, not a SUM - the candidate query delivers the
//   unioned count; this module never adds per-tcode user counts.
// - Usage and population scores are LOG-scaled: execution counts are heavy-
//   tailed and a linear score would produce a top-10 of five apps and noise.
// - Coverage and confidence stay two separate signals, never blended.
// - Confidence is reason CODES; prose (RationaleText) is generated from the
//   same codes so it can never contradict the score.
// ---------------------------------------------------------------------------

const ENGINE_VERSION = '1.0.0';

const MAPPING_TYPE_WEIGHT = {
  REPLACES: 1.0,
  PARTIAL: 0.6,
  COMPLEMENTS: 0.35,
  NO_EQUIVALENT: 0
};

const READINESS_BY_AVAILABILITY = {
  AVAILABLE: 100,
  MISSING_SERVICE: 60,
  NOT_INSTALLED: 25,
  UNKNOWN: 50
};

const DAY_MS = 24 * 60 * 60 * 1000;

function log1pScale(value, maxValue) {
  if (!maxValue || maxValue <= 0) return 0;
  return Math.min(100, (100 * Math.log1p(Math.max(0, value))) / Math.log1p(maxValue));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Release gate: MinS4Release like '2023'; system release from S4CORE
// component (108 => 2023). Numeric compare on the normalised 4-digit year.
function normalizeS4Release(release) {
  const text = String(release || '').trim();
  if (!text) return null;
  if (/^\d{4}$/.test(text)) return Number(text);
  // S4CORE component release: 102=1809, 103=1909, 104=2020, 105=2021,
  // 106=2022, 107... SAP skipped 107; 108=2023, 109=2025(FPS?) - map known.
  const componentMap = { 102: 1809, 103: 1909, 104: 2020, 105: 2021, 106: 2022, 108: 2023, 110: 2025 };
  const numeric = Number(text);
  return componentMap[numeric] || null;
}

function releaseGatePasses(minRelease, systemRelease) {
  const min = normalizeS4Release(minRelease);
  const system = normalizeS4Release(systemRelease);
  if (min === null) return true;        // no requirement declared
  if (system === null) return true;     // unknown system: do not gate, flag via confidence
  return system >= min;
}

function recencyFactor(lastUsedOn, now) {
  if (!lastUsedOn) return 0;
  const ageDays = Math.max(0, (now - new Date(lastUsedOn).getTime()) / DAY_MS);
  if (ageDays <= 30) return 1.0;
  if (ageDays >= 365) return 0.5;
  // Linear 1.0 -> 0.5 between 30 and 365 days.
  return round2(1.0 - 0.5 * ((ageDays - 30) / (365 - 30)));
}

function windowWeeks(candidate) {
  if (!candidate.periodFrom || !candidate.periodTo) return 0;
  return (new Date(candidate.periodTo).getTime() - new Date(candidate.periodFrom).getTime()) / (7 * DAY_MS);
}

function deriveConfidence(candidate, context) {
  const reasons = [];
  const weeks = windowWeeks(candidate);
  if (weeks > 0 && weeks < 2) reasons.push('SHORT_WINDOW');
  if ((candidate.distinctUserCount || 0) <= 1) reasons.push('SINGLE_USER');
  const dominantType = dominantMappingType(candidate);
  if (dominantType !== 'REPLACES') reasons.push('PARTIAL_COVERAGE');
  if (!candidate.availability || candidate.availability === 'UNKNOWN') reasons.push('BACKEND_UNKNOWN');
  if ((candidate.matchedTcodes || []).some((t) => /^[YZ]/i.test(t.tcode))) reasons.push('CUSTOM_TCODE');
  if (!releaseGatePasses(candidate.minS4Release, context.systemS4Release)) reasons.push('RELEASE_GATE');
  if ((candidate.editorialConfidence || 'HIGH') !== 'HIGH') reasons.push('EDITORIAL_UNCERTAIN');
  if ((candidate.totalExecutions || 0) < 50) reasons.push('THIN_SAMPLE');

  // SHORT_WINDOW or BACKEND UNKNOWN alone already caps at MEDIUM; two or
  // more reasons (or a hard one) mean LOW.
  const hardReasons = reasons.filter((reason) => ['RELEASE_GATE', 'SHORT_WINDOW'].includes(reason));
  let level = 'HIGH';
  if (reasons.length === 1) level = 'MEDIUM';
  if (reasons.length >= 2 || hardReasons.length) level = reasons.length >= 2 ? 'LOW' : 'MEDIUM';
  if (reasons.length >= 2 && hardReasons.length) level = 'LOW';
  return { level, reasons };
}

function dominantMappingType(candidate) {
  const totals = new Map();
  for (const tcode of candidate.matchedTcodes || []) {
    const key = tcode.mappingType || 'PARTIAL';
    totals.set(key, (totals.get(key) || 0) + Number(tcode.executions || 0));
  }
  let best = 'PARTIAL';
  let bestValue = -1;
  for (const [type, value] of totals) {
    if (value > bestValue) { best = type; bestValue = value; }
  }
  return best;
}

function coverageScoreOf(candidate) {
  const total = Number(candidate.totalExecutions || 0);
  if (!total) return 0;
  let score = 0;
  for (const tcode of candidate.matchedTcodes || []) {
    const share = Number(tcode.executions || 0) / total;
    const typeWeight = MAPPING_TYPE_WEIGHT[tcode.mappingType] ?? 0.35;
    const coverage = Number(tcode.coveragePercent ?? 60);
    score += coverage * typeWeight * share;
  }
  return Math.min(100, score);
}

function effortScoreOf(candidate) {
  const newRoles = Number(candidate.newRolesNeeded || 1);
  const steps = Number(candidate.activationStepCount || 4);
  const assignUsers = candidate.assignUsers ? 1 : 0;
  const prerequisites = Number(candidate.prerequisiteCount || 0);
  return Math.max(0, 100 - Math.min(100, 6 * newRoles + 2 * steps + 8 * assignUsers + 10 * prerequisites));
}

function rationaleFrom(candidate, scores, confidence) {
  const tcodes = (candidate.matchedTcodes || [])
    .slice()
    .sort((a, b) => Number(b.executions || 0) - Number(a.executions || 0));
  const top = tcodes.slice(0, 3).map((t) => `${t.tcode} (${Number(t.executions || 0).toLocaleString('en-US')} executions)`);
  const parts = [
    `${candidate.appTitle || candidate.fioriId} maps ${tcodes.length} transaction${tcodes.length === 1 ? '' : 's'}: ${top.join(', ')}${tcodes.length > 3 ? ` and ${tcodes.length - 3} more` : ''}.`,
    `${Number(candidate.distinctUserCount || 0)} distinct users ran these transactions in the analysed window.`
  ];
  if (candidate.availability === 'AVAILABLE') {
    parts.push('The app is technically available in the target system.');
  } else if (candidate.availability === 'MISSING_SERVICE') {
    parts.push('The app exists but its OData service is not activated yet.');
  } else if (candidate.availability === 'NOT_INSTALLED') {
    parts.push('The app is not installed in the target system.');
  }
  if (candidate.alreadyAdopted) {
    parts.push('Already launched in the customer launchpad - ranked down accordingly.');
  }
  const reasonText = {
    SHORT_WINDOW: 'the analysed window is under two weeks',
    SINGLE_USER: 'only one user produced the usage signal',
    PARTIAL_COVERAGE: 'the mapping does not fully replace every transaction',
    BACKEND_UNKNOWN: 'backend availability could not be derived',
    CUSTOM_TCODE: 'custom (Y/Z) transactions are involved',
    RELEASE_GATE: 'the app requires a newer S/4HANA release',
    EDITORIAL_UNCERTAIN: 'the curated mapping is not editorially confirmed',
    THIN_SAMPLE: 'the usage sample is thin'
  };
  if (confidence.reasons.length) {
    parts.push(`Confidence ${confidence.level}: ${confidence.reasons.map((reason) => reasonText[reason] || reason).join('; ')}.`);
  }
  return parts.join(' ');
}

// candidates: built by fiori-candidate-query.js. context: {maxExecutionsInRun,
// totalActiveDialogUsers, systemS4Release, now (epoch ms)}.
function scoreCandidates(candidates, weights, context) {
  const now = Number(context?.now) || 0;
  const scored = (candidates || []).map((candidate) => {
    const usageScore = log1pScale(candidate.totalExecutions, context.maxExecutionsInRun);
    const populationScore = log1pScale(candidate.distinctUserCount, context.totalActiveDialogUsers);
    const coverageScore = coverageScoreOf(candidate);
    const gatePasses = releaseGatePasses(candidate.minS4Release, context.systemS4Release);
    const readinessScore = gatePasses
      ? (READINESS_BY_AVAILABILITY[candidate.availability] ?? READINESS_BY_AVAILABILITY.UNKNOWN)
      : 0;
    const effortScore = effortScoreOf(candidate);
    const recency = recencyFactor(candidate.lastUsedOn, now);
    const confidence = deriveConfidence(candidate, context);

    let composite = recency * (
      (weights.usage || 0) * usageScore +
      (weights.population || 0) * populationScore +
      (weights.coverage || 0) * coverageScore +
      (weights.readiness || 0) * readinessScore +
      (weights.effort || 0) * effortScore
    );
    if (candidate.alreadyAdopted) composite *= 0.15;

    return {
      ...candidate,
      scores: {
        usage: round2(usageScore),
        population: round2(populationScore),
        coverage: round2(coverageScore),
        readiness: round2(readinessScore),
        effort: round2(effortScore),
        recencyFactor: recency,
        composite: round2(composite)
      },
      confidence: confidence.level,
      confidenceReasons: confidence.reasons,
      coveragePercent: Math.round(coverageScore),
      rationale: rationaleFrom(candidate, null, confidence)
    };
  });

  // Deterministic ranking: score desc, users desc, FioriId asc - re-running
  // a completed analysis is a no-op.
  scored.sort((a, b) =>
    b.scores.composite - a.scores.composite ||
    (b.distinctUserCount || 0) - (a.distinctUserCount || 0) ||
    String(a.fioriId).localeCompare(String(b.fioriId))
  );
  scored.forEach((candidate, index) => { candidate.rank = index + 1; });
  return scored;
}

module.exports = {
  ENGINE_VERSION,
  scoreCandidates,
  // Exported for tests:
  log1pScale,
  recencyFactor,
  releaseGatePasses,
  normalizeS4Release,
  coverageScoreOf,
  deriveConfidence,
  dominantMappingType
};
