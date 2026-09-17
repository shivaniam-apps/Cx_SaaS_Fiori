import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractionParameters,
  userTransactionUsageEntity,
  fetchUserTransactionUsagePage
} = require('../srv/srv/utils/s4-fiori-adapter.js');
const { mockUserTransactionUsagePage } = require('../srv/srv/utils/usage-extraction.js');

// ---------------------------------------------------------------------------
// S6: topUsersPerTcode / minExecutions reach the ABAP reader as CDS entity
// parameters of ZADO_C_USER_TX_USAGE instead of being dropped in the adapter.
// ---------------------------------------------------------------------------

describe('extraction parameters on the wire (ZADO_C_USER_TX_USAGE parameters)', () => {
  it('addresses the parameterized entity the way RAP OData V4 expects', () => {
    expect(userTransactionUsageEntity({ topUsersPerTcode: 20, minExecutions: 5 }))
      .to.equal('UserTransactionUsage(P_TopUsers=20,P_MinExecutions=5)/Set');
  });

  it('applies the reader defaults and sanitizes odd input (0 = all users, threshold at least 1)', () => {
    expect(extractionParameters()).to.deep.equal({ topUsersPerTcode: 20, minExecutions: 1 });
    expect(extractionParameters({ topUsersPerTcode: '0', minExecutions: '0' })).to.deep.equal({ topUsersPerTcode: 0, minExecutions: 1 });
    expect(extractionParameters({ topUsersPerTcode: -3, minExecutions: 2.9 })).to.deep.equal({ topUsersPerTcode: 0, minExecutions: 2 });
    expect(extractionParameters({ topUsersPerTcode: 'x', minExecutions: null })).to.deep.equal({ topUsersPerTcode: 20, minExecutions: 1 });
    expect(userTransactionUsageEntity({ topUsersPerTcode: 'x' })).to.equal('UserTransactionUsage(P_TopUsers=20,P_MinExecutions=1)/Set');
  });

  it('reports a page as parametersApplied=false only on a 404 of the parameter path (older add-on)', async () => {
    // The mocked transport answers 200 with a foreign payload: the parameter
    // path is "supported" from the adapter's point of view and no fallback
    // happens - the flag stays true.
    process.env.ADOPTOPS_MOCK_S4 = 'true';
    try {
      const page = await fetchUserTransactionUsagePage({
        targetSystem: { destinationName: 'S4H_2023' }, periodFrom: '2026-01-01', periodTo: '2026-06-30',
        topUsersPerTcode: 5, minExecutions: 3, top: 10, skip: 0
      });
      expect(page.parametersApplied).to.equal(true);
      expect(page.rows).to.be.an('array');
    } finally {
      delete process.env.ADOPTOPS_MOCK_S4;
    }
  });
});

describe('mock USERTCODE page mirrors the reader bounds', () => {
  const base = { periodFrom: '2026-01-01', periodTo: '2026-06-30', skip: 0, top: 100000 };

  it('threshold first, then top-N per transaction', () => {
    const all = mockUserTransactionUsagePage({ ...base, topUsersPerTcode: 0, minExecutions: 1 });
    const topFive = mockUserTransactionUsagePage({ ...base, topUsersPerTcode: 5, minExecutions: 1 });
    const strict = mockUserTransactionUsagePage({ ...base, topUsersPerTcode: 0, minExecutions: 500 });
    expect(all.totalCount).to.be.greaterThan(topFive.totalCount);
    const perTcode = {};
    for (const row of topFive.rows) perTcode[row.TransactionCode] = (perTcode[row.TransactionCode] || 0) + 1;
    expect(Math.max(...Object.values(perTcode))).to.be.at.most(5);
    expect(strict.totalCount).to.be.lessThan(all.totalCount);
    for (const row of strict.rows) expect(row.ExecutionCount).to.be.at.least(500);
    expect(all.parametersApplied).to.equal(true);
  });

  it('keeps the default behaviour when no parameters are given', () => {
    const defaulted = mockUserTransactionUsagePage(base);
    const explicit = mockUserTransactionUsagePage({ ...base, topUsersPerTcode: 20, minExecutions: 1 });
    expect(defaulted.totalCount).to.equal(explicit.totalCount);
  });
});
