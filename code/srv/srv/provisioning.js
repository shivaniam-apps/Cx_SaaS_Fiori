const cds = require('@sap/cds');
const xsenv = require('@sap/xsenv');
const AlertNotification = require('./utils/alert-notification.js');
const { isTenantAutomationEnabled, currentTier } = require('./utils/tier.js');
const Logger = cds.log('provisioning')
class Provisioning {    
    service = (service) => {
        service.on('UPDATE', 'tenant', async (req, next) => {
            Logger.log('Subscription Data: ', JSON.stringify(req.data));
            const { 
                subscribedSubdomain: subdomain, 
                subscribedTenantId : tenant, 
                subscriptionParams : params = {}
            }  = req.data;
    
            const { custSubdomain: custdomain = null } = params;
            const tenantURL = this.getTenantUrl(subdomain, custdomain);
            await next();
            if (isTenantAutomationEnabled()) {
                const { runWorkflow } = require('./utils/tenant-automator.js');
                await runWorkflow(tenant, subdomain, "provisioning");
            } else {
                Logger.log(`Skipping tenant automation for tier ${currentTier()}.`);
            }
            return tenantURL;
        });
    
        service.on('DELETE', 'tenant', async (req, next) => {
            Logger.log('Unsubscribe Data: ', JSON.stringify(req.data));
            const { subscribedSubdomain: subdomain, subscribedTenantId : tenant }  = req.data;
            await next();
            if (isTenantAutomationEnabled()) {
                const { runWorkflow } = require('./utils/tenant-automator.js');
                await runWorkflow(tenant, subdomain, "deprovisioning");
            } else {
                Logger.log(`Skipping tenant deprovisioning automation for tier ${currentTier()}.`);
            }
            return tenant;
        });
    
    
        service.on('upgradeTenant', async (req, next) => {
            await next();
            const { instanceData, deploymentOptions } = cds.context.req.body;
            Logger.log('UpgradeTenant: ', req.data.subscribedTenantId, req.data.subscribedSubdomain, instanceData, deploymentOptions);
        });
    
    
        service.on('dependencies', async (_, next) => {
            let dependencies = await next();
            const services = xsenv.getServices({
                html5Runtime: { tag: 'html5-apps-repo-rt' },
                destination: { tag: 'destination' }
            });
    
            dependencies.push({ xsappname: services.html5Runtime.uaa.xsappname });
            dependencies.push({ xsappname: services.destination.xsappname });
            
            Logger.debug("SaaS Dependencies:", JSON.stringify(dependencies));
            return dependencies;
        });
    }
}

class CloudFoundry extends Provisioning {
    getTenantUrl(subdomain){
        return `https://${subdomain}${process.env.tenantSeparator}${process.env.appDomain}`;
    }
}


module.exports = CloudFoundry;
