const cds = require('@sap/cds');
const { isDatabaseLess } = require('./tier.js');
const { clampText } = require('./telemetry-sanitize.js');
const { buildReferenceNumber } = require('./feedback-telemetry-handlers.js');
const { writeAdminAuditEvent } = require('./admin-audit.js');
const UserManagement = require('./user-management.js');

const logger = cds.log('access-requests');

const ACCESS_REQUESTS = 'adops.db.AccessRequests';

// Requestable scopes are a fixed vocabulary: the area keys match the
// restricted pages that render the Request Access CTA ('application' is the
// shell-level Member gate), and the role names match XSUAA role collections
// resolvable via UserManagement.
const REQUESTABLE_AREAS = new Set(['application', 'settings', 'product-insights', 'access-requests']);
const REQUESTABLE_ROLES = new Set(['Admin', 'Member']);
const URGENCIES = new Set(['LOW', 'NORMAL', 'HIGH']);
const DECISIONS = new Set(['APPROVE', 'DECLINE']);

const TIER_MESSAGE = 'Access requests are available in Standard or Enterprise tiers.';

function canGrantRoles() {
    return Boolean(cds.env.profiles.find((p) => p.includes('hybrid') || p.includes('production')));
}

function requesterEmail(req) {
    try {
        const fromToken = req.req?.authInfo?.getEmail?.();
        if (fromToken) return clampText(fromToken, 160);
    } catch {
        // fall through to the id heuristic below
    }
    // XSUAA user ids are typically the logon email; only trust that shape.
    const id = String(req.user?.id || '');
    return id.includes('@') ? clampText(id, 160) : null;
}

function requesterName(req) {
    try {
        return clampText(req.req?.authInfo?.getGivenName?.(), 160) || null;
    } catch {
        return null;
    }
}

function toReceipt(row) {
    return { ID: row.ID, referenceNumber: row.ReferenceNumber, status: row.Status };
}

function toMyRequestInfo(row) {
    return {
        ID: row.ID,
        referenceNumber: row.ReferenceNumber,
        requestedArea: row.RequestedArea,
        requestedRole: row.RequestedRole,
        status: row.Status,
        requestedAt: row.RequestedAt,
        decidedAt: row.DecidedAt,
        decisionNotes: row.DecisionNotes,
        grantStatus: row.GrantStatus,
    };
}

// Best-effort XSUAA role-collection assignment; every failure mode returns a
// FAILED grant with a reason instead of throwing, because the admin decision
// itself must never be rolled back by fulfillment problems.
async function grantRoleCollection(request) {
    try {
        const httpReq = cds.context?.http?.req;
        const token = httpReq?.authInfo?.getTokenInfo?.()?.getTokenValue?.();
        if (!token) return { status: 'FAILED', error: 'No admin token available for XSUAA role assignment.' };

        const userManagement = new UserManagement(token);

        const identifiers = [request.RequesterEmail, request.RequesterId]
            .filter(Boolean)
            .map((value) => String(value).toLowerCase());
        const shadowUsers = await userManagement.getShadowUsers();
        const shadow = (shadowUsers?.resources || []).find((candidate) => {
            const names = [candidate.userName, candidate.externalId, ...(candidate.emails || []).map((entry) => entry?.value)]
                .filter(Boolean)
                .map((value) => String(value).toLowerCase());
            return names.some((name) => identifiers.includes(name));
        });
        if (!shadow) return { status: 'FAILED', error: `No subaccount user found for ${request.RequesterEmail || request.RequesterId}.` };

        const roleCollections = await userManagement.getRoleCollections('AdoptOps');
        const requestedRole = String(request.RequestedRole || '').toLowerCase();
        const roleCollection = (roleCollections || []).find((candidate) => {
            const id = String(candidate.id || '').toLowerCase();
            return id === requestedRole || id.endsWith(`_${requestedRole}`) || id.endsWith(`-${requestedRole}`) || id.includes(requestedRole);
        });
        if (!roleCollection) return { status: 'FAILED', error: `No AdoptOps role collection matches role ${request.RequestedRole}.` };

        await userManagement.assignRoleCollectionToUser(roleCollection.id, shadow.id);
        return { status: 'GRANTED', error: null };
    } catch (error) {
        return { status: 'FAILED', error: clampText(error.message, 500) || 'Role assignment failed.' };
    }
}

