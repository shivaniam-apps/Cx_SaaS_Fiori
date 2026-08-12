using {
      managed,
      cuid
} from '@sap/cds/common';
using { Percentage, Score, tenantScoped } from './data-types';

context adops.db {

      // ------------------------------------------------------------------
      // Target systems and connectivity
      //
      // Deliberately NO locationId column: the Cloud Connector Location ID
      // belongs to destination routing, is resolved at call time and never
      // persisted (see .claude/rules/sap-backend.md).
      // ------------------------------------------------------------------

      entity TargetSystems : cuid, managed, tenantScoped {
            displayName             : String(120);
            destinationName         : String(120);   // BTP destination KEY - the only routing identity we persist
            systemId                : String(3);     // SAP SID (identity, not routing)
            client                  : String(3);
            environment             : String(30);    // DEV | QAS | PRD | SANDBOX
            timeZone                : String(80);
            abapRelease             : String(20);
            s4Release               : String(10);    // '2023'
            sapUi5Version           : String(20);
            frontendServerType      : String(20);    // EMBEDDED | HUB
            serviceRootPath         : String(300);   // override for the ZADO usage service root
            activationRootPath      : String(300);   // override for the ZADO activation service root
            addOnVersion            : String(20);
            active                  : Boolean default true;
            isDefault               : Boolean default false;
            identifiedUsageAllowed  : Boolean default false;  // pseudonymised unless explicitly opted in (audited)
            // Transport defaults for activation
            defaultTransportRequest : String(20);
            transportLayer          : String(10);
            defaultPackage          : String(30);
            // Last connection verdict (checkTargetSystemConnection)
            lastCheckedAt           : Timestamp;
            lastCheckStatus         : String(20);    // OK | DESTINATION | SERVICE
            lastCheckMessage        : String(500);
            extractions             : Composition of many ExtractionRuns
                                            on extractions.targetSystem = $self;
      }

      // ------------------------------------------------------------------
      // Extraction and usage facts
      // ------------------------------------------------------------------

      entity ExtractionRuns : cuid, managed, tenantScoped {
            targetSystem        : Association to TargetSystems;
            Title               : String(160);
            Status              : String(20);   // QUEUED|RUNNING|COMPLETED|PARTIAL|FAILED|CANCELLED
            SourcesJson         : LargeString;  // ["ST03N","STAD","AGR","USR02","FIORI"]
            PeriodFrom          : Date;
            PeriodTo            : Date;
            PeriodGranularity   : String(10);   // DAY | WEEK | MONTH
            Pseudonymised       : Boolean default true;
            RequestedBy         : String(120);
            StartedAt           : Timestamp;
            CompletedAt         : Timestamp;
            DurationMs          : Integer;
            // Rollups so a list page never has to count child rows
            TransactionRowCount : Integer;
            UserRowCount        : Integer;
            RoleRowCount        : Integer;
            FioriRowCount       : Integer;
            Truncated           : Boolean;      // any source hit its row ceiling
            ErrorText           : String(2000);
            CorrelationId       : String(64);
            snapshots           : Composition of many UsageSnapshots
                                        on snapshots.extractionRun = $self;
      }

      // Per source + period header. Keeps provenance (which ST03N aggregation
      // level produced these numbers) attached to the facts.
      entity UsageSnapshots : cuid, managed, tenantScoped {
            extractionRun       : Association to ExtractionRuns;
            targetSystem        : Association to TargetSystems;
            Source              : String(20);   // ST03N | STAD | FIORI | AGR | USR02
            SapAggregationLevel : String(20);   // DAY | WEEK | MONTH | TOTAL (as ST03N reports it)
            TaskType            : String(20);   // DIALOG | RFC | BACKGROUND | HTTP | ...
            InstanceName        : String(40);   // ST03N is per application server
            PeriodFrom          : Date;
            PeriodTo            : Date;
            CollectedAt         : Timestamp;
            RowCount            : Integer;
            Truncated           : Boolean;
      }

      // THE fact table for scoring. One row per tcode per period per snapshot.
      entity TransactionUsage : cuid, managed, tenantScoped {
            snapshot             : Association to UsageSnapshots;
            targetSystem         : Association to TargetSystems;
            TransactionCode      : String(20);
            TransactionText      : String(120);
            ProgramName          : String(40);
            PackageName          : String(30);
            ApplicationComponent : String(40);   // e.g. FI-GL, MM-PUR
            LineOfBusiness       : String(60);   // derived from component
            PeriodFrom           : Date;
            PeriodTo             : Date;
            ExecutionCount       : Integer64;
            DialogStepCount      : Integer64;
            DistinctUserCount    : Integer;
            TotalResponseTimeMs  : Decimal(18,2);
            AvgResponseTimeMs    : Decimal(15,2);
            TotalCpuTimeMs       : Decimal(18,2);
            TotalDbTimeMs        : Decimal(18,2);
            FirstUsedOn          : Date;
            LastUsedOn           : Date;
            IsCustom             : Boolean;      // Y*/Z*/namespace
            IsStandard           : Boolean;
            Source               : String(20);
      }

      // Per user x tcode. Volume-bounded on the ABAP side: the add-on returns
      // the top-N users per tcode above a threshold. UserKey is pseudonymised
      // unless the target system has identifiedUsageAllowed.
      entity UserTransactionUsage : cuid, managed, tenantScoped {
            snapshot        : Association to UsageSnapshots;
            targetSystem    : Association to TargetSystems;
            UserKey         : String(64);
            TransactionCode : String(20);
            PeriodFrom      : Date;
            PeriodTo        : Date;
            ExecutionCount  : Integer64;
            DialogStepCount : Integer64;
            LastUsedOn      : Date;
      }

      // Existing Fiori/launchpad usage - both the "what is already adopted"
      // baseline and a negative signal (do not propose what they already run).
      entity FioriUsage : cuid, managed, tenantScoped {
            snapshot          : Association to UsageSnapshots;
            targetSystem      : Association to TargetSystems;
            FioriId           : String(20);
            AppTitle          : String(120);
            SemanticObject    : String(30);
            SemanticAction    : String(60);
            PeriodFrom        : Date;
            PeriodTo          : Date;
            LaunchCount       : Integer64;
            DistinctUserCount : Integer;
            LastUsedOn        : Date;
      }

      // ------------------------------------------------------------------
      // User and role inventory
      // ------------------------------------------------------------------

      entity UserInventory : cuid, managed, tenantScoped {
            targetSystem       : Association to TargetSystems;
            extractionRun      : Association to ExtractionRuns;
            UserKey            : String(64);    // pseudonymised unless opted in
            FullName           : String(80);    // empty when pseudonymised
            Email              : String(241);   // empty when pseudonymised
            UserType           : String(1);     // A dialog, B system, C comm, S service, L ref
            UserGroup          : String(12);
            Department         : String(60);
            CostCenter         : String(20);
            ValidFrom          : Date;
            ValidTo            : Date;
            LockStatus         : String(2);
            LastLogonOn        : Date;
            IsActiveDialogUser : Boolean;       // A + not locked + logged on in window
            RoleCount          : Integer;
            DistinctTcodeCount : Integer;
            UsesFioriToday     : Boolean;
      }

      entity RoleInventory : cuid, managed, tenantScoped {
            targetSystem         : Association to TargetSystems;
            extractionRun        : Association to ExtractionRuns;
            RoleName             : String(30);
            RoleText             : String(80);
            RoleType             : String(10);   // SINGLE | COMPOSITE | DERIVED
            ParentRole           : String(30);
            IsSapDelivered       : Boolean;      // SAP_* namespace
            MenuTcodeCount       : Integer;
            AuthTcodeCount       : Integer;      // S_TCODE values
            UserCount            : Integer;
            HasFioriCatalog      : Boolean;
            BusinessCatalogCount : Integer;
            ChangedOn            : Date;
      }

      entity RoleTransactions : cuid, managed, tenantScoped {
            targetSystem    : Association to TargetSystems;
            extractionRun   : Association to ExtractionRuns;
            RoleName        : String(30);
            TransactionCode : String(20);
            Source          : String(10);   // MENU (AGR_TCODES) | AUTH (AGR_1251/S_TCODE)
      }

      entity RoleUsers : cuid, managed, tenantScoped {
            targetSystem  : Association to TargetSystems;
            extractionRun : Association to ExtractionRuns;
            RoleName      : String(30);
            UserKey       : String(64);
            ValidFrom     : Date;
            ValidTo       : Date;
      }

      // ------------------------------------------------------------------
      // Catalog: backend-derived truth + curated overlay
      // ------------------------------------------------------------------

      // Backend-derived truth cache. Refreshed by deriveCatalog; never edited
      // by users. Tells us what actually EXISTS/works in THIS system.
      entity BackendCatalogApps : cuid, managed, tenantScoped {
            targetSystem           : Association to TargetSystems;
            derivationRun          : Association to ExtractionRuns;
            FioriId                : String(20);     // F1234 / F1234A
            AppTitle               : String(120);
            AppSubtitle            : String(160);
            AppType                : String(20);     // SAPUI5 | WDA | GUI | WEBCLIENT | URL
            AppCategory            : String(30);     // TRANSACTIONAL | ANALYTICAL | FACTSHEET
            SemanticObject         : String(30);
            SemanticAction         : String(60);
            IamAppId               : String(70);
            UI5ComponentName       : String(120);
            BspApplication         : String(40);
            TechnicalCatalogId     : String(80);
            BusinessCatalogId      : String(80);
            BusinessGroupId        : String(80);
            BusinessRoleId         : String(80);
            ODataServicesJson      : LargeString;    // [{service, version, active}]
            ServiceActivationState : String(20);     // ACTIVE|INACTIVE|MISSING
            IcfNodeState           : String(20);     // ACTIVE|INACTIVE|MISSING
            UiComponentState       : String(20);     // INSTALLED|MISSING
            Availability           : String(20);     // AVAILABLE|MISSING_SERVICE|NOT_INSTALLED|UNKNOWN
            RelatedTcodesJson      : LargeString;    // backend-declared tcode relations + confidence
            MinS4Release           : String(10);
            LastSeenAt             : Timestamp;
      }

      // Existing launchpad content in the backend, so activation can extend
      // instead of clashing.
      entity BackendLaunchpadContent : cuid, managed, tenantScoped {
            targetSystem   : Association to TargetSystems;
            derivationRun  : Association to ExtractionRuns;
            ContentType    : String(20);   // SPACE | PAGE | SECTION | GROUP | CATALOG
            ContentId      : String(80);
            Title          : String(160);
            ParentId       : String(80);
            AssignedRoles  : LargeString;  // json array of PFCG roles
            ItemCount      : Integer;
            IsSapDelivered : Boolean;
      }

      // The curated tcode -> Fiori app overlay. Product content ships with
      // Origin SHIPPED and is upgraded in place by an idempotent boot upsert
      // keyed on MappingKey with an integer Revision (see sap-backend.md
      // "Shipped / Seed Content"). Customers add/suppress entries with
      // Origin CUSTOMER.
      entity AppMappingOverlay : cuid, managed, tenantScoped {
            MappingKey              : String(120);  // stable key: '<TCODE>::<FIORIID>'
            Revision                : Integer;
            Origin                  : String(20) default 'SHIPPED';  // SHIPPED | CUSTOMER
            SupersedesMappingKey    : String(120);  // customer row overriding a shipped one
            TransactionCode         : String(20);
            FioriId                 : String(20);
            AppTitle                : String(120);
            MappingType             : String(20);   // REPLACES|PARTIAL|COMPLEMENTS|NO_EQUIVALENT
            CoveragePercent         : Integer;      // 0..100 of the tcode's scope
            Persona                 : String(60);
            LineOfBusiness          : String(60);
            RequiredBusinessRole    : String(80);
            RequiredBusinessCatalog : String(80);
            RequiredBusinessGroup   : String(80);
            MinS4Release            : String(10);
            MinSapUi5Version        : String(20);
            RequiredComponentsJson  : LargeString;
            ValueRationale          : String(1000);
            PrerequisiteNote        : String(500);
            SourceReference         : String(200);
            EditorialConfidence     : String(10);   // HIGH | MEDIUM | LOW
            Active                  : Boolean default true;
            Suppressed              : Boolean default false;  // customer opt-out
            SuppressReason          : String(500);
      }

      // ------------------------------------------------------------------
      // Analysis and proposals
      // ------------------------------------------------------------------

      entity AnalysisRuns : cuid, managed, tenantScoped {
            targetSystem          : Association to TargetSystems;
            extractionRun         : Association to ExtractionRuns;
            Title                 : String(160);
            Status                : String(20);   // QUEUED|RUNNING|COMPLETED|FAILED|CANCELLED
            ScoringProfile        : String(30);   // BALANCED|QUICK_WINS|ADOPTION_FIRST|CUSTOM
            EngineVersion         : String(20);   // pins results to an algorithm version
            WeightsJson           : LargeString;  // effective weights actually used
            ScopeJson             : LargeString;  // {modules, minExecutions, userGroups, ...}
            StartedAt             : Timestamp;
            CompletedAt           : Timestamp;
            DurationMs            : Integer;
            // Headline figures for the run card
            CandidateCount        : Integer;
            ProposalCount         : Integer;
            CoveredTcodeCount     : Integer;
            UncoveredTcodeCount   : Integer;
            CoveredUserCount      : Integer;
            CoveredExecutionShare : Percentage;
            ErrorText             : String(2000);
            proposals             : Composition of many AppProposals
                                          on proposals.analysisRun = $self;
      }

      entity AppProposals : cuid, managed, tenantScoped {
            analysisRun           : Association to AnalysisRuns;
            targetSystem          : Association to TargetSystems;
            FioriId               : String(20);
            AppTitle              : String(120);
            AppType               : String(20);
            AppCategory           : String(30);
            SemanticObject        : String(30);
            SemanticAction        : String(60);
            BusinessCatalogId     : String(80);
            BusinessGroupId       : String(80);
            BusinessRoleId        : String(80);
            LineOfBusiness        : String(60);
            Persona               : String(60);
            // --- scoring (0..100, produced by fiori-recommendation-engine.js) ---
            Score                 : Score;
            Rank                  : Integer;
            UsageScore            : Score;
            PopulationScore       : Score;
            CoverageScore         : Score;
            ReadinessScore        : Score;
            EffortScore           : Score;        // higher = cheaper
            RecencyFactor         : Decimal(4,3);
            Confidence            : String(10);   // HIGH | MEDIUM | LOW
            ConfidenceReasonsJson : LargeString;  // reason codes, not prose
            RationaleText         : String(2000);
            // --- evidence rollups (so the list page needs no child reads) ---
            MatchedTcodeCount     : Integer;
            TotalExecutions       : Integer64;
            DistinctUserCount     : Integer;      // UNION across matched tcodes
            AffectedRoleCount     : Integer;
            TotalDialogSteps      : Integer64;
            LastUsedOn            : Date;
            CoveragePercent       : Integer;
            // --- feasibility ---
            BackendAvailability   : String(20);   // AVAILABLE|MISSING_SERVICE|NOT_INSTALLED|UNKNOWN
            AlreadyAdopted        : Boolean;      // present in FioriUsage
            EstimatedEffort       : String(10);   // LOW | MEDIUM | HIGH
            PrerequisiteText      : String(1000);
            // --- grouping ---
            GroupKey              : String(120);  // BusinessRoleId or LoB fallback
            GroupTitle            : String(160);
            UserSegmentKey        : String(120);
            // --- review ---
            ReviewStatus          : String(20) default 'NEW';
                                    // NEW|IN_REVIEW|APPROVED|REJECTED|DEFERRED|SUPERSEDED
            DecidedBy             : String(120);
            DecidedAt             : Timestamp;
            DecisionNotes         : String(2000);
            Priority              : String(10);   // HIGH|MEDIUM|LOW
            TargetWave            : String(40);
            evidence              : Composition of many ProposalEvidence
                                          on evidence.proposal = $self;
            comments              : Composition of many ProposalComments
                                          on comments.proposal = $self;
      }

      entity ProposalEvidence : cuid, managed, tenantScoped {
            proposal          : Association to AppProposals;
            EvidenceType      : String(20);   // TCODE | ROLE | USER_SEGMENT | EXISTING_APP
            TransactionCode   : String(20);
            TransactionText   : String(120);
            RoleName          : String(30);
            SegmentLabel      : String(120);
            ExecutionCount    : Integer64;
            DistinctUserCount : Integer;
            SharePercent      : Percentage;   // share of this proposal's total signal
            MappingType       : String(20);
            MappingSource     : String(20);   // EXACT_LAUNCHER | ROLE_IMPLIED | OVERLAY | HEURISTIC
            CoveragePercent   : Integer;
            Included          : Boolean default true;  // reviewer scope adjustment
            LastUsedOn        : Date;
            Note              : String(500);
      }

      entity ProposalComments : cuid, managed, tenantScoped {
            proposal    : Association to AppProposals;
            PostedAt    : Timestamp;
            Author      : String(120);
            AuthorName  : String(160);
            CommentType : String(20);   // QUESTION | DECISION | NOTE
            CommentText : String(2000);
      }

      // ------------------------------------------------------------------
      // Activation and transport
      // ------------------------------------------------------------------

      entity ActivationPlans : cuid, managed, tenantScoped {
            targetSystem     : Association to TargetSystems;
            analysisRun      : Association to AnalysisRuns;
            transportRequest : Association to TransportRequests;
            Name             : String(160);
            Description      : String(500);
            Status           : String(20);
            // DRAFT|SIMULATING|SIMULATED|READY|EXECUTING|COMPLETED|PARTIAL|FAILED|ROLLED_BACK
            SpaceId          : String(40);
            SpaceTitle       : String(160);
            PageIdPattern    : String(60);
            RoleNamePattern  : String(60);   // e.g. 'Z_ADO_{LOB}_{PERSONA}'
            AssignUsers      : Boolean default false;
            StopOnError      : Boolean default true;
            SimulatedAt      : Timestamp;
            SimulatedBy      : String(120);
            ExecutedAt       : Timestamp;
            ExecutedBy       : String(120);
            StepCount        : Integer;
            SucceededCount   : Integer;
            WarningCount     : Integer;
            FailedCount      : Integer;
            SkippedCount     : Integer;
            steps            : Composition of many ActivationSteps
                                     on steps.plan = $self;
      }

      entity ActivationSteps : cuid, managed, tenantScoped {
            plan              : Association to ActivationPlans;
            proposal          : Association to AppProposals;
            dependsOn         : Association to ActivationSteps;
            SequenceNo        : Integer;
            StepGroup         : String(30);  // FOUNDATION | SERVICE | CATALOG | CONTENT | ROLE | USER | TRANSPORT
            StepType          : String(40);
            // ACTIVATE_ODATA_SERVICE | ACTIVATE_ICF_NODE | ASSIGN_BUSINESS_CATALOG |
            // CREATE_SPACE | CREATE_PAGE | ASSIGN_PAGE_TO_SPACE | CREATE_PFCG_ROLE |
            // ADD_CATALOG_TO_ROLE | ADD_SPACE_TO_ROLE | GENERATE_PROFILE |
            // ASSIGN_ROLE_TO_USERS | RUN_TASK_LIST | ADD_TO_TRANSPORT
            ObjectType        : String(40);
            ObjectName        : String(120);
            ObjectKeyJson     : LargeString;  // full typed key for the ABAP action
            Status            : String(20);
            // PENDING|SIMULATED_OK|SIMULATED_WARN|SIMULATED_BLOCKED|RUNNING|
            // SUCCESS|WARNING|FAILED|SKIPPED|ROLLED_BACK
            Idempotent        : Boolean default true;
            ExistsAlready     : Boolean;      // simulation found the object present
            IsDestructive     : Boolean default false;
            Transportable     : Boolean;
            LocalReplay       : Boolean;      // must be repeated per system (SICF, gateway, users)
            Reversible        : Boolean;
            SimulationMessage : String(1000);
            StartedAt         : Timestamp;
            CompletedAt       : Timestamp;
            DurationMs        : Integer;
            RetryCount        : Integer;
            messages          : Composition of many ActivationStepMessages
                                      on messages.step = $self;
      }

      // BAPI-style message rows from the ZADO add-on.
      entity ActivationStepMessages : cuid, managed, tenantScoped {
            step          : Association to ActivationSteps;
            Sequence      : Integer;
            MessageType   : String(1);    // S E W I A
            MessageClass  : String(20);
            MessageNumber : String(3);
            MessageText   : String(500);
            ObjectName    : String(120);
            RawJson       : LargeString;
      }

      entity TransportRequests : cuid, managed, tenantScoped {
            targetSystem       : Association to TargetSystems;
            plan               : Association to ActivationPlans;
            TransportRequestId : String(20);   // e.g. A4HK900123
            TaskId             : String(20);
            RequestType        : String(10);   // K workbench | W customizing
            Description        : String(60);
            Owner              : String(12);
            TransportTarget    : String(10);   // transport route target, NOT the source SID
            Status             : String(20);   // MODIFIABLE|RELEASING|RELEASED|RELEASE_FAILED
            CreatedInSapAt     : Timestamp;
            ReleasedAt         : Timestamp;
            ReleasedBy         : String(120);
            ObjectCount        : Integer;
            ReleaseLogText     : LargeString;
            RawJson            : LargeString;
      }

      // ------------------------------------------------------------------
      // Async task tracking
      // ------------------------------------------------------------------

      // Generic async work item. Every slow S/4 operation gets a row here so
      // the UI polls one endpoint shape regardless of what is running.
      entity BackgroundTasks : cuid, managed, tenantScoped {
            targetSystem    : Association to TargetSystems;
            TaskType        : String(40);
            // USAGE_EXTRACTION | CATALOG_DERIVATION | ANALYSIS |
            // ACTIVATION_SIMULATION | ACTIVATION_EXECUTION | TRANSPORT_RELEASE
            ObjectType      : String(40);   // ExtractionRuns | AnalysisRuns | ActivationPlans
            ObjectId        : String(36);
            Status          : String(20);
            // QUEUED|CLAIMED|RUNNING|SUCCEEDED|FAILED|CANCELLED|TIMED_OUT
            Phase           : String(60);   // human-readable current stage
            ProgressPercent : Integer;
            ProcessedItems  : Integer;
            TotalItems      : Integer;
            QueuedAt        : Timestamp;
            ClaimedAt       : Timestamp;
            HeartbeatAt     : Timestamp;    // stale heartbeat -> reclaimable
            CompletedAt     : Timestamp;
            ClaimedBy       : String(80);   // "<CF_INSTANCE_INDEX>:<pid>:<uuid>"
            AttemptCount    : Integer default 0;
            MaxAttempts     : Integer default 2;
            DeadlineAt      : Timestamp;
            CancelRequested : Boolean default false;
            RequestedBy     : String(120);
            CorrelationId   : String(64);
            ResultJson      : LargeString;
            ErrorText       : String(2000);
            logs            : Composition of many BackgroundTaskLogs
                                    on logs.task = $self;
      }

      entity BackgroundTaskLogs : cuid, managed, tenantScoped {
            task     : Association to BackgroundTasks;
            LoggedAt : Timestamp;
            Severity : String(10);   // INFO | WARN | ERROR
            Phase    : String(60);
            Message  : String(1000);
      }

      // ------------------------------------------------------------------
      // Audit (business/compliance traceability)
      // ------------------------------------------------------------------

      entity AuditEvents : cuid, managed, tenantScoped {
            Timestamp     : Timestamp;
            EventType     : String(60);
            Severity      : String(30);
            ObjectType    : String(80);
            ObjectName    : String(160);
            ObjectId      : String(120);
            UserId        : String(120);
            TargetSystem  : String(120);
            Source        : String(80);
            Message       : String(500);
            BeforeValue   : String(120);
            AfterValue    : String(120);
            SAPResponse   : String(1000);
            CorrelationId : String(120);
      }

      // ------------------------------------------------------------------
      // Product telemetry (pilot feedback + client crash reports).
      // Deliberately separate from AuditEvents: audit rows are business/
      // compliance traceability, these are product-improvement diagnostics.
      // ------------------------------------------------------------------

      entity PilotFeedback : cuid, managed {
            SubmittedAt     : Timestamp;
            SubmittedBy     : String(120);
            SubmittedByName : String(160);
            TenantId        : String(60);
            Category        : String(40);
            Title           : String(160);
            Description     : String(2000);
            Impact          : String(40);
            Sentiment       : String(30);
            Route           : String(200);
            Feature         : String(120);
            TargetSystem    : String(120);
            AppVersion      : String(60);
            BrowserInfo     : String(200);
            SessionId       : String(64);
            CorrelationId   : String(64);
            ContactAllowed  : Boolean;
            Status          : String(30);
            AssignedTo      : String(120);
            AdminNotes      : String(2000);
            ResolutionNotes : String(2000);
            ReferenceNumber : String(30);
      }

      // Authorization access requests: a non-admin user asks for a role from
      // a restricted page; admins triage them in Settings. Identity fields
      // are server-derived (never client-supplied).
      entity AccessRequests : cuid, managed {
            RequestedAt     : Timestamp;
            RequesterId     : String(120);
            RequesterName   : String(160);
            RequesterEmail  : String(160);
            TenantId        : String(60);
            RequestedArea   : String(60);
            RequestedRole   : String(60);
            Justification   : String(2000);
            Urgency         : String(20);
            Status          : String(30);
            DecidedBy       : String(120);
            DecidedAt       : Timestamp;
            DecisionNotes   : String(2000);
            GrantStatus     : String(30);
            GrantError      : String(500);
            ReferenceNumber : String(30);
      }

      entity ClientErrorReports : cuid, managed {
            FirstSeenAt     : Timestamp;
            LastSeenAt      : Timestamp;
            OccurrenceCount : Integer;
            TenantId        : String(60);
            UserId          : String(120);
            SessionId       : String(64);
            ErrorType       : String(60);
            ErrorMessage    : String(1000);
            StackTrace      : String(4000);
            ComponentStack  : String(2000);
            Route           : String(200);
            Feature         : String(120);
            EndpointPath    : String(300);
            HttpMethod      : String(10);
            HttpStatus      : Integer;
            AppVersion      : String(60);
            BrowserInfo     : String(200);
            CorrelationId   : String(64);
            Fingerprint     : String(64);
            Severity        : String(30);
            Status          : String(30);
      }

      entity UsageEvents : cuid, managed {
            Timestamp     : Timestamp;
            TenantId      : String(60);
            UserId        : String(120);
            SessionId     : String(64);
            EventName     : String(60);
            EventCategory : String(40);
            Route         : String(200);
            Feature       : String(120);
            Action        : String(60);
            Outcome       : String(30);
            DurationMs    : Integer;
            TargetSystem  : String(120);
            AppVersion    : String(60);
            CorrelationId : String(64);
            MetadataJson  : String(2000);
      }

      entity PerformanceEvents : cuid, managed {
            Timestamp       : Timestamp;
            TenantId        : String(60);
            SessionId       : String(64);
            Source          : String(20);
            OperationName   : String(120);
            RouteOrEndpoint : String(300);
            DurationMs      : Integer;
            ThresholdMs     : Integer;
            Outcome         : String(30);
            AppVersion      : String(60);
            CorrelationId   : String(64);
            MetadataJson    : String(2000);
      }

      // Tenant-level telemetry configuration. Single-tenant today, so exactly
      // one row with SingletonKey 'GLOBAL'; handlers upsert by that key.
      entity TelemetrySettings : cuid, managed {
            SingletonKey             : String(10);
            FeedbackEnabled          : Boolean;
            UsageEnabled             : Boolean;
            CrashReportingEnabled    : Boolean;
            PerformanceEnabled       : Boolean;
            StackTraceEnabled        : Boolean;
            UserIdentificationMode   : String(20);
            SamplingPercent          : Integer;
            SlowRouteThresholdMs     : Integer;
            SlowApiThresholdMs       : Integer;
            SevereApiThresholdMs     : Integer;
            UsageRetentionDays       : Integer;
            PerformanceRetentionDays : Integer;
            ErrorRetentionDays       : Integer;
            UpdatedBy                : String(120);
      }

      // ------------------------------------------------------------------
      // Identity (user-management integration)
      // ------------------------------------------------------------------

      entity Roles : managed {
            key ID          : String;
                description : String;
      }

      entity Users : cuid, managed {
            @Core.Computed: true
            fullName    : String;
            firstName   : String;
            lastName    : String;
            email       : String;
            shadowId    : UUID;
            iasLocation : String;
            role        : Association to Roles;
      }
}

context adops.common {
      @cds.persistence.exists
      entity Shared : cuid {
            value : String;
      }
}
