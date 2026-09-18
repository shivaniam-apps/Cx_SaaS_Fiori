// Snapshot coverage of a target system for the Target Systems page (O17,
// client part of I34). Mirrors srv/utils/snapshot-coverage.js over the
// SystemInfo fields getBackendCapabilities passes through: an add-on older
// than S7 reports no SnapshotMonths at all, one with the collector running
// reports the covered window and the last run. Dependency-free: runs under
// node --test.

const clean = (v) => String(v ?? '').trim();

export function snapshotCoverageFrom(capabilities) {
  const info = capabilities || null;
  const reported = Boolean(info) && Object.prototype.hasOwnProperty.call(info, 'SnapshotMonths');
  const months = Number(info?.SnapshotMonths) || 0;
  const from = clean(info?.SnapshotFrom);
  const to = clean(info?.SnapshotTo);
  const jobScheduled = info?.CollectorJobScheduled === true || info?.CollectorJobScheduled === 'X';
  return {
    reported,
    available: months > 0 && Boolean(from) && Boolean(to),
    from,
    to,
    months,
    collectedOn: clean(info?.SnapshotCollectedOn),
    collectedAt: clean(info?.SnapshotCollectedAt),
    jobScheduled,
    addOnVersion: clean(info?.AddOnVersion)
  };
}

// Tag + tooltip for the Connection cell. Designs: Positive = snapshots
// serve extractions, Critical = collector not (yet) delivering, Neutral =
// add-on predates S7 (usage is read live), Information = not tested yet.
export function coverageBadge(coverage) {
  if (!coverage) return { label: 'Snapshots: untested', design: 'Information', detail: 'Run Test Connection to read the add-on\'s snapshot coverage.' };
  if (!coverage.reported) {
    return { label: 'Live usage reads', design: 'Neutral', detail: 'The add-on predates the snapshot collector (S7); usage is read live from ST03N on every extraction.' };
  }
  if (!coverage.available) {
    return coverage.jobScheduled
      ? { label: 'Snapshots pending', design: 'Critical', detail: 'No snapshot collected yet; the collector job is scheduled.' }
      : { label: 'No snapshots', design: 'Critical', detail: 'No snapshot collected and no collector job scheduled - schedule ZADO_COLLECT_USAGE (docu/07).' };
  }
  const span = `${coverage.from} to ${coverage.to} (${coverage.months} month${coverage.months === 1 ? '' : 's'})`;
  const collected = coverage.collectedOn ? `, last collected ${coverage.collectedOn}${coverage.collectedAt ? ` ${coverage.collectedAt}` : ''}` : '';
  if (!coverage.jobScheduled) {
    return { label: `Snapshots ${coverage.months} mo, job missing`, design: 'Critical', detail: `Snapshots ${span}${collected}; the collector job is NOT scheduled, coverage will go stale.` };
  }
  return { label: `Snapshots ${coverage.months} mo`, design: 'Positive', detail: `Snapshots ${span}${collected}; collector job scheduled.` };
}
