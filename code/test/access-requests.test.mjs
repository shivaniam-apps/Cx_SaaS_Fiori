import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { summarizeAccessRequestStatuses } = require('../srv/srv/utils/access-request-handlers.js');

describe('access requests (triage summary)', () => {
  it('sums grouped status counts into cards that partition the total', () => {
    const summary = summarizeAccessRequestStatuses([
      { Status: 'PENDING', cnt: 3 },
      { Status: 'APPROVED', cnt: 5 },
      { Status: 'DECLINED', cnt: 1 }
    ]);
    expect(summary).to.deep.equal({ Total: 9, Pending: 3, Approved: 5, Declined: 1, Other: 0 });
  });

  it('folds unknown statuses into Other so the strip still sums', () => {
    const summary = summarizeAccessRequestStatuses([
      { Status: 'PENDING', cnt: 1 },
      { Status: 'WITHDRAWN', cnt: 2 },
      { Status: null, count: 1 }
    ]);
    expect(summary.Total).to.equal(4);
    expect(summary.Other).to.equal(3);
    expect(summary.Pending + summary.Approved + summary.Declined + summary.Other).to.equal(summary.Total);
  });

  it('returns zeros for an empty or missing result', () => {
    expect(summarizeAccessRequestStatuses([])).to.deep.equal({ Total: 0, Pending: 0, Approved: 0, Declined: 0, Other: 0 });
    expect(summarizeAccessRequestStatuses(undefined).Total).to.equal(0);
  });
});
