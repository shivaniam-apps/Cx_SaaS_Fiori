// Secondary indexes for the volume tables (idea I46, measured in
// docu/13-operations-observability/performance-baseline.md).
//
// CAP creates primary keys only. The reads of Usage Insight and the User &
// Role Landscape filter the big tables by run, snapshot, transaction, role
// or user, which are sequential scans without these indexes. One list feeds
// three consumers so they cannot drift:
//   - create-indexes.js, the db deployer step after cds-deploy (PostgreSQL)
//   - scripts/refresh-sqlite-views.mjs, the local db.sqlite refresh
//   - test/load-volume.test.mjs, which measures with and without them
//
// Table and column names are the identifiers CAP emits for `adops.db.*`
// (namespace dots become underscores, casing as in the model). They are
// written unquoted, so PostgreSQL folds them exactly as it folded the
// CREATE TABLE statements of cds-deploy. Every statement is idempotent.
const INDEXES = [
    { name: 'adops_ix_txusage_snapshot', table: 'adops_db_TransactionUsage', columns: ['snapshot_ID'] },
    { name: 'adops_ix_usertx_snapshot_tcode', table: 'adops_db_UserTransactionUsage', columns: ['snapshot_ID', 'TransactionCode'] },
    { name: 'adops_ix_usertx_tcode', table: 'adops_db_UserTransactionUsage', columns: ['TransactionCode'] },
    { name: 'adops_ix_userinv_run', table: 'adops_db_UserInventory', columns: ['extractionRun_ID'] },
    { name: 'adops_ix_roleinv_run', table: 'adops_db_RoleInventory', columns: ['extractionRun_ID'] },
    { name: 'adops_ix_roleusers_run_role', table: 'adops_db_RoleUsers', columns: ['extractionRun_ID', 'RoleName'] },
    { name: 'adops_ix_roleusers_run_user', table: 'adops_db_RoleUsers', columns: ['extractionRun_ID', 'UserKey'] },
    { name: 'adops_ix_roletx_run_role', table: 'adops_db_RoleTransactions', columns: ['extractionRun_ID', 'RoleName'] },
    { name: 'adops_ix_proposals_run', table: 'adops_db_AppProposals', columns: ['analysisRun_ID'] },
    { name: 'adops_ix_tasks_object', table: 'adops_db_BackgroundTasks', columns: ['ObjectId', 'TaskType'] }
];

// CREATE INDEX IF NOT EXISTS is understood by PostgreSQL and SQLite alike.
function indexStatements(indexes = INDEXES) {
    return indexes.map((index) => `CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table} (${index.columns.join(', ')})`);
}

module.exports = { INDEXES, indexStatements };
