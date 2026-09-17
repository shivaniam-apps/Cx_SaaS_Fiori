import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  mapTransactionUsage,
  mapUserTransactionUsage
} = require('../srv/srv/utils/s4-fiori-adapter.js');
const {
  pseudonymiseUser,
  lineOfBusinessOf,
  isCustomTcode
} = require('../srv/srv/utils/usage-extraction.js');

describe('s4 fiori adapter row mappers (the ABAP<->CAP contract)', () => {
  it('maps the ZADO TransactionUsage shape, tolerating the raw SWNC aliases', () => {
    // Preferred: the CDS view aliases (TransactionCode, ExecutionCount...)
    expect(mapTransactionUsage({
      TransactionCode: 'VA01', TransactionText: 'Create Sales Order',
      ApplicationComponent: 'SD-SLS', ExecutionCount: '120', DistinctUserCount: 7,
      TotalResponseTimeMs: 42000
    })).to.include({ TransactionCode: 'VA01', ExecutionCount: 120, DistinctUserCount: 7 });

    // Fallback: raw SWNCAGGUSERTCODE-era names (EntryId/StepCount) so an ABAP
    // alias slip degrades gracefully instead of producing empty rows.
    const raw = mapTransactionUsage({ EntryId: 'ME21N', StepCount: 55 });
    expect(raw.TransactionCode).to.equal('ME21N');
    expect(raw.ExecutionCount).to.equal(55);
  });

  it('derives AvgResponseTimeMs only when the view did not', () => {
    expect(mapTransactionUsage({ TransactionCode: 'X', AvgResponseTimeMs: 250 }).AvgResponseTimeMs).to.equal(250);
    expect(mapTransactionUsage({ TransactionCode: 'X' }).AvgResponseTimeMs).to.equal(0);
  });

  it('maps user x tcode rows including the ACCOUNT fallback', () => {
    expect(mapUserTransactionUsage({ UserKey: 'U1', TransactionCode: 'VA01', ExecutionCount: 3 }).UserKey).to.equal('U1');
    expect(mapUserTransactionUsage({ Account: 'JSMITH', EntryId: 'VA01', StepCount: 9 }))
      .to.include({ UserKey: 'JSMITH', TransactionCode: 'VA01', ExecutionCount: 9 });
  });
});

describe('usage extraction helpers', () => {
  it('pseudonymisation is stable per tenant and never echoes the user id', () => {
    const a = pseudonymiseUser('JSMITH', 't1');
    expect(a).to.equal(pseudonymiseUser('jsmith', 't1'));       // case-insensitive stable
    expect(a).to.not.equal(pseudonymiseUser('JSMITH', 't2'));   // per-tenant salt
    expect(a).to.have.lengthOf(24);
    expect(a.toUpperCase()).to.not.contain('JSMITH');
  });

  it('derives line of business from the application component', () => {
    expect(lineOfBusinessOf('FI-GL')).to.equal('FI');
    expect(lineOfBusinessOf('SD-SLS')).to.equal('SD');
    expect(lineOfBusinessOf('')).to.equal('OTHER');
  });

  it('classifies custom transactions by namespace', () => {
    expect(isCustomTcode('ZSD_PRICE_UPD')).to.equal(true);
    expect(isCustomTcode('YHR_REPORT')).to.equal(true);
    expect(isCustomTcode('VA01')).to.equal(false);
  });
});
