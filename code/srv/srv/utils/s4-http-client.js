const xsenv = require('@sap/xsenv');
const cds = require('@sap/cds');
const axios = require('axios');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const zlib = require('node:zlib');
const TokenUtils = require('./token-helper.js');
const { envValue, envNumber, envFlag } = require('./env.js');

// ---------------------------------------------------------------------------
// S/4 transport layer, lifted from ChronoPilot's s4-job-adapter.js (the
// battle-tested half with nothing job-specific in it). Encodes the hard-won
// behaviour documented in .claude/rules/sap-backend.md:
//   - destination resolution that reconciles subaccount vs effective scope
//     and lets the SUBACCOUNT record win for routing (matches Settings)
//   - keep-alive sockets keyed by proxy+location+destination, because SAP
//     Connectivity binds a proxy TCP connection to the first SCC location
//     used on it
//   - per-destination-context concurrency gates (local tunnel: strictly 1)
//   - session cookie jar + one 401 retry, CSRF token cache, $metadata-derived
//     bound-action names with remembered URL shapes
//   - the diagnostic error shape with full routing context and no secrets
// Do not "clean this up" without reading the rule file first.
// ---------------------------------------------------------------------------

const LOG = cds.log('s4-http-client');

const DEFAULT_DESTINATION = envValue('S4_DESTINATION', 'S4H_2023');
const DEFAULT_S4_SERVICE_ROOT = envValue(
  'S4_SERVICE_ROOT',
  '/sap/opu/odata4/sap/zado_usage_o4/srvd/sap/zado_usage_srv/0001'
);

function connectivityResponseText(data) {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data || '');
  } catch {
    return String(data || '');
  }
}

function isTransientOnPremiseResponse(response) {
  const status = Number(response?.status || 0);
  if ([500, 502, 503, 504].includes(status)) return true;
  if (status !== 400) return false;

  const text = connectivityResponseText(response?.data);
  return /SAP-Connectivity-(?:SCC-Location_ID|ConsumerAccount)|different value compared to the value which was already used for this connection|already used for this connection/i.test(text);
}

function isTransientOnPremiseError(error) {
  const code = String(error?.code || '').toUpperCase();
  return ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function serializeHttpBody(body) {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body) || typeof body === 'string') return body;
  return JSON.stringify(body);
}

// SAP Connectivity binds each proxy TCP connection to the first SCC
// location/consumer context used on it. Reusing a socket is therefore safe
// ONLY within one destination+location context. Keep-alive agents are keyed
// by that context so a socket never carries a foreign location ID, while
// same-context requests skip the per-request TCP handshake.
//
// Transport profiles: the LOCAL cf-ssh tunnel terminates response bodies by
// closing the connection (hangs kept-alive responses) and destabilises under
// concurrency, so it stays sequential without keep-alive. The real CF
// connectivity proxy has neither problem, so it gets keep-alive and bounded
// parallelism by default. ADOPTOPS_ONPREM_KEEPALIVE=on|off overrides both.
const ONPREM_KEEPALIVE_MODE = String(envValue('ONPREM_KEEPALIVE', '')).trim().toLowerCase();
const onPremiseAgents = new Map();

function onPremiseKeepAliveEnabled(proxyHost) {
  if (ONPREM_KEEPALIVE_MODE === 'on') return true;
  if (ONPREM_KEEPALIVE_MODE === 'off') return false;
  return !isLocalConnectivityProxyHost(proxyHost);
}

function onPremiseAgentFor(agentKey, proxyHost) {
  if (!agentKey || !onPremiseKeepAliveEnabled(proxyHost)) return false;
  let agent = onPremiseAgents.get(agentKey);
  if (!agent) {
    agent = new http.Agent({
      keepAlive: true,
      maxSockets: 6,
      maxFreeSockets: 2,
      timeout: 30000
    });
    onPremiseAgents.set(agentKey, agent);
  }
  return agent;
}

// Optional per-destination direct base URLs, e.g. for local development where
// the S/4 system is reachable without the Cloud Connector round trip:
//   ADOPTOPS_S4_URL_OVERRIDES=S4H_2023=http://vhcala4hci:50000,OTHER=https://...
// The override is applied only when the destination carries its own basic
// credentials. On a connection-level failure the override is parked for a few
// minutes and the call transparently falls back to the connectivity proxy.
const DIRECT_URL_OVERRIDES = (() => {
  const map = new Map();
  for (const pair of String(envValue('S4_URL_OVERRIDES', '')).split(',')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const url = pair.slice(separator + 1).trim();
    if (name && /^https?:\/\//i.test(url)) map.set(name, url.replace(/\/+$/, ''));
  }
  return map;
})();
const DIRECT_RETRY_PARK_MS = 5 * 60 * 1000;
const directOverrideParkedUntil = new Map();
const directAgents = new Map();

function directUrlOverrideFor(destinationName) {
  const overrideUrl = DIRECT_URL_OVERRIDES.get(destinationName);
  if (!overrideUrl) return '';
  const parkedUntil = directOverrideParkedUntil.get(destinationName) || 0;
  if (parkedUntil > Date.now()) return '';
  return overrideUrl;
}

function parkDirectOverride(destinationName, reason) {
  directOverrideParkedUntil.set(destinationName, Date.now() + DIRECT_RETRY_PARK_MS);
  LOG.warn(`Direct S/4 URL override for ${destinationName} is unreachable (${reason}); falling back to the connectivity proxy for ${Math.round(DIRECT_RETRY_PARK_MS / 60000)} minutes.`);
}

function directAgentFor(baseUrl) {
  let agent = directAgents.get(baseUrl);
  if (!agent) {
    const isHttps = /^https:/i.test(baseUrl);
    const AgentClass = isHttps ? https.Agent : http.Agent;
    agent = new AgentClass({
      keepAlive: true,
      maxSockets: 8,
      maxFreeSockets: 2,
      timeout: 30000,
      ...(isHttps && String(envValue('S4_DIRECT_INSECURE_TLS', 'on')).toLowerCase() === 'on'
        ? { rejectUnauthorized: false }
        : {})
    });
    directAgents.set(baseUrl, agent);
  }
  return agent;
}

function isConnectionLevelError(error) {
  const code = String(error?.code || '').toUpperCase();
  return ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'EPIPE'].includes(code)
    && !error?.response;
}

