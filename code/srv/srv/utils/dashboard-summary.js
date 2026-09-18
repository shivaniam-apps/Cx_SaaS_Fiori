// Adoption Cockpit summary (O8): the dashboard consumes ONE purpose-built
// read whose figures are grouped counts computed at the database, never a
// download of the underlying tables (performance.md, Dashboard).
//
// Every figure is a partition of its entity's status vocabulary: the named
// buckets plus "Other" always sum to Total, and each bucket is the SAME
// server-side expression the click-through page uses to slice its list
// (bucketStatuses is shared with queryActivationRuns / queryTransportRequests
// / queryProposals), so a card never disagrees with the page it opens.

const { summarizeRunStatuses } = require('./activation-runs.js');

// Status vocabularies from db/data-model.cds. A null / '' status lands in the
// bucket that lists '' (systems never checked); anything unlisted is Other.
const PARTITIONS = {
  systems: {
    field: 'lastCheckStatus',
    buckets: { Healthy: ['OK'], Attention: ['DESTINATION', 'SERVICE', 'ACTIVATION'], Unchecked: [''] }
  },
  extractions: {
    field: 'Status',
    buckets: { Active: ['QUEUED', 'RUNNING'], Completed: ['COMPLETED'], Partial: ['PARTIAL'], Failed: ['FAILED', 'CANCELLED'] }
  },
  analyses: {
    field: 'Status',
    buckets: { Active: ['QUEUED', 'RUNNING'], Completed: ['COMPLETED'], Failed: ['FAILED', 'CANCELLED'] }
  },
  proposals: {
    field: 'ReviewStatus',
    buckets: { Open: ['NEW', 'IN_REVIEW'], Approved: ['APPROVED'], Rejected: ['REJECTED'], Deferred: ['DEFERRED'], NoPath: ['SUPERSEDED'] }
  },
  waves: {
    field: 'Status',
    buckets: { Planned: ['PLANNED'], InProgress: ['IN_PROGRESS'], Completed: ['COMPLETED'], OnHold: ['ON_HOLD'] }
  },
  plans: {
    field: 'Status',
    buckets: { Draft: ['DRAFT', 'SIMULATING', 'SIMULATED'], Ready: ['READY'], Executing: ['EXECUTING'], Completed: ['COMPLETED'], Attention: ['PARTIAL', 'FAILED', 'ROLLED_BACK'] }
  },
  transports: {
    field: 'Status',
    buckets: { Open: ['MODIFIABLE', 'RELEASING'], Released: ['RELEASED'], Failed: ['RELEASE_FAILED'] }
  }
};

const normalise = (value) => String(value ?? '').trim().toUpperCase();

// { Total, <Bucket>..., Other } from grouped rows [{ <field>: status, cnt }].
function partition(kind, grouped) {
  const spec = PARTITIONS[kind];
  if (!spec) throw new Error(`Unknown dashboard partition: ${kind}`);
  const result = { Total: 0 };
  for (const bucket of Object.keys(spec.buckets)) result[bucket] = 0;
  result.Other = 0;
  for (const row of grouped || []) {
    const count = Number(row?.cnt || 0);
    if (!count) continue;
    const status = normalise(row?.[spec.field]);
    const bucket = Object.keys(spec.buckets).find((name) => spec.buckets[name].includes(status));
    result[bucket || 'Other'] += count;
    result.Total += count;
  }
  return result;
}

// Statuses behind one bucket of a partition, for the list pages' server
// filters. Unknown bucket -> null (no filter). Bucket names are matched
// case-insensitively so URL params can be written either way.
function bucketStatuses(kind, bucket) {
  const spec = PARTITIONS[kind];
  const name = Object.keys(spec?.buckets || {}).find((b) => b.toUpperCase() === normalise(bucket));
  return name ? [...spec.buckets[name]] : null;
}

function shapeDashboardSummary({ systems, extractions, analyses, proposals, waves, plans, runs, transports }, scope = {}) {
  return {
    Scope: {
      TargetSystemId: scope.targetSystemId || null,
      // The proposal figures cover the current (latest completed) analysis run
      // per target system in scope; the click-through carries the run when
      // exactly one is in scope so the Proposals page shows the same slice.
      AnalysisRunIds: Array.isArray(scope.analysisRunIds) ? scope.analysisRunIds : []
    },
    Systems: partition('systems', systems),
    Extractions: partition('extractions', extractions),
    Analyses: partition('analyses', analyses),
    Proposals: partition('proposals', proposals),
    Waves: partition('waves', waves),
    Plans: partition('plans', plans),
    Runs: summarizeRunStatuses(runs || []),
    Transports: partition('transports', transports),
    GeneratedAt: new Date().toISOString()
  };
}

module.exports = { PARTITIONS, partition, bucketStatuses, shapeDashboardSummary };
