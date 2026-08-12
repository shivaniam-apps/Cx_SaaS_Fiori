import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasMemberAccess,
  hasApproverAccess,
  hasActivatorAccess,
  hasAdminAccess
} from './memberAccess.js';

const info = (scopes) => ({ scopes });

test('no scopes payload means no access', () => {
  assert.equal(hasMemberAccess(null), false);
  assert.equal(hasMemberAccess({}), false);
  assert.equal(hasAdminAccess({}), false);
});

test('member access follows the role hierarchy', () => {
  assert.equal(hasMemberAccess(info({ Member: true })), true);
  assert.equal(hasMemberAccess(info({ Approver: true })), true);
  assert.equal(hasMemberAccess(info({ Activator: true })), true);
  assert.equal(hasMemberAccess(info({ Admin: true })), true);
  assert.equal(hasMemberAccess(info({})), false);
});

test('approver access includes activator but not admin-only', () => {
  assert.equal(hasApproverAccess(info({ Approver: true })), true);
  assert.equal(hasApproverAccess(info({ Activator: true })), true);
  // Admin administers the SaaS; it does not imply decision rights.
  assert.equal(hasApproverAccess(info({ Admin: true })), false);
  assert.equal(hasApproverAccess(info({ Member: true })), false);
});

test('activator access is exact', () => {
  assert.equal(hasActivatorAccess(info({ Activator: true })), true);
  assert.equal(hasActivatorAccess(info({ Admin: true, Approver: true })), false);
});
