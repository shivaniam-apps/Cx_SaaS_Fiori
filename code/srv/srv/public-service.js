const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');
const Logger = cds.log('public-service');
const { registerTenantScope, currentTenant } = require('./utils/tenant-scope.js');
const { checkTargetSystemConnection, getBackendCapabilities } = require('./utils/s4-fiori-adapter.js');
const { enqueueTask } = require('./utils/task-runner.js');

module.exports = cds.service.impl(async function () {
    registerTenantScope(this);

    // --- Connectivity / discovery ------------------------------------------

    this.on('checkTargetSystemConnection', async (req) => {
        const { destinationName, path } = req.data;
        if (!destinationName) return req.reject(400, 'destinationName is required.');
        const verdict = await checkTargetSystemConnection({ destinationName, path, req });
        // Persist the last verdict on the matching target system so the list
        // page shows health without re-testing.
        await UPDATE('adops.db.TargetSystems')
            .set({
                lastCheckedAt: verdict.TestedAt,
                lastCheckStatus: verdict.Stage,
                lastCheckMessage: verdict.Message
            })
            .where({ destinationName });
        return verdict;
    });

    this.on('getBackendCapabilities', async (req) => {
        const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: req.data.targetSystemId });
        if (!targetSystem) return req.reject(404, 'Target system not found.');
        const capabilities = await getBackendCapabilities({ targetSystem, req });
        return JSON.stringify(capabilities);
    });

    // --- Extraction (async) -------------------------------------------------

    this.on('runUsageExtraction', async (req) => {
        const {
            targetSystemId, sources, periodFrom, periodTo,
            granularity, topUsersPerTcode, minExecutions
        } = req.data;
        const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: targetSystemId });
        if (!targetSystem) return req.reject(404, 'Target system not found.');
        if (!periodFrom || !periodTo) return req.reject(400, 'periodFrom and periodTo are required.');

        const effectiveSources = (sources && sources.length ? sources : ['ST03N']).map((s) => String(s).toUpperCase());
        const runId = randomUUID();
        const pseudonymised = !targetSystem.identifiedUsageAllowed;

        await INSERT.into('adops.db.ExtractionRuns').entries({
            ID: runId,
            targetSystem_ID: targetSystemId,
            TenantId: currentTenant(),
            Title: `${targetSystem.displayName || targetSystem.systemId || 'System'} ${periodFrom}..${periodTo}`,
            Status: 'QUEUED',
            SourcesJson: JSON.stringify(effectiveSources),
            PeriodFrom: periodFrom,
            PeriodTo: periodTo,
            PeriodGranularity: granularity || 'MONTH',
            Pseudonymised: pseudonymised,
            RequestedBy: req.user?.id || null,
            CorrelationId: cds.context?.id || null
        });

        const task = await enqueueTask({
            taskType: 'USAGE_EXTRACTION',
            targetSystemId,
            objectType: 'ExtractionRuns',
            objectId: runId,
            requestedBy: req.user?.id,
            correlationId: cds.context?.id,
            payload: {
                targetSystemId,
                sources: effectiveSources,
                periodFrom,
                periodTo,
                granularity: granularity || 'MONTH',
                topUsersPerTcode: topUsersPerTcode || 20,
                minExecutions: minExecutions || 1,
                runId
            }
        });

        return { taskId: task.ID, objectId: runId, status: task.Status, pollAfterMs: 2000 };
    });

    // --- Task polling (live already: rows are written by the task runner) ---

    const toStatus = (task) => task && {
        taskId: task.ID,
        taskType: task.TaskType,
        objectType: task.ObjectType,
        objectId: task.ObjectId,
        status: task.Status,
        phase: task.Phase,
        progressPercent: task.ProgressPercent,
        processedItems: task.ProcessedItems,
        totalItems: task.TotalItems,
        pollAfterMs: task.Status === 'RUNNING' || task.Status === 'CLAIMED' || task.Status === 'QUEUED' ? 2000 : 0,
        errorText: task.ErrorText
    };

    this.on('getTaskStatus', async (req) => {
        const task = await SELECT.one.from('adops.db.BackgroundTasks').where({ ID: req.data.taskId });
        if (!task) return req.reject(404, 'Task not found.');
        return toStatus(task);
    });

    this.on('listActiveTasks', async (req) => {
        const where = { Status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] } };
        if (req.data.targetSystemId) where.targetSystem_ID = req.data.targetSystemId;
        const tasks = await SELECT.from('adops.db.BackgroundTasks').where(where).orderBy('QueuedAt desc');
        return tasks.map(toStatus);
    });

    this.on('cancelTask', async (req) => {
        const task = await SELECT.one.from('adops.db.BackgroundTasks').where({ ID: req.data.taskId });
        if (!task) return req.reject(404, 'Task not found.');
        if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(task.Status)) {
            return toStatus(task);
        }
        // The runner honours CancelRequested at page/step boundaries;
        // in-flight S/4 requests are allowed to complete.
        await UPDATE('adops.db.BackgroundTasks').set({ CancelRequested: true }).where({ ID: task.ID });
        Logger.info(`Cancel requested for task ${task.ID} (${task.TaskType})`);
        return toStatus({ ...task, CancelRequested: true });
    });

    // --- Usage reads --------------------------------------------------------

    this.on('queryTransactionUsage', async (req) => {
        const {
            extractionRunId, search, lineOfBusiness, customOnly, minExecutions,
            top = 200, skip = 0, sortField = 'ExecutionCount', sortDirection = 'desc',
            includeSummary = true
        } = req.data;
        if (!extractionRunId) return req.reject(400, 'extractionRunId is required.');

        const snapshots = await SELECT.from('adops.db.UsageSnapshots').columns('ID')
            .where({ extractionRun_ID: extractionRunId, Source: 'ST03N' });
        const snapshotIds = snapshots.map((s) => s.ID);
        if (!snapshotIds.length) return { Items: [], Count: 0, HasMore: false, Summary: null };

        const where = { snapshot_ID: { in: snapshotIds } };
        if (lineOfBusiness) where.LineOfBusiness = lineOfBusiness;
        if (customOnly) where.IsCustom = true;
        if (minExecutions) where.ExecutionCount = { '>=': minExecutions };
        if (search) where.TransactionCode = { like: `%${String(search).toUpperCase()}%` };

        // Deterministic tiebreaker so paging never skips rows.
        const SORTABLE = ['ExecutionCount', 'DialogStepCount', 'DistinctUserCount', 'AvgResponseTimeMs', 'TransactionCode', 'LastUsedOn'];
        const field = SORTABLE.includes(sortField) ? sortField : 'ExecutionCount';
        const direction = sortDirection === 'asc' ? 'asc' : 'desc';
        const boundedTop = Math.min(Number(top) || 200, 1000);

        const rows = await SELECT.from('adops.db.TransactionUsage')
            .where(where)
            .orderBy(`${field} ${direction}`, 'TransactionCode asc')
            .limit(boundedTop + 1, Number(skip) || 0);
        const hasMore = rows.length > boundedTop;
        if (hasMore) rows.pop();

        let summary = null;
        let totalExecutions = 0;
        if (includeSummary) {
            const [agg] = await SELECT.from('adops.db.TransactionUsage')
                .columns(
                    'count(*) as totalTcodes',
                    'sum(ExecutionCount) as totalExecutions',
                    'max(DistinctUserCount) as maxUsers'
                )
                .where({ snapshot_ID: { in: snapshotIds } });
            totalExecutions = Number(agg?.totalExecutions) || 0;
            summary = {
                totalTcodes: Number(agg?.totalTcodes) || 0,
                totalExecutions,
                distinctUsers: Number(agg?.maxUsers) || 0,
                customShare: 0,
                fioriAdoptionPercent: 0
            };
        }

        const items = rows.map((r) => ({
            ID: r.ID,
            TransactionCode: r.TransactionCode,
            TransactionText: r.TransactionText,
            ApplicationComponent: r.ApplicationComponent,
            LineOfBusiness: r.LineOfBusiness,
            ExecutionCount: r.ExecutionCount,
            DialogStepCount: r.DialogStepCount,
            DistinctUserCount: r.DistinctUserCount,
            AvgResponseTimeMs: r.AvgResponseTimeMs,
            SharePercent: totalExecutions ? Math.round((Number(r.ExecutionCount) / totalExecutions) * 10000) / 100 : 0,
            CumulativePercent: 0, // server computes only for the default ExecutionCount-desc sort, client renders
            FirstUsedOn: r.FirstUsedOn,
            LastUsedOn: r.LastUsedOn,
            IsCustom: r.IsCustom
        }));

        // Cumulative % is only meaningful in executions-descending order.
        if (field === 'ExecutionCount' && direction === 'desc' && totalExecutions && !skip) {
            let running = 0;
            for (const item of items) {
                running += Number(item.ExecutionCount) || 0;
                item.CumulativePercent = Math.round((running / totalExecutions) * 10000) / 100;
            }
        }

        return { Items: items, Count: items.length, HasMore: hasMore, Summary: summary };
    });

    this.on('queryUsageOverview', async (req) => {
        const { extractionRunId } = req.data;
        if (!extractionRunId) return req.reject(400, 'extractionRunId is required.');
        const run = await SELECT.one.from('adops.db.ExtractionRuns').where({ ID: extractionRunId });
        if (!run) return req.reject(404, 'Extraction run not found.');
        return JSON.stringify({
            runId: run.ID,
            status: run.Status,
            periodFrom: run.PeriodFrom,
            periodTo: run.PeriodTo,
            transactionRowCount: run.TransactionRowCount,
            userRowCount: run.UserRowCount,
            roleRowCount: run.RoleRowCount,
            truncated: run.Truncated
        });
    });
});
