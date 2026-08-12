const xsenv = require('@sap/xsenv');
const cds = require('@sap/cds');
const { currentTier } = require('./utils/tier.js');

const LOG = cds.log('basic-subscription');

function tenantUrl(subdomain) {
  const separator = process.env.tenantSeparator || '-';
  const appDomain = process.env.appDomain;
  if (!subdomain || !appDomain) return process.env.approuterUrl || '';
  return `https://${subdomain}${separator}${appDomain}`;
}

function readDependencyXsappnames() {
  const dependencies = [];
  try {
    const services = xsenv.getServices({
      html5Runtime: { tag: 'html5-apps-repo-rt' },
      destination: { tag: 'destination' }
    });

    if (services.html5Runtime?.uaa?.xsappname) {
      dependencies.push({ xsappname: services.html5Runtime.uaa.xsappname });
    }
    if (services.destination?.xsappname) {
      dependencies.push({ xsappname: services.destination.xsappname });
    }
  } catch (error) {
    LOG.warn(`Could not resolve optional SaaS dependencies: ${error.message}`);
  }
  return dependencies;
}

function registerBasicSubscriptionRoutes(app) {
  // These lightweight callbacks allow the Basic tier to be subscribed via SAP SaaS Provisioning
  // without activating CAP MTX tenant database deployment, Service Manager, HANA, or PostgreSQL.
  app.put('/-/basic/saas-provisioning/tenant/:tenantId', async (req, res) => {
    const tenantId = req.params.tenantId;
    const subdomain = req.body?.subscribedSubdomain || req.body?.subdomain;
    LOG.info(`Basic SaaS subscription received for tenant ${tenantId}, subdomain ${subdomain || '<unknown>'}, tier ${currentTier()}.`);
    return res.status(200).send(tenantUrl(subdomain));
  });

  app.delete('/-/basic/saas-provisioning/tenant/:tenantId', async (req, res) => {
    const tenantId = req.params.tenantId;
    const subdomain = req.body?.subscribedSubdomain || req.body?.subdomain;
    LOG.info(`Basic SaaS unsubscription received for tenant ${tenantId}, subdomain ${subdomain || '<unknown>'}, tier ${currentTier()}.`);
    return res.status(200).send(tenantId);
  });

  app.get('/-/basic/saas-provisioning/dependencies', async (_req, res) => {
    const dependencies = readDependencyXsappnames();
    LOG.debug(`Basic SaaS dependencies: ${JSON.stringify(dependencies)}`);
    return res.status(200).json(dependencies);
  });
}

module.exports = { registerBasicSubscriptionRoutes };