// One timing line per S/4 round trip. Slow requests surface at info level so
// production logs show where time goes without enabling debug.
const S4_SLOW_REQUEST_MS = Math.max(0, envNumber('S4_SLOW_MS', 2500));

function logS4Timing({ method, destinationName, transport, path, status, ms, attempts }) {
  const pathTail = String(path || '').split('?')[0].split('/').slice(-2).join('/');
  const line = `S4 ${method} ${destinationName}[${transport}] /${pathTail} -> ${status} in ${ms}ms${attempts > 1 ? ` (${attempts} attempts)` : ''}`;
  if (S4_SLOW_REQUEST_MS && ms >= S4_SLOW_REQUEST_MS) LOG.info(line);
  else LOG.debug(line);
}

function nativeOnPremiseHttpRequest({
  targetUrl,
  proxyHost,
  proxyPort,
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 20000,
  agentKey = ''
}) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const payload = serializeHttpBody(body);
    const agent = onPremiseAgentFor(agentKey, proxyHost);
    const requestHeaders = {
      ...headers,
      Host: target.host,
      'Accept-Encoding': 'gzip',
      ...(agent
        ? { Connection: 'keep-alive', 'Proxy-Connection': 'keep-alive' }
        : { Connection: 'close', 'Proxy-Connection': 'close' }),
      ...(payload !== undefined && headers['Content-Length'] === undefined
        ? { 'Content-Length': Buffer.byteLength(payload) }
        : {})
    };

    // Node's native HTTP client is used (not Axios) so the proxy connection is
    // fully controlled: either a context-keyed keep-alive agent (see above) or
    // agent:false, which guarantees a brand-new TCP connection per request.
    const request = http.request({
      host: proxyHost,
      port: proxyPort,
      method,
      path: targetUrl,
      headers: requestHeaders,
      agent
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        let bodyBuffer = Buffer.concat(chunks);
        if (/gzip/i.test(String(response.headers?.['content-encoding'] || ''))) {
          try {
            bodyBuffer = zlib.gunzipSync(bodyBuffer);
          } catch (gunzipError) {
            reject(new Error(`S/4 OnPremise response could not be gunzipped: ${gunzipError.message}`));
            return;
          }
        }
        resolve({
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          headers: response.headers || {},
          data: bodyBuffer.toString('utf8')
        });
      });
    });

    request.setTimeout(Math.max(1000, Number(timeoutMs) || 20000), () => {
      const timeoutError = new Error(`S/4 OnPremise proxy request timed out after ${timeoutMs} ms.`);
      timeoutError.code = 'ETIMEDOUT';
      request.destroy(timeoutError);
    });

    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

// The SAP Connectivity proxy can bind a TCP connection to the consumer account /
// Cloud Connector location used by the first request on that connection, and the
// local hybrid tunnel destabilises when many requests hit ONE destination at
// once. Requests are therefore funnelled through a per-destination-context
// concurrency gate: limit 1 (strictly sequential) for the local tunnel, a small
// bounded pool for the real CF connectivity proxy and for direct connections.
const ONPREM_CONCURRENCY = Math.max(1, envNumber('ONPREM_CONCURRENCY', 4));
const DIRECT_CONCURRENCY = Math.max(1, envNumber('S4_DIRECT_CONCURRENCY', 6));
const requestGates = new Map();

function limitRequestConcurrency(queueKey, limit, operation) {
  const key = String(queueKey || 'default');
  let gate = requestGates.get(key);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    requestGates.set(key, gate);
  }

  const run = async () => {
    gate.active += 1;
    try {
      return await operation();
    } finally {
      gate.active -= 1;
      const next = gate.waiters.shift();
      if (next) next();
    }
  };

  if (gate.active < Math.max(1, limit)) return run();
  return new Promise((resolve, reject) => {
    gate.waiters.push(() => run().then(resolve, reject));
  });
}

// Generic short-TTL promise cache. Caching the in-flight promise also
// deduplicates concurrent identical reads.
function cachedRead(cacheMap, ttlMs, cacheKey, operation, maxEntries = 200) {
  if (ttlMs <= 0) return operation();

  const now = Date.now();
  const hit = cacheMap.get(cacheKey);
  if (hit && now - hit.at < ttlMs) return hit.promise;

  const promise = operation().catch((error) => {
    cacheMap.delete(cacheKey);
    throw error;
  });
  cacheMap.set(cacheKey, { at: now, promise });

  if (cacheMap.size > maxEntries) {
    for (const [key, entry] of cacheMap) {
      if (now - entry.at >= ttlMs) cacheMap.delete(key);
    }
  }

  return promise;
}

