import { expect } from 'chai';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseSwncEntryId,
  filterDialogRows,
  sanitizeExtractJson
} = require('../srv/srv/utils/usage-extraction.js');

// Entry shapes taken from a real RD1 ZADO_EXPORT_USAGE extract: the tcode
// field is the raw SWNC ENTRY_ID ("<name> <task-type>" / "<report> <jobname>"),
// truncated to 20 chars.
describe('SWNC ENTRY_ID parsing (offline extract import)', () => {
  it('classifies dialog transactions and strips the task-type suffix', () => {
    expect(parseSwncEntryId('PFCG T')).to.deep.equal({ tcode: 'PFCG', taskType: 'T', isDialog: true });
    expect(parseSwncEntryId('SESSION_MANAGER T')).to.include({ tcode: 'SESSION_MANAGER', isDialog: true });
    expect(parseSwncEntryId('ZSD_BUPA_REL_UPLD T')).to.include({ tcode: 'ZSD_BUPA_REL_UPLD', isDialog: true });
  });

  it('classifies background/report entries as non-dialog', () => {
    expect(parseSwncEntryId('SAPMSSY1 R')).to.include({ taskType: 'R', isDialog: false });
    expect(parseSwncEntryId('(BATCH) R')).to.include({ isDialog: false });
    expect(parseSwncEntryId('SWNC_TCOLL_STARTER S')).to.include({ taskType: 'S', isDialog: false });
  });

  it('treats jobname and truncated entries (no single-letter suffix) as non-dialog', () => {
    expect(parseSwncEntryId('RBDAPP01 LK_PUP_DOCS')).to.include({ isDialog: false, taskType: null });
    expect(parseSwncEntryId('<NUMBER RANGE BUFFER')).to.include({ isDialog: false });
    expect(parseSwncEntryId('CL_BGRFC_DAEMON_DEL_')).to.include({ isDialog: false });
    expect(parseSwncEntryId('KALC_VIA_JOB SAP_FIN')).to.include({ isDialog: false });
  });

  it('is defensive about empty and non-string input', () => {
    expect(parseSwncEntryId('')).to.include({ tcode: '', isDialog: false });
    expect(parseSwncEntryId(null)).to.include({ isDialog: false });
    expect(parseSwncEntryId(undefined)).to.include({ isDialog: false });
  });
});

describe('dialog-only import filter', () => {
  const transactions = [
    { tcode: 'PFCG T', executions: 22283 },
    { tcode: 'SE16N T', executions: 20343 },
    { tcode: 'RSM13000 R', executions: 8282846 },
    { tcode: 'RBDAPP01 LK_PUP_DOCS', executions: 263304 }
  ];
  const userTcodes = [
    { user: 'U1', tcode: 'PFCG T', executions: 10 },
    { user: 'U1', tcode: 'RSM13000 R', executions: 999 },
    { user: 'U2', tcode: 'SE16N T', executions: 5 }
  ];

  it('keeps only dialog rows and strips suffixes in both sections', () => {
    const result = filterDialogRows(transactions, userTcodes);
    expect(result.transactions.map((r) => r.tcode)).to.deep.equal(['PFCG', 'SE16N']);
    expect(result.userTcodes.map((r) => r.tcode)).to.deep.equal(['PFCG', 'SE16N']);
    expect(result.skippedTransactions).to.equal(2);
    expect(result.skippedUserRows).to.equal(1);
  });

  it('preserves the other row fields unchanged', () => {
    const result = filterDialogRows(transactions, userTcodes);
    expect(result.transactions[0]).to.deep.equal({ tcode: 'PFCG', executions: 22283 });
    expect(result.userTcodes[0]).to.deep.equal({ user: 'U1', tcode: 'PFCG', executions: 10 });
  });

  it('imports a suffix-free (already clean) extract unchanged', () => {
    const clean = [{ tcode: 'VA01', executions: 5 }, { tcode: 'ME21N', executions: 3 }];
    const cleanUsers = [{ user: 'U1', tcode: 'VA01', executions: 5 }];
    const result = filterDialogRows(clean, cleanUsers);
    expect(result.transactions).to.deep.equal(clean);
    expect(result.userTcodes).to.deep.equal(cleanUsers);
    expect(result.skippedTransactions).to.equal(0);
    expect(result.skippedUserRows).to.equal(0);
  });

  it('returns no rows when the extract holds only background entries', () => {
    const result = filterDialogRows(
      [{ tcode: 'RSM13000 R' }, { tcode: '(BATCH) R' }],
      [{ user: 'U1', tcode: 'RSM13000 R' }]
    );
    expect(result.transactions).to.have.length(0);
    expect(result.skippedTransactions).to.equal(2);
  });
});

describe('extract payload sanitizer', () => {
  it('strips raw control bytes so strict JSON.parse succeeds', () => {
    // Shape observed on RD1: an ACCOUNT of 12 NULs from an aborted session.
    const payload = '{"userTcodes":[{"user":"' + String.fromCharCode(0).repeat(12) + '","tcode":"Aborted R","executions":1}]}';
    expect(() => JSON.parse(payload)).to.throw();
    const parsed = JSON.parse(sanitizeExtractJson(payload));
    expect(parsed.userTcodes[0].user).to.equal('');
    expect(parsed.userTcodes[0].tcode).to.equal('Aborted R');
  });

  it('preserves tab, CR and LF (legal whitespace and escaped sequences)', () => {
    const payload = '{\r\n  "a": "b\\tc"\r\n}';
    expect(sanitizeExtractJson(payload)).to.equal(payload);
    expect(JSON.parse(sanitizeExtractJson(payload)).a).to.equal('b\tc');
  });

  it('is a no-op on clean payloads', () => {
    const payload = JSON.stringify({ format: 'adops-usage-extract', transactions: [{ tcode: 'PFCG T' }] });
    expect(sanitizeExtractJson(payload)).to.equal(payload);
  });
});