function registerAccessRequestPublicHandlers(service) {
    service.on('submitAccessRequest', async (req) => {
        if (isDatabaseLess()) return req.reject(501, TIER_MESSAGE);

        const area = clampText(req.data.requestedArea, 60).toLowerCase();
        if (!REQUESTABLE_AREAS.has(area)) return req.reject(400, `Unsupported access request area: ${area || '(empty)'}`);

        const role = clampText(req.data.requestedRole, 60) || 'Admin';
        if (!REQUESTABLE_ROLES.has(role)) return req.reject(400, `Unsupported access request role: ${role}`);

        const justification = clampText(req.data.justification, 2000);
        if (!justification) return req.reject(400, 'A business justification is required to request access.');

        const urgency = clampText(req.data.urgency, 20).toUpperCase() || 'NORMAL';
        if (!URGENCIES.has(urgency)) return req.reject(400, `Unsupported urgency: ${urgency}`);

        const requesterId = req.user?.id || 'anonymous';

        // Idempotent duplicate handling: a pending request for the same area
        // is returned as-is so a double submit (or a stale page) cannot pile
        // up rows or surface an error the user cannot act on.
        const existing = await SELECT.one.from(ACCESS_REQUESTS).where({
            RequesterId: requesterId,
            RequestedArea: area,
            Status: 'PENDING',
        });
        if (existing) return toReceipt(existing);

        const row = {
            ID: cds.utils.uuid(),
            RequestedAt: new Date().toISOString(),
            RequesterId: requesterId,
            RequesterName: requesterName(req),
            RequesterEmail: requesterEmail(req),
            TenantId: req.user?.tenant || null,
            RequestedArea: area,
            RequestedRole: role,
            Justification: justification,
            Urgency: urgency,
            Status: 'PENDING',
            ReferenceNumber: buildReferenceNumber('AR'),
        };

        try {
            await INSERT.into(ACCESS_REQUESTS).entries(row);
        } catch (error) {
            logger.error(`Access request persistence failed for ${requesterId}: ${error.message}`);
            return req.reject(500, 'Your access request could not be saved. Please try again.');
        }

        await writeAdminAuditEvent(req, {
            eventType: 'ACCESS_REQUEST_SUBMITTED',
            objectType: 'Access Request',
            objectName: row.ReferenceNumber,
            objectId: row.ID,
            message: `Access request ${row.ReferenceNumber}: ${requesterId} requested ${role} for ${area}.`,
            beforeValue: '',
            afterValue: 'PENDING',
            source: 'Access Requests',
        });

        logger.info(`Access request ${row.ReferenceNumber} recorded for ${requesterId} (${area}).`);
        return toReceipt(row);
    });

    service.on('getMyAccessRequests', async (req) => {
        // Empty, not 501: the restricted page calls this unconditionally and
        // must still render cleanly on database-less tiers.
        if (isDatabaseLess()) return [];
        const rows = await SELECT.from(ACCESS_REQUESTS)
            .where({ RequesterId: req.user?.id || 'anonymous' })
            .orderBy('RequestedAt desc');
        return (rows || []).map(toMyRequestInfo);
    });
}

function registerAccessRequestAdminHandlers(service) {
    service.on('decideAccessRequest', async (req) => {
        if (isDatabaseLess()) return req.reject(501, TIER_MESSAGE);

        const id = clampText(req.data.ID, 36);
        if (!id) return req.reject(400, 'ID is required.');
        const existing = await SELECT.one.from(ACCESS_REQUESTS).where({ ID: id });
        if (!existing) return req.reject(404, 'Access request not found.');
        if (existing.Status !== 'PENDING') {
            return req.reject(400, `Access request ${existing.ReferenceNumber || id} has already been decided.`);
        }

        const decision = String(req.data.decision || '').toUpperCase();
        if (!DECISIONS.has(decision)) return req.reject(400, `Unsupported decision: ${decision || '(empty)'}`);

        const status = decision === 'APPROVE' ? 'APPROVED' : 'DECLINED';
        const patch = {
            Status: status,
            DecidedBy: req.user?.id || 'anonymous',
            DecidedAt: new Date().toISOString(),
            DecisionNotes: clampText(req.data.decisionNotes, 2000) || null,
            GrantStatus: null,
            GrantError: null,
        };

        if (status === 'APPROVED') {
            if (req.data.grantRole === true && canGrantRoles()) {
                const grant = await grantRoleCollection(existing);
                patch.GrantStatus = grant.status;
                patch.GrantError = grant.error;
                if (grant.status === 'FAILED') {
                    logger.warn(`Access request ${existing.ReferenceNumber}: role grant failed - ${grant.error}`);
                }
            } else {
                patch.GrantStatus = 'MANUAL';
            }
        }

        await UPDATE(ACCESS_REQUESTS).set(patch).where({ ID: id });
        await writeAdminAuditEvent(req, {
            eventType: decision === 'APPROVE' ? 'ACCESS_REQUEST_APPROVED' : 'ACCESS_REQUEST_DECLINED',
            objectType: 'Access Request',
            objectName: existing.ReferenceNumber || id,
            objectId: id,
            message: `Access request ${existing.ReferenceNumber || id} ${status.toLowerCase()} for ${existing.RequesterId}.`,
            beforeValue: existing.Status,
            afterValue: patch.GrantStatus ? `${status}/${patch.GrantStatus}` : status,
            source: 'Access Requests',
        });

        return SELECT.one.from(ACCESS_REQUESTS).where({ ID: id });
    });
}

module.exports = { registerAccessRequestPublicHandlers, registerAccessRequestAdminHandlers };