// CSRF tokens and their session cookies stay valid for the security session,
// not for a single request. Caching them removes 1-3 GET round trips from
// EVERY write/action call. Invalidated on a CSRF-rejected response.
const CSRF_CACHE_TTL_MS = Math.max(0, envNumber('CSRF_CACHE_TTL_MS', 20 * 60 * 1000));
const csrfCache = new Map();

function csrfCacheKey(destinationName, path) {
  return `${destinationName}::${serviceRootFromPath(path)}`;
}

function invalidateCsrfToken(destinationName, path) {
  csrfCache.delete(csrfCacheKey(destinationName, path));
}

function isCsrfRejectedResponse(response) {
  if (Number(response?.status) !== 403) return false;
  const headerToken = responseHeader(response.headers, 'x-csrf-token');
  if (/required/i.test(String(headerToken || ''))) return true;
  const text = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data || '');
  return /csrf/i.test(text);
}

// $metadata is fetched once per destination+service root to learn the schema
// namespace and bound action names, instead of once per action invocation.
const actionMetadataCache = new Map();
const ACTION_METADATA_TTL_MS = 60 * 60 * 1000;

// Remembers which of the probed URL shapes (key format x action suffix) a
// RAP service accepted, so follow-up actions go straight to the working shape.
const actionShapeCache = new Map();

function preferRememberedShape(shapeKey, candidates) {
  const rememberedIndex = actionShapeCache.get(shapeKey);
  if (rememberedIndex === undefined || rememberedIndex <= 0 || rememberedIndex >= candidates.length) return candidates;
  return [candidates[rememberedIndex], ...candidates.filter((_, index) => index !== rememberedIndex)];
}

function rememberShape(shapeKey, candidates, successfulCandidate) {
  const index = candidates.indexOf(successfulCandidate);
  if (index >= 0) actionShapeCache.set(shapeKey, index);
}

// Mock switch: automated tests always mock; local demo mode is an explicit
// opt-in so the offline sqlite profile can exercise the full UI without an
// S/4 system behind it.
function shouldMockSap() {
  if (process.env.NODE_ENV === 'test') return true;
  if (cds.env?.profiles?.includes('test')) return true;
  return envFlag('MOCK_S4', false);
}

function destinationService() {
  return xsenv.getServices({ destination: { tag: 'destination' } }).destination;
}

function connectivityService() {
  try {
    return xsenv.getServices({ connectivity: { tag: 'connectivity' } }).connectivity;
  } catch {
    try {
      return xsenv.getServices({ connectivity: { label: 'connectivity' } }).connectivity;
    } catch {
      return null;
    }
  }
}

function connectivityProxyConfig(connectivity) {
  const proxyHost =
    process.env.CONNECTIVITY_PROXY_HOST ||
    envValue('CONNECTIVITY_PROXY_HOST') ||
    connectivity.onpremise_proxy_host;

  const proxyPortValue =
    process.env.CONNECTIVITY_PROXY_PORT ||
    process.env.CONNECTIVITY_PROXY_HTTP_PORT ||
    envValue('CONNECTIVITY_PROXY_PORT') ||
    connectivity.onpremise_proxy_http_port;

  const proxyPort = Number(proxyPortValue);

  return {
    host: proxyHost,
    port: Number.isFinite(proxyPort) ? proxyPort : null
  };
}

function effectiveConnectivityProxyDetails() {
  const connectivity = connectivityService();
  if (!connectivity) {
    return {
      bound: false,
      host: '',
      port: null,
      rawHost: '',
      rawHttpPort: null
    };
  }

  const proxy = connectivityProxyConfig(connectivity);
  return {
    bound: true,
    host: proxy.host,
    port: proxy.port,
    rawHost: connectivity.onpremise_proxy_host || '',
    rawHttpPort: connectivity.onpremise_proxy_http_port || null
  };
}

function isLocalConnectivityProxyHost(host) {
  return ['localhost', '127.0.0.1', '::1'].includes(String(host || '').trim().toLowerCase());
}

function isInternalConnectivityProxyHost(host) {
  const normalizedHost = String(host || '').trim().toLowerCase();
  return normalizedHost.includes('connectivityproxy.internal.cf.');
}

function connectivityProxyTroubleshootingHint({ proxyHost, proxyPort, destinationName, code }) {
  const host = String(proxyHost || '').trim();
  const port = Number(proxyPort);
  const reachablePort = Number.isFinite(port) ? port : 'the configured port';
  const errorCode = String(code || '').trim().toUpperCase();

  if (isLocalConnectivityProxyHost(host)) {
    return ` Destination ${destinationName} uses an OnPremise Connectivity proxy via ${host}:${reachablePort}. For local hybrid runs, start the Cloud Foundry SSH tunnel first and verify it with npm run srv:hybrid:check.`;
  }

  if (isInternalConnectivityProxyHost(host) && ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(errorCode)) {
    return ` Destination ${destinationName} uses the internal Cloud Foundry Connectivity proxy ${host}:${reachablePort}. That host is normally reachable only from Cloud Foundry or through a local SSH tunnel. For local hybrid runs, set CONNECTIVITY_PROXY_HOST=localhost and CONNECTIVITY_PROXY_PORT=${reachablePort}, then start the tunnel and verify it with npm run srv:hybrid:check.`;
  }

  return '';
}

