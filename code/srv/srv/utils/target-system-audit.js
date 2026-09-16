const { appendAuditEvent } = require('./audit-chain.js');

// Identified (non-pseudonymised) usage is an explicit, audited opt-in per
// target system (.claude/rules/sap-backend.md). TargetSystems is the one
// projection Admins still edit directly, on both PublicService and
// AdminService, so the audit hook is registered on each service impl and
// runs inside the request transaction: no flag change commits without its
// audit row, and a failed audit write rolls the change back.

const TARGET_SYSTEMS = 'adops.db.TargetSystems';
const EVENT_TYPE = 'IDENTIFIED_USAGE_CHANGED';

function modeLabel(flag) {
    return flag ? 'IDENTIFIED' : 'PSEUDONYMISED';
}

function systemLabel(system) {
    return system.displayName || system.destinationName || system.ID || '';
}

function systemKey(system) {
    return [system.systemId, system.client].filter(Boolean).join('/');
}

async function auditIdentifiedUsageChange(req, { system, before, after, serviceName }) {
    const key = systemKey(system);
    await appendAuditEvent({
        TenantId: system.TenantId,
        EventType: EVENT_TYPE,
        Severity: after ? 'WARNING' : 'INFO',
        ObjectType: 'TargetSystems',
        ObjectName: systemLabel(system),
        ObjectId: system.ID,
        UserId: req.user?.id || 'anonymous',
        TargetSystem: key,
        Source: serviceName,
        Message: `Identified usage ${after ? 'enabled' : 'disabled'} for target system ${systemLabel(system)}${key ? ` (${key})` : ''}.`,
        BeforeValue: modeLabel(before),
        AfterValue: modeLabel(after)
    });
}

function registerIdentifiedUsageAudit(service) {
    const serviceName = service.name;

    // UPDATE: compare against the stored flag before the generic handler
    // overwrites it. Payloads that do not touch the flag are ignored.
    service.before('UPDATE', 'TargetSystems', async (req) => {
        if (!req.data || req.data.identifiedUsageAllowed === undefined) return;
        const id = req.data.ID || req.params?.[0]?.ID || req.params?.[0];
        if (!id) return;
        const existing = await SELECT.one.from(TARGET_SYSTEMS).where({ ID: id });
        if (!existing) return;
        const before = Boolean(existing.identifiedUsageAllowed);
        const after = Boolean(req.data.identifiedUsageAllowed);
        if (before === after) return;
        await auditIdentifiedUsageChange(req, { system: existing, before, after, serviceName });
    });

    // CREATE: a system registered with the opt-in already set is an opt-in
    // too. The default is pseudonymised, so only true is worth an event.
    service.after('CREATE', 'TargetSystems', async (created, req) => {
        if (!created || !created.identifiedUsageAllowed) return;
        await auditIdentifiedUsageChange(req, { system: created, before: false, after: true, serviceName });
    });
}

module.exports = { registerIdentifiedUsageAudit, IDENTIFIED_USAGE_EVENT_TYPE: EVENT_TYPE };
