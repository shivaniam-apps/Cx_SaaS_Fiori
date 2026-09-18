const cds = require('@sap/cds');
const express = require('express');
const { currentTier } = require('./utils/tier.js');
const { recordSubscription, recordUnsubscription, saasDependencies, tenantUrl } = require('./utils/subscription-lifecycle.js');

const LOG = cds.log('basic-subscription');

// The SaaS registry calls the callbacks with a token that carries the
// mtcallback scope (xs-security.json grants it to sap-provisioning). Plain
// express routes sit outside CAP's per-service authentication, so the
// callbacks authenticate through the same strategy and refuse every caller
// without that scope (T6 security review).
function requireSaasCallbackScope(req, res, next) {
  const user = req.user || cds.context?.user;
  if (user && typeof user.is === 'function' && user.is('mtcallback')) return next();
  LOG.warn(`SaaS callback ${req.method} ${req.path} refused: caller ${user?.id || 'anonymous'} lacks the mtcallback scope.`);
  return res.status(403).json({ error: { code: '403', message: 'The SaaS provisioning callbacks require the mtcallback scope.' } });
}

function failure(res, error, fallback) {
  const status = Number(error?.status) || 500;
  LOG.error(`${fallback}: ${error?.message || error}`);
  return res.status(status).json({ error: { code: String(status), message: error?.message || fallback } });
}

// Subscription lifecycle (T2) for the shared-database tiers (basic and
// standard share one PostgreSQL and one registry entry): SAP SaaS
// Provisioning without CAP MTX tenant database deployment, Service Manager
// or HANA. The URL path keeps its historical /-/basic prefix because the
// saas-registry appUrls in mta.yaml point at it.
function registerBasicSubscriptionRoutes(app) {
  // context() opens the request scope auth() writes the user into; without
  // it the auth middleware has nowhere to put req.user and the request hangs.
  // Plain express routes get no body parser from CAP: without express.json()
  // the registry's { subscribedSubdomain } payload arrives as undefined.
  app.use('/-/basic/saas-provisioning', express.json({ limit: '64kb' }), cds.middlewares.context(), cds.middlewares.auth(), requireSaasCallbackScope);

  app.put('/-/basic/saas-provisioning/tenant/:tenantId', async (req, res) => {
    const tenantId = req.params.tenantId;
    const subdomain = req.body?.subscribedSubdomain || req.body?.subdomain;
    const plan = req.body?.subscriptionParams?.plan || req.body?.plan || '';
    LOG.info(`SaaS subscription received for tenant ${tenantId}, subdomain ${subdomain || '<unknown>'}, tier ${currentTier()}.`);
    try {
      const result = await recordSubscription({ tenantId, subdomain, plan });
      // The registry expects the tenant URL as the plain response body.
      return res.status(200).send(result.tenantUrl || tenantUrl(subdomain));
    } catch (error) {
      return failure(res, error, 'Subscription could not be recorded');
    }
  });

  app.delete('/-/basic/saas-provisioning/tenant/:tenantId', async (req, res) => {
    const tenantId = req.params.tenantId;
    const subdomain = req.body?.subscribedSubdomain || req.body?.subdomain;
    LOG.info(`SaaS unsubscription received for tenant ${tenantId}, subdomain ${subdomain || '<unknown>'}, tier ${currentTier()}.`);
    try {
      await recordUnsubscription({ tenantId, subdomain });
      return res.status(200).send(tenantId);
    } catch (error) {
      return failure(res, error, 'Unsubscription could not be recorded');
    }
  });

  app.get('/-/basic/saas-provisioning/dependencies', async (_req, res) => {
    const dependencies = saasDependencies();
    LOG.debug(`SaaS dependencies: ${JSON.stringify(dependencies)}`);
    return res.status(200).json(dependencies);
  });
}

module.exports = { registerBasicSubscriptionRoutes, requireSaasCallbackScope };
