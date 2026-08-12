// Refreshes the deployed CDS views inside the local dev db.sqlite so every
// checkout self-heals after a merge that changed service projections.
//
// What it does:
//   1. Fingerprints the CDS model sources; if unchanged since the last run
//      (fingerprint stored inside db.sqlite), exits immediately.
//   2. Compiles the model to sqlite DDL (same model set as `cds deploy
//      --profile development` from srv/) and hashes the DDL.
//   3. Verifies the base tables in db.sqlite still carry every column the
//      compiled model expects. Views never hold data, so they are dropped
//      and re-created from the compiled DDL; base tables and row data are
//      never touched.
//   4. Additive base-table drift self-heals: a table missing entirely is
//      created from the compiled DDL (empty - CSV seed rows only arrive with
//      a full deploy), and missing columns whose definition is legal for
//      sqlite ALTER TABLE ... ADD COLUMN are added in place. A timestamped
//      db.sqlite.bak-* copy is written before the first such change. Drift
//      that ADD COLUMN cannot express (PRIMARY KEY/UNIQUE columns, NOT NULL
//      without a constant default, non-constant defaults) still falls back
//      to instructing a full `cds deploy` (which reseeds).
//
// Usage: node ./scripts/refresh-sqlite-views.mjs [--db <path>] [--force]
//   --db     sqlite file to refresh (default: ./db.sqlite, i.e. code/db.sqlite)
//   --force  skip the source-fingerprint fast path and re-verify the views
//
// Exit codes: 0 = up to date, refreshed or healed, 1 = full deploy required / error.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const TAG = '[db:refresh:sqlite]';
const codeDir = process.cwd();
const require = createRequire(path.join(codeDir, 'package.json'));

const args = process.argv.slice(2);
const force = args.includes('--force');
const dbArgIndex = args.indexOf('--db');
const dbPath = path.resolve(codeDir, dbArgIndex >= 0 ? args[dbArgIndex + 1] : 'db.sqlite');

// Model sources that feed the development-profile compile. Over-inclusion is
// harmless (worst case one unnecessary recompile that ends as a no-op).
const MODEL_DIRS = ['srv', 'api', 'db', 'db-com', 'app', 'test'];
const CONFIG_FILES = ['package.json', 'srv/.cdsrc.json', 'srv/srv/.cdsrc.json'];
const SKIP_DIRS = new Set(['node_modules', 'gen', 'dist', '.git']);

function log(message) {
  console.log(`${TAG} ${message}`);
}

function fail(lines) {
  for (const line of [].concat(lines)) console.error(`${TAG} ${line}`);
  process.exit(1);
}

function collectCdsFiles(dir, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectCdsFiles(path.join(dir, entry.name), found);
    } else if (entry.name.endsWith('.cds')) {
      found.push(path.join(dir, entry.name));
    }
  }
}

function sourceFingerprint() {
  const files = [];
  for (const dir of MODEL_DIRS) collectCdsFiles(path.join(codeDir, dir), files);
  for (const file of CONFIG_FILES) {
    const abs = path.join(codeDir, file);
    if (fs.existsSync(abs)) files.push(abs);
  }
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(codeDir, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function compileDdl() {
  process.env.CDS_ENV = 'development';
  const cds = require('@sap/cds');
  cds.root = path.join(codeDir, 'srv');
  const csn = await cds.load('*');
  const ddl = cds.compile.to.sql(csn, { dialect: 'sqlite' });
  const statements = Array.isArray(ddl)
    ? ddl
    : String(ddl).split(/;\s*(?:\r?\n|$)/);
  return statements
    .map((s) => s.trim().replace(/;$/, ''))
    .filter(Boolean);
}

// Column names + full definitions of a compiled CREATE TABLE statement
// (constraint lines skipped). The definition is what ALTER TABLE ... ADD
// COLUMN would need, i.e. the column line minus the trailing comma.
function parseTableColumns(createTableSql) {
  const body = createTableSql.slice(createTableSql.indexOf('(') + 1, createTableSql.lastIndexOf(')'));
  const columns = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))\s/);
    if (!match) continue;
    const name = match[1] ?? match[2];
    if (/^(PRIMARY|CONSTRAINT|FOREIGN|UNIQUE|CHECK)$/i.test(name)) continue;
    columns.push({ name, definition: line.replace(/,\s*$/, '') });
  }
  return columns;
}

