// Ordered source of truth for the tabbed Settings page: one entry per tab,
// consumed by the tab strip and route resolution (/settings/:view?), plus
// the pure form logic for both tabs. Dependency-free: runs under node --test.

export const SETTINGS_VIEWS = [
  { id: 'target-systems', routeSuffix: '', label: 'Target Systems', icon: 'connected' },
  { id: 'telemetry', routeSuffix: 'telemetry', label: 'Telemetry', icon: 'performance' }
];

const BY_ID = new Map(SETTINGS_VIEWS.map((view) => [view.id, view]));

// Unknown or absent :view values fall back to the first tab so stale deep
// links degrade gracefully instead of 404ing.
export function resolveSettingsView(param) {
  const candidate = String(param || '').trim().toLowerCase();
  return BY_ID.has(candidate) ? candidate : SETTINGS_VIEWS[0].id;
}

export function getSettingsViewPath(id) {
  const view = BY_ID.get(id);
  return view?.routeSuffix ? `/settings/${view.routeSuffix}` : '/settings';
}

// --- Target Systems tab -------------------------------------------------------
// Two per-system settings live here (the rest of the system row is edited on
// the Target Systems page): the audited identified-usage opt-in
// (sap-backend.md) and the ZADO activation service root override.

export const IDENTIFIED_USAGE_EVENT_TYPE = 'IDENTIFIED_USAGE_CHANGED';

export function usageModeLabel(identifiedUsageAllowed) {
  return identifiedUsageAllowed ? 'Identified' : 'Pseudonymised';
}

export function systemSettingsDraft(system) {
  return {
    identifiedUsageAllowed: Boolean(system?.identifiedUsageAllowed),
    activationRootPath: String(system?.activationRootPath || '')
  };
}

// The PATCH body: only the keys that differ from the stored row, or null
// when nothing changed (the Save button and the request share this).
export function systemSettingsPatch(system, draft) {
  if (!system || !draft) return null;
  const stored = systemSettingsDraft(system);
  const patch = {};
  if (Boolean(draft.identifiedUsageAllowed) !== stored.identifiedUsageAllowed) {
    patch.identifiedUsageAllowed = Boolean(draft.identifiedUsageAllowed);
  }
  const path = String(draft.activationRootPath || '').trim();
  if (path !== stored.activationRootPath) patch.activationRootPath = path || null;
  return Object.keys(patch).length ? patch : null;
}

// Enabling identified usage is the privacy-relevant direction: it is
// confirmed before it lands in the draft. Disabling needs no confirmation.
export function needsIdentifiedUsageConfirmation(system, nextValue) {
  return Boolean(nextValue) && !system?.identifiedUsageAllowed;
}

// "PSEUDONYMISED → IDENTIFIED" from an audit row.
export function auditChangeLabel(event) {
  const before = event?.BeforeValue || '';
  const after = event?.AfterValue || '';
  if (!before && !after) return '';
  return `${before || '—'} → ${after || '—'}`;
}

// --- Telemetry tab -------------------------------------------------------------
// Field metadata drives the form and the updateTelemetrySettings payload
// (AdminService); the server validates again.

export const IDENTIFICATION_MODES = [
  { id: 'IDENTIFIED', label: 'Identified (user id stored)' },
  { id: 'HASHED', label: 'Hashed (one-way pseudonym)' },
  { id: 'ANONYMOUS', label: 'Anonymous (no user id)' }
];

