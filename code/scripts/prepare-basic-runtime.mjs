import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = process.cwd();

const RUNTIME_DEPENDENCIES = {
  '@cap-js-community/odata-v2-adapter': '^1.14.4',
  '@sap/cds': '^8.9.4',
  '@cap-js/postgres': '^1.10.0',
  '@sap/xsenv': '^5.6.1',
  '@sap/xssec': '^4.7.0',
  axios: '^1.9.0',
  express: '^4.18.2',
  passport: '^0.7.0'
};

const generatedApps = [
  { path: join(projectRoot, 'gen', 'srv'), name: 'adops-basic-srv' },
  { path: join(projectRoot, 'gen', 'api'), name: 'adops-basic-api-srv' }
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function sanitizePackage(app) {
  const packagePath = join(app.path, 'package.json');
  if (!existsSync(packagePath)) return;

  const pkg = readJson(packagePath);
  writeJson(packagePath, {
    name: app.name,
    version: pkg.version || '0.0.1',
    description: `${app.name} runtime package for adoptops Basic`,
    private: true,
    engines: {
      node: pkg.engines?.node || '22.x'
    },
    scripts: {
      start: 'cds-serve'
    },
    dependencies: RUNTIME_DEPENDENCIES
  });

  const lockPath = join(app.path, 'package-lock.json');
  if (existsSync(lockPath)) unlinkSync(lockPath);
}

function writeRuntimeConfig(app) {
  writeJson(join(app.path, '.cdsrc.json'), {
    requires: {
      auth: {
        kind: 'xsuaa'
      },
      db: {
        kind: 'postgres',
        vcap: {
          label: 'postgresql-db'
        }
      },
      multitenancy: false,
      extensibility: false,
      toggles: false
    }
  });
}

function sanitizeCsn(app) {
  const csnPath = join(app.path, 'srv', 'csn.json');
  if (!existsSync(csnPath)) return;

  const csn = readJson(csnPath);
  const defs = csn.definitions || {};
  for (const name of Object.keys(defs)) {
    if (name.startsWith('cds.xt.')) delete defs[name];
  }
  writeJson(csnPath, csn);
}

for (const app of generatedApps) {
  if (!existsSync(app.path)) continue;
  sanitizePackage(app);
  sanitizeCsn(app);
  writeRuntimeConfig(app);
}

// The PostgreSQL schema deployer (gen/pg, cds build task "postgres") ships the
// same CSN the srv runtime serves. A build that silently lost the task would
// deploy an app against an empty database, so its output is mandatory and its
// persisted entities must match the runtime CSN exactly.
function prepareDbDeployer() {
  const deployerDir = join(projectRoot, 'gen', 'pg');
  const csnPath = join(deployerDir, 'db', 'csn.json');
  const packagePath = join(deployerDir, 'package.json');
  if (!existsSync(csnPath) || !existsSync(packagePath)) {
    throw new Error(
      'gen/pg is incomplete: the "postgres" cds build task did not run. Check cds.build.tasks in package.json and that @cap-js/postgres is installed.'
    );
  }

  const csn = readJson(csnPath);
  const defs = csn.definitions || {};
  for (const name of Object.keys(defs)) {
    if (name.startsWith('cds.xt.')) delete defs[name];
  }
  writeJson(csnPath, csn);

  const runtimeCsnPath = join(projectRoot, 'gen', 'srv', 'srv', 'csn.json');
  if (existsSync(runtimeCsnPath)) {
    const runtimeDefs = readJson(runtimeCsnPath).definitions || {};
    const persisted = (d) => Object.entries(d)
      .filter(([, def]) => def.kind === 'entity' && !def.query && !def.projection && !def['@cds.persistence.skip'])
      .map(([name]) => name)
      .sort();
    const deployerTables = persisted(defs);
    const runtimeTables = persisted(runtimeDefs);
    const missing = runtimeTables.filter((name) => !deployerTables.includes(name));
    const extra = deployerTables.filter((name) => !runtimeTables.includes(name));
    if (missing.length || extra.length) {
      throw new Error(
        `gen/pg and gen/srv disagree on persisted entities. Missing in deployer: [${missing.join(', ')}]; only in deployer: [${extra.join(', ')}]`
      );
    }
    console.log(`Verified the PostgreSQL deployer covers all ${deployerTables.length} persisted entities of the srv runtime.`);
  }
}

prepareDbDeployer();

console.log('Prepared Basic runtime artifacts for PostgreSQL, XSUAA, and Destination-based integration.');
