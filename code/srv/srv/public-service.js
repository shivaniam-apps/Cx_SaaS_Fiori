const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');
const Logger = cds.log('public-service');
const { registerTenantScope, currentTenant } = require('./utils/tenant-scope.js');
const { checkTargetSystemConnection, getBackendCapabilities } = require('./utils/s4-fiori-adapter.js');
const { shouldMockSap } = require('./utils/s4-http-client.js');
const { enqueueTask } = require('./utils/task-runner.js');
const { appendAuditEvent } = require('./utils/audit-chain.js');
const { registerIdentifiedUsageAudit } = require('./utils/target-system-audit.js');
const { registerTargetSystemValidation } = require('./utils/target-system-validation.js');
const { shapeDashboardSummary, bucketStatuses } = require('./utils/dashboard-summary.js');

module.exports = cds.service.impl(async function () {
    registerTenantScope(this);
    registerIdentifiedUsageAudit(this);
    registerTargetSystemValidation(this);

    // --- Connectivity / discovery ------------------------------------------

    this.on('checkTargetSystemConnection', async (req) => {
        const { destinationName, path, targetSystemId } = req.data;
        if (!destinationName) return req.reject(400, 'destinationName is required.');
        // The environment decides what "healthy" means for the activation
        // endpoint (DEV: reachable, QA/PROD: unpublished), so the probe needs
        // the registered system - by ID when given, else by destination. An
        // unregistered destination gets the usage probe only.
        const targetSystem = targetSystemId
            ? await SELECT.one.from('adops.db.TargetSystems').where({ ID: targetSystemId })
            : await SELECT.one.from('adops.db.TargetSystems').where({ destinationName });
        const verdict = await checkTargetSystemConnection({
            destinationName: targetSystem?.destinationName || destinationName, path, targetSystem, req
        });
        // Persist the last verdict on the matching target system so the list
        // page shows health per endpoint without re-testing.
        await UPDATE('adops.db.TargetSystems')
            .set({
                lastCheckedAt: verdict.TestedAt,
                lastCheckStatus: verdict.Stage,
                lastCheckMessage: verdict.Message,
                lastCheckEndpointsJson: JSON.stringify(verdict.Endpoints || [])
            })
            .where(targetSystem ? { ID: targetSystem.ID } : { destinationName });
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

        // Default extraction: usage (ST03N) plus the user and role inventory
        // (USR02, AGR_*) the landscape and the proposal engine correlate on.
        const effectiveSources = (sources && sources.length ? sources : ['ST03N', 'USR02', 'AGR']).map((s) => String(s).toUpperCase());
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

    // S9: backend catalog derivation as a CATALOG_DERIVATION task on an
    // ExtractionRuns row (source CATALOG) so it shows on the Extractions page.
    this.on('deriveBackendCatalog', async (req) => {
        const { targetSystemId } = req.data;
        const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: targetSystemId });
        if (!targetSystem) return req.reject(404, 'Target system not found.');
        const runId = randomUUID();
        const today = new Date().toISOString().slice(0, 10);
        await INSERT.into('adops.db.ExtractionRuns').entries({
            ID: runId,
            targetSystem_ID: targetSystemId,
            TenantId: currentTenant(),
            Title: `Catalog ${targetSystem.displayName || targetSystem.systemId || 'System'} ${today}`,
            Status: 'QUEUED',
            SourcesJson: JSON.stringify(['CATALOG']),
            PeriodFrom: today,
            PeriodTo: today,
            PeriodGranularity: 'MONTH',
            Pseudonymised: true,
            RequestedBy: req.user?.id || null,
            CorrelationId: cds.context?.id || null
        });
        const task = await enqueueTask({
            taskType: 'CATALOG_DERIVATION',
            targetSystemId,
            objectType: 'ExtractionRuns',
            objectId: runId,
            requestedBy: req.user?.id,
            correlationId: cds.context?.id,
            payload: { targetSystemId, runId }
        });
        return { taskId: task.ID, objectId: runId, status: task.Status, pollAfterMs: 2000 };
    });

    this.on('importUsageExtract', async (req) => {
        const { targetSystemId, payload } = req.data;
        const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: targetSystemId });
        if (!targetSystem) return req.reject(404, 'Target system not found.');
        const { importUsageExtract, sanitizeExtractJson } = require('./utils/usage-extraction.js');
        let extract;
        try {
            // Sanitize first: raw SWNC fields can smuggle control bytes into
            // the exported JSON (observed on RD1), which strict parsing rejects.
            extract = JSON.parse(sanitizeExtractJson(payload));
        } catch {
            return req.reject(400, 'The file is not valid JSON.');
        }
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
        // A dashboard bucket (OPEN, APPROVED, ...) expands to its statuses so
        // the card and this slice share one expression; a raw status still
        // matches exactly.
        if (reviewStatus) where.ReviewStatus = bucketStatuses('proposals', reviewStatus) ? { in: bucketStatuses('proposals', reviewStatus) } : reviewStatus;
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
        // Wave membership: the string label stays the API surface, but when a
        // wave row of that name exists the association is linked as well.
        let waveId = proposal.wave_ID || null;
        if (targetWave) {
            const wave = await SELECT.one.from('adops.db.AdoptionWaves')
                .where({ targetSystem_ID: proposal.targetSystem_ID, Name: targetWave });
            if (wave) waveId = wave.ID;
        }
        await UPDATE('adops.db.AppProposals').set({
            ReviewStatus: decision,
            DecidedBy: req.user?.id || null,
            DecidedAt: now,
            DecisionNotes: notes || null,
            TargetWave: targetWave || proposal.TargetWave,
            wave_ID: waveId
        }).where({ ID: proposalId });
        await appendAuditEvent({
            TenantId: proposal.TenantId,
            Timestamp: now,
            EventType: `PROPOSAL_${decision}`,
            Severity: 'INFO',
            ObjectType: 'AppProposals',
            ObjectName: `${proposal.FioriId} ${proposal.AppTitle}`.trim(),
            ObjectId: proposalId,
            UserId: req.user?.id || '',
            Source: 'PublicService',
            Message: String(notes || ''),
            BeforeValue: proposal.ReviewStatus,
            AfterValue: decision
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

    // --- Adoption waves (Phase 3) -------------------------------------------

    // Membership rollups for a set of waves in ONE grouped query (list pages
    // must not do child reads). Distinct-user figures are deliberately absent:
    // summing per-proposal user counts would double-count shared users.
    const waveRollups = async (waveIds) => {
        if (!waveIds.length) return {};
        const rows = await SELECT.from('adops.db.AppProposals')
            .columns('wave_ID', 'ReviewStatus', 'count(*) as cnt', 'sum(TotalExecutions) as execSum')
            .where({ wave_ID: { in: waveIds } })
            .groupBy('wave_ID', 'ReviewStatus');
        const byWave = {};
        for (const row of rows) {
            const agg = byWave[row.wave_ID] || (byWave[row.wave_ID] = {
                appCount: 0, approved: 0, open: 0, rejected: 0, deferred: 0,
                totalExecutions: 0, approvedExecutions: 0
            });
            const cnt = Number(row.cnt) || 0;
            const execs = Number(row.execSum) || 0;
            agg.appCount += cnt;
            agg.totalExecutions += execs;
            if (row.ReviewStatus === 'APPROVED') { agg.approved += cnt; agg.approvedExecutions += execs; }
            else if (row.ReviewStatus === 'REJECTED') agg.rejected += cnt;
            else if (row.ReviewStatus === 'DEFERRED') agg.deferred += cnt;
            else agg.open += cnt;
        }
        return byWave;
    };

    this.on('createAdoptionWave', async (req) => {
        const { targetSystemId, name, description, targetDate, adoptLabelled } = req.data;
        const trimmed = String(name || '').trim();
        if (!trimmed) return req.reject(400, 'name is required.');
        const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: targetSystemId });
        if (!targetSystem) return req.reject(404, 'Target system not found.');
        const existing = await SELECT.one.from('adops.db.AdoptionWaves')
            .where({ targetSystem_ID: targetSystemId, Name: trimmed });
        if (existing) return req.reject(409, `A wave named "${trimmed}" already exists for this target system.`);

        const id = randomUUID();
        await INSERT.into('adops.db.AdoptionWaves').entries({
            ID: id,
            targetSystem_ID: targetSystemId,
            TenantId: currentTenant(),
            Name: trimmed,
            Description: description || '',
            Status: 'PLANNED',
            TargetDate: targetDate || null
        });
        if (adoptLabelled) {
            // Adopt proposals already carrying this label from the string era.
            await UPDATE('adops.db.AppProposals')
                .set({ wave_ID: id })
                .where({ targetSystem_ID: targetSystemId, TargetWave: trimmed, wave_ID: null });
        }
        return SELECT.one.from('adops.db.AdoptionWaves').where({ ID: id });
    });

    const setWaveMembership = async (req, join) => {
        const { waveId, proposalIds = [] } = req.data;
        const wave = await SELECT.one.from('adops.db.AdoptionWaves').where({ ID: waveId });
        if (!wave) return req.reject(404, 'Adoption wave not found.');
        if (!proposalIds.length) return JSON.stringify({ changed: 0 });
        const changed = await UPDATE('adops.db.AppProposals')
            .set(join
                ? { wave_ID: wave.ID, TargetWave: wave.Name }
                : { wave_ID: null, TargetWave: null })
            .where(join
                ? { ID: { in: proposalIds } }
                : { ID: { in: proposalIds }, wave_ID: wave.ID });
        return JSON.stringify({ changed: Number(changed) || 0 });
    };
    this.on('assignProposalsToWave', (req) => setWaveMembership(req, true));
    this.on('removeProposalsFromWave', (req) => setWaveMembership(req, false));

    this.on('queryAdoptionWaves', async (req) => {
        const { targetSystemId } = req.data;
        const where = targetSystemId ? { targetSystem_ID: targetSystemId } : {};
        const waves = await SELECT.from('adops.db.AdoptionWaves').where(where)
            .orderBy('SortOrder asc', 'Name asc');
        const rollups = await waveRollups(waves.map((w) => w.ID));
        const items = waves.map((w) => ({ ...w, Rollup: rollups[w.ID] || null }));
        return JSON.stringify({ Items: items, Count: items.length });
    });

    this.on('readAdoptionWave', async (req) => {
        const { waveId } = req.data;
        const wave = await SELECT.one.from('adops.db.AdoptionWaves').where({ ID: waveId });
        if (!wave) return req.reject(404, 'Adoption wave not found.');
        const proposals = await SELECT.from('adops.db.AppProposals')
            .columns('ID', 'FioriId', 'AppTitle', 'LineOfBusiness', 'Score', 'Rank', 'Confidence',
                'ReviewStatus', 'TotalExecutions', 'DistinctUserCount', 'BusinessRoleId')
            .where({ wave_ID: waveId })
            .orderBy('Rank asc');
        const plans = await SELECT.from('adops.db.ActivationPlans')
            .columns('ID', 'Name', 'Status', 'StepCount', 'SucceededCount', 'WarningCount',
                'FailedCount', 'SkippedCount', 'SimulatedAt', 'createdAt', 'targetSystem_ID')
            .where({ wave_ID: waveId })
            .orderBy('createdAt desc');
        // Label cross-system plans without a per-row read.
        const planSystemIds = [...new Set(plans.map((p) => p.targetSystem_ID).filter(Boolean))];
        if (planSystemIds.length) {
            const systems = await SELECT.from('adops.db.TargetSystems')
                .columns('ID', 'displayName', 'environment')
                .where({ ID: { in: planSystemIds } });
            const nameById = new Map(systems.map((s) => [s.ID, `${s.displayName}${s.environment ? ` (${s.environment})` : ''}`]));
            for (const plan of plans) plan.TargetSystemName = nameById.get(plan.targetSystem_ID) || '';
        }
        const rollup = (await waveRollups([waveId]))[waveId] || null;
        return JSON.stringify({ Wave: wave, Rollup: rollup, Proposals: proposals, Plans: plans });
    });

    // Deleting a wave unlinks members; it never deletes proposals or plans.
    this.before('DELETE', 'AdoptionWaves', async (req) => {
        const id = req.data.ID;
        await UPDATE('adops.db.AppProposals').set({ wave_ID: null, TargetWave: null }).where({ wave_ID: id });
        await UPDATE('adops.db.ActivationPlans').set({ wave_ID: null }).where({ wave_ID: id });
    });

    // --- Activation planning (Phase 3) --------------------------------------

    const activationPlanPayload = async (planId) => {
        const plan = await SELECT.one.from('adops.db.ActivationPlans').where({ ID: planId });
        if (!plan) return null;
        const steps = await SELECT.from('adops.db.ActivationSteps')
            .where({ plan_ID: planId }).orderBy('SequenceNo asc');
        // Labels and the plan's recent runs travel with the plan so the
        // Activation Plans page has ONE poll target while a run is active.
        const [targetSystem, wave, transport, runs] = await Promise.all([
            plan.targetSystem_ID
                ? SELECT.one.from('adops.db.TargetSystems')
                    .columns('ID', 'displayName', 'environment', 'client', 'systemId')
                    .where({ ID: plan.targetSystem_ID })
                : null,
            plan.wave_ID
                ? SELECT.one.from('adops.db.AdoptionWaves').columns('ID', 'Name', 'Status').where({ ID: plan.wave_ID })
                : null,
            plan.transportRequest_ID
                ? SELECT.one.from('adops.db.TransportRequests')
                    .columns('ID', 'TransportRequestId', 'Status').where({ ID: plan.transportRequest_ID })
                : null,
            SELECT.from('adops.db.BackgroundTasks')
                .columns('ID', 'Status', 'Phase', 'ProgressPercent', 'ProcessedItems', 'TotalItems',
                    'QueuedAt', 'ClaimedAt', 'CompletedAt', 'RequestedBy', 'CancelRequested', 'ErrorText')
                .where({ ObjectId: planId, TaskType: 'ACTIVATION_EXECUTION' })
                .orderBy('QueuedAt desc', 'createdAt desc').limit(20)
        ]);
        return { Plan: plan, Steps: steps, TargetSystem: targetSystem, Wave: wave, Transport: transport, Runs: runs };
    };

    this.on('queryActivationPlans', async (req) => {
        const { targetSystemId } = req.data;
        const where = targetSystemId ? { targetSystem_ID: targetSystemId } : {};
        const { summarizePlanStatuses, latestRunByPlan, decoratePlanRow } = require('./utils/activation-plans.js');

        // Rows are bounded; the summary is a grouped count over the SAME
        // scope so the KPI cards never disagree with the list.
        const [plans, grouped] = await Promise.all([
            SELECT.from('adops.db.ActivationPlans')
                .columns('ID', 'Name', 'Description', 'Status', 'StepCount', 'SucceededCount', 'WarningCount',
                    'FailedCount', 'SkippedCount', 'SimulatedAt', 'SimulatedBy', 'ExecutedAt', 'ExecutedBy',
                    'createdAt', 'createdBy', 'wave_ID', 'targetSystem_ID', 'transportRequest_ID')
                .where(where).orderBy('createdAt desc').limit(200),
            SELECT.from('adops.db.ActivationPlans').columns('Status', 'count(*) as cnt')
                .where(where).groupBy('Status')
        ]);

        // Labels in one pass per entity - the list page must not do child reads.
        const planIds = plans.map((p) => p.ID);
        const waveIds = [...new Set(plans.map((p) => p.wave_ID).filter(Boolean))];
        const systemIds = [...new Set(plans.map((p) => p.targetSystem_ID).filter(Boolean))];
        const transportIds = [...new Set(plans.map((p) => p.transportRequest_ID).filter(Boolean))];
        const [waves, systems, transports, tasks] = await Promise.all([
            waveIds.length
                ? SELECT.from('adops.db.AdoptionWaves').columns('ID', 'Name').where({ ID: { in: waveIds } })
                : [],
            systemIds.length
                ? SELECT.from('adops.db.TargetSystems').columns('ID', 'displayName', 'environment', 'systemId').where({ ID: { in: systemIds } })
                : [],
            transportIds.length
                ? SELECT.from('adops.db.TransportRequests').columns('ID', 'TransportRequestId').where({ ID: { in: transportIds } })
                : [],
            planIds.length
                ? SELECT.from('adops.db.BackgroundTasks').columns('ID', 'ObjectId', 'Status', 'QueuedAt', 'createdAt')
                    .where({ ObjectId: { in: planIds }, TaskType: 'ACTIVATION_EXECUTION' })
                : []
        ]);
        const waveById = new Map(waves.map((w) => [w.ID, w]));
        const systemById = new Map(systems.map((s) => [s.ID, s]));
        const transportById = new Map(transports.map((t) => [t.ID, t]));
        const runByPlan = latestRunByPlan(tasks);

        const items = plans.map((plan) => decoratePlanRow(plan, {
            wave: waveById.get(plan.wave_ID) || null,
            system: systemById.get(plan.targetSystem_ID) || null,
            transport: transportById.get(plan.transportRequest_ID) || null,
            run: runByPlan.get(plan.ID) || null
        }));
        return JSON.stringify({ Items: items, Count: items.length, Summary: summarizePlanStatuses(grouped) });
    });

    this.on('createActivationPlan', async (req) => {
        const { waveId, name, targetSystemId } = req.data;
        const wave = await SELECT.one.from('adops.db.AdoptionWaves').where({ ID: waveId });
        if (!wave) return req.reject(404, 'Adoption wave not found.');
        const approved = await SELECT.from('adops.db.AppProposals')
            .where({ wave_ID: waveId, ReviewStatus: 'APPROVED' })
            .orderBy('Rank asc');
        if (!approved.length) return req.reject(400, 'The wave has no approved proposals - approve apps before planning activation.');

        const { deriveActivationSteps, isActivationTargetEnvironment } = require('./utils/activation-plan.js');

        // Source != target: the wave's proposals may be scored from PROD
        // usage, but activation writes go to a DEV system. Explicit choice
        // wins; the default prefers the wave's own system when permissible,
        // else the tenant's DEV/SANDBOX system.
        let target;
        if (targetSystemId) {
            target = await SELECT.one.from('adops.db.TargetSystems').where({ ID: targetSystemId });
            if (!target) return req.reject(404, 'Target system not found.');
        } else {
            const waveSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: wave.targetSystem_ID });
            if (waveSystem && isActivationTargetEnvironment(waveSystem.environment)) {
                target = waveSystem;
            } else {
                const candidates = await SELECT.from('adops.db.TargetSystems')
                    .where({ environment: { in: ['DEV', 'SANDBOX'] }, active: true })
                    .orderBy('isDefault desc', 'displayName asc');
                target = candidates[0];
            }
            if (!target) {
                return req.reject(400, 'No permissible activation target found - pass targetSystemId for a DEV system.');
            }
        }
        if (!isActivationTargetEnvironment(target.environment)) {
            return req.reject(400, `Target system "${target.displayName}" is ${target.environment} - activation plans write to development systems only; QA/PROD receive the content via transport.`);
        }

        // ICF nodes are addressed by BSP application - catalog truth per
        // target system (BackendCatalogApps, filled by catalog derivation).
        // Apps without a row get an empty url on purpose: the ABAP dispatcher
        // fails that step fast (docu/09-activation-and-transport/object-key-contract.md).
        const fioriIds = [...new Set(approved.map((p) => p.FioriId).filter(Boolean))];
        const catalogRows = fioriIds.length
            ? await SELECT.from('adops.db.BackendCatalogApps')
                .columns('FioriId', 'BspApplication')
                .where({ targetSystem_ID: target.ID, FioriId: { in: fioriIds } })
            : [];
        const bspByFioriId = new Map(catalogRows.filter((r) => r.BspApplication).map((r) => [r.FioriId, r.BspApplication]));
        const proposals = approved.map((p) => ({ ...p, BspApplication: bspByFioriId.get(p.FioriId) || '' }));
        const { steps, spaceId, roleName } = deriveActivationSteps({ proposals, waveName: wave.Name });

        const crossSystem = target.ID !== wave.targetSystem_ID;
        const planId = randomUUID();
        await INSERT.into('adops.db.ActivationPlans').entries({
            ID: planId,
            targetSystem_ID: target.ID,
            wave_ID: wave.ID,
            analysisRun_ID: approved[0].analysisRun_ID,
            TenantId: currentTenant(),
            Name: String(name || '').trim() || `Activation of ${wave.Name}`,
            Description: `Derived from ${approved.length} approved proposal(s) of wave "${wave.Name}"`
                + `${crossSystem ? ` (usage source differs; writes target ${target.displayName})` : ''}.`,
            Status: 'DRAFT',
            SpaceId: spaceId,
            SpaceTitle: wave.Name,
            RoleNamePattern: roleName,
            AssignUsers: false,
            StopOnError: true,
            StepCount: steps.length
        });
        await INSERT.into('adops.db.ActivationSteps').entries(steps.map((s) => ({
            ...s, plan_ID: planId, TenantId: currentTenant()
        })));
        Logger.info(`Activation plan ${planId} derived from wave ${wave.Name}: ${steps.length} steps.`);
        return JSON.stringify(await activationPlanPayload(planId));
    });

    this.on('simulateActivationPlan', async (req) => {
        const { planId } = req.data;
        const plan = await SELECT.one.from('adops.db.ActivationPlans').where({ ID: planId });
        if (!plan) return req.reject(404, 'Activation plan not found.');
        if (!['DRAFT', 'SIMULATED'].includes(plan.Status)) {
            return req.reject(400, `Plan is ${plan.Status}; simulation runs on DRAFT or SIMULATED plans.`);
        }
        // Live mode probes the DEV system's real state through the write
        // unit's read-only probe (ZCL_ADO_ACT_PROBE): existing objects are
        // reported as existsAlready, steps without an executor as BLOCKED.
        // Without a routable target system the simulation stays structural
        // and every message says so - nothing may claim to exist unprobed.
        const { simulateSteps, mockSimulationProbe } = require('./utils/activation-plan.js');
        let probe = mockSimulationProbe;
        if (!shouldMockSap()) {
            const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: plan.targetSystem_ID });
            if (targetSystem?.destinationName) {
                const { liveSimulationProbeFor } = require('./utils/s4-activate-adapter.js');
                probe = liveSimulationProbeFor(targetSystem);
            } else {
                probe = (step) => {
                    const verdict = mockSimulationProbe(step);
                    return {
                        ...verdict,
                        existsAlready: false,
                        message: `${verdict.message} [offline simulation - the target system has no BTP destination, backend state not probed]`
                    };
                };
            }
        }
        const steps = await SELECT.from('adops.db.ActivationSteps')
            .where({ plan_ID: planId }).orderBy('SequenceNo asc');
        const { steps: verdicts, rollup } = await simulateSteps(steps, probe);
        for (const v of verdicts) {
            await UPDATE('adops.db.ActivationSteps')
                .set({ Status: v.Status, ExistsAlready: v.ExistsAlready, SimulationMessage: v.SimulationMessage })
                .where({ ID: v.ID });
        }
        await UPDATE('adops.db.ActivationPlans').set({
            Status: 'SIMULATED',
            SimulatedAt: new Date().toISOString(),
            SimulatedBy: req.user?.id || null,
            ...rollup
        }).where({ ID: planId });
        return JSON.stringify(await activationPlanPayload(planId));
    });

    this.on('readActivationPlan', async (req) => {
        const payload = await activationPlanPayload(req.data.planId);
        if (!payload) return req.reject(404, 'Activation plan not found.');
        return JSON.stringify(payload);
    });

    this.on('executeActivationPlan', async (req) => {
        const { planId } = req.data;
        const plan = await SELECT.one.from('adops.db.ActivationPlans').where({ ID: planId });
        if (!plan) return req.reject(404, 'Activation plan not found.');

        const { EXECUTABLE_PLAN_STATES } = require('./utils/activation-execution.js');
        if (plan.Status === 'DRAFT') {
            return req.reject(400, 'Simulate the plan first - execution needs the blast-radius verdicts.');
        }
        if (!EXECUTABLE_PLAN_STATES.includes(plan.Status) && plan.Status !== 'EXECUTING') {
            return req.reject(400, `Plan is ${plan.Status}; execution needs one of ${EXECUTABLE_PLAN_STATES.join('/')}.`);
        }
        if (!shouldMockSap()) {
            // Live mode needs a routable target system; the DEV-only ICF node
            // (ZCL_ADO_ACT_HTTP) is reached through its BTP destination.
            const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: plan.targetSystem_ID });
            if (!targetSystem?.destinationName) {
                return req.reject(400, 'Live execution needs a target system with a configured BTP destination.');
            }
        }

        // Idempotent start: while a task for this plan is still active,
        // return its handle instead of enqueuing a duplicate.
        const active = await SELECT.one.from('adops.db.BackgroundTasks')
            .where({ ObjectId: planId, TaskType: 'ACTIVATION_EXECUTION', Status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] } });
        if (active) {
            return { taskId: active.ID, objectId: planId, status: active.Status, pollAfterMs: 2000 };
        }
        if (plan.Status === 'EXECUTING') {
            // EXECUTING without an active task = a dead worker; allow resume.
            await UPDATE('adops.db.ActivationPlans').set({ Status: 'PARTIAL' }).where({ ID: planId });
        }

        const task = await enqueueTask({
            taskType: 'ACTIVATION_EXECUTION',
            targetSystemId: plan.targetSystem_ID,
            objectType: 'ActivationPlans',
            objectId: planId,
            requestedBy: req.user?.id,
            correlationId: cds.context?.id,
            payload: { planId, executedBy: req.user?.id }
        });
        return { taskId: task.ID, objectId: planId, status: task.Status, pollAfterMs: 2000 };
    });

    // --- Transports (Phase 3) ------------------------------------------------

    // The QA/PROD replay manifest of a plan (null when the plan does not
    // exist); shared by readActivationManifest and the S10 verification.
    async function manifestForPlan(planId) {
        const plan = await SELECT.one.from('adops.db.ActivationPlans').where({ ID: planId });
        if (!plan) return null;
        const steps = await SELECT.from('adops.db.ActivationSteps')
            .where({ plan_ID: planId }).orderBy('SequenceNo asc');
        const wave = plan.wave_ID ? await SELECT.one.from('adops.db.AdoptionWaves').where({ ID: plan.wave_ID }) : null;
        const targetSystem = plan.targetSystem_ID
            ? await SELECT.one.from('adops.db.TargetSystems').where({ ID: plan.targetSystem_ID })
            : null;
        const transport = plan.transportRequest_ID
            ? await SELECT.one.from('adops.db.TransportRequests').where({ ID: plan.transportRequest_ID })
            : null;
        const { buildActivationManifest } = require('./utils/activation-manifest.js');
        return buildActivationManifest({ plan, steps, wave, targetSystem, transport });
    }

    this.on('queryTransportRequests', async (req) => {
        const { targetSystemId, status } = req.data;
        const where = targetSystemId ? { targetSystem_ID: targetSystemId } : {};
        // Optional dashboard bucket (OPEN | RELEASED | FAILED): the same
        // expression the cockpit counted with.
        if (status) {
            const statuses = bucketStatuses('transports', status);
            if (!statuses) return req.reject(400, `Unknown transport status bucket: ${status}`);
            where.Status = { in: statuses };
        }
        const rows = await SELECT.from('adops.db.TransportRequests').where(where)
            .orderBy('createdAt desc').limit(200);

        // Labels in one pass - the list page must not do child reads.
        const planIds = [...new Set(rows.map((r) => r.plan_ID).filter(Boolean))];
        const systemIds = [...new Set(rows.map((r) => r.targetSystem_ID).filter(Boolean))];
        const plans = planIds.length
            ? await SELECT.from('adops.db.ActivationPlans').columns('ID', 'Name', 'wave_ID').where({ ID: { in: planIds } })
            : [];
        const waveIds = [...new Set(plans.map((p) => p.wave_ID).filter(Boolean))];
        const waves = waveIds.length
            ? await SELECT.from('adops.db.AdoptionWaves').columns('ID', 'Name').where({ ID: { in: waveIds } })
            : [];
        const systems = systemIds.length
            ? await SELECT.from('adops.db.TargetSystems').columns('ID', 'displayName', 'environment').where({ ID: { in: systemIds } })
            : [];
        const planById = new Map(plans.map((p) => [p.ID, p]));
        const waveById = new Map(waves.map((w) => [w.ID, w]));
        const systemById = new Map(systems.map((s) => [s.ID, s]));

        // S10: the import rows of these requests (one read, verification
        // payload left out - readTransportImport carries it) and the systems
        // a request can be verified on: every active registered system; the
        // client hides the request's own source system.
        const transportIds = rows.map((r) => r.ID);
        const importRows = transportIds.length
            ? await SELECT.from('adops.db.TransportImports')
                .columns('ID', 'transport_ID', 'targetSystem_ID', 'ImportStatus', 'Source', 'RequestStatus', 'ObjectCount',
                    'ImportedAt', 'CheckedAt', 'CheckedBy', 'Note', 'VerifiedAt', 'VerifiedCount', 'NotFoundCount',
                    'ManualCount', 'UnknownCount')
                .where({ transport_ID: { in: transportIds } }).orderBy('CheckedAt desc')
            : [];
        // followOnSystem_ID carries the tenant's transport route (O13); the
        // client walks it from a request's source to preselect the next hop.
        const followOnSystems = await SELECT.from('adops.db.TargetSystems')
            .columns('ID', 'displayName', 'environment', 'active', 'followOnSystem_ID').orderBy('displayName asc');
        const labelOf = (system) => (system ? `${system.displayName}${system.environment ? ` (${system.environment})` : ''}` : '');
        const followOnById = new Map(followOnSystems.map((s) => [s.ID, s]));
        const importsByTransport = new Map();
        for (const imp of importRows) {
            const list = importsByTransport.get(imp.transport_ID) || [];
            list.push({ ...imp, TargetSystemName: labelOf(followOnById.get(imp.targetSystem_ID)) });
            importsByTransport.set(imp.transport_ID, list);
        }

        const items = rows.map((row) => {
            const plan = planById.get(row.plan_ID);
            const system = systemById.get(row.targetSystem_ID);
            return {
                ...row,
                PlanName: plan?.Name || '',
                WaveName: plan?.wave_ID ? (waveById.get(plan.wave_ID)?.Name || '') : '',
                TargetSystemName: labelOf(system),
                Imports: importsByTransport.get(row.ID) || []
            };
        });
        return JSON.stringify({
            Items: items,
            Count: items.length,
            FollowOnSystems: followOnSystems
                .filter((s) => s.active !== false)
                .map((s) => ({ ID: s.ID, displayName: s.displayName, environment: s.environment || '', followOnSystem_ID: s.followOnSystem_ID || null }))
        });
    });

    this.on('releaseTransport', async (req) => {
        const { transportId, simulate } = req.data;
        const transport = await SELECT.one.from('adops.db.TransportRequests').where({ ID: transportId });
        if (!transport) return req.reject(404, 'Transport request not found.');
        if (!transport.TransportRequestId) return req.reject(400, 'The row carries no TRKORR.');
        if (transport.Status === 'RELEASED' && !simulate) {
            return JSON.stringify({ Status: 'RELEASED', Messages: [{ type: 'S', message: `${transport.TransportRequestId} is already released.` }] });
        }

        // The release IS a write-unit step (ADD_TO_TRANSPORT with a TRKORR
        // dispatches to release in ZCL_ADO_ACTIVATE); mock mode answers
        // deterministically, live mode goes through the adapter.
        let result;
        if (shouldMockSap()) {
            result = {
                status: 'SUCCESS',
                messages: [{
                    type: 'S',
                    message: simulate
                        ? `Release simulation for ${transport.TransportRequestId} passed - nothing released (mock).`
                        : `${transport.TransportRequestId} released (mock).`
                }]
            };
        } else {
            const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: transport.targetSystem_ID });
            if (!targetSystem?.destinationName) return req.reject(400, 'The transport\'s target system has no destination.');
            const { executeStepRemote } = require('./utils/s4-activate-adapter.js');
            const { objectKeyJson } = require('./utils/activation-plan.js');
            result = await executeStepRemote({
                targetSystem,
                step: {
                    StepType: 'ADD_TO_TRANSPORT',
                    ObjectKeyJson: objectKeyJson('ADD_TO_TRANSPORT', { trkorr: transport.TransportRequestId, simulation: Boolean(simulate) })
                }
            });
        }

        const messageText = (result.messages || []).map((m) => `[${m.type}] ${m.message}`).join('\n');
        if (!simulate) {
            const released = ['SUCCESS', 'SKIPPED'].includes(result.status);
            await UPDATE('adops.db.TransportRequests').set({
                Status: released ? 'RELEASED' : 'RELEASE_FAILED',
                ReleasedAt: released ? new Date().toISOString() : null,
                ReleasedBy: released ? (req.user?.id || null) : null,
                ReleaseLogText: messageText
            }).where({ ID: transportId });
        }
        const fresh = await SELECT.one.from('adops.db.TransportRequests').where({ ID: transportId });
        return JSON.stringify({ Status: fresh.Status, Simulated: Boolean(simulate), StepStatus: result.status, Messages: result.messages || [] });
    });

    // --- Transport verification on follow-on systems (S10) ----------------------
    // Read-only towards S/4: the read unit answers E070 (TransportStatus) and
    // AGR_DEFINE (RoleInventory) on QA/PROD; the write unit is never touched.

    const {
        verifyTransportImport, mockReaders, importRowFrom, operatorRowFrom, RECORDABLE_IMPORT_STATUSES
    } = require('./utils/transport-verification.js');

    const loadTransportAndFollowOn = async (req, { transportId, targetSystemId }) => {
        const transport = await SELECT.one.from('adops.db.TransportRequests').where({ ID: transportId });
        if (!transport) return req.reject(404, 'Transport request not found.');
        if (!transport.TransportRequestId) return req.reject(400, 'The row carries no TRKORR.');
        const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: targetSystemId });
        if (!targetSystem) return req.reject(404, 'Target system not found.');
        if (targetSystem.ID === transport.targetSystem_ID) {
            return req.reject(400, `${targetSystem.displayName} is the source system of ${transport.TransportRequestId} - verify on the follow-on system (QA, PROD) the request was imported into.`);
        }
        return { transport, targetSystem };
    };

    // One row per transport and follow-on system; a re-check overwrites it.
    const upsertTransportImport = async ({ transport, targetSystem, fields }) => {
        const existing = await SELECT.one.from('adops.db.TransportImports')
            .where({ transport_ID: transport.ID, targetSystem_ID: targetSystem.ID });
        if (existing) {
            await UPDATE('adops.db.TransportImports').set(fields).where({ ID: existing.ID });
            return { previousStatus: existing.ImportStatus || '', row: await SELECT.one.from('adops.db.TransportImports').where({ ID: existing.ID }) };
        }
        const id = randomUUID();
        await INSERT.into('adops.db.TransportImports').entries({
            ID: id, TenantId: currentTenant(), transport_ID: transport.ID, targetSystem_ID: targetSystem.ID, ...fields
        });
        return { previousStatus: '', row: await SELECT.one.from('adops.db.TransportImports').where({ ID: id }) };
    };

    const importView = (row) => {
        if (!row) return null;
        const { VerificationJson, ...rest } = row;
        let verification = null;
        try {
            verification = VerificationJson ? JSON.parse(VerificationJson) : null;
        } catch {
            verification = null;
        }
        return { ...rest, Verification: verification };
    };

    const importAudit = ({ req, eventType, transport, targetSystem, previousStatus, row, message }) => appendAuditEvent({
        Timestamp: new Date().toISOString(),
        EventType: eventType,
        Severity: row.ImportStatus === 'IMPORT_FAILED' ? 'WARN' : 'INFO',
        ObjectType: 'TransportRequests',
        ObjectName: `${transport.TransportRequestId} on ${targetSystem.displayName}`,
        ObjectId: transport.ID,
        UserId: req.user?.id || '',
        Source: 'PublicService',
        Message: String(message || ''),
        BeforeValue: previousStatus || '',
        AfterValue: row.ImportStatus || ''
    });

    this.on('verifyTransportImport', async (req) => {
        const { transport, targetSystem } = await loadTransportAndFollowOn(req, req.data);
        const manifest = transport.plan_ID ? await manifestForPlan(transport.plan_ID) : null;

        let readers;
        if (shouldMockSap()) {
            readers = mockReaders({ transport });
        } else {
            if (!targetSystem.destinationName) {
                return req.reject(400, `${targetSystem.displayName} has no BTP destination - record the import by hand instead.`);
            }
            const { fetchTransportStatus, fetchRolesByName } = require('./utils/s4-fiori-adapter.js');
            readers = {
                readTransportStatus: ({ targetSystem: system, trkorr }) => fetchTransportStatus({ targetSystem: system, trkorr, req }),
                readRoles: ({ targetSystem: system, roleNames }) => fetchRolesByName({ targetSystem: system, roleNames, req })
            };
        }

        const result = await verifyTransportImport({ transport, targetSystem, manifest, readers });
        const { previousStatus, row } = await upsertTransportImport({
            transport, targetSystem, fields: importRowFrom({ result, checkedBy: req.user?.id })
        });
        await importAudit({
            req, eventType: 'TRANSPORT_IMPORT_CHECKED', transport, targetSystem, previousStatus, row, message: result.importStatus.detail
        });
        return JSON.stringify({ Import: importView(row), TransportStatus: result.transportStatus.row || null, Verification: result.verification });
    });

    this.on('recordTransportImport', async (req) => {
        const status = String(req.data.status || '').trim().toUpperCase();
        if (!RECORDABLE_IMPORT_STATUSES.includes(status)) {
            return req.reject(400, `status must be one of ${RECORDABLE_IMPORT_STATUSES.join(', ')}.`);
        }
        const { transport, targetSystem } = await loadTransportAndFollowOn(req, req.data);
        const { previousStatus, row } = await upsertTransportImport({
            transport, targetSystem, fields: operatorRowFrom({ status, note: req.data.note, checkedBy: req.user?.id })
        });
        await importAudit({
            req, eventType: 'TRANSPORT_IMPORT_RECORDED', transport, targetSystem, previousStatus, row, message: row.Note || ''
        });
        return JSON.stringify({ Import: importView(row) });
    });

    this.on('readTransportImport', async (req) => {
        const { transportId, targetSystemId } = req.data;
        const row = await SELECT.one.from('adops.db.TransportImports')
            .where({ transport_ID: transportId, targetSystem_ID: targetSystemId });
        return JSON.stringify({ Import: importView(row) });
    });

    // --- Operator decisions on steps (S5) ----------------------------------------

    const {
        skipStepAllowed, rollbackStepAllowed, applyOperatorSkip, applyOperatorRollback
    } = require('./utils/activation-operator.js');

    const loadStepAndPlan = async (stepId) => {
        const step = await SELECT.one.from('adops.db.ActivationSteps').where({ ID: stepId });
        const plan = step ? await SELECT.one.from('adops.db.ActivationPlans').where({ ID: step.plan_ID }) : null;
        return { step, plan };
    };

    this.on('skipActivationStep', async (req) => {
        const { stepId, reason } = req.data;
        const { step, plan } = await loadStepAndPlan(stepId);
        if (!step || !plan) return req.reject(404, 'Activation step not found.');
        const verdict = skipStepAllowed(step, plan);
        if (!verdict.ok) return req.reject(400, verdict.reason);
        return JSON.stringify(await applyOperatorSkip({ step, plan, reason, user: req.user?.id }));
    });

    this.on('rollbackActivationStep', async (req) => {
        const { stepId, reason } = req.data;
        const { step, plan } = await loadStepAndPlan(stepId);
        if (!step || !plan) return req.reject(404, 'Activation step not found.');
        const verdict = rollbackStepAllowed(step, plan);
        if (!verdict.ok) return req.reject(400, verdict.reason);

        // One write-unit step, synchronous like releaseTransport: mock mode
        // answers deterministically, live mode goes through the adapter.
        const { mockStepExecutor } = require('./utils/activation-execution.js');
        let executor = mockStepExecutor;
        let systemId = 'MCK';
        if (!shouldMockSap() && verdict.mode === 'EXECUTE') {
            const targetSystem = await SELECT.one.from('adops.db.TargetSystems').where({ ID: plan.targetSystem_ID });
            if (!targetSystem?.destinationName) return req.reject(400, 'Rollback needs a target system with a configured BTP destination.');
            const { liveStepExecutorFor } = require('./utils/s4-activate-adapter.js');
            executor = liveStepExecutorFor(targetSystem);
            systemId = targetSystem.systemId || targetSystem.displayName || '';
        }
        return JSON.stringify(await applyOperatorRollback({ step, plan, reason, user: req.user?.id, executor, systemId }));
    });

    // --- Activation runs (monitor) ---------------------------------------------

    const { decorateRun, summarizeRunStatuses, statusesForRunBucket } = require('./utils/activation-runs.js');

    // Task columns the monitor needs - ResultJson is projected to Outcome by
    // decorateRun, never returned raw (it also carries the enqueue payload).
    const RUN_TASK_COLUMNS = [
        'ID', 'targetSystem_ID', 'ObjectId', 'Status', 'Phase', 'ProgressPercent', 'ProcessedItems',
        'TotalItems', 'QueuedAt', 'ClaimedAt', 'CompletedAt', 'RequestedBy', 'AttemptCount',
        'CancelRequested', 'ErrorText', 'ResultJson', 'createdAt'
    ];

    // Labels for a set of runs in one pass per entity (plan -> wave/transport,
    // system). Shared by the list and the detail read.
    const runLabelMaps = async (tasks) => {
        const planIds = [...new Set(tasks.map((t) => t.ObjectId).filter(Boolean))];
        const plans = planIds.length
            ? await SELECT.from('adops.db.ActivationPlans')
                .columns('ID', 'Name', 'Status', 'StepCount', 'wave_ID', 'targetSystem_ID', 'transportRequest_ID')
                .where({ ID: { in: planIds } })
            : [];
        const waveIds = [...new Set(plans.map((p) => p.wave_ID).filter(Boolean))];
        const transportIds = [...new Set(plans.map((p) => p.transportRequest_ID).filter(Boolean))];
        const systemIds = [...new Set([
            ...tasks.map((t) => t.targetSystem_ID),
            ...plans.map((p) => p.targetSystem_ID)
        ].filter(Boolean))];
        const [waves, transports, systems] = await Promise.all([
            waveIds.length
                ? SELECT.from('adops.db.AdoptionWaves').columns('ID', 'Name').where({ ID: { in: waveIds } })
                : [],
            transportIds.length
                ? SELECT.from('adops.db.TransportRequests').columns('ID', 'TransportRequestId').where({ ID: { in: transportIds } })
                : [],
            systemIds.length
                ? SELECT.from('adops.db.TargetSystems').columns('ID', 'displayName', 'environment', 'systemId', 'client').where({ ID: { in: systemIds } })
                : []
        ]);
        const planById = new Map(plans.map((p) => [p.ID, p]));
        const waveById = new Map(waves.map((w) => [w.ID, w]));
        const transportById = new Map(transports.map((t) => [t.ID, t]));
        const systemById = new Map(systems.map((s) => [s.ID, s]));
        return (task) => {
            const plan = planById.get(task.ObjectId) || null;
            return {
                plan,
                wave: plan?.wave_ID ? waveById.get(plan.wave_ID) || null : null,
                transport: plan?.transportRequest_ID ? transportById.get(plan.transportRequest_ID) || null : null,
                system: systemById.get(task.targetSystem_ID || plan?.targetSystem_ID) || null
            };
        };
    };

    this.on('queryActivationRuns', async (req) => {
        const { targetSystemId, status } = req.data;
        const where = { TaskType: 'ACTIVATION_EXECUTION' };
        if (targetSystemId) where.targetSystem_ID = targetSystemId;
        // Optional status bucket for the list; the summary stays the partition
        // over the system scope, so the card that was clicked equals the slice.
        const bucket = status ? statusesForRunBucket(status) : null;
        if (status && !bucket) return req.reject(400, `Unknown run status bucket: ${status}`);

        // Rows are bounded; the summary is a grouped count over the SAME
        // scope so the KPI cards never disagree with the list.
        const [tasks, grouped] = await Promise.all([
            SELECT.from('adops.db.BackgroundTasks').columns(...RUN_TASK_COLUMNS)
                .where(bucket ? { ...where, Status: { in: bucket } } : where)
                .orderBy('QueuedAt desc', 'createdAt desc').limit(200),
            SELECT.from('adops.db.BackgroundTasks').columns('Status', 'count(*) as cnt')
                .where(where).groupBy('Status')
        ]);
        const labelsFor = await runLabelMaps(tasks);
        const items = tasks.map((task) => decorateRun(task, labelsFor(task)));
        return JSON.stringify({ Items: items, Count: items.length, Summary: summarizeRunStatuses(grouped) });
    });

    this.on('readActivationRun', async (req) => {
        const { runId } = req.data;
        const task = await SELECT.one.from('adops.db.BackgroundTasks').columns(...RUN_TASK_COLUMNS)
            .where({ ID: runId, TaskType: 'ACTIVATION_EXECUTION' });
        if (!task) return req.reject(404, 'Activation run not found.');

        const labelsFor = await runLabelMaps([task]);
        const labels = labelsFor(task);
        const [steps, logs] = await Promise.all([
            labels.plan
                ? SELECT.from('adops.db.ActivationSteps')
                    .columns('ID', 'SequenceNo', 'StepGroup', 'StepType', 'ObjectType', 'ObjectName', 'Status',
                        'ExistsAlready', 'Transportable', 'LocalReplay', 'Reversible', 'IsDestructive',
                        'SimulationMessage', 'StartedAt', 'CompletedAt', 'DurationMs', 'RetryCount', 'dependsOn_ID',
                        'OperatorAction', 'OperatorNote', 'OperatorBy')
                    .where({ plan_ID: labels.plan.ID }).orderBy('SequenceNo asc')
                : [],
            SELECT.from('adops.db.BackgroundTaskLogs')
                .columns('ID', 'LoggedAt', 'Severity', 'Phase', 'Message')
                .where({ task_ID: runId }).orderBy('LoggedAt asc', 'createdAt asc').limit(500)
        ]);
        return JSON.stringify({
            Run: decorateRun(task, labels),
            Plan: labels.plan,
            Steps: steps,
            Logs: logs,
            TargetSystem: labels.system
        });
    });

    this.on('readActivationManifest', async (req) => {
        const manifest = await manifestForPlan(req.data.planId);
        if (!manifest) return req.reject(404, 'Activation plan not found.');
        const { renderManifestMarkdown } = require('./utils/activation-manifest.js');
        return JSON.stringify({ Manifest: manifest, Markdown: renderManifestMarkdown(manifest) });
    });

    this.on('readActivationStepMessages', async (req) => {
        const { stepId } = req.data;
        const step = await SELECT.one.from('adops.db.ActivationSteps').where({ ID: stepId });
        if (!step) return req.reject(404, 'Activation step not found.');
        const messages = await SELECT.from('adops.db.ActivationStepMessages')
            .columns('ID', 'Sequence', 'MessageType', 'MessageText', 'ObjectName')
            .where({ step_ID: stepId })
            .orderBy('Sequence asc');
        return JSON.stringify({ StepId: stepId, Messages: messages });
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

    // --- Adoption Cockpit (O8) ------------------------------------------------
    // One read, eight grouped counts at the database (tenant scope is added
    // by registerTenantScope), nothing row-level leaves the server.
    this.on('queryDashboardSummary', async (req) => {
        const { targetSystemId } = req.data;
        const scoped = targetSystemId ? { targetSystem_ID: targetSystemId } : {};
        const grouped = (entity, field, where) => {
            const query = SELECT.from(entity).columns(field, 'count(*) as cnt');
            return (where && Object.keys(where).length ? query.where(where) : query).groupBy(field);
        };

        // Proposals: the current analysis run per target system in scope
        // (latest COMPLETED), so the figures match what the Proposals page
        // opens by default instead of summing every historical run.
        const completedRuns = await SELECT.from('adops.db.AnalysisRuns')
            .columns('ID', 'targetSystem_ID', 'CompletedAt', 'createdAt')
            .where({ ...scoped, Status: 'COMPLETED' })
            .orderBy('CompletedAt desc', 'createdAt desc');
        const currentRunBySystem = new Map();
        for (const run of completedRuns) {
            const key = run.targetSystem_ID || '';
            if (!currentRunBySystem.has(key)) currentRunBySystem.set(key, run.ID);
        }
        const analysisRunIds = [...currentRunBySystem.values()];

        const [systems, extractions, analyses, proposals, waves, plans, runs, transports] = await Promise.all([
            grouped('adops.db.TargetSystems', 'lastCheckStatus', targetSystemId ? { ID: targetSystemId } : {}),
            grouped('adops.db.ExtractionRuns', 'Status', scoped),
            grouped('adops.db.AnalysisRuns', 'Status', scoped),
            analysisRunIds.length
                ? grouped('adops.db.AppProposals', 'ReviewStatus', { analysisRun_ID: { in: analysisRunIds } })
                : [],
            grouped('adops.db.AdoptionWaves', 'Status', scoped),
            grouped('adops.db.ActivationPlans', 'Status', scoped),
            grouped('adops.db.BackgroundTasks', 'Status', { ...scoped, TaskType: 'ACTIVATION_EXECUTION' }),
            grouped('adops.db.TransportRequests', 'Status', scoped)
        ]);
        return JSON.stringify(shapeDashboardSummary(
            { systems, extractions, analyses, proposals, waves, plans, runs, transports },
            { targetSystemId: targetSystemId || null, analysisRunIds }
        ));
    });
});
