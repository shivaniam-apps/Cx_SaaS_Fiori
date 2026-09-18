// SAP Alert Notification service client (roadmap T4).
//
// Raises events through the producer API of the bound `alert-notification`
// service instance so operators are paged instead of polling the pages.
// Deliberately a thin fetch-based client: the binding carries the producer
// URL and OAuth client credentials (or basic credentials on the legacy
// plan), the event shape is the documented resource-event JSON, and every
// failure mode degrades to a log line - an alert must never break the work
// it reports on. Without a binding (local, tests) the module is a no-op.
//
// Subscriptions (who gets what) live in the service instance's cockpit
// configuration, not here: docu/13 describes the conditions to create.
const cds = require('@sap/cds');
const xsenv = require('@sap/xsenv');

const LOG = cds.log('alert');
const EVENT_TASK_FAILED = 'AdoptOpsTaskFailed';
const PRODUCER_PATH = '/cf/producer/v1/resource-events';
const TOKEN_SAFETY_MS = 30 * 1000;

let overrides = null;      // test hook: { binding, fetch }
let tokenCache = null;     // { value, expiresAt }
let unboundLogged = false;

function readBinding() {
    if (overrides && 'binding' in overrides) return overrides.binding || null;
    for (const query of [{ ans: { label: 'alert-notification' } }, { ans: { tag: 'alert-notification' } }]) {
        try {
            return xsenv.getServices(query).ans;
        } catch {
            // next lookup
        }
    }
    return null;
}

function fetchImpl() {
    return overrides?.fetch || globalThis.fetch;
}

function isAlertingBound() {
    return Boolean(readBinding());
}

// Tests inject the binding and the transport; `configureAlerting(null)` restores
// the real lookup.
function configureAlerting(options) {
    overrides = options || null;
    tokenCache = null;
    unboundLogged = false;
}

async function authorizationHeader(binding) {
    if (binding.client_id && binding.client_secret && binding.oauth_url) {
        const now = Date.now();
        if (tokenCache && tokenCache.expiresAt - TOKEN_SAFETY_MS > now) return `Bearer ${tokenCache.value}`;
        const url = new URL(binding.oauth_url);
        if (!url.searchParams.has('grant_type')) url.searchParams.set('grant_type', 'client_credentials');
        const response = await fetchImpl()(url.toString(), {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`${binding.client_id}:${binding.client_secret}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        });
        if (!response.ok) throw new Error(`token endpoint answered ${response.status}`);
        const token = await response.json();
        if (!token?.access_token) throw new Error('token endpoint returned no access_token');
        tokenCache = { value: token.access_token, expiresAt: now + Math.max(60, Number(token.expires_in) || 3600) * 1000 };
        return `Bearer ${token.access_token}`;
    }
    if (binding.username && binding.password) {
        return `Basic ${Buffer.from(`${binding.username}:${binding.password}`).toString('base64')}`;
    }
    throw new Error('binding carries neither OAuth client credentials nor basic credentials');
}

function clamp(value, max) {
    return String(value ?? '').slice(0, max);
}

// Pure: the resource event for a failed or timed-out background task.
function buildTaskFailureEvent(task, { appName = process.env.appName || process.env.APPLICATION_NAME || 'adops-basic-srv', instance = process.env.CF_INSTANCE_INDEX || '0', now = new Date() } = {}) {
    const status = task.Status || 'FAILED';
    return {
        eventType: EVENT_TASK_FAILED,
        severity: 'ERROR',
        category: 'ALERT',
        subject: clamp(`AdoptOps ${task.TaskType || 'task'} ${status}: ${task.ObjectType || 'object'} ${task.ObjectId || ''}`.trim(), 255),
        body: clamp([
            `Task ${task.ID} (${task.TaskType || '?'}) ended ${status}.`,
            `Error: ${task.ErrorText || 'no error text'}`,
            `Phase: ${task.Phase || '-'}; attempts ${task.AttemptCount ?? '?'}/${task.MaxAttempts ?? '?'}.`,
            `Tenant: ${task.TenantId || 'GLOBAL'}; target system: ${task.targetSystem_ID || '-'}; requested by ${task.RequestedBy || '-'}.`,
            `Correlation id: ${task.CorrelationId || '-'}.`,
            'Open Extractions or Activation Runs in AdoptOps for the task log; docu/13 section 4 lists the recovery steps.'
        ].join('\n'), 4000),
        priority: 1,
        eventTimestamp: Math.floor(now.getTime() / 1000),
        resource: {
            resourceName: clamp(appName, 100),
            resourceType: 'cf-application',
            resourceInstance: clamp(instance, 20),
            tags: {
                taskId: clamp(task.ID, 64),
                taskType: clamp(task.TaskType, 40),
                taskStatus: clamp(status, 20),
                tenant: clamp(task.TenantId || 'GLOBAL', 60),
                objectType: clamp(task.ObjectType, 40),
                objectId: clamp(task.ObjectId, 64)
            }
        },
        tags: {
            'ans:correlationId': clamp(task.CorrelationId, 64),
            'adops:taskType': clamp(task.TaskType, 40)
        }
    };
}

// Sends one resource event. Resolves { sent, status?, reason? }; never throws.
async function sendAlert(event) {
    const binding = readBinding();
    if (!binding) {
        if (!unboundLogged) {
            unboundLogged = true;
            LOG.info('Alert Notification service not bound - alerts are logged only.');
        }
        LOG.warn(`ALERT (not sent) ${event.eventType}: ${event.subject}`);
        return { sent: false, reason: 'unbound' };
    }
    try {
        const base = String(binding.url || '').replace(/\/$/, '');
        if (!base) throw new Error('binding carries no url');
        const response = await fetchImpl()(`${base}${PRODUCER_PATH}`, {
            method: 'POST',
            headers: { Authorization: await authorizationHeader(binding), 'Content-Type': 'application/json' },
            body: JSON.stringify(event)
        });
        if (!response.ok) {
            const text = typeof response.text === 'function' ? clamp(await response.text(), 300) : '';
            LOG.warn(`Alert ${event.eventType} refused by the Alert Notification service: ${response.status} ${text}`);
            return { sent: false, status: response.status, reason: 'refused' };
        }
        LOG.info(`Alert ${event.eventType} sent: ${event.subject}`);
        return { sent: true, status: response.status };
    } catch (error) {
        LOG.warn(`Alert ${event.eventType} not sent: ${error.message}`);
        return { sent: false, reason: error.message };
    }
}

async function alertTaskFailure(task, options) {
    return sendAlert(buildTaskFailureEvent(task, options));
}

module.exports = {
    EVENT_TASK_FAILED,
    PRODUCER_PATH,
    buildTaskFailureEvent,
    sendAlert,
    alertTaskFailure,
    isAlertingBound,
    configureAlerting
};
