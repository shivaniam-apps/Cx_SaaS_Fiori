// S/4 transport layer.
//
// Phase 1 replaces this file with the verbatim lift of the transport half of
// ChronoPilot's s4-job-adapter.js (destination resolution, connectivity
// proxy, keep-alive agents keyed by location id, cookie jar, CSRF cache,
// callS4Destination). Until then only the startup diagnostics that server.js
// needs live here, matching the original's behaviour and env overrides.
const xsenv = require('@sap/xsenv');

function connectivityService() {
    try {
        return xsenv.getServices({ connectivity: { tag: 'connectivity' } }).connectivity;
    } catch {
        return null;
    }
}

// Env overrides first (hybrid runs tunnel the proxy to localhost), then the
// bound connectivity service credentials.
function effectiveConnectivityProxyDetails() {
    const service = connectivityService();
    const rawHost = service?.onpremise_proxy_host || '';
    const rawHttpPort = service?.onpremise_proxy_http_port || service?.onpremise_proxy_port || '';
    const host = process.env.CONNECTIVITY_PROXY_HOST || rawHost;
    const port = process.env.CONNECTIVITY_PROXY_PORT || rawHttpPort;
    return {
        bound: Boolean(service) || Boolean(process.env.CONNECTIVITY_PROXY_HOST),
        host,
        port,
        rawHost,
        rawHttpPort
    };
}

module.exports = { effectiveConnectivityProxyDetails, connectivityService };
