import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_VIEWS,
  resolveSettingsView,
  getSettingsViewPath,
  usageModeLabel,
  systemSettingsDraft,
  systemSettingsPatch,
  needsIdentifiedUsageConfirmation,
  auditChangeLabel,
  IDENTIFICATION_MODES,
  TELEMETRY_FIELDS,
  TELEMETRY_GROUPS,
  telemetryFormFrom,
  validateTelemetryForm,
  telemetryPayload,
  telemetryChanged
} from './settingsViews.js';

test('tab order, ids and route resolution', () => {
  assert.deepEqual(SETTINGS_VIEWS.map((v) => v.id), ['target-systems', 'telemetry']);
  for (const view of SETTINGS_VIEWS) {
    assert.ok(view.label && view.icon, view.id);
    assert.equal(resolveSettingsView(view.id), view.id);
  }
  assert.equal(resolveSettingsView('TELEMETRY'), 'telemetry');
  for (const bad of [undefined, '', null, 'overview']) assert.equal(resolveSettingsView(bad), 'target-systems');
  assert.equal(getSettingsViewPath('target-systems'), '/settings');
  assert.equal(getSettingsViewPath('telemetry'), '/settings/telemetry');
  assert.equal(getSettingsViewPath('nope'), '/settings');
});

test('system settings draft and patch carry only what changed', () => {
  const system = { ID: 's1', identifiedUsageAllowed: false, activationRootPath: '' };
  assert.deepEqual(systemSettingsDraft(system), { identifiedUsageAllowed: false, activationRootPath: '' });
  assert.deepEqual(systemSettingsDraft(null), { identifiedUsageAllowed: false, activationRootPath: '' });
  assert.equal(systemSettingsPatch(system, systemSettingsDraft(system)), null);
  assert.deepEqual(systemSettingsPatch(system, { identifiedUsageAllowed: true, activationRootPath: '' }), { identifiedUsageAllowed: true });
  assert.deepEqual(systemSettingsPatch(system, { identifiedUsageAllowed: false, activationRootPath: '  /sap/opu/odata4/zado/  ' }), { activationRootPath: '/sap/opu/odata4/zado/' });
  const withPath = { ...system, activationRootPath: '/x' };
  assert.deepEqual(systemSettingsPatch(withPath, { identifiedUsageAllowed: false, activationRootPath: '' }), { activationRootPath: null });
  assert.equal(systemSettingsPatch(null, {}), null);
});

test('identified usage: labels and the confirmation rule', () => {
  assert.equal(usageModeLabel(true), 'Identified');
  assert.equal(usageModeLabel(false), 'Pseudonymised');
  assert.equal(needsIdentifiedUsageConfirmation({ identifiedUsageAllowed: false }, true), true);
  assert.equal(needsIdentifiedUsageConfirmation({ identifiedUsageAllowed: true }, true), false);
  assert.equal(needsIdentifiedUsageConfirmation({ identifiedUsageAllowed: true }, false), false);
  assert.equal(auditChangeLabel({ BeforeValue: 'PSEUDONYMISED', AfterValue: 'IDENTIFIED' }), 'PSEUDONYMISED → IDENTIFIED');
  assert.equal(auditChangeLabel({ AfterValue: 'IDENTIFIED' }), '— → IDENTIFIED');
  assert.equal(auditChangeLabel({}), '');
});

const RESULT = {
  FeedbackEnabled: true, UsageEnabled: true, CrashReportingEnabled: true, PerformanceEnabled: false, StackTraceEnabled: true,
  UserIdentificationMode: 'hashed', SamplingPercent: 100, SlowRouteThresholdMs: 3000, SlowApiThresholdMs: 2000,
  SevereApiThresholdMs: 8000, UsageRetentionDays: 90, PerformanceRetentionDays: 30, ErrorRetentionDays: 180
};

test('telemetry form round-trips the admin result into the action payload', () => {
  const form = telemetryFormFrom(RESULT);
  assert.equal(form.UserIdentificationMode, 'HASHED');
  assert.equal(form.SamplingPercent, '100');
  assert.equal(form.PerformanceEnabled, false);
  assert.deepEqual(validateTelemetryForm(form), {});
  assert.equal(telemetryChanged(form, telemetryFormFrom(RESULT)), false);
  const payload = telemetryPayload(form);
  assert.deepEqual(Object.keys(payload).sort(), TELEMETRY_FIELDS.map((f) => f.param).sort());
  assert.equal(payload.userIdentificationMode, 'HASHED');
  assert.equal(payload.samplingPercent, 100);
  assert.equal(payload.performanceEnabled, false);
  assert.ok(IDENTIFICATION_MODES.some((m) => m.id === payload.userIdentificationMode));
  assert.deepEqual(TELEMETRY_GROUPS, ['Collection', 'Privacy', 'Thresholds', 'Retention']);
  assert.equal(telemetryFormFrom(null).UserIdentificationMode, 'IDENTIFIED');
  assert.equal(telemetryFormFrom(null).SamplingPercent, '');
});

test('telemetry validation catches blanks, ranges, bad modes and the severe >= slow rule', () => {
  const form = telemetryFormFrom(RESULT);
  const errors = validateTelemetryForm({ ...form, SamplingPercent: '150', UsageRetentionDays: '', UserIdentificationMode: 'X', SevereApiThresholdMs: '1000' });
  assert.match(errors.SamplingPercent, /between 0 and 100/);
  assert.match(errors.UsageRetentionDays, /whole number/);
  assert.match(errors.UserIdentificationMode, /identification mode/);
  assert.match(errors.SevereApiThresholdMs, /slow API threshold/);
  assert.equal(errors.SlowApiThresholdMs, undefined);
  assert.equal(telemetryChanged({ ...form, SamplingPercent: '50' }, form), true);
  assert.equal(telemetryChanged(null, form), false);
});
