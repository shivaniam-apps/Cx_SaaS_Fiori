const cds = require('@sap/cds');
const { appendAuditEvent } = require('./audit-chain.js');

const logger = cds.log('admin-audit');

// Admin-triggered configuration and authorization changes go through the
// hash-chained writer like every other audit row. A failed audit write is
// no longer swallowed: it propagates, so the request transaction rolls the
// audited change back with it (roadmap A4 - a change without its audit row
// is exactly what the chain must rule out). Callers outside a request
// (schedulers) catch and log themselves.
async function writeAdminAuditEvent(req, { eventType, objectType, objectName, objectId, message, beforeValue, afterValue, source = 'Product Insights' }) {
    try {
        return await appendAuditEvent({
            EventType: eventType,
            Severity: 'INFO',
            ObjectType: objectType,
            ObjectName: objectName,
            ObjectId: objectId,
            UserId: req.user?.id || 'anonymous',
            Source: source,
            Message: message,
            BeforeValue: beforeValue,
            AfterValue: afterValue,
            CorrelationId: req.headers?.['x-correlation-id'] || cds.context?.id
        });
    } catch (error) {
        logger.error(`Audit write for ${eventType} failed: ${error.message}`);
        throw error;
    }
}

module.exports = { writeAdminAuditEvent };
