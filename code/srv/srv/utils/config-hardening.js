// ---------------------------------------------------------------------------
// Configuration hardening (S11): the boot-time checks on the process
// environment and the local defaults that used to be hardcoded.
//
// Pure: takes the environment and the profile list as arguments so the
// server, the tests and a future /readyz detail share one judgement.
// ---------------------------------------------------------------------------

// Local client port slots (docu/14 parallel-worktrees): primary 5273, then
// the overview / scheduling / admin / spare worktrees.
const LOCAL_CLIENT_PORTS = Object.freeze([5273, 5283, 5293, 5303, 5313]);

function localClientOrigins(ports = LOCAL_CLIENT_PORTS) {
  const origins = [];
  for (const port of ports) {
    origins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  }
  return origins;
}

// CORS_ORIGINS as a list; the local port slots when unset. '*' is honoured
// by the middleware as "any origin" and stays a deliberate operator choice.
function corsOriginsFrom(raw, fallback = localClientOrigins()) {
  const list = String(raw || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return list.length ? list : [...fallback];
}

// Development conveniences that must never reach a deployed instance. The
// bare names resolve with the ADOPTOPS_ / ADOPS_ prefixes like env.js does.
const DEV_ONLY_VARIABLES = Object.freeze([
  { name: 'S4_URL_OVERRIDES', why: 'routes S/4 calls to a direct base URL instead of the BTP destination' },
  { name: 'S4_DIRECT_USER', why: 'basic credentials for direct S/4 calls' },
  { name: 'S4_DIRECT_PASSWORD', why: 'basic credentials for direct S/4 calls' },
  { name: 'S4_DIRECT_INSECURE_TLS', why: 'disables certificate verification on direct S/4 calls' },
  // Mock S/4 is the normal local dev mode: refused in CF, not nagged about locally.
  { name: 'MOCK_S4', why: 'answers every S/4 call with mock data', warnLocally: false }
]);

const PREFIXES = ['ADOPTOPS_', 'ADOPS_', ''];

function resolvedKey(env, name) {
  for (const prefix of PREFIXES) {
    const key = `${prefix}${name}`;
    const value = env[key];
    if (value !== undefined && value !== '') return key;
  }
  return null;
}

// Which dev-only variables are set, with the key they were found under.
function devOnlySettings(env = process.env) {
  const found = [];
  for (const variable of DEV_ONLY_VARIABLES) {
    const key = resolvedKey(env, variable.name);
    if (key) found.push({ name: variable.name, key, why: variable.why, warnLocally: variable.warnLocally !== false });
  }
  return found;
}

// A Cloud Foundry instance carries VCAP_APPLICATION; nothing else does.
function isCloudFoundry(env = process.env) {
  return Boolean(env.VCAP_APPLICATION);
}

function isProductionProfile(env = process.env, profiles = []) {
  return env.NODE_ENV === 'production' || (Array.isArray(profiles) && profiles.includes('production'));
}

// The verdict at boot: findings carry a level - 'refuse' stops the server,
// 'warn' is logged once. Dev-only variables: refused in Cloud Foundry (a
// deployed instance routes through destinations, full stop), warned about
// everywhere else, including the local hybrid scripts that run with
// NODE_ENV=production on purpose.
function assessStartupConfig({ env = process.env, profiles = [] } = {}) {
  const findings = [];
  const settings = devOnlySettings(env);
  const cloudFoundry = isCloudFoundry(env);
  const production = isProductionProfile(env, profiles);

  for (const setting of settings) {
    if (!cloudFoundry && setting.warnLocally === false) continue;
    findings.push({
      level: cloudFoundry ? 'refuse' : 'warn',
      variable: setting.key,
      message: cloudFoundry
        ? `${setting.key} is set in a Cloud Foundry instance (${setting.why}). Development conveniences are refused in CF - unset it in the .mtaext / cf unset-env and redeploy.`
        : `${setting.key} is set (${setting.why}). Development convenience${production ? ' under the production profile' : ''} - never set it in a deployed instance.`
    });
  }

  if (!env.CORS_ORIGINS && (cloudFoundry || production)) {
    findings.push({
      level: 'warn',
      variable: 'CORS_ORIGINS',
      message: 'CORS_ORIGINS is unset: the local client port slots are allowed. Set it to the approuter URL in a deployed instance.'
    });
  }

  return { cloudFoundry, production, settings, findings, refused: findings.some((f) => f.level === 'refuse') };
}

// The message a caller gets when no S/4 destination can be determined.
function noDestinationMessage(targetSystem) {
  const label = targetSystem?.displayName || targetSystem?.ID || '';
  return label
    ? `Target system "${label}" has no BTP destination configured. Set its destination name (Target Systems page) - there is no default destination.`
    : 'No S/4 destination: the call carries no destination name and ADOPTOPS_S4_DESTINATION is unset. Register the target system with a BTP destination - there is no default destination.';
}

module.exports = {
  LOCAL_CLIENT_PORTS,
  DEV_ONLY_VARIABLES,
  localClientOrigins,
  corsOriginsFrom,
  devOnlySettings,
  isCloudFoundry,
  isProductionProfile,
  assessStartupConfig,
  noDestinationMessage
};
