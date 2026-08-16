const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');
const { envNumber } = require('./env.js');

// Explicit ql import so the module also works under mocha (the SELECT/...
// globals only exist when the cds server injects them).
const { SELECT, INSERT, UPDATE } = cds.ql;

const Logger = cds.log('task-runner');

// ---------------------------------------------------------------------------
// Async work framework.
//
// Every slow S/4 operation is a BackgroundTasks row: actions enqueue and
// return immediately; an in-process poller claims work with an atomic
// conditional UPDATE (safe on PostgreSQL and SQLite, and across multiple CF
// instances); the UI polls getTaskStatus. Three timeout layers protect a
// customer-facing system: per HTTP call (the adapter), per task (DeadlineAt),
// and worker liveness (HeartbeatAt - a stale heartbeat makes a CLAIMED/
// RUNNING task reclaimable, which is what recovers from a CF instance killed
// mid-run).
//
// MaxAttempts is 2 for read-only task types and 1 for ACTIVATION_EXECUTION -
// never silently re-run a write against a customer's S/4. Execution resumes
// (completed steps skip) rather than retries.
// ---------------------------------------------------------------------------

const TERMINAL_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

const DEFAULT_DEADLINES_MS = {
    USAGE_EXTRACTION: 30 * 60 * 1000,
    CATALOG_DERIVATION: 30 * 60 * 1000,
    ANALYSIS: 15 * 60 * 1000,
    ACTIVATION_SIMULATION: 30 * 60 * 1000,
    ACTIVATION_EXECUTION: 60 * 60 * 1000,
    TRANSPORT_RELEASE: 15 * 60 * 1000
};

const SINGLE_ATTEMPT_TYPES = ['ACTIVATION_EXECUTION'];

const handlers = new Map();
const workerId = `${process.env.CF_INSTANCE_INDEX ?? 'local'}:${process.pid}:${randomUUID().slice(0, 8)}`;

let pollTimer = null;
let runningCount = 0;

function taskConcurrency() {
    return envNumber('TASK_CONCURRENCY', 2);
}

function heartbeatMs() {
    return envNumber('TASK_HEARTBEAT_MS', 5000);
}

function staleMs() {
    return envNumber('TASK_STALE_MS', 120000);
}

function pollIntervalMs() {
    return envNumber('TASK_POLL_MS', 3000);
}

// Handlers receive ({ task, reportProgress, log, isCancelRequested }) and
// return a result object persisted to ResultJson. Throwing marks the task
// FAILED (or QUEUED again while attempts remain).
function registerTaskHandler(taskType, handler) {
    handlers.set(taskType, handler);
}

async function enqueueTask({ taskType, targetSystemId, objectType, objectId, requestedBy, correlationId, payload }) {
    const db = cds.db;
    const now = new Date();
    const deadline = new Date(now.getTime() + (DEFAULT_DEADLINES_MS[taskType] || 15 * 60 * 1000));
    const task = {
        ID: randomUUID(),
        targetSystem_ID: targetSystemId || null,
        TaskType: taskType,
        ObjectType: objectType || null,
        ObjectId: objectId || null,
        Status: 'QUEUED',
        Phase: 'Queued',
        ProgressPercent: 0,
        ProcessedItems: 0,
        TotalItems: 0,
        QueuedAt: now.toISOString(),
        AttemptCount: 0,
        MaxAttempts: SINGLE_ATTEMPT_TYPES.includes(taskType) ? 1 : 2,
        DeadlineAt: deadline.toISOString(),
        CancelRequested: false,
        RequestedBy: requestedBy || null,
        CorrelationId: correlationId || null,
        ResultJson: payload ? JSON.stringify({ payload }) : null
    };
    await db.run(INSERT.into('adops.db.BackgroundTasks').entries(task));
    // Nudge the poller so interactive runs start promptly.
    setImmediate(() => pollOnce().catch(() => {}));
    return task;
}

async function requestCancel(taskId) {
    await UPDATE('adops.db.BackgroundTasks')
        .set({ CancelRequested: true })
        .where({ ID: taskId, Status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] } });
}

