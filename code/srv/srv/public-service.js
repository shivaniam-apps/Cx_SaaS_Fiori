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

    // --- Offline file bridge ------------------------------------------------

    this.on('importUsageExtract', async (req) => {
        const { targetSystemId, payload } = req.data;
        const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: targetSystemId });
        if (!targetSystem) return req.reject(404, 'Target system not found.');
        let extract;
        try {
            extract = JSON.parse(payload);
        } catch {
            return req.reject(400, 'The file is not valid JSON.');
        }
        const { importUsageExtract } = require('./utils/usage-extraction.js');
        try {
            const result = await importUsageExtract({
                targetSystem,
                extract,
                requestedBy: req.user?.id,
                tenantId: currentTenant()
            });
            return JSON.stringify(result);
        } catch (error) {
            return req.reject(400, error.message);
        }
    });

    // --- Proposals (Phase 2) ------------------------------------------------

    this.on('generateProposals', async (req) => {
        const { extractionRunId, scoringProfile, minExecutions, includeAlreadyAdopted } = req.data;
        const extractionRun = await SELECT.one.from('adops.db.ExtractionRuns').where({ ID: extractionRunId });
        if (!extractionRun) return req.reject(404, 'Extraction run not found.');
        if (!['COMPLETED', 'PARTIAL'].includes(extractionRun.Status)) {
            return req.reject(400, `Extraction run is ${extractionRun.Status}; analysis needs COMPLETED or PARTIAL.`);
        }

        const analysisRunId = randomUUID();
        await INSERT.into('adops.db.AnalysisRuns').entries({
            ID: analysisRunId,
            targetSystem_ID: extractionRun.targetSystem_ID,
            extractionRun_ID: extractionRunId,
            TenantId: currentTenant(),
            Title: `Analysis of ${extractionRun.Title}`,
            Status: 'QUEUED',
            ScoringProfile: scoringProfile || 'BALANCED'
        });

        const task = await enqueueTask({
            taskType: 'ANALYSIS',
            targetSystemId: extractionRun.targetSystem_ID,
            objectType: 'AnalysisRuns',
            objectId: analysisRunId,
            requestedBy: req.user?.id,
            correlationId: cds.context?.id,
            payload: {
                extractionRunId,
                scoringProfile: scoringProfile || 'BALANCED',
                minExecutions: minExecutions || 1,
                includeAlreadyAdopted: includeAlreadyAdopted !== false,
                analysisRunId
            }
        });
        return { taskId: task.ID, objectId: analysisRunId, status: task.Status, pollAfterMs: 2000 };
    });

    this.on('queryProposals', async (req) => {
        const { analysisRunId, search, reviewStatus, confidence, lineOfBusiness, top = 100, skip = 0, includeSummary = true } = req.data;
        if (!analysisRunId) return req.reject(400, 'analysisRunId is required.');

        const where = { analysisRun_ID: analysisRunId };
        if (reviewStatus) where.ReviewStatus = reviewStatus;
        if (confidence) where.Confidence = confidence;
        if (lineOfBusiness) where.LineOfBusiness = lineOfBusiness;
        if (search) where.AppTitle = { like: `%${search}%` };

        const boundedTop = Math.min(Number(top) || 100, 500);
        const rows = await SELECT.from('adops.db.AppProposals')
            .where(where)
            .orderBy('Rank asc')
            .limit(boundedTop + 1, Number(skip) || 0);
        const hasMore = rows.length > boundedTop;
        if (hasMore) rows.pop();

        let summary = null;
        if (includeSummary) {
            const all = await SELECT.from('adops.db.AppProposals')
                .columns('ReviewStatus', 'TotalExecutions')
                .where({ analysisRun_ID: analysisRunId });
            const run = await SELECT.one.from('adops.db.AnalysisRuns').where({ ID: analysisRunId });
            const totalRunExecutions = all.reduce((sum, row) => sum + Number(row.TotalExecutions || 0), 0);
            const approvedExecutions = all
                .filter((row) => row.ReviewStatus === 'APPROVED')
                .reduce((sum, row) => sum + Number(row.TotalExecutions || 0), 0);
            summary = {
                open: all.filter((row) => ['NEW', 'IN_REVIEW'].includes(row.ReviewStatus)).length,
                approved: all.filter((row) => row.ReviewStatus === 'APPROVED').length,
                rejected: all.filter((row) => row.ReviewStatus === 'REJECTED').length,
                deferred: all.filter((row) => row.ReviewStatus === 'DEFERRED').length,
                noEquivalent: all.filter((row) => row.ReviewStatus === 'SUPERSEDED').length,
                // % of the run's mapped GUI executions covered by the ACCEPTED
                // set - the number the customer actually cares about.
                approvedExecutionShare: totalRunExecutions
                    ? Math.round((approvedExecutions / totalRunExecutions) * 10000) / 100
                    : 0,
                mappedExecutionShare: run?.CoveredExecutionShare ?? null
            };
        }
        return JSON.stringify({ Items: rows, Count: rows.length, HasMore: hasMore, Summary: summary });
    });

    this.on('readProposal', async (req) => {
        const proposal = await SELECT.one.from('adops.db.AppProposals').where({ ID: req.data.proposalId });
        if (!proposal) return req.reject(404, 'Proposal not found.');
        const evidence = await SELECT.from('adops.db.ProposalEvidence')
            .where({ proposal_ID: proposal.ID }).orderBy('ExecutionCount desc');
        const comments = await SELECT.from('adops.db.ProposalComments')
            .where({ proposal_ID: proposal.ID }).orderBy('PostedAt desc');
        return JSON.stringify({ proposal, evidence, comments });
    });

    const decide = (decision) => async (req) => {
        const { proposalId, notes, targetWave } = req.data;
        const proposal = await SELECT.one.from('adops.db.AppProposals').where({ ID: proposalId });
        if (!proposal) return req.reject(404, 'Proposal not found.');
        if (decision === 'REJECTED' && !String(notes || '').trim()) {
            return req.reject(400, 'A rejection requires a reason.');
        }
        const now = new Date().toISOString();
        await UPDATE('adops.db.AppProposals').set({
            ReviewStatus: decision,
            DecidedBy: req.user?.id || null,
            DecidedAt: now,
            DecisionNotes: notes || null,
            TargetWave: targetWave || proposal.TargetWave
        }).where({ ID: proposalId });
        await INSERT.into('adops.db.AuditEvents').entries({
            ID: randomUUID(),
            TenantId: proposal.TenantId,
            Timestamp: now,
            EventType: `PROPOSAL_${decision}`,
            Severity: 'INFO',
            ObjectType: 'AppProposals',
            ObjectName: `${proposal.FioriId} ${proposal.AppTitle}`.trim(),
            ObjectId: proposalId,
            UserId: req.user?.id || '',
            Source: 'PublicService',
            Message: String(notes || '').slice(0, 500),
            BeforeValue: proposal.ReviewStatus,
            AfterValue: decision,
            CorrelationId: cds.context?.id || ''
        });
        return SELECT.one.from('adops.db.AppProposals').where({ ID: proposalId });
    };

    this.on('approveProposal', decide('APPROVED'));
    this.on('rejectProposal', decide('REJECTED'));
    this.on('deferProposal', decide('DEFERRED'));

    this.on('bulkDecideProposals', async (req) => {
        const { proposalIds = [], decision, notes } = req.data;
        const decisionMap = { APPROVED: 'approveProposal', REJECTED: 'rejectProposal', DEFERRED: 'deferProposal' };
        if (!decisionMap[decision]) return req.reject(400, 'decision must be APPROVED, REJECTED or DEFERRED.');
        const handler = decide(decision);
        const results = { decided: 0, skipped: 0 };
        for (const proposalId of proposalIds) {
            try {
                await handler({ data: { proposalId, notes }, user: req.user, reject: () => { throw new Error('skip'); } });
                results.decided += 1;
            } catch {
                results.skipped += 1;
            }
        }
        return JSON.stringify(results);
    });

    this.on('addProposalComment', async (req) => {
        const { proposalId, commentType, commentText } = req.data;
        const proposal = await SELECT.one.from('adops.db.AppProposals').where({ ID: proposalId });
        if (!proposal) return req.reject(404, 'Proposal not found.');
        if (!String(commentText || '').trim()) return req.reject(400, 'commentText is required.');
        const id = randomUUID();
        await INSERT.into('adops.db.ProposalComments').entries({
            ID: id,
            proposal_ID: proposalId,
            TenantId: proposal.TenantId,
            PostedAt: new Date().toISOString(),
            Author: req.user?.id || '',
            CommentType: commentType || 'NOTE',
            CommentText: String(commentText).slice(0, 2000)
        });
        return SELECT.one.from('adops.db.ProposalComments').where({ ID: id });
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
