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
};
