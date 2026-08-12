import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  scoreCandidates,
  log1pScale,
  recencyFactor,
  releaseGatePasses,
  normalizeS4Release,
  coverageScoreOf,
  deriveConfidence
} = require('../srv/srv/utils/fiori-recommendation-engine.js');

const NOW = new Date('2026-08-13T00:00:00Z').getTime();

const baseCandidate = (overrides = {}) => ({
  fioriId: 'F0842',
  appTitle: 'Manage Sales Orders',
  totalExecutions: 1000,
  distinctUserCount: 40,
  availability: 'AVAILABLE',
  alreadyAdopted: false,
  editorialConfidence: 'HIGH',
  lastUsedOn: '2026-08-01',
  periodFrom: '2026-02-01',
  periodTo: '2026-07-31',
  matchedTcodes: [
    { tcode: 'VA01', executions: 600, mappingType: 'REPLACES', coveragePercent: 90 },
    { tcode: 'VA02', executions: 400, mappingType: 'REPLACES', coveragePercent: 90 }
  ],
  ...overrides
});

const WEIGHTS = { usage: 0.3, population: 0.25, coverage: 0.2, readiness: 0.15, effort: 0.1 };
const CONTEXT = { maxExecutionsInRun: 1000, totalActiveDialogUsers: 500, systemS4Release: '108', now: NOW };

describe('recommendation engine scoring', () => {
  it('log-scales usage so heavy tails do not flatten the field', () => {
    expect(log1pScale(1000, 1000)).to.equal(100);
    // Linear would give 1%; log scaling keeps a meaningful score.
    expect(log1pScale(10, 1000)).to.be.greaterThan(30);
    expect(log1pScale(0, 1000)).to.equal(0);
  });

  it('release-gates readiness to zero when the app needs a newer S/4', () => {
    expect(normalizeS4Release('108')).to.equal(2023);
    expect(releaseGatePasses('2023', '108')).to.equal(true);
    expect(releaseGatePasses('2025', '108')).to.equal(false);
    const [gated] = scoreCandidates([baseCandidate({ minS4Release: '2025' })], WEIGHTS, CONTEXT);
    expect(gated.scores.readiness).to.equal(0);
    expect(gated.confidenceReasons).to.include('RELEASE_GATE');
  });

  it('weights coverage by mapping type and execution share', () => {
    const full = coverageScoreOf(baseCandidate());
    const partial = coverageScoreOf(baseCandidate({
      matchedTcodes: [
        { tcode: 'VA01', executions: 600, mappingType: 'PARTIAL', coveragePercent: 90 },
        { tcode: 'VA02', executions: 400, mappingType: 'PARTIAL', coveragePercent: 90 }
      ]
    }));
    expect(full).to.equal(90);
    expect(partial).to.equal(54); // 90 * 0.6
  });

  it('applies the recency decay 1.0 -> 0.5 over a year', () => {
    expect(recencyFactor('2026-08-01', NOW)).to.equal(1.0);
    expect(recencyFactor('2025-01-01', NOW)).to.equal(0.5);
    expect(recencyFactor(null, NOW)).to.equal(0);
    const mid = recencyFactor('2026-02-13', NOW); // ~181 days
    expect(mid).to.be.greaterThan(0.5).and.lessThan(1.0);
  });

  it('ranks the already-adopted app down without hiding it', () => {
    const [adopted, fresh] = [
      baseCandidate({ fioriId: 'F0001', alreadyAdopted: true }),
      baseCandidate({ fioriId: 'F0002' })
    ];
    const ranked = scoreCandidates([adopted, fresh], WEIGHTS, CONTEXT);
    expect(ranked[0].fioriId).to.equal('F0002');
    expect(ranked[1].fioriId).to.equal('F0001');
    expect(ranked[1].scores.composite).to.be.greaterThan(0); // surfaced, not removed
  });

  it('derives confidence from reason codes, never a blended number', () => {
    const high = deriveConfidence(baseCandidate(), CONTEXT);
    expect(high.level).to.equal('HIGH');
    expect(high.reasons).to.deep.equal([]);

    const single = deriveConfidence(baseCandidate({ distinctUserCount: 1 }), CONTEXT);
    expect(single.level).to.equal('MEDIUM');
    expect(single.reasons).to.deep.equal(['SINGLE_USER']);

    const low = deriveConfidence(
      baseCandidate({ distinctUserCount: 1, availability: 'UNKNOWN' }),
      CONTEXT
    );
    expect(low.level).to.equal('LOW');
    expect(low.reasons).to.include.members(['SINGLE_USER', 'BACKEND_UNKNOWN']);
  });

  it('is deterministic: same inputs, same order, stable tie-breaks', () => {
    const twins = [
      baseCandidate({ fioriId: 'F0300' }),
      baseCandidate({ fioriId: 'F0100' }),
      baseCandidate({ fioriId: 'F0200', distinctUserCount: 45 })
    ];
    const first = scoreCandidates(twins, WEIGHTS, CONTEXT).map((c) => c.fioriId);
    const second = scoreCandidates([...twins].reverse(), WEIGHTS, CONTEXT).map((c) => c.fioriId);
    // Higher user count wins the tie; equal candidates order by FioriId asc.
    expect(first).to.deep.equal(['F0200', 'F0100', 'F0300']);
    expect(second).to.deep.equal(first);
  });

  it('writes rationale prose from the same reason codes as the score', () => {
    const [scored] = scoreCandidates(
      [baseCandidate({ availability: 'MISSING_SERVICE', distinctUserCount: 1 })],
      WEIGHTS,
      CONTEXT
    );
    expect(scored.rationale).to.contain('OData service is not activated');
    expect(scored.rationale).to.contain('only one user');
  });
});