export const TELEMETRY_FIELDS = [
  { key: 'FeedbackEnabled', param: 'feedbackEnabled', label: 'Pilot feedback', kind: 'boolean', group: 'Collection' },
  { key: 'UsageEnabled', param: 'usageEnabled', label: 'Usage events', kind: 'boolean', group: 'Collection' },
  { key: 'CrashReportingEnabled', param: 'crashReportingEnabled', label: 'Crash reports', kind: 'boolean', group: 'Collection' },
  { key: 'PerformanceEnabled', param: 'performanceEnabled', label: 'Performance events', kind: 'boolean', group: 'Collection' },
  { key: 'StackTraceEnabled', param: 'stackTraceEnabled', label: 'Store stack traces with crash reports', kind: 'boolean', group: 'Collection' },
  { key: 'UserIdentificationMode', param: 'userIdentificationMode', label: 'User identification', kind: 'mode', group: 'Privacy' },
  { key: 'SamplingPercent', param: 'samplingPercent', label: 'Usage sampling (%)', kind: 'integer', min: 0, max: 100, group: 'Privacy' },
  { key: 'SlowRouteThresholdMs', param: 'slowRouteThresholdMs', label: 'Slow route threshold (ms)', kind: 'integer', min: 100, max: 600000, group: 'Thresholds' },
  { key: 'SlowApiThresholdMs', param: 'slowApiThresholdMs', label: 'Slow API threshold (ms)', kind: 'integer', min: 100, max: 600000, group: 'Thresholds' },
  { key: 'SevereApiThresholdMs', param: 'severeApiThresholdMs', label: 'Severe API threshold (ms)', kind: 'integer', min: 100, max: 600000, group: 'Thresholds' },
  { key: 'UsageRetentionDays', param: 'usageRetentionDays', label: 'Usage retention (days)', kind: 'integer', min: 1, max: 3650, group: 'Retention' },
  { key: 'PerformanceRetentionDays', param: 'performanceRetentionDays', label: 'Performance retention (days)', kind: 'integer', min: 1, max: 3650, group: 'Retention' },
  { key: 'ErrorRetentionDays', param: 'errorRetentionDays', label: 'Crash report retention (days)', kind: 'integer', min: 1, max: 3650, group: 'Retention' }
];

export const TELEMETRY_GROUPS = [...new Set(TELEMETRY_FIELDS.map((f) => f.group))];

// Form state from the TelemetrySettingsResult: booleans stay booleans,
// numbers become strings (what an Input holds), the mode is upper-cased.
export function telemetryFormFrom(result) {
  const form = {};
  for (const field of TELEMETRY_FIELDS) {
    const value = result?.[field.key];
    if (field.kind === 'boolean') form[field.key] = Boolean(value);
    else if (field.kind === 'mode') form[field.key] = String(value || IDENTIFICATION_MODES[0].id).toUpperCase();
    else form[field.key] = value === null || value === undefined ? '' : String(value);
  }
  return form;
}

// Field-level messages keyed by field key; empty object when valid.
export function validateTelemetryForm(form) {
  const errors = {};
  for (const field of TELEMETRY_FIELDS) {
    const raw = form?.[field.key];
    if (field.kind === 'integer') {
      const text = String(raw ?? '').trim();
      const value = Number(text);
      if (!text || !Number.isInteger(value)) errors[field.key] = 'Enter a whole number.';
      else if (value < field.min || value > field.max) errors[field.key] = `Enter a value between ${field.min} and ${field.max}.`;
    } else if (field.kind === 'mode') {
      if (!IDENTIFICATION_MODES.some((mode) => mode.id === raw)) errors[field.key] = 'Pick an identification mode.';
    }
  }
  if (!errors.SlowApiThresholdMs && !errors.SevereApiThresholdMs
    && Number(form?.SevereApiThresholdMs) < Number(form?.SlowApiThresholdMs)) {
    errors.SevereApiThresholdMs = 'Must be at least the slow API threshold.';
  }
  return errors;
}

// The updateTelemetrySettings action payload (camelCase params).
export function telemetryPayload(form) {
  const payload = {};
  for (const field of TELEMETRY_FIELDS) {
    const raw = form?.[field.key];
    if (field.kind === 'boolean') payload[field.param] = Boolean(raw);
    else if (field.kind === 'mode') payload[field.param] = String(raw || '').toUpperCase();
    else payload[field.param] = Number(raw);
  }
  return payload;
}

export function telemetryChanged(form, original) {
  if (!form || !original) return false;
  return TELEMETRY_FIELDS.some((field) => String(form[field.key] ?? '') !== String(original[field.key] ?? ''));
}
