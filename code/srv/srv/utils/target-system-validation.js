// Target-system write validation (O11 / I6): a BTP destination name is the
// only routing identity AdoptOps persists, and several paths resolve a system
// BY destination (checkTargetSystemConnection without an id, destination
// value help). Two rows sharing a destination in one tenant would make that
// lookup ambiguous, so the name must be unique per tenant. Enforced on both
// services that let Admins edit TargetSystems (PublicService, AdminService);
// the db-level tenant scope limits the conflict read to the caller's tenant.

const TARGET_SYSTEMS = 'adops.db.TargetSystems';

const clean = (value) => String(value ?? '').trim();

function rowId(req) {
    return req.data?.ID || req.params?.[0]?.ID || req.params?.[0] || null;
}

// The system (other than `ownId`) already registered on `destinationName`
// in the caller's tenant, or null.
async function findDestinationConflict(destinationName, ownId) {
    const rows = await SELECT.from(TARGET_SYSTEMS).columns('ID', 'displayName', 'destinationName')
        .where({ destinationName });
    return rows.find((row) => row.ID !== ownId) || null;
}

function registerTargetSystemValidation(service) {
    // Transport route (O13): a system cannot be its own follow-on system,
    // and the follow-on system must exist in the caller's tenant.
    service.before(['CREATE', 'UPDATE'], 'TargetSystems', async (req) => {
        const next = req.data?.followOnSystem_ID;
        if (next === undefined || next === null || next === '') {
            if (next === '') req.data.followOnSystem_ID = null;
            return;
        }
        if (req.event === 'UPDATE' && next === rowId(req)) return req.reject(400, 'A target system cannot be its own follow-on system.');
        const target = await SELECT.one.from(TARGET_SYSTEMS).columns('ID').where({ ID: next });
        if (!target) return req.reject(400, 'The follow-on system does not exist.');
    });

    service.before(['CREATE', 'UPDATE'], 'TargetSystems', async (req) => {
        if (!req.data || req.data.destinationName === undefined) {
            if (req.event === 'CREATE') return req.reject(400, 'destinationName is required.');
            return;
        }
        const destinationName = clean(req.data.destinationName);
        if (!destinationName) return req.reject(400, 'destinationName is required.');
        req.data.destinationName = destinationName;

        const conflict = await findDestinationConflict(destinationName, req.event === 'UPDATE' ? rowId(req) : null);
        if (conflict) {
            return req.reject(409,
                `Destination "${destinationName}" is already registered for target system "${conflict.displayName || conflict.ID}". `
                + 'One destination identifies one system and client; edit that system instead or use a different destination.');
        }
    });
}

module.exports = { registerTargetSystemValidation, findDestinationConflict };