// One candidate pass: reclaim stale work, then claim QUEUED tasks up to the
// concurrency budget, honouring one-task-per-target-system.
async function pollOnce() {
    if (!cds.db) return;
    if (runningCount >= taskConcurrency()) return;

    await reclaimStaleTasks();

    const busySystems = await SELECT.from('adops.db.BackgroundTasks')
        .columns('targetSystem_ID')
        .where({ Status: { in: ['CLAIMED', 'RUNNING'] } });
    const busySystemIds = new Set(busySystems.map((r) => r.targetSystem_ID).filter(Boolean));

    const candidates = await SELECT.from('adops.db.BackgroundTasks')
        .where({ Status: 'QUEUED', TaskType: { in: [...handlers.keys()] } })
        .orderBy('QueuedAt asc')
        .limit(10);

    for (const candidate of candidates) {
        if (runningCount >= taskConcurrency()) break;
        // An extraction and an activation must never hit the same S/4 at once.
        if (candidate.targetSystem_ID && busySystemIds.has(candidate.targetSystem_ID)) continue;

        const nowIso = new Date().toISOString();
        // Atomic claim: only one instance wins the conditional update.
        const claimed = await UPDATE('adops.db.BackgroundTasks')
            .set({
                Status: 'CLAIMED',
                ClaimedBy: workerId,
                ClaimedAt: nowIso,
                HeartbeatAt: nowIso,
                AttemptCount: candidate.AttemptCount + 1
            })
            .where({ ID: candidate.ID, Status: 'QUEUED' });
        if (!claimed) continue;

        if (candidate.targetSystem_ID) busySystemIds.add(candidate.targetSystem_ID);
        runningCount += 1;
        runTask(candidate.ID)
            .catch((error) => Logger.error(`Task ${candidate.ID} runner failure: ${error.message}`))
            .finally(() => {
                runningCount -= 1;
            });
    }
}

// A CLAIMED/RUNNING task whose heartbeat went silent is reclaimable: back to
// QUEUED while attempts remain, else FAILED. Deadline overruns become
// TIMED_OUT regardless of attempts.
async function reclaimStaleTasks() {
    const now = Date.now();
    const staleBefore = new Date(now - staleMs()).toISOString();
    const nowIso = new Date(now).toISOString();

    const stale = await SELECT.from('adops.db.BackgroundTasks')
        .where({ Status: { in: ['CLAIMED', 'RUNNING'] }, HeartbeatAt: { '<': staleBefore } });
    for (const task of stale) {
        const exhausted = task.AttemptCount >= task.MaxAttempts;
        await UPDATE('adops.db.BackgroundTasks')
            .set(exhausted
                ? { Status: 'FAILED', CompletedAt: nowIso, ErrorText: `Worker ${task.ClaimedBy || '?'} went silent and attempts are exhausted.` }
                : { Status: 'QUEUED', Phase: 'Requeued after stale heartbeat' })
            .where({ ID: task.ID, Status: task.Status, HeartbeatAt: task.HeartbeatAt });
        Logger.warn(`Task ${task.ID} (${task.TaskType}) stale heartbeat -> ${exhausted ? 'FAILED' : 'requeued'}`);
    }

    await UPDATE('adops.db.BackgroundTasks')
        .set({ Status: 'TIMED_OUT', CompletedAt: nowIso, ErrorText: 'Task deadline exceeded.' })
        .where({ Status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] }, DeadlineAt: { '<': nowIso } });
}

