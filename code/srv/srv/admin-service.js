const cds = require("@sap/cds")
const UserManagement = require("./utils/user-management.js");
const Logger = cds.log('admin-service');
const { isDatabaseLess, currentTier } = require('./utils/tier.js');
const { registerTelemetryAdminHandlers } = require('./utils/telemetry-admin-handlers.js');
const { registerAccessRequestAdminHandlers } = require('./utils/access-request-handlers.js');
const { registerTenantScope } = require('./utils/tenant-scope.js');

module.exports = cds.service.impl(async function () {
    const { Users } = this.entities;

    registerTenantScope(this);

    // Before the database-less early return so the actions exist in every
    // tier; each handler degrades internally when persistence is absent.
    registerTelemetryAdminHandlers(this);
    registerAccessRequestAdminHandlers(this);

    // --- Connectivity (Phase 1 wires these to s4-http-client.js) ----------
    // Kept as explicit 501s so the frontend contract exists from day one and
    // the Settings page can render its states.
    for (const action of ['listBtpDestinations', 'getBtpAccountInfo', 'testS4Destination', 'checkTargetSystemConnection']) {
        this.on(action, (req) => req.reject(501, `${action} arrives with the Phase 1 S/4 transport lift.`));
    }

    // --- Overlay curation --------------------------------------------------
    this.on('upsertOverlayMapping', async (req) => {
        const d = req.data;
        const mappingKey = d.mappingKey || `${d.transactionCode}::${d.fioriId}`;
        const existing = await SELECT.one.from('adops.db.AppMappingOverlay').where({ MappingKey: mappingKey, Origin: 'CUSTOMER' });
        const row = {
            MappingKey: mappingKey,
            Origin: 'CUSTOMER',
            TransactionCode: d.transactionCode,
            FioriId: d.fioriId,
            AppTitle: d.appTitle,
            MappingType: d.mappingType,
            CoveragePercent: d.coveragePercent,
            LineOfBusiness: d.lineOfBusiness,
            Persona: d.persona,
            ValueRationale: d.valueRationale,
            Active: true,
            Suppressed: false
        };
        if (existing) {
            await UPDATE('adops.db.AppMappingOverlay').set(row).where({ ID: existing.ID });
            return SELECT.one.from('adops.db.AppMappingOverlay').where({ ID: existing.ID });
        }
        row.Revision = 1;
        const inserted = await INSERT.into('adops.db.AppMappingOverlay').entries(row);
        const key = inserted?.results?.[0]?.values?.[0] || row.ID;
        return SELECT.one.from('adops.db.AppMappingOverlay').where({ MappingKey: mappingKey, Origin: 'CUSTOMER' });
    });

    this.on('suppressOverlayMapping', async (req) => {
        const { ID, reason } = req.data;
        const row = await SELECT.one.from('adops.db.AppMappingOverlay').where({ ID });
        if (!row) return req.reject(404, 'Overlay mapping not found.');
        await UPDATE('adops.db.AppMappingOverlay')
            .set({ Suppressed: true, SuppressReason: reason || '' })
            .where({ ID });
        return SELECT.one.from('adops.db.AppMappingOverlay').where({ ID });
    });

    // --- Retention ----------------------------------------------------------
    this.on('purgeExtractionRun', async (req) => {
        const { runId } = req.data;
        const run = await SELECT.one.from('adops.db.ExtractionRuns').where({ ID: runId });
        if (!run) return req.reject(404, 'Extraction run not found.');
        const snapshots = await SELECT.from('adops.db.UsageSnapshots').columns('ID').where({ extractionRun_ID: runId });
        const snapshotIds = snapshots.map((s) => s.ID);
        let transactionsDeleted = 0;
        let userUsageDeleted = 0;
        if (snapshotIds.length) {
            transactionsDeleted = await DELETE.from('adops.db.TransactionUsage').where({ snapshot_ID: { in: snapshotIds } });
            userUsageDeleted = await DELETE.from('adops.db.UserTransactionUsage').where({ snapshot_ID: { in: snapshotIds } });
            await DELETE.from('adops.db.FioriUsage').where({ snapshot_ID: { in: snapshotIds } });
        }
        const snapshotsDeleted = await DELETE.from('adops.db.UsageSnapshots').where({ extractionRun_ID: runId });
        await DELETE.from('adops.db.ExtractionRuns').where({ ID: runId });
        return {
            snapshotsDeleted: Number(snapshotsDeleted) || snapshotIds.length,
            transactionsDeleted: Number(transactionsDeleted) || 0,
            userUsageDeleted: Number(userUsageDeleted) || 0
        };
    });

    if (isDatabaseLess()) {
        Logger.warn(`Running AdminService in database-less ${currentTier()} tier. Admin persistence is disabled.`);
        for (const name of Object.keys(this.entities)) {
            this.on('READ', name, (req) => req.query?.SELECT?.one ? null : []);
            this.on(['CREATE', 'UPDATE', 'DELETE'], name, (req) => req.reject(501, 'Admin persistence is available in Standard or Enterprise tiers.'));
        }
        return;
    }

    // Scope check for local development
    if (cds.env.profiles.find(p => p.includes("hybrid") || p.includes("production"))) {
        this.before("SAVE", Users, async (req) => {
            try {
                let user = req.data;

                const { req: request } = cds.context.http
                const tenantHost = request.get('x-forwarded-host') ?? request.host;
                const tenantProto = request.get('x-forwarded-proto') ?? request.protocol;

                const userToken = request.authInfo.getTokenInfo().getTokenValue();
                const userManagement = new UserManagement(userToken);

                await userManagement.validateRoleCollection(req.data.role_ID);

                if (req.event !== 'UPDATE') {
                    let userInfo = await userManagement.createUser({
                        first_name: user.firstName,
                        last_name: user.lastName,
                        email: user.email,
                        target_url: `${tenantProto}://${tenantHost}`,
                        roleId: req.data.role_ID
                    })

                    req.data.iasLocation = userInfo?.iasLocation;
                    req.data.shadowId = userInfo.shadow.id;

                    Logger.log("User successfully created!", JSON.stringify(userInfo));
                    req.notify(200, 'User successfully created!')
                } else {
                    let diff = await req.diff();

                    if (diff.ID) {
                        let users = await cds.run(SELECT.from("adops.db.Users").where({ ID: diff.ID }));
                        await userManagement.removeRoleCollectionFromUser(users[0].role_ID, users[0].shadowId);
                        await userManagement.assignRoleCollectionToUser(req.data.role_ID, users[0].shadowId);

                        Logger.log("User successfully updated!");
                        req.notify(200, 'User successfully updated!')
                    }
                }
            } catch (error) {
                Logger.error(`Error: An error occurred while saving the user!`);
                Logger.error("Error: ", error.message);
                req.reject(500, error.message)
            }
        })
    }

    // Scope check for local development
    if (cds.env.profiles.find(p => p.includes("hybrid") || p.includes("production"))) {
        this.on("READ", 'Roles', async (req) => {
            try {
                const { req: request } = cds.context.http
                let loggedInUserToken = request.authInfo.getTokenInfo().getTokenValue()
                let userManagement = new UserManagement(loggedInUserToken);
                let pagination = {
                    startIndex: req.query.SELECT.limit.offset.val + 1,
                    count: req.query.SELECT.limit.rows.val + 1,
                    sortOrder: 'ascending',
                    sortBy: 'displayName'
                }
                let roleCollections = await userManagement.getRoleCollections("AdoptOps", pagination);
                let response = [];

                if (req.query.SELECT.count) {
                    response.$count = roleCollections.length
                }
                if (req.query.SELECT.search) {
                    let searchValue = req.query.SELECT.search[0].val;
                    roleCollections = roleCollections.filter((resource) => resource.id.includes(searchValue) || resource.description.includes(searchValue))
                }
                roleCollections.map((roleCollection) => {
                    response.push({ ID: roleCollection.id, description: roleCollection.description });
                })

                Logger.log("Role collections successfully read!");

                req.reply(response);
            } catch (error) {
                Logger.error(`Error: An error occurred while reading the application roles!`);
                Logger.error("Error: ", error.message);
                req.reject(500, error.message)
            }
        })
    }

    // Scope check for local development
    if (cds.env.profiles.find(p => p.includes("hybrid") || p.includes("production"))) {
        this.before("DELETE", 'Users', async (req) => {
            try {
                const { req: request } = cds.context.http
                let loggedInUserToken = request.authInfo.getTokenInfo().getTokenValue();
                let userManagement = new UserManagement(loggedInUserToken);
                let user = await cds.run(SELECT.from("adops.db.Users").where({ ID: req.data.ID }));

                await userManagement.deleteUser(user[0]);

                Logger.log("User successfully deleted!");
                req.notify(200, 'User successfully deleted!')
            } catch (error) {
                Logger.error(`Error: An error occurred while deleting the user!`);
                Logger.error("Error: ", error.message);
                req.reject(500, error.message)
            }
        })
    }
});