async function verifyLocalConnectivityProxyReachability(proxyHost, proxyPort) {
  if (!proxyHost || !proxyPort || !isLocalConnectivityProxyHost(proxyHost)) return;

  await new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const cleanup = () => socket.removeAllListeners();

    socket.setTimeout(1500);
    socket.once('connect', () => {
      cleanup();
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      cleanup();
      socket.destroy();
      reject(new Error(
        `Local Connectivity proxy ${proxyHost}:${proxyPort} did not respond. Start the Cloud Foundry SSH tunnel first, or set CONNECTIVITY_PROXY_HOST and CONNECTIVITY_PROXY_PORT to a reachable proxy.`
      ));
    });
    socket.once('error', (error) => {
      cleanup();
      socket.destroy();
      reject(new Error(
        `Local Connectivity proxy ${proxyHost}:${proxyPort} is not reachable (${error.code || error.message}). Start the Cloud Foundry SSH tunnel first, or set CONNECTIVITY_PROXY_HOST and CONNECTIVITY_PROXY_PORT to a reachable proxy.`
      ));
    });

    socket.connect(proxyPort, proxyHost);
  });
}

// Multitenancy-critical: the subdomain swap yields a TENANT-scoped token, so
// destinations are read from the subscriber's consumer subaccount, not the
// provider's (PRA pattern; see docu/12-multitenancy-pra-alignment).
function tokenUrlForDestinationService(destination, subdomain) {
  const url = `${destination.url}/oauth/token?grant_type=client_credentials`;
  if (!subdomain) return url;
  return url.replace(/(^https:\/\/)([^.]+)(\..+$)/, `$1${subdomain}$3`);
}

async function destinationServiceToken(subdomain) {
  const destination = destinationService();
  return TokenUtils.getTokenWithClientCreds(
    tokenUrlForDestinationService(destination, subdomain),
    destination.clientid,
    destination.clientsecret
  );
}

async function connectivityToken(connectivity) {
  const tokenEndpoint = `${connectivity.url}/oauth/token?grant_type=client_credentials`;
  return TokenUtils.getTokenWithClientCreds(tokenEndpoint, connectivity.clientid, connectivity.clientsecret);
}

function readDestinationConfigurationProperty(configuration, ...propertyNames) {
  if (!configuration) return '';

  for (const propertyName of propertyNames) {
    if (configuration[propertyName] !== undefined && configuration[propertyName] !== null && configuration[propertyName] !== '') {
      return configuration[propertyName];
    }

    const matchingKey = Object.keys(configuration).find((key) => key.toLowerCase() === propertyName.toLowerCase());
    if (matchingKey && configuration[matchingKey] !== undefined && configuration[matchingKey] !== null && configuration[matchingKey] !== '') {
      return configuration[matchingKey];
    }
  }

  return '';
}

function cloudConnectorLocationId(configuration) {
  return String(readDestinationConfigurationProperty(
    configuration,
    'CloudConnectorLocationId',
    'cloudConnectorLocationId',
    'LocationId',
    'locationId'
  ) || '').trim();
}

function destinationRoutingIdentity(configuration = {}) {
  return {
    url: String(readDestinationConfigurationProperty(configuration, 'URL', 'url') || '').trim(),
    proxyType: String(readDestinationConfigurationProperty(configuration, 'ProxyType', 'proxyType') || '').trim().toLowerCase(),
    locationId: cloudConnectorLocationId(configuration)
  };
}

function sameDestinationRouting(left = {}, right = {}) {
  const a = destinationRoutingIdentity(left);
  const b = destinationRoutingIdentity(right);
  return a.url === b.url && a.proxyType === b.proxyType && a.locationId === b.locationId;
}

// Every callS4Destination resolves the destination first, and resolving costs
// two HTTP calls to the BTP destination service. Caching the in-flight promise
// also collapses concurrent resolves of the same destination into one.
const DESTINATION_CACHE_TTL_MS = Math.max(0, envNumber('DESTINATION_CACHE_TTL_MS', 300000));
const destinationCache = new Map();

async function resolveDestination(name, subdomain) {
  if (DESTINATION_CACHE_TTL_MS <= 0) return resolveDestinationLive(name, subdomain);

  const cacheKey = `${name || ''}::${subdomain || ''}`;
  const now = Date.now();
  const hit = destinationCache.get(cacheKey);
  if (hit && now - hit.at < DESTINATION_CACHE_TTL_MS) return hit.promise;

  const promise = resolveDestinationLive(name, subdomain).catch((error) => {
    destinationCache.delete(cacheKey);
    throw error;
  });
  destinationCache.set(cacheKey, { at: now, promise });

  if (destinationCache.size > 100) {
    for (const [key, entry] of destinationCache) {
      if (now - entry.at >= DESTINATION_CACHE_TTL_MS) destinationCache.delete(key);
    }
  }

  return promise;
}

