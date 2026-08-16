const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');
const { buildCandidates } = require('./fiori-candidate-query.js');
const { scoreCandidates, ENGINE_VERSION } = require('./fiori-recommendation-engine.js');

const { SELECT, INSERT, UPDATE } = cds.ql;

// ---------------------------------------------------------------------------
// ANALYSIS task handler: candidate query -> pure scoring -> persisted
// AnalysisRuns + AppProposals + ProposalEvidence, with the rollups the list
// page needs so it never reads child rows.
// ---------------------------------------------------------------------------

function loadProfiles() {
  // config/ ships with the app; require keeps it cached.
  return require('../../../config/scoring-profiles.json');
}

async function runAnalysis({ task, payload, reportProgress, log }) {
  const {
    extractionRunId,
    scoringProfile = 'BALANCED',
    weights: customWeights,
    minExecutions = 1,
    includeAlreadyAdopted = true,
    lineOfBusinessIn = [],
    analysisRunId
  } = payload || {};

  const analysisRun = await SELECT.one.from('adops.db.AnalysisRuns').where({ ID: analysisRunId });
  if (!analysisRun) throw new Error('Analysis run row not found.');
  const extractionRun = await SELECT.one.from('adops.db.ExtractionRuns').where({ ID: extractionRunId });
  if (!extractionRun) throw new Error('Extraction run not found.');

  const startedAt = Date.now();
  await UPDATE('adops.db.AnalysisRuns')
    .set({ Status: 'RUNNING', StartedAt: new Date(startedAt).toISOString() })
    .where({ ID: analysisRunId });

  try {
    await reportProgress({ phase: 'Building candidate set', processedItems: 0, totalItems: 0 });
    const { candidates, context } = await buildCandidates({ runId: extractionRunId, minExecutions, lineOfBusinessIn });
    if (!context) throw new Error('The extraction run has no snapshots to analyse.');

    const targetSystem = await SELECT.one.from('adops.db.TargetSystems')
      .where({ ID: extractionRun.targetSystem_ID });

    const profiles = loadProfiles();
    const weights = (scoringProfile === 'CUSTOM' && customWeights) || profiles[scoringProfile] || profiles.BALANCED;

    await reportProgress({ phase: `Scoring ${candidates.length} candidates`, processedItems: 0, totalItems: candidates.length });
    const scored = scoreCandidates(
      candidates.filter((candidate) => includeAlreadyAdopted || !candidate.alreadyAdopted),
      weights,
      {
        maxExecutionsInRun: context.maxExecutionsInRun,
        totalActiveDialogUsers: context.totalActiveDialogUsers,
        systemS4Release: targetSystem?.s4Release,
        now: Date.now()
      }
    );

    await reportProgress({ phase: 'Persisting proposals', processedItems: 0, totalItems: scored.length });
    let persisted = 0;
    for (const candidate of scored) {
      const proposalId = randomUUID();
      const hasEquivalent = candidate.matchedTcodes.some((m) => m.mappingType !== 'NO_EQUIVALENT');
      await INSERT.into('adops.db.AppProposals').entries({
        ID: proposalId,
        analysisRun_ID: analysisRunId,
        targetSystem_ID: extractionRun.targetSystem_ID,
        TenantId: analysisRun.TenantId,
        FioriId: candidate.fioriId,
        AppTitle: candidate.appTitle,
        AppType: candidate.appType,
        LineOfBusiness: candidate.lineOfBusiness,
        Persona: candidate.persona,
        BusinessCatalogId: candidate.businessCatalogId,
        BusinessRoleId: candidate.businessRoleId,
        Score: candidate.scores.composite,
        Rank: candidate.rank,
        UsageScore: candidate.scores.usage,
        PopulationScore: candidate.scores.population,
        CoverageScore: candidate.scores.coverage,
        ReadinessScore: candidate.scores.readiness,
        EffortScore: candidate.scores.effort,
        RecencyFactor: candidate.scores.recencyFactor,
        Confidence: candidate.confidence,
        ConfidenceReasonsJson: JSON.stringify(candidate.confidenceReasons),
        RationaleText: candidate.rationale.slice(0, 2000),
        MatchedTcodeCount: candidate.matchedTcodes.length,
        TotalExecutions: candidate.totalExecutions,
        DistinctUserCount: candidate.distinctUserCount,
        TotalDialogSteps: candidate.totalDialogSteps,
        LastUsedOn: candidate.lastUsedOn,
        CoveragePercent: candidate.coveragePercent,
        BackendAvailability: candidate.availability,
        AlreadyAdopted: candidate.alreadyAdopted,
        EstimatedEffort: candidate.scores.effort >= 70 ? 'LOW' : candidate.scores.effort >= 40 ? 'MEDIUM' : 'HIGH',
        PrerequisiteText: candidate.prerequisiteNote || '',
        GroupKey: candidate.businessRoleId || `${candidate.lineOfBusiness || 'OTHER'}::${candidate.persona || 'General'}`,
        GroupTitle: candidate.businessRoleId || `${candidate.lineOfBusiness || 'Other'} - ${candidate.persona || 'General'}`,
        ReviewStatus: hasEquivalent ? 'NEW' : 'SUPERSEDED'
      });

      const evidence = candidate.matchedTcodes.map((matched) => ({
        ID: randomUUID(),
        proposal_ID: proposalId,
        TenantId: analysisRun.TenantId,
        EvidenceType: 'TCODE',
        TransactionCode: matched.tcode,
        TransactionText: matched.tcodeText,
        ExecutionCount: matched.executions,
        DistinctUserCount: matched.userCount,
        SharePercent: candidate.totalExecutions
          ? Math.round((matched.executions / candidate.totalExecutions) * 10000) / 100
          : 0,
        MappingType: matched.mappingType,
        MappingSource: matched.mappingSource,
        CoveragePercent: matched.coveragePercent,
        Included: true,
        LastUsedOn: matched.lastUsedOn
      }));
      if (evidence.length) await INSERT.into('adops.db.ProposalEvidence').entries(evidence);

      persisted += 1;
      if (persisted % 20 === 0) {
        await reportProgress({ phase: 'Persisting proposals', processedItems: persisted, totalItems: scored.length });
      }
    }

    // Headline figures for the run card / decision funnel baseline.
    const coveredExecutions = scored
      .filter((c) => c.matchedTcodes.some((m) => m.mappingType !== 'NO_EQUIVALENT'))
      .reduce((sum, c) => sum + c.totalExecutions, 0);
    const coveredShare = context.totalExecutionsInRun
      ? Math.min(100, Math.round((coveredExecutions / context.totalExecutionsInRun) * 10000) / 100)
      : 0;

    await UPDATE('adops.db.AnalysisRuns')
      .set({
        Status: 'COMPLETED',
        CompletedAt: new Date().toISOString(),
        DurationMs: Date.now() - startedAt,
        EngineVersion: ENGINE_VERSION,
        WeightsJson: JSON.stringify(weights),
        CandidateCount: candidates.length,
        ProposalCount: persisted,
        CoveredTcodeCount: context.coveredTcodes.size,
        UncoveredTcodeCount: Math.max(0, context.totalTcodes - context.coveredTcodes.size),
        CoveredUserCount: context.totalActiveDialogUsers,
        CoveredExecutionShare: coveredShare
      })
      .where({ ID: analysisRunId });

    await log('INFO', 'Completed', `${persisted} proposals from ${candidates.length} candidates; ${coveredShare}% of executions have a mapped app.`);
    return { analysisRunId, proposals: persisted, coveredShare };
  } catch (error) {
    await UPDATE('adops.db.AnalysisRuns')
      .set({ Status: 'FAILED', CompletedAt: new Date().toISOString(), ErrorText: String(error.message).slice(0, 2000) })
      .where({ ID: analysisRunId });
    throw error;
  }
}

module.exports = { runAnalysis };