async function runTask(taskId) {
    const task = await SELECT.one.from('adops.db.BackgroundTasks').where({ ID: taskId });
    if (!task || task.Status !== 'CLAIMED') return;

    const handler = handlers.get(task.TaskType);
    if (!handler) {
        await finishTask(taskId, 'FAILED', { errorText: `No handler for task type ${task.TaskType}` });
        return;
    }

    await UPDATE('adops.db.BackgroundTasks')
        .set({ Status: 'RUNNING', Phase: 'Starting' })
        .where({ ID: taskId, Status: 'CLAIMED' });

    let lastHeartbeat = 0;
    const reportProgress = async ({ phase, processedItems, totalItems, progressPercent }) => {
        const now = Date.now();
        if (now - lastHeartbeat < heartbeatMs() && progressPercent !== 100) return;
        lastHeartbeat = now;
        const patch = { HeartbeatAt: new Date(now).toISOString() };
        if (phase !== undefined) patch.Phase = phase;
        if (processedItems !== undefined) patch.ProcessedItems = processedItems;
        if (totalItems !== undefined) patch.TotalItems = totalItems;
        patch.ProgressPercent = progressPercent !== undefined
            ? progressPercent
            : (totalItems ? Math.min(99, Math.round((processedItems / totalItems) * 100)) : undefined);
        if (patch.ProgressPercent === undefined) delete patch.ProgressPercent;
        await UPDATE('adops.db.BackgroundTasks').set(patch).where({ ID: taskId });
    };

    const log = async (severity, phase, message) => {
        try {
            await INSERT.into('adops.db.BackgroundTaskLogs').entries({
                ID: randomUUID(),
                task_ID: taskId,
                LoggedAt: new Date().toISOString(),
                Severity: severity,
                Phase: phase,
                Message: String(message).slice(0, 1000)
            });
        } catch (error) {
            Logger.warn(`Task ${taskId} log write failed: ${error.message}`);
        }
    };

    const isCancelRequested = async () => {
        const row = await SELECT.one.from('adops.db.BackgroundTasks').columns('CancelRequested').where({ ID: taskId });
        return Boolean(row?.CancelRequested);
    };

    const isPastDeadline = () => task.DeadlineAt && new Date(task.DeadlineAt).getTime() < Date.now();

    try {
        const payload = task.ResultJson ? (JSON.parse(task.ResultJson).payload ?? null) : null;
        const result = await handler({ task, payload, reportProgress, log, isCancelRequested, isPastDeadline });
        if (await isCancelRequested()) {
            await finishTask(taskId, 'CANCELLED', { result });
        } else {
            await finishTask(taskId, 'SUCCEEDED', { result });
        }
    } catch (error) {
        const fresh = await SELECT.one.from('adops.db.BackgroundTasks').where({ ID: taskId });
        const canRetry = fresh && fresh.AttemptCount < fresh.MaxAttempts;
        await log('ERROR', fresh?.Phase || 'Failed', error.message);
        if (canRetry) {
            await UPDATE('adops.db.BackgroundTasks')
                .set({ Status: 'QUEUED', Phase: `Retrying after: ${String(error.message).slice(0, 120)}` })
                .where({ ID: taskId });
            Logger.warn(`Task ${taskId} failed, requeued (attempt ${fresh.AttemptCount}/${fresh.MaxAttempts}): ${error.message}`);
        } else {
            await finishTask(taskId, 'FAILED', { errorText: error.message });
        }
    }
}

async function finishTask(taskId, status, { result, errorText } = {}) {
    const patch = {
        Status: status,
        CompletedAt: new Date().toISOString(),
        ProgressPercent: status === 'SUCCEEDED' ? 100 : undefined,
        ErrorText: errorText ? String(errorText).slice(0, 2000) : undefined,
        ResultJson: result !== undefined ? JSON.stringify({ result }) : undefined
    };
    for (const key of Object.keys(patch)) if (patch[key] === undefined) delete patch[key];
    await UPDATE('adops.db.BackgroundTasks').set(patch).where({ ID: taskId });
}

// Started from cds.on('served'). unref'd so tests and one-shot CLIs exit.
function startTaskRunner() {
    if (pollTimer) return;
    pollTimer = setInterval(() => pollOnce().catch((error) => Logger.error(`poll failed: ${error.message}`)), pollIntervalMs());
    if (pollTimer.unref) pollTimer.unref();
    Logger.info(`Task runner started as ${workerId} (concurrency ${taskConcurrency()})`);
}

function stopTaskRunner() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}

module.exports = {
    registerTaskHandler,
    enqueueTask,
    requestCancel,
    startTaskRunner,
    stopTaskRunner,
    pollOnce,          // exposed for tests and the enqueue nudge
    TERMINAL_STATES,
    workerId
};