async function resolveDestinationLive(name, subdomain) {
  const destination = destinationService();
  const token = await destinationServiceToken(subdomain);
  const destinationName = encodeURIComponent(name);
  const headers = { Authorization: `Bearer ${token}` };

  // Settings reads the BTP subaccount destination catalog. Resolve runtime routing
  // from that same source first so CloudConnectorLocationId cannot come from a
  // different destination scope with the same name.
  const subaccountResponse = await fetch(
    `${destination.uri}/destination-configuration/v1/subaccountDestinations/${destinationName}`,
    { headers }
  );

  const effectiveResponse = await fetch(
    `${destination.uri}/destination-configuration/v1/destinations/${destinationName}`,
    { headers }
  );

  if (subaccountResponse.ok) {
    const subaccountConfiguration = await subaccountResponse.json();

    if (effectiveResponse.ok) {
      const effective = await effectiveResponse.json();
      const effectiveConfiguration = effective.destinationConfiguration || {};

      if (sameDestinationRouting(subaccountConfiguration, effectiveConfiguration)) {
        return {
          ...effective,
          // The subaccount record remains authoritative for routing-sensitive
          // properties such as CloudConnectorLocationId, matching Settings.
          destinationConfiguration: {
            ...effectiveConfiguration,
            ...subaccountConfiguration
          }
        };
      }

      LOG.warn(
        `Destination ${name} resolves differently between subaccount and effective destination scopes. ` +
        `Using the subaccount routing shown in Settings. ` +
        `subaccount=${JSON.stringify(destinationRoutingIdentity(subaccountConfiguration))} ` +
        `effective=${JSON.stringify(destinationRoutingIdentity(effectiveConfiguration))}`
      );
    }

    return {
      destinationConfiguration: subaccountConfiguration,
      authTokens: []
    };
  }

  if (!effectiveResponse.ok) {
    const subaccountText = await subaccountResponse.text();
    const effectiveText = await effectiveResponse.text();
    throw new Error(
      `Destination ${name} could not be resolved: ` +
      `subaccountDestinations=${subaccountResponse.status} ${subaccountText}; ` +
      `destinations=${effectiveResponse.status} ${effectiveText}`
    );
  }

  return effectiveResponse.json();
}

async function listDestinations() {
  const destination = destinationService();
  const token = await destinationServiceToken();
  const response = await fetch(`${destination.uri}/destination-configuration/v1/subaccountDestinations`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const responseText = await response.text();
  let data = responseText;
  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = responseText;
    }
  }

  if (!response.ok) {
    throw new Error(`Could not list subaccount destinations: ${response.status} ${responseText}`);
  }

  return Array.isArray(data) ? data.map(redactDestination) : data;
}

// The destination service binding identifies the subaccount whose catalog
// the Settings page lists. Exposing subdomain/tenant/region (never secrets)
// lets admins confirm WHICH subaccount they are exposing systems from.
function getBtpAccountInfo() {
  let credentials;
  try {
    credentials = destinationService();
  } catch {
    return { Available: false, Subdomain: '', TenantId: '', Region: '' };
  }

  const uri = String(credentials?.uri || '');
  return {
    Available: true,
    Subdomain: String(credentials?.identityzone || ''),
    TenantId: String(credentials?.tenantid || ''),
    Region: uri.match(/cfapps\.([a-z0-9-]+)\./i)?.[1] || ''
  };
}

function redactDestination(destination) {
  const clone = { ...destination };
  for (const key of Object.keys(clone)) {
    if (/password|secret|clientSecret|passwd/i.test(key)) clone[key] = '***';
  }
  return clone;
}

function authorizationHeaders(resolvedDestination) {
  const authToken = resolvedDestination.authTokens?.find((token) => token.type === 'Bearer' || token.value);
  if (authToken?.value) {
    return {
      [authToken.http_header?.key || 'Authorization']: authToken.http_header?.value || `${authToken.type} ${authToken.value}`
    };
  }
  return {};
}

