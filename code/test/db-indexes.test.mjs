// Secondary indexes (idea I46): one list feeds the PostgreSQL deployer step,
// the local sqlite refresh and the load test. Every entry must name a
// persisted entity and columns that exist in the model, and the statements
// must apply to the test database.
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { cds, test, expectInMemoryDb } from './helpers/cds-http-test.mjs';

const require = createRequire(import.meta.url);
const { INDEXES, indexStatements } = require('../db/indexes.js');

describe('secondary indexes (db/indexes.js)', function () {
  this.timeout(20000);

  before(async () => {
    expectInMemoryDb();
    await test; // shared server up, model loaded
  });

  it('name persisted entities and existing columns of the model', () => {
    const csn = cds.model || cds.db?.model;
    expect(csn, 'model loaded').to.exist;
    for (const index of INDEXES) {
      const entityName = index.table.replace(/^adops_db_/, 'adops.db.');
      const entity = csn.definitions[entityName];
      expect(entity, `${index.table} -> ${entityName}`).to.exist;
      expect(entity.kind).to.equal('entity');
      expect(entity.query || entity.projection, `${entityName} must be a table, not a view`).to.equal(undefined);
      for (const column of index.columns) {
        expect(entity.elements[column], `${entityName}.${column}`).to.exist;
      }
      expect(index.name).to.match(/^adops_ix_[a-z0-9_]+$/);
    }
    expect(new Set(INDEXES.map((i) => i.name)).size, 'index names are unique').to.equal(INDEXES.length);
  });

  it('render idempotent CREATE INDEX IF NOT EXISTS statements', () => {
    const statements = indexStatements();
    expect(statements).to.have.length(INDEXES.length);
    expect(statements[1]).to.equal('CREATE INDEX IF NOT EXISTS adops_ix_usertx_snapshot_tcode ON adops_db_UserTransactionUsage (snapshot_ID, TransactionCode)');
    expect(indexStatements([{ name: 'x', table: 't', columns: ['a'] }])).to.deep.equal(['CREATE INDEX IF NOT EXISTS x ON t (a)']);
  });

  it('apply to the database twice without error and show up in the catalogue', async () => {
    for (const statement of indexStatements()) await cds.db.run(statement);
    for (const statement of indexStatements()) await cds.db.run(statement);
    const rows = await cds.db.run("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'adops_ix_%'");
    expect(rows.map((r) => r.name).sort()).to.deep.equal(INDEXES.map((i) => i.name).sort());
  });
});
