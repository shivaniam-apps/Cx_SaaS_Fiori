const cds = require('@sap/cds');
const { clampText } = require('./telemetry-sanitize.js');

const logger = cds.log('admin-audit');

// Admin-triggered configuration and authorization changes belong in the
// existing audit trail; failures must not block the change itself.
async function writeAdminAuditEvent(req, { eventType, objectType, objectName, objectId, message, beforeValue, afterValue, source = 'Product Insights' }) {
    try {
        await INSERT.into('adops.db.AuditEvents').entries({
            ID: cds.utils.uuid(),
            Timestamp: new Date().toISOString(),
            EventType: eventType,
            Severity: 'Information',
            ObjectType: objectType,
            ObjectName: clampText(objectName, 160),
            ObjectId: clampText(objectId, 120),
            UserId: req.user?.id || 'anonymous',
            Source: source,
            Message: clampText(message, 500),
            BeforeValue: clampText(beforeValue, 120),
            AfterValue: clampText(afterValue, 120),
            CorrelationId: clampText(req.headers?.['x-correlation-id'], 120) || cds.utils.uuid(),
        });
    } catch (error) {
        logger.warn(`Audit write for ${eventType} failed: ${error.message}`);
    }
}

module.exports = { writeAdminAuditEvent };
