using {
  adops.db as db,
  adops.common as common
} from '../../db/data-model';

// Administration data (target systems, overlay curation, user/role
// management, telemetry triage) requires the Admin scope from
// xs-security.json. Admin deliberately does NOT imply Activator: writing
// PFCG roles into a customer's S/4 is a separate job from administering
// the SaaS. Local dev users: srv/.cdsrc.json [development] and the [hybrid]
// mocked users in package.json give alice all four roles.
service AdminService @(path : '/catalog/AdminService', impl: 'srv/admin-service', requires: 'Admin') {

  entity TargetSystems as projection on db.TargetSystems;

  // Curated tcode -> Fiori app overlay. SHIPPED rows are product content
  // (boot-upserted, read-only in the UI); CUSTOMER rows are tenant curation.
  entity AppMappingOverlay as projection on db.AppMappingOverlay;

  entity BackgroundTasks as projection on db.BackgroundTasks;
  entity BackgroundTaskLogs as projection on db.BackgroundTaskLogs;
  entity AuditEvents as projection on db.AuditEvents;

  entity Users as select from db.Users {
    *,
    (firstName || ' ' || lastName) as fullName : String
  } excluding {
    createdAt, createdBy, modifiedAt, modifiedBy,
    iasLocation, shadowId
  };

  entity Roles as projection on db.Roles excluding {
    createdAt, createdBy, modifiedAt, modifiedBy
  };

  entity SharedEntity as projection on common.Shared;

  // Authorization access requests (submitted through CoreService from
  // restricted pages); admins read and decide them in Settings.
  entity AccessRequests as projection on db.AccessRequests;

  // Product telemetry reads (pilot feedback triage, grouped crash reports).
  // Ingestion happens through CoreService actions; only admins may read.
  entity PilotFeedback as projection on db.PilotFeedback;
  entity ClientErrorReports as projection on db.ClientErrorReports;
  entity UsageEvents as projection on db.UsageEvents;
  entity PerformanceEvents as projection on db.PerformanceEvents;

  // --- Connectivity ---------------------------------------------------------

  type TargetConnectionCheck {
    Ok                 : Boolean;
    Stage              : String;   // DESTINATION | SERVICE | OK
    HttpStatus         : Integer;
    Message            : String;
    LatencyMs          : Integer;
    DestinationName    : String;
    Path               : String;
    ResolvedLocationId : String;   // read-only surface; never persisted
    TestedAt           : Timestamp;
  };

  // Redacted destination catalog + subaccount info for the Settings page.
  function listBtpDestinations() returns LargeString;
  function getBtpAccountInfo() returns LargeString;

  // Lax generic GET proxy: returns the payload even when S/4 answers
  // 4xx/5xx — capability and value-help reads depend on exactly that.
  // Never tighten it (see .claude/rules/sap-backend.md). A caller that
  // needs a pass/fail verdict uses checkTargetSystemConnection.
  action testS4Destination(destinationName: String, path: String) returns LargeString;
  action checkTargetSystemConnection(destinationName: String, path: String) returns TargetConnectionCheck;

  // --- Overlay curation -----------------------------------------------------

  type OverlayImportResult {
    inserted : Integer;
    updated  : Integer;
    skipped  : Integer;
    errors   : many String;
  };

  action upsertOverlayMapping(
    mappingKey: String,
    transactionCode: String,
    fioriId: String,
    appTitle: String,
    mappingType: String,
    coveragePercent: Integer,
    lineOfBusiness: String,
    persona: String,
    valueRationale: String
  ) returns AppMappingOverlay;

  action suppressOverlayMapping(ID: UUID, reason: String) returns AppMappingOverlay;

  // --- Retention ------------------------------------------------------------

  type PurgeResult {
    snapshotsDeleted    : Integer;
    transactionsDeleted : Integer;
    userUsageDeleted    : Integer;
  };

  // Usage facts are the storage growth driver; purge whole extraction runs.
  action purgeExtractionRun(runId: UUID) returns PurgeResult;

  // --- Product Insights (telemetry) ----------------------------------------

  type TelemetrySettingsResult {
    FeedbackEnabled          : Boolean;
    UsageEnabled             : Boolean;
    CrashReportingEnabled    : Boolean;
    PerformanceEnabled       : Boolean;
    StackTraceEnabled        : Boolean;
    UserIdentificationMode   : String;
    SamplingPercent          : Integer;
    SlowRouteThresholdMs     : Integer;
    SlowApiThresholdMs       : Integer;
    SevereApiThresholdMs     : Integer;
    UsageRetentionDays       : Integer;
    PerformanceRetentionDays : Integer;
    ErrorRetentionDays       : Integer;
  };

  type NamedCount {
    eventName : String;
    count     : Integer;
  };

  type FeatureCount {
    feature : String;
    outcome : String;
    count   : Integer;
  };

  type VersionCount {
    appVersion : String;
    count      : Integer;
  };

  type UsageSummary {
    windowDays        : Integer;
    totalEvents       : Integer;
    activeUsers       : Integer;
    activeSessions    : Integer;
    byEventName       : many NamedCount;
    byFeature         : many FeatureCount;
    byVersion         : many VersionCount;
    feedbackByFeature : many FeatureCount;
  };

  type OperationTiming {
    source        : String;
    operationName : String;
    count         : Integer;
    avgMs         : Integer;
    maxMs         : Integer;
  };

  type PerformanceSummary {
    windowDays  : Integer;
    totalEvents : Integer;
    failedCount : Integer;
    operations  : many OperationTiming;
  };

  type CleanupResult {
    usageDeleted       : Integer;
    performanceDeleted : Integer;
    errorsDeleted      : Integer;
  };

  function getTelemetrySettingsAdmin() returns TelemetrySettingsResult;
  action updateTelemetrySettings(
    feedbackEnabled: Boolean,
    usageEnabled: Boolean,
    crashReportingEnabled: Boolean,
    performanceEnabled: Boolean,
    stackTraceEnabled: Boolean,
    userIdentificationMode: String,
    samplingPercent: Integer,
    slowRouteThresholdMs: Integer,
    slowApiThresholdMs: Integer,
    severeApiThresholdMs: Integer,
    usageRetentionDays: Integer,
    performanceRetentionDays: Integer,
    errorRetentionDays: Integer
  ) returns TelemetrySettingsResult;

  action updateFeedbackTriage(
    ID: UUID,
    status: String,
    assignedTo: String,
    adminNotes: String,
    resolutionNotes: String
  ) returns PilotFeedback;

  action updateClientErrorStatus(ID: UUID, status: String) returns ClientErrorReports;

  // Approve/decline an access request. grantRole additionally assigns the
  // matching XSUAA role collection (hybrid/production only); a failed grant
  // keeps the approval and records GrantStatus FAILED for manual follow-up.
  action decideAccessRequest(
    ID: UUID,
    decision: String,
    decisionNotes: String,
    grantRole: Boolean
  ) returns AccessRequests;

  // Server-side aggregation: the Product Insights usage/performance views
  // consume these instead of downloading raw event tables.
  function queryUsageSummary(days: Integer) returns UsageSummary;
  function queryPerformanceSummary(days: Integer) returns PerformanceSummary;

  action runTelemetryCleanup() returns CleanupResult;
};