// sqlite ALTER TABLE ... ADD COLUMN cannot express every column definition:
// no PRIMARY KEY/UNIQUE, no NOT NULL without a constant default, and the
// default itself must be a constant (no CURRENT_* / parenthesised expression).
function addColumnBlocker(definition) {
  if (/\bPRIMARY\s+KEY\b/i.test(definition)) return 'PRIMARY KEY';
  if (/\bUNIQUE\b/i.test(definition)) return 'UNIQUE';
  const defaultMatch = definition.match(/\bDEFAULT\s+(.+)$/i);
  if (defaultMatch && /^\s*(CURRENT_|\()/i.test(defaultMatch[1])) return 'non-constant DEFAULT';
  if (/\bNOT\s+NULL\b/i.test(definition) && (!defaultMatch || /^\s*NULL\b/i.test(defaultMatch[1]))) {
    return 'NOT NULL without a constant DEFAULT';
  }
  return null;
}

function objectName(sql, kind) {
  const match = sql.match(new RegExp(`^CREATE ${kind}\\s+(?:"([^"]+)"|(\\S+))`, 'i'));
  return match ? (match[1] ?? match[2]) : null;
}

const FULL_DEPLOY_ADVICE = [
  'Fix: back up the DB, then run a full deploy (re-creates tables and reseeds; local data in db.sqlite is replaced):',
  '  PowerShell:  Copy-Item db.sqlite "db.sqlite.bak-$(Get-Date -Format yyyy-MM-ddTHH-mm-ss)"',
  '  bash:        cp db.sqlite "db.sqlite.bak-$(date +%Y-%m-%dT%H-%M-%S)"',
  '  then:        cd srv; npx cds deploy --profile development',
];

async function main() {
  if (!fs.existsSync(dbPath)) {
    fail([
      `No sqlite DB found at ${dbPath}.`,
      'Create it with a full deploy (also loads the CSV seed data):',
      '  cd srv; npx cds deploy --profile development',
    ]);
  }

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    fail('better-sqlite3 is not installed (comes with @cap-js/sqlite) - run npm install.');
  }

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS adoptops_schema_sync (key TEXT PRIMARY KEY, value TEXT)');
    const readMeta = db.prepare('SELECT value FROM adoptops_schema_sync WHERE key = ?');
    const storedFingerprint = readMeta.get('source_fingerprint')?.value;
    const storedDdlHash = readMeta.get('ddl_hash')?.value;

    const fingerprint = sourceFingerprint();
    if (!force && fingerprint === storedFingerprint) {
      log('model sources unchanged - views are up to date.');
      return;
    }

    log('model sources changed (or first run) - compiling CDS model...');
    const statements = await compileDdl();
    const tables = statements.filter((s) => /^CREATE TABLE/i.test(s));
    const views = statements.filter((s) => /^CREATE VIEW/i.test(s));
    const ddlHash = createHash('sha256').update(statements.join(';\n')).digest('hex');

    const writeMeta = db.prepare(
      'INSERT INTO adoptops_schema_sync (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );

    const existingViewNames = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all().map((r) => r.name)
    );
    const compiledViewNames = views.map((v) => objectName(v, 'VIEW'));
    const allViewsPresent = compiledViewNames.every((name) => existingViewNames.has(name));

    if (!force && ddlHash === storedDdlHash && allViewsPresent) {
      writeMeta.run('source_fingerprint', fingerprint);
      log('compiled schema unchanged - views are up to date.');
      return;
    }

    // Base tables must carry every model column before views can be
    // refreshed. Additive drift (new table, new ADD COLUMN-compatible
    // columns) is healed in place; anything else is real table drift.
    const drift = [];
    const heals = [];
    const tableInfo = (name) => {
      try {
        return db.pragma(`table_info(${JSON.stringify(name)})`);
      } catch {
        return [];
      }
    };
    for (const tableSql of tables) {
      const name = objectName(tableSql, 'TABLE');
      const existing = new Set(tableInfo(name).map((c) => c.name));
      if (existing.size === 0) {
        heals.push({
          sql: tableSql,
          note: `created missing table ${name} (empty - CSV seed rows only arrive with a full cds deploy)`,
        });
        continue;
      }
      for (const column of parseTableColumns(tableSql).filter((c) => !existing.has(c.name))) {
        const blocker = addColumnBlocker(column.definition);
        if (blocker) {
          drift.push(`table ${name} is missing column ${column.name} (${blocker} - not addable in place)`);
        } else {
          heals.push({
            sql: `ALTER TABLE ${JSON.stringify(name)} ADD COLUMN ${column.definition}`,
            note: `added column ${column.name} to ${name}`,
          });
        }
      }
    }
    if (drift.length) {
      fail([
        'Base tables in db.sqlite no longer match the CDS model - a view refresh cannot fix this:',
        ...drift.map((d) => `  - ${d}`),
        ...FULL_DEPLOY_ADVICE,
      ]);
    }

    if (heals.length) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      const backupPath = `${dbPath}.bak-${stamp}`;
      fs.copyFileSync(dbPath, backupPath);
      log(`base tables need additive changes - backed up DB to ${path.basename(backupPath)}.`);
    }

    const refresh = db.transaction(() => {
      for (const heal of heals) {
        db.exec(heal.sql);
        log(heal.note);
      }
      for (const name of existingViewNames) {
        db.exec(`DROP VIEW IF EXISTS ${JSON.stringify(name)}`);
      }
      for (const viewSql of views) db.exec(viewSql);
      writeMeta.run('source_fingerprint', fingerprint);
      writeMeta.run('ddl_hash', ddlHash);
      writeMeta.run('refreshed_at', new Date().toISOString());
    });
    refresh();
    log(
      heals.length
        ? `healed ${heals.length} base-table change(s) and re-created ${views.length} view(s) (existing row data untouched).`
        : `re-created ${views.length} view(s) from the compiled model (base tables and data untouched).`
    );
  } finally {
    db.close();
  }
}

main().catch((error) => {
  fail([`unexpected error: ${error.message}`, 'Server start aborted; fix the model/DB and retry.']);
});
