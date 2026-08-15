using {
  adops.db as db
} from '../../db/data-model';

// The business front door (/fiori). Service-level gated: every projection
// and action here requires at least the Member role; Approver/Activator
// requirements sit on the individual actions. Role-less endpoints
// (userInfo, access requests, telemetry) live on CoreService (/core) and
// must never move here.
service PublicService @(path : '/fiori', impl: 'srv/public-service', requires: ['Member', 'Approver', 'Activator', 'Admin']) {

  // --- Read surfaces --------------------------------------------------------

  entity TargetSystems as projection on db.TargetSystems;
  entity ExtractionRuns as projection on db.ExtractionRuns;
  entity UsageSnapshots as projection on db.UsageSnapshots;
  entity TransactionUsage as projection on db.TransactionUsage;
  entity UserTransactionUsage as projection on db.UserTransactionUsage;
  entity FioriUsage as projection on db.FioriUsage;
  entity UserInventory as projection on db.UserInventory;
  entity RoleInventory as projection on db.RoleInventory;
  entity RoleTransactions as projection on db.RoleTransactions;
  entity RoleUsers as projection on db.RoleUsers;
  entity BackendCatalogApps as projection on db.BackendCatalogApps;
  entity BackendLaunchpadContent as projection on db.BackendLaunchpadContent;
  @readonly entity AppMappingOverlay as projection on db.AppMappingOverlay;
  entity AnalysisRuns as projection on db.AnalysisRuns;
  entity AdoptionWaves as projection on db.AdoptionWaves;
  entity AppProposals as projection on db.AppProposals;
  entity ProposalEvidence as projection on db.ProposalEvidence;
  entity ProposalComments as projection on db.ProposalComments;
  entity ActivationPlans as projection on db.ActivationPlans;
  entity ActivationSteps as projection on db.ActivationSteps;
  entity ActivationStepMessages as projection on db.ActivationStepMessages;
  entity TransportRequests as projection on db.TransportRequests;
  entity BackgroundTasks as projection on db.BackgroundTasks;
  entity BackgroundTaskLogs as projection on db.BackgroundTaskLogs;
  @readonly entity AuditEvents as projection on db.AuditEvents;

  // --- Shared result types --------------------------------------------------

  type TargetConnectionCheck {
    Ok                 : Boolean;
    Stage              : String;   // DESTINATION | SERVICE | OK
    HttpStatus         : Integer;
    Message            : String;
    LatencyMs          : Integer;
    DestinationName    : String;
    Path               : String;
    ResolvedLocationId : String;
    TestedAt           : Timestamp;
  };

  // Async contract: every slow S/4 operation returns a TaskHandle
  // immediately; the client polls getTaskStatus at pollAfterMs cadence.
  type TaskHandle {
    taskId      : UUID;
    objectId    : UUID;     // the owning run/plan row
    status      : String;
    pollAfterMs : Integer;
  };

  type TaskStatus {
    taskId          : UUID;
    taskType        : String;
    objectType      : String;
    objectId        : String;
    status          : String;
    phase           : String;
    progressPercent : Integer;
    processedItems  : Integer;
    totalItems      : Integer;
    pollAfterMs     : Integer;
    errorText       : String;
  };

  type UsageSummaryFigures {
    totalTcodes           : Integer;
    totalExecutions       : Integer64;
    distinctUsers         : Integer;
    customShare           : Decimal(5,2);
    fioriAdoptionPercent  : Decimal(5,2);
  };

  type TransactionUsageRow {
    ID                   : UUID;
    TransactionCode      : String;
    TransactionText      : String;
    ApplicationComponent : String;
    LineOfBusiness       : String;
    ExecutionCount       : Integer64;
    DialogStepCount      : Integer64;
    DistinctUserCount    : Integer;
    AvgResponseTimeMs    : Decimal(15,2);
    SharePercent         : Decimal(5,2);
    CumulativePercent    : Decimal(5,2);
    FirstUsedOn          : Date;
    LastUsedOn           : Date;
    IsCustom             : Boolean;
  };

  type TransactionUsagePage {
    Items   : many TransactionUsageRow;
    Count   : Integer;
    HasMore : Boolean;
    Summary : UsageSummaryFigures;
  };

  // --- Connectivity / discovery --------------------------------------------

  action checkTargetSystemConnection(destinationName: String, path: String) returns TargetConnectionCheck;
  function getBackendCapabilities(targetSystemId: UUID) returns LargeString;

  // --- Extraction (async) ---------------------------------------------------

  action runUsageExtraction(
    targetSystemId: UUID,
    sources: many String,
    periodFrom: Date,
    periodTo: Date,
    granularity: String,
    topUsersPerTcode: Integer,
    minExecutions: Integer
  ) returns TaskHandle;

  // Offline bridge: ingest a ZADO_EXPORT_USAGE JSON file as an extraction
  // run - for landscapes where the Cloud Connector path is not open yet.
  action importUsageExtract(targetSystemId: UUID, payload: LargeString) returns LargeString;

  action cancelTask(taskId: UUID) returns TaskStatus;
  function getTaskStatus(taskId: UUID) returns TaskStatus;
  function listActiveTasks(targetSystemId: UUID) returns array of TaskStatus;

  // --- Usage reads (server-aggregated, purpose-built) -----------------------

  action queryTransactionUsage(
    extractionRunId: UUID,
    search: String,
    lineOfBusiness: String,
    customOnly: Boolean,
    minExecutions: Integer,
    top: Integer,
    skip: Integer,
    sortField: String,
    sortDirection: String,
    includeSummary: Boolean
  ) returns TransactionUsagePage;

  function queryUsageOverview(extractionRunId: UUID) returns LargeString;

  // --- Proposals (Phase 2) --------------------------------------------------
  // Composite reads return JSON LargeStrings: the shapes are page-specific
  // view models (typed contracts live in the services layer of the client);
  // decisions return the typed entity so OData clients see the new state.

  action generateProposals(
    extractionRunId: UUID,
    scoringProfile: String,      // BALANCED | QUICK_WINS | ADOPTION_FIRST
    minExecutions: Integer,
    includeAlreadyAdopted: Boolean
  ) returns TaskHandle;

  action queryProposals(
    analysisRunId: UUID,
    search: String,
    reviewStatus: String,
    confidence: String,
    lineOfBusiness: String,
    top: Integer,
    skip: Integer,
    includeSummary: Boolean
  ) returns LargeString;

  function readProposal(proposalId: UUID) returns LargeString;

  @(requires: 'Approver')
  action approveProposal(proposalId: UUID, notes: String, targetWave: String) returns AppProposals;
  @(requires: 'Approver')
  action rejectProposal(proposalId: UUID, notes: String) returns AppProposals;
  @(requires: 'Approver')
  action deferProposal(proposalId: UUID, notes: String, targetWave: String) returns AppProposals;
  @(requires: 'Approver')
  action bulkDecideProposals(proposalIds: many String, decision: String, notes: String) returns LargeString;

  action addProposalComment(proposalId: UUID, commentType: String, commentText: String) returns ProposalComments;

  // --- Adoption waves (Phase 3) ---------------------------------------------
  // Wave membership lives on AppProposals.wave; TargetWave (the wave Name)
  // is kept in sync for existing consumers of the string label.

  @(requires: 'Approver')
  action createAdoptionWave(
    targetSystemId: UUID,
    name: String,
    description: String,
    targetDate: Date,
    adoptLabelled: Boolean   // link proposals whose TargetWave already equals name
  ) returns AdoptionWaves;

  @(requires: 'Approver')
  action assignProposalsToWave(waveId: UUID, proposalIds: many String) returns LargeString;
  @(requires: 'Approver')
  action removeProposalsFromWave(waveId: UUID, proposalIds: many String) returns LargeString;

  // Wave list with server-side membership rollups (counts by review status,
  // approved execution share) so the list page needs no child reads.
  function queryAdoptionWaves(targetSystemId: UUID) returns LargeString;
  function readAdoptionWave(waveId: UUID) returns LargeString;

  // --- Activation planning (Phase 3) ----------------------------------------
  // createActivationPlan derives the step sequence from the wave's APPROVED
  // proposals; simulateActivationPlan is verify-first and never writes to
  // S/4 (mock-S4 runs a deterministic stub; live simulation arrives with
  // the ZADO activation read unit).
  //
  // Source and target are separate systems: analysis (the wave's proposals)
  // may come from PROD usage while the plan writes into the landscape's DEV
  // system. targetSystemId picks the write target; omitted, it defaults to
  // the wave's system when that is a permissible target, else the tenant's
  // DEV system. QA/PROD-like environments are refused.

  @(requires: 'Activator')
  action createActivationPlan(waveId: UUID, name: String, targetSystemId: UUID) returns LargeString;
  @(requires: 'Activator')
  action simulateActivationPlan(planId: UUID) returns LargeString;
  function readActivationPlan(planId: UUID) returns LargeString;

  // Execution is async (ACTIVATION_EXECUTION task, single attempt - the
  // runner never retries writes; re-invoking the action RESUMES a PARTIAL/
  // FAILED plan, completed steps are skipped). Requires a simulated plan.
  @(requires: 'Activator')
  action executeActivationPlan(planId: UUID) returns TaskHandle;

  // Step messages are fetched only when a step row is expanded (monitor
  // read discipline - never shipped with the plan read).
  function readActivationStepMessages(stepId: UUID) returns LargeString;

  // --- Transports (Phase 3) -------------------------------------------------
  // One composite read for the list page (plan/wave/system labels included);
  // release goes through the write unit's CTS step (simulate = release
  // checks only, never releases). Releasing is IRREVERSIBLE.

  function queryTransportRequests(targetSystemId: UUID) returns LargeString;
  @(requires: 'Activator')
  action releaseTransport(transportId: UUID, simulate: Boolean) returns LargeString;

  // The QA/PROD replay runbook for a plan: what arrives via transport, what
  // must be repeated per system, and how to verify each item.
  function readActivationManifest(planId: UUID) returns LargeString;
};
