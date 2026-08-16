// The role-less "front door": the only endpoints an authenticated user
// without a business role can reach. Everything here must keep working for a
// user whose access request is still pending - identity/role introspection,
// the access-request flow itself, and telemetry/crash ingestion (a crash on
// the restricted screen is still a crash). Business data and operations live
// on PublicService (/fiori), which requires a business role; do NOT
// add business reads or actions to this service.
service CoreService @(path : '/core', impl: 'srv/core-service', requires: 'authenticated-user') {

  type UserScopeInfo {
    identified      : Boolean;
    authenticated   : Boolean;
    Member          : Boolean;
    Approver        : Boolean;
    Activator       : Boolean;
    Admin           : Boolean;
    ExtendCDS       : Boolean;
    ExtendCDSdelete : Boolean;
  };

  type UserInfoResult {
    user      : String;
    givenName : String;
    locale    : String;
    tenant    : String;
    tier      : String;
    dbMode    : String;
    scopes    : UserScopeInfo;
  };

  // Server-derived identity and role information. This is the authoritative
  // role source for frontend gates (Member gate in the shell, Admin gates on
  // Settings/Product Insights), so it must stay reachable by role-less users.
  function userInfo() returns UserInfoResult;

  type PilotFeedbackReceipt {
    ID              : UUID;
    referenceNumber : String;
    status          : String;
  };

  type ClientErrorReceipt {
    received        : Boolean;
    fingerprint     : String;
    occurrenceCount : Integer;
  };

  // Pilot feedback + crash ingestion (telemetry phase 1). Write-only from the
  // client: the backing entities are deliberately not exposed here - reads are
  // admin-only through AdminService. Identity/tenant context is derived
  // server-side; client-supplied fields are clamped and secret-redacted.
  action submitPilotFeedback(
    category: String,
    title: String,
    description: String,
    impact: String,
    contactAllowed: Boolean,
    route: String,
    feature: String,
    targetSystem: String,
    appVersion: String,
    browserInfo: String,
    sessionId: String,
    correlationId: String
  ) returns PilotFeedbackReceipt;

  type AccessRequestReceipt {
    ID              : UUID;
    referenceNumber : String;
    status          : String;
  };

  type MyAccessRequestInfo {
    ID              : UUID;
    referenceNumber : String;
    requestedArea   : String;
    requestedRole   : String;
    status          : String;
    requestedAt     : Timestamp;
    decidedAt       : Timestamp;
    decisionNotes   : String;
    grantStatus     : String;
  };

  // Authorization access requests from restricted pages (including the
  // application-level Member gate). Write-only from the client like pilot
  // feedback: the backing entity is exposed for triage on AdminService only,
  // and requester identity is derived server-side.
  action submitAccessRequest(
    requestedArea: String,
    requestedRole: String,
    justification: String,
    urgency: String
  ) returns AccessRequestReceipt;

  // The requester's own requests, for the restricted page to show
  // pending/declined/approved state instead of a bare CTA.
  function getMyAccessRequests() returns array of MyAccessRequestInfo;

  type UsageEventInput {
    timestamp     : Timestamp;
    eventName     : String;
    eventCategory : String;
    route         : String;
    feature       : String;
    action        : String;
    outcome       : String;
    durationMs    : Integer;
    targetSystem  : String;
    metadataJson  : String;
  };

  type PerformanceEventInput {
    timestamp       : Timestamp;
    source          : String;
    operationName   : String;
    routeOrEndpoint : String;
    durationMs      : Integer;
    thresholdMs     : Integer;
    outcome         : String;
    metadataJson    : String;
  };

  type TelemetryBatchReceipt {
    acceptedUsage       : Integer;
    acceptedPerformance : Integer;
  };

  type EffectiveTelemetrySettings {
    feedbackEnabled      : Boolean;
    usageEnabled         : Boolean;
    crashReportingEnabled: Boolean;
    performanceEnabled   : Boolean;
    slowRouteThresholdMs : Integer;
    slowApiThresholdMs   : Integer;
    severeApiThresholdMs : Integer;
  };

  // What the telemetry client should collect and which thresholds apply.
  // Readable by any authenticated user; administration happens in AdminService.
  function getTelemetrySettings() returns EffectiveTelemetrySettings;

  // Batched ordinary telemetry (usage + threshold-crossing performance).
  // Individual per-event actions are intentionally not exposed - the client
  // queue always batches. Invalid rows are skipped, never failing the batch;
  // per-batch row caps bound ingestion volume. Identity/tenant/session and
  // app version are applied server-side/batch-wide.
  action recordTelemetryBatch(
    sessionId: String,
    appVersion: String,
    usageEvents: many UsageEventInput,
    performanceEvents: many PerformanceEventInput
  ) returns TelemetryBatchReceipt;

  action recordClientError(
    errorType: String,
    errorMessage: String,
    stackTrace: String,
    componentStack: String,
    route: String,
    feature: String,
    endpointPath: String,
    httpMethod: String,
    httpStatus: Integer,
    severity: String,
    appVersion: String,
    browserInfo: String,
    sessionId: String,
    correlationId: String
  ) returns ClientErrorReceipt;
}
