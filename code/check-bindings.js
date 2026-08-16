const xsenv = require("@sap/xsenv");
const cds = require('@sap/cds');
const net = require('node:net');

function resolveProxyHost(connectivity) {
  return process.env.CONNECTIVITY_PROXY_HOST ||
    process.env.ADOPTOPS_CONNECTIVITY_PROXY_HOST ||
    connectivity.onpremise_proxy_host;
}

function resolveProxyPort(connectivity) {
  const value = process.env.CONNECTIVITY_PROXY_PORT ||
    process.env.CONNECTIVITY_PROXY_HTTP_PORT ||
    process.env.ADOPTOPS_CONNECTIVITY_PROXY_PORT ||
    connectivity.onpremise_proxy_http_port;
  const port = Number(value);
  return Number.isFinite(port) ? port : null;
}

function probeTcp(host, port, timeoutMs = 1500) {
  if (!host || !port) return Promise.resolve({ reachable: false, reason: 'missing host or port' });

  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ reachable: true }));
    socket.once('timeout', () => finish({ reachable: false, reason: 'timeout' }));
    socket.once('error', (error) => finish({ reachable: false, reason: error.code || error.message }));
    socket.connect(port, host);
  });
}

async function probeDatabase() {
  try {
    const db = await cds.connect.to('db');
    await db.run('SELECT 1 AS ok');
    return { reachable: true };
  } catch (error) {
    return {
      reachable: false,
      reason: error.code || error.message
    };
  }
}

async function main() {
  const s = xsenv.getServices({
  destination: { tag: "destination" },
  connectivity: { tag: "connectivity" },
  xsuaa: { tag: "xsuaa" }
  });

  const effectiveProxyHost = resolveProxyHost(s.connectivity);
  const effectiveProxyPort = resolveProxyPort(s.connectivity);
  const [proxyReachability, databaseReachability] = await Promise.all([
    probeTcp(effectiveProxyHost, effectiveProxyPort),
    probeDatabase()
  ]);

  console.log(JSON.stringify({
    destinationUri: s.destination.uri,
    connectivityProxyHost: s.connectivity.onpremise_proxy_host,
    connectivityProxyHttpPort: s.connectivity.onpremise_proxy_http_port,
    connectivityProxyHttpsPort: s.connectivity.onpremise_proxy_https_port,
    effectiveConnectivityProxyHost: effectiveProxyHost,
    effectiveConnectivityProxyPort: effectiveProxyPort,
    effectiveConnectivityProxyReachable: proxyReachability.reachable,
    effectiveConnectivityProxyReason: proxyReachability.reason || null,
    databaseReachable: databaseReachability.reachable,
    databaseReason: databaseReachability.reason || null,
    xsuaaUrl: s.xsuaa.url
  }, null, 2));

  if (!proxyReachability.reachable && ['localhost', '127.0.0.1', '::1'].includes(String(effectiveProxyHost || '').toLowerCase())) {
    console.error('\nLocal connectivity proxy is not reachable. Start the CF SSH tunnel before running CAP hybrid against an OnPremise destination.');
    process.exitCode = 2;
  }

  if (!databaseReachability.reachable) {
    console.error('\nThe bound PostgreSQL database is not reachable. Check the service instance/network, or run `npm run srv:hybrid:sqlite` to keep the cloud SAP bindings with local persistence.');
    process.exitCode = 3;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
