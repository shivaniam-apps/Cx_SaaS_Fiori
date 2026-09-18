#!/usr/bin/env node
// Second step of the PostgreSQL deployer task (idea I46): after cds-deploy
// has created or migrated the tables, create the secondary indexes of
// db/indexes.js. Idempotent (CREATE INDEX IF NOT EXISTS), so every
// deployment runs it; a failure fails the task, because a missing index is
// exactly the silent regression this step exists to prevent.
//
// Runs in gen/pg with the deployer's own @sap/cds and @cap-js/postgres,
// bound to the postgresql-db instance through VCAP_SERVICES like cds-deploy.
const cds = require('@sap/cds');
const { indexStatements } = require('./indexes.js');

async function main() {
    const db = await cds.connect.to('db');
    const statements = indexStatements();
    for (const statement of statements) {
        await db.run(statement);
        console.log(`[create-indexes] ${statement}`);
    }
    console.log(`[create-indexes] ${statements.length} index(es) present.`);
    await cds.shutdown?.();
}

main().catch((error) => {
    console.error(`[create-indexes] failed: ${error.message}`);
    process.exit(1);
});