function basicHeaders(destinationConfiguration) {
  if (destinationConfiguration.Authentication !== 'BasicAuthentication') return {};
  if (!destinationConfiguration.User || !destinationConfiguration.Password) return {};
  const token = Buffer.from(`${destinationConfiguration.User}:${destinationConfiguration.Password}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

function destinationUrl(destinationConfiguration, path) {
  return new URL(path || '/', destinationConfiguration.URL).toString();
}

async function callS4Destination({ destinationName = DEFAULT_DESTINATION, path = '/', method = 'GET', body, headers: extraHeaders = {}, req, subdomain, timeoutMs = 20000, maxAttempts: maxAttemptsOverride, _noDirect = false, _noSessionRetry = false }) {
  if (shouldMockSap()) {
    return {
      mocked: true,
      destinationName,
      path,
      status: 200,
      ok: true,
      data: {
        message: 'S/4 calls are mocked (test profile or ADOPTOPS_MOCK_S4).',
        destinationName,
        path
      }
    };
  }

  const resolved = await resolveDestination(destinationName, subdomain);
  const config = resolved.destinationConfiguration || {};
  const locationId = cloudConnectorLocationId(config);

  // Direct transport: bypass the connectivity proxy when a base-URL override is
  // configured and the destination brings its own basic credentials. This keeps
  // production routing untouched while local development talks to a locally
  // reachable S/4 without the two intercontinental proxy hops.
  const directBaseUrl = !_noDirect && basicHeaders(config).Authorization
    ? directUrlOverrideFor(destinationName)
    : '';
  const useDirect = Boolean(directBaseUrl);
  const targetUrl = useDirect
    ? new URL(path || '/', `${directBaseUrl}/`).toString()
    : destinationUrl(config, path);
  const headers = {
    Accept: 'application/json',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...basicHeaders(config),
    ...authorizationHeaders(resolved),
    ...extraHeaders
  };

  const jarKey = cookieJarKey(destinationName, targetUrl);
  const jarHadCookies = Boolean(sessionCookieJar.get(jarKey)?.size);
  const mergedCookie = sessionCookieHeaderValue(jarKey, headers.Cookie || headers.cookie);
  delete headers.cookie;
  if (mergedCookie) headers.Cookie = mergedCookie;

  const axiosConfig = {
    method,
    url: targetUrl,
    headers,
    data: body || undefined,
    timeout: Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Number(timeoutMs)) : 20000,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [(data) => data]
  };

  const isOnPremise = !useDirect && config.ProxyType === 'OnPremise';

  if (isOnPremise) {
    const connectivity = connectivityService();
    if (!connectivity) {
      throw new Error(`Destination ${destinationName} is OnPremise, but no Connectivity service is bound to this app.`);
    }

    const proxyToken = await connectivityToken(connectivity);
    const proxyConfig = connectivityProxyConfig(connectivity);
    await verifyLocalConnectivityProxyReachability(proxyConfig.host, proxyConfig.port);
    axiosConfig.proxy = {
      protocol: 'http',
      host: proxyConfig.host,
      port: proxyConfig.port
    };
    const keepAlive = onPremiseKeepAliveEnabled(proxyConfig.host);
    axiosConfig.headers = {
      ...headers,
      Connection: keepAlive ? 'keep-alive' : 'close',
      'Proxy-Connection': keepAlive ? 'keep-alive' : 'close',
      'Proxy-Authorization': `Bearer ${proxyToken}`,
      ...(locationId ? { 'SAP-Connectivity-SCC-Location_ID': locationId } : {})
    };
  }

  if (useDirect) {
    const agent = directAgentFor(directBaseUrl);
    if (/^https:/i.test(directBaseUrl)) axiosConfig.httpsAgent = agent;
    else axiosConfig.httpAgent = agent;
  }

  const requestedAttempts = Number(maxAttemptsOverride);
  const maxAttempts = Number.isFinite(requestedAttempts) && requestedAttempts > 0
    ? Math.floor(requestedAttempts)
    : isOnPremise ? 3 : 1;

  const executeRequest = async () => {
    let response;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (isOnPremise && new URL(targetUrl).protocol === 'http:') {
          response = await nativeOnPremiseHttpRequest({
            targetUrl,
            proxyHost: axiosConfig.proxy.host,
            proxyPort: axiosConfig.proxy.port,
            method,
            headers: axiosConfig.headers,
            body,
            timeoutMs: axiosConfig.timeout,
            agentKey: `${axiosConfig.proxy.host}:${axiosConfig.proxy.port}::${locationId || ''}::${destinationName}`
          });
        } else {
          // Direct transport, Internet destinations and the uncommon HTTPS
          // OnPremise case use Axios. For OnPremise HTTPS, agent:false prevents
          // use of Node's global pooled agents.
          const attemptConfig = isOnPremise
            ? { ...axiosConfig, httpAgent: false, httpsAgent: false }
            : axiosConfig;
          response = await axios(attemptConfig);
        }

        if (isOnPremise && attempt < maxAttempts && isTransientOnPremiseResponse(response)) {
          await wait(150 * attempt);
          continue;
        }
        return response;
      } catch (error) {
        if (isOnPremise && attempt < maxAttempts && isTransientOnPremiseError(error)) {
          await wait(150 * attempt);
          continue;
        }

        if (useDirect && isConnectionLevelError(error)) {
          error.directOverrideFailed = true;
          throw error;
        }

        const details = {
          destinationName,
          path,
          targetHost: (() => {
            try {
              return new URL(targetUrl).host;
            } catch {
              return undefined;
            }
          })(),
          proxyType: useDirect ? 'DirectOverride' : config.ProxyType || 'Internet',
          proxyHost: axiosConfig.proxy?.host,
          proxyPort: axiosConfig.proxy?.port,
          cloudConnectorLocationId: locationId || '(empty)',
          status: error.response?.status,
          statusText: error.response?.statusText,
          code: error.code,
          message: error.message,
          data: safeResponseData(error.response?.data)
        };
        const detailText = JSON.stringify(details, null, 2);
        const hint = connectivityProxyTroubleshootingHint({
          proxyHost: axiosConfig.proxy?.host,
          proxyPort: axiosConfig.proxy?.port,
          destinationName,
          code: error.code
        });
        const diagnostic = new Error(`S/4 destination call failed: ${detailText}${hint}`);
        diagnostic.status = error.response?.status || 502;
        throw diagnostic;
      }
    }

    return response;
  };

  const transport = useDirect ? 'direct' : isOnPremise ? 'proxy' : 'internet';
  const startedAt = Date.now();
  let response;

  try {
    if (useDirect) {
      response = await limitRequestConcurrency(`direct::${destinationName}`, DIRECT_CONCURRENCY, executeRequest);
    } else if (isOnPremise) {
      const proxyLimit = isLocalConnectivityProxyHost(axiosConfig.proxy?.host) ? 1 : ONPREM_CONCURRENCY;
      response = await limitRequestConcurrency(`${locationId || ''}::${destinationName}`, proxyLimit, executeRequest);
    } else {
      response = await executeRequest();
    }
  } catch (error) {
    if (useDirect && error.directOverrideFailed) {
      parkDirectOverride(destinationName, error.code || error.message);
      return callS4Destination({
        destinationName,
        path,
        method,
        body,
        headers: extraHeaders,
        req,
        subdomain,
        timeoutMs,
        maxAttempts: maxAttemptsOverride,
        _noDirect: true
      });
    }
    logS4Timing({ method, destinationName, transport, path, status: 'ERR', ms: Date.now() - startedAt, attempts: maxAttempts });
    throw error;
  }

  logS4Timing({ method, destinationName, transport, path, status: response.status, ms: Date.now() - startedAt, attempts: 1 });

  storeSessionCookies(jarKey, responseHeader(response.headers, 'set-cookie'));

  // A 401 with a replayed session cookie means the SAP security session
  // expired. Clear the jar and retry once so basic authentication establishes
  // a fresh session transparently.
  if (response.status === 401 && jarHadCookies && !_noSessionRetry) {
    sessionCookieJar.delete(jarKey);
    return callS4Destination({
      destinationName,
      path,
      method,
      body,
      headers: extraHeaders,
      req,
      subdomain,
      timeoutMs,
      maxAttempts: maxAttemptsOverride,
      _noDirect,
      _noSessionRetry: true
    });
  }

  let data = response.data;
  if (typeof data === 'string' && data) {
    try {
      data = JSON.parse(data);
    } catch {
      // Keep non-JSON responses as text, for example metadata XML or HTML error pages.
    }
  }

  return {
    mocked: false,
    destinationName,
    path,
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    headers: response.headers || {},
    data
  };
}

function responseHeader(headers, name) {
  if (!headers || !name) return '';
  const lowerName = String(name).toLowerCase();
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(lowerName) || '';
  return headers[name] || headers[lowerName] || '';
}

function cookieHeaderFromSetCookie(setCookie) {
  if (!setCookie) return '';

  const cookieLines = Array.isArray(setCookie)
    ? setCookie
    : String(setCookie).split(/,(?=\s*[^;,=]+=[^;,]+)/g);

  return cookieLines
    .map((cookie) => String(cookie || '').split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function uniqueList(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

// Generic service-root derivation: strip the query, then the last path
// segment (entity set, $metadata, action). '/…/0001/TransactionUsage' ->
// '/…/0001/'.
function serviceRootFromPath(path) {
  const cleanPath = String(path || '').split('?')[0].replace(/\/?$/, '');
  const slashIndex = cleanPath.lastIndexOf('/');
  return slashIndex >= 0 ? `${cleanPath.slice(0, slashIndex)}/` : '/';
}

async function fetchCsrfToken({ destinationName, path, req, forceRefresh = false }) {
  if (CSRF_CACHE_TTL_MS <= 0) return fetchCsrfTokenLive({ destinationName, path, req });

  const cacheKey = csrfCacheKey(destinationName, path);
  const now = Date.now();

  if (!forceRefresh) {
    const cached = csrfCache.get(cacheKey);
    if (cached && now - cached.at < CSRF_CACHE_TTL_MS) return cached.promise;
  }

  // The in-flight promise is cached so concurrent writes share ONE token fetch
  // chain instead of each paying their own service-root/$metadata probes.
  const promise = fetchCsrfTokenLive({ destinationName, path, req }).then((result) => {
    if (!result.token) csrfCache.delete(cacheKey);
    return result;
  }, (error) => {
    csrfCache.delete(cacheKey);
    throw error;
  });
  csrfCache.set(cacheKey, { at: now, promise });
  return promise;
}

async function fetchCsrfTokenLive({ destinationName, path, req }) {
  const serviceRoot = serviceRootFromPath(path);
  const candidates = uniqueList([
    serviceRoot,
    `${serviceRoot}$metadata`,
    addODataTop(path, 1)
  ]);

  const attempts = [];
  let cookie = '';

  for (const csrfPath of candidates) {
    const csrfResponse = await callS4Destination({
      destinationName,
      path: csrfPath,
      method: 'GET',
      headers: {
        Accept: 'application/json,application/xml,text/plain,*/*',
        'X-CSRF-Token': 'Fetch',
        ...(cookie ? { Cookie: cookie } : {})
      },
      req
    });

    const responseToken = responseHeader(csrfResponse.headers, 'x-csrf-token');
    const responseCookie = cookieHeaderFromSetCookie(responseHeader(csrfResponse.headers, 'set-cookie'));

    if (responseCookie) {
      cookie = cookie ? `${cookie}; ${responseCookie}` : responseCookie;
    }

    attempts.push({
      path: csrfPath,
      status: csrfResponse.status,
      token: responseToken ? 'yes' : 'no',
      cookie: cookie ? 'yes' : 'no'
    });

    if (responseToken) {
      return {
        token: responseToken,
        cookie,
        status: csrfResponse.status,
        path: csrfPath,
        attempts
      };
    }
  }

  return {
    token: '',
    cookie,
    status: attempts.at(-1)?.status,
    path: attempts.at(-1)?.path || path,
    attempts
  };
}

function safeResponseData(data) {
  if (!data) return data;
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return text
    .replace(/(password|clientsecret|authorization|proxy-authorization)(["'\s:=]+)[^"',\s}]+/ig, '$1$2***')
    .slice(0, 2000);
}

function unwrapODataPayload(data) {
  if (Array.isArray(data?.value)) return data.value;
  if (Array.isArray(data?.d?.results)) return data.d.results;
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

function appendQuery(path, params) {
  const entries = Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!entries.length) return path;

  const separator = path.includes('?') ? '&' : '?';
  const query = entries
    .map(([key, value]) => {
      const queryKey = String(key || '').startsWith('$') ? String(key) : encodeURIComponent(key);
      return `${queryKey}=${encodeURIComponent(value)}`;
    })
    .join('&');

  return `${path}${separator}${query}`;
}

function escapeODataString(value) {
  return String(value || '').replace(/'/g, "''");
}

function hasQueryOption(path, optionName) {
  const pattern = new RegExp(`[?&](?:\\$${optionName}|%24${optionName}|${optionName})=`, 'i');
  return pattern.test(path);
}

function addODataTop(path, top = 50) {
  if (hasQueryOption(path, 'top')) return path;
  return appendQuery(path, { '$top': top });
}

function setODataQueryOption(path, optionName, value) {
  const text = String(path || '').trim();
  if (!text) return text;

  const hashIndex = text.indexOf('#');
  const hash = hashIndex >= 0 ? text.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  const queryIndex = withoutHash.indexOf('?');
  const basePath = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const existingQuery = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '';
  const normalizedOption = String(optionName || '').replace(/^\$/, '');
  const params = new URLSearchParams(existingQuery);

  [normalizedOption, `$${normalizedOption}`].forEach((key) => params.delete(key));
  params.set(`$${normalizedOption}`, String(value));

  const query = Array.from(params.entries())
    .map(([key, entryValue]) => {
      const queryKey = key.startsWith('$') ? key : encodeURIComponent(key);
      return `${queryKey}=${encodeURIComponent(entryValue)}`;
    })
    .join('&');

  return `${basePath}${query ? `?${query}` : ''}${hash}`;
}

function parseActionMetadata(metadataText) {
  const text = typeof metadataText === 'string' ? metadataText : JSON.stringify(metadataText || '');
  const schemaMatch = text.match(/<Schema\b[^>]*\bNamespace="([^"]+)"/i);
  const boundActions = new Set();
  const actionPattern = /<Action\b[^>]*\bName="([^"]+)"[^>]*\bIsBound="true"/gi;
  let match;
  while ((match = actionPattern.exec(text)) !== null) boundActions.add(match[1]);
  return { namespace: schemaMatch?.[1] || '', boundActions };
}

// SAP re-authenticates every request that arrives without a security-session
// cookie, and on some systems that logon costs seconds. The jar replays the
// SAP_SESSIONID (and friends) per destination+origin so only the first request
// pays the logon; a 401 clears the jar and the call retries once with fresh
// basic authentication.
const sessionCookieJar = new Map();

function cookieJarKey(destinationName, targetUrl) {
  try {
    return `${destinationName}::${new URL(targetUrl).origin}`;
  } catch {
    return String(destinationName || '');
  }
}

function storeSessionCookies(jarKey, setCookieHeader) {
  if (!setCookieHeader) return;
  const lines = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : String(setCookieHeader).split(/,(?=\s*[^;,=]+=[^;,]+)/g);

  let jar = sessionCookieJar.get(jarKey);
  if (!jar) {
    jar = new Map();
    sessionCookieJar.set(jarKey, jar);
  }

  for (const line of lines) {
    const pair = String(line || '').split(';')[0].trim();
    const equalsIndex = pair.indexOf('=');
    if (equalsIndex <= 0) continue;
    const name = pair.slice(0, equalsIndex).trim();
    const value = pair.slice(equalsIndex + 1).trim();
    if (!value) jar.delete(name);
    else jar.set(name, `${name}=${value}`);
  }
}

function sessionCookieHeaderValue(jarKey, callerCookie = '') {
  const jar = sessionCookieJar.get(jarKey);
  const jarCookies = jar ? [...jar.values()] : [];
  const callerCookies = String(callerCookie || '').split(';').map((cookie) => cookie.trim()).filter(Boolean);
  const callerNames = new Set(callerCookies.map((cookie) => cookie.split('=')[0].trim()));
  return [...callerCookies, ...jarCookies.filter((cookie) => !callerNames.has(cookie.split('=')[0].trim()))].join('; ');
}

// The service schema namespace and its bound actions are static per service
// version, so $metadata is read once per destination+service root instead of
// once per action invocation.
async function boundActionNameCandidates({ destinationName, servicePath, actionName, req }) {
  const serviceRoot = serviceRootFromPath(servicePath);
  const metadataCacheKey = `${destinationName}::${serviceRoot}`;
  const cached = actionMetadataCache.get(metadataCacheKey);
  let parsed = cached && Date.now() - cached.at < ACTION_METADATA_TTL_MS ? cached.parsed : null;

  if (!parsed) {
    const metadataPath = `${serviceRoot}$metadata`;
    try {
      const metadata = await callS4Destination({
        destinationName,
        path: metadataPath,
        method: 'GET',
        headers: { Accept: 'application/xml, text/xml, application/json' },
        req
      });

      parsed = parseActionMetadata(metadata.data);
      if (parsed.namespace) actionMetadataCache.set(metadataCacheKey, { at: Date.now(), parsed });
    } catch (error) {
      LOG.warn(`Could not read S/4 metadata at ${metadataPath}; trying unqualified action ${actionName}. ${error.message}`);
      return [actionName];
    }
  }

  const candidates = [];
  if (parsed.namespace && parsed.boundActions.has(actionName)) {
    candidates.push(`${parsed.namespace}.${actionName}`);
  }
  candidates.push(actionName);
  return Array.from(new Set(candidates));
}

module.exports = {
  DEFAULT_DESTINATION,
  DEFAULT_S4_SERVICE_ROOT,
  addODataTop,
  appendQuery,
  authorizationHeaders,
  basicHeaders,
  boundActionNameCandidates,
  cachedRead,
  callS4Destination,
  cloudConnectorLocationId,
  connectivityProxyTroubleshootingHint,
  connectivityService,
  destinationRoutingIdentity,
  effectiveConnectivityProxyDetails,
  escapeODataString,
  fetchCsrfToken,
  getBtpAccountInfo,
  invalidateCsrfToken,
  isCsrfRejectedResponse,
  limitRequestConcurrency,
  listDestinations,
  preferRememberedShape,
  readDestinationConfigurationProperty,
  redactDestination,
  rememberShape,
  resolveDestination,
  responseHeader,
  safeResponseData,
  serviceRootFromPath,
  setODataQueryOption,
  shouldMockSap,
  uniqueList,
  unwrapODataPayload
};
