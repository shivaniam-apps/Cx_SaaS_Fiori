const cds = require('@sap/cds');
const { isDatabaseLess, currentTier } = require('./utils/tier.js');
const { registerFeedbackTelemetryHandlers } = require('./utils/feedback-telemetry-handlers.js');
const { registerAccessRequestPublicHandlers } = require('./utils/access-request-handlers.js');

// Database-less tiers keep telemetry ingestion in memory (moved here with the
// handlers from PublicService). Only the ingestion handlers write these;
// AdminService reads degrade independently on those tiers.
const inMemory = {
    PilotFeedback: new Map(),
    ClientErrorReports: new Map(),
    UsageEvents: new Map(),
    PerformanceEvents: new Map()
};

module.exports = cds.service.impl(function () {
    // Feedback/crash/usage ingestion exists in every tier and handles the
    // database-less fallback internally via the shared in-memory maps.
    registerFeedbackTelemetryHandlers(this, { inMemory });
    // Access requests degrade internally on database-less tiers (submit
    // rejects 501, getMyAccessRequests returns an empty list).
    registerAccessRequestPublicHandlers(this);

    // Both tier variants moved verbatim from PublicService: the database-less
    // shape reports dbMode 'none' and omits the profile fields the full shape
    // derives from the auth token.
    this.on('userInfo', (req) => {
        if (isDatabaseLess()) {
            return {
                user: req.user.id,
                tenant: req.user.tenant,
                tier: currentTier(),
                dbMode: 'none',
                scopes: {
                    identified: req.user.is('identified-user'),
                    authenticated: req.user.is('authenticated-user'),
                    Member: req.user.is('Member'),
                    Approver: req.user.is('Approver'),
                    Activator: req.user.is('Activator'),
                    Admin: req.user.is('Admin')
                }
            };
        }

        let results = {};
        results.user = req.user.id;
        let username = req.req?.authInfo?.getGivenName?.();
        if (req.user.hasOwnProperty('locale')) {
            results.locale = req.user.locale;
        }
        if (username) {
            results.givenName = username;
        }
        results.tier = currentTier();
        results.scopes = {};
        results.scopes.identified = req.user.is('identified-user');
        results.scopes.authenticated = req.user.is('authenticated-user');
        results.scopes.Member = req.user.is('Member');
        results.scopes.Approver = req.user.is('Approver');
        results.scopes.Activator = req.user.is('Activator');
        results.scopes.Admin = req.user.is('Admin');
        results.tenant = req.user.tenant;
        results.scopes.ExtendCDS = req.user.is('ExtendCDS');
        results.scopes.ExtendCDSdelete = req.user.is('ExtendCDSdelete');
        return results;
    });
});
