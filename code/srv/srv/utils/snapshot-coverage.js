// ---------------------------------------------------------------------------
// Snapshot coverage (S7): what the ZADO collector has persisted on a target
// system, as reported by SystemInfo, and whether an extraction window is
// served from snapshots or live. Pure: no cds, no network.
//
// DataSource on the usage rows tells what actually served a read:
//   SNAPSHOT  the ZADO_SNAP_* tables (collector ran, window covered)
//   LIVE      SWNC called in the request path (no coverage, or forced)
//   MOCK      the seeded mock (tests, ADOPTOPS_MOCK_S4)
//   unknown   an add-on older than S7 (no DataSource field) -> LIVE
// ---------------------------------------------------------------------------

const DATA_SOURCE = Object.freeze({ SNAPSHOT: 'SNAPSHOT', LIVE: 'LIVE', MOCK: 'MOCK' });

function normalizeDataSource(value) {
  const upper = String(value || '').trim().toUpperCase();
  return DATA_SOURCE[upper] ? upper : DATA_SOURCE.LIVE;
}

// Coverage from a SystemInfo row (fields absent on an older add-on).
function snapshotCoverageFrom(systemInfo) {
  const months = Number(systemInfo?.SnapshotMonths) || 0;
  const from = systemInfo?.SnapshotFrom || null;
  const to = systemInfo?.SnapshotTo || null;
  const collectedOn = systemInfo?.SnapshotCollectedOn || null;
  const collectedAt = systemInfo?.SnapshotCollectedAt || null;
  const jobScheduled = systemInfo?.CollectorJobScheduled === true || systemInfo?.CollectorJobScheduled === 'X';
  const reported = systemInfo ? Object.prototype.hasOwnProperty.call(systemInfo, 'SnapshotMonths') : false;
  return {
    reported,                       // false: add-on older than S7
    available: months > 0 && Boolean(from) && Boolean(to),
    from,
    to,
    months,
    collectedOn,
    collectedAt,
    jobScheduled
  };
}

// First day of the month of an ISO date (YYYY-MM-DD or YYYYMMDD).
function monthStartOf(value) {
  const digits = String(value || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(digits)) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-01`;
}

// A window is served from snapshots when every month it touches lies within
// the coverage (the collector stores whole months).
function windowCoveredBySnapshots(coverage, periodFrom, periodTo) {
  if (!coverage?.available) return false;
  const fromMonth = monthStartOf(periodFrom);
  const toMonth = monthStartOf(periodTo);
  const coverFrom = monthStartOf(coverage.from);
  const coverTo = monthStartOf(coverage.to);
  if (!fromMonth || !toMonth || !coverFrom || !coverTo) return false;
  return fromMonth >= coverFrom && toMonth <= coverTo;
}

// One line for the run log and the Target Systems page.
function coverageLabel(coverage) {
  if (!coverage?.reported) return 'Snapshots: not supported by this add-on (older than S7) - usage is read live from ST03N.';
  if (!coverage.available) {
    return `Snapshots: none collected yet${coverage.jobScheduled ? ' (collector job scheduled)' : ' - schedule ZADO_COLLECT_USAGE (docu/07)'}.`;
  }
  const collected = coverage.collectedOn ? ` last collected ${coverage.collectedOn}` : '';
  const job = coverage.jobScheduled ? '' : ' - collector job NOT scheduled';
  return `Snapshots: ${coverage.from} to ${coverage.to} (${coverage.months} month${coverage.months === 1 ? '' : 's'})${collected}${job}.`;
}

// The run-log line once the first page told what served the read.
function dataSourceLogLine(dataSource, { periodFrom, periodTo } = {}) {
  const source = normalizeDataSource(dataSource);
  const window = periodFrom && periodTo ? ` ${periodFrom} to ${periodTo}` : '';
  switch (source) {
    case DATA_SOURCE.SNAPSHOT:
      return { level: 'INFO', message: `Data source: ZADO snapshots (collector tables) for${window}.` };
    case DATA_SOURCE.MOCK:
      return { level: 'INFO', message: 'Data source: seeded mock (no S/4 call).' };
    default:
      return { level: 'WARN', message: `Data source: live ST03N (SWNC in the request path) for${window} - schedule ZADO_COLLECT_USAGE so the window is served from snapshots (docu/07).` };
  }
}

module.exports = {
  DATA_SOURCE,
  normalizeDataSource,
  snapshotCoverageFrom,
  monthStartOf,
  windowCoveredBySnapshots,
  coverageLabel,
  dataSourceLogLine
};
