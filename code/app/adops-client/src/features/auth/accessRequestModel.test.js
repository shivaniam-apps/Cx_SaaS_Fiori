import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_REQUEST_AREAS,
  accessRequestStatusLabel,
  accessRequestUrgencyLabel,
  accessRequestAreaLabel,
  accessRequestAreaOptions,
  grantStatusLabel,
  mapMyRequest,
  mapAdminRequest,
  findRequestForArea,
  isTierUnavailableError,
  deriveRestrictedView,
  requesterLabel,
  buildAccessRequestFilter,
  hasActiveFilters,
  canDecide,
  decisionDescription,
  accessRequestSummaryCards,
  requesterDisplay,
  formatTimestamp
} from './accessRequestModel.js';

test('area vocabulary matches the CAP REQUESTABLE_AREAS and maps roles', () => {
  assert.deepEqual(Object.keys(ACCESS_REQUEST_AREAS).sort(), ['access-requests', 'application', 'product-insights', 'settings']);
  assert.equal(ACCESS_REQUEST_AREAS.application.role, 'Member');
  for (const key of ['settings', 'product-insights', 'access-requests']) assert.equal(ACCESS_REQUEST_AREAS[key].role, 'Admin', key);
  assert.deepEqual(accessRequestAreaOptions().map((o) => o.value), Object.keys(ACCESS_REQUEST_AREAS));
});

test('labels never surface raw enums for known values and fall back to the raw value otherwise', () => {
  assert.equal(accessRequestStatusLabel('PENDING'), 'Pending');
  assert.equal(accessRequestStatusLabel('WITHDRAWN'), 'WITHDRAWN');
  assert.equal(accessRequestUrgencyLabel(undefined), 'Normal');
  assert.equal(accessRequestUrgencyLabel('HIGH'), 'High');
  assert.equal(accessRequestAreaLabel('application'), 'AdoptOps Application');
  assert.equal(accessRequestAreaLabel('unknown'), 'unknown');
  assert.equal(grantStatusLabel('MANUAL'), 'Grant manually');
  assert.equal(grantStatusLabel(null), '');
});

test('mappers translate the two backend shapes into one client shape', () => {
  const mine = mapMyRequest({ ID: '1', referenceNumber: 'AR-1', requestedArea: 'application', requestedRole: 'Member', status: 'PENDING', requestedAt: 't' });
  assert.equal(mine.area, 'application');
  assert.equal(mine.role, 'Member');
  const admin = mapAdminRequest({ ID: '2', ReferenceNumber: 'AR-2', RequesterId: 'eve', RequestedArea: 'settings', Status: 'APPROVED', GrantStatus: 'MANUAL', Urgency: 'HIGH' });
  assert.equal(admin.referenceNumber, 'AR-2');
  assert.equal(admin.requesterId, 'eve');
  assert.equal(admin.grantStatus, 'MANUAL');
  assert.equal(admin.urgency, 'HIGH');
});

test('findRequestForArea prefers a pending request, else the newest for that area', () => {
  const requests = [
    { area: 'application', status: 'DECLINED', referenceNumber: 'AR-3' },
    { area: 'settings', status: 'PENDING', referenceNumber: 'AR-2' },
    { area: 'application', status: 'PENDING', referenceNumber: 'AR-1' }
  ];
  assert.equal(findRequestForArea(requests, 'application').referenceNumber, 'AR-1');
  assert.equal(findRequestForArea(requests, 'settings').referenceNumber, 'AR-2');
  assert.equal(findRequestForArea(requests, 'product-insights'), null);
  assert.equal(findRequestForArea(null, 'application'), null);
});

test('isTierUnavailableError recognises the 501 tier rejection only', () => {
  assert.equal(isTierUnavailableError({ response: { status: 501 } }), true);
  assert.equal(isTierUnavailableError({ response: { status: 400 } }), false);
  assert.equal(isTierUnavailableError(new Error('x')), false);
});

test('deriveRestrictedView hides the CTA while loading, pending or approved', () => {
  assert.equal(deriveRestrictedView({ requests: null, area: 'application' }).showCta, false);
  assert.equal(deriveRestrictedView({ requests: [], area: 'application' }).showCta, true);
  const pending = deriveRestrictedView({ requests: [{ area: 'application', status: 'PENDING' }], area: 'application' });
  assert.equal(pending.showPending, true);
  assert.equal(pending.showCta, false);
  const approved = deriveRestrictedView({ requests: [{ area: 'application', status: 'APPROVED' }], area: 'application' });
  assert.equal(approved.showApproved, true);
  assert.equal(approved.showCta, false);
  const declined = deriveRestrictedView({ requests: [{ area: 'application', status: 'DECLINED' }], area: 'application' });
  assert.equal(declined.showDeclined, true);
  assert.equal(declined.showCta, true);
  const tier = deriveRestrictedView({ requests: [], area: 'application', tierUnavailable: true });
  assert.equal(tier.showTierUnavailable, true);
  assert.equal(tier.showCta, false);
});

test('requesterLabel combines given name and id without repeating them', () => {
  assert.equal(requesterLabel({ user: 'alice', givenName: 'Alice' }), 'Alice (alice)');
  assert.equal(requesterLabel({ user: 'alice', givenName: 'alice' }), 'alice');
  assert.equal(requesterLabel({ user: 'alice' }), 'alice');
  assert.equal(requesterLabel(null), 'Current user');
});

test('buildAccessRequestFilter emits server-side terms and escapes quotes', () => {
  assert.equal(buildAccessRequestFilter({}), '');
  assert.equal(buildAccessRequestFilter({ status: 'PENDING' }), "Status eq 'PENDING'");
  assert.equal(
    buildAccessRequestFilter({ status: 'PENDING', area: 'settings', urgency: 'HIGH' }),
    "Status eq 'PENDING' and RequestedArea eq 'settings' and Urgency eq 'HIGH'"
  );
  const search = buildAccessRequestFilter({ search: " o'neil " });
  assert.match(search, /^\(contains\(ReferenceNumber,'o''neil'\) or contains\(RequesterId,'o''neil'\)/);
  assert.match(search, /contains\(Justification,'o''neil'\)\)$/);
  assert.equal(hasActiveFilters({ search: '  ' }), false);
  assert.equal(hasActiveFilters({ area: 'settings' }), true);
});

test('canDecide and decisionDescription follow the PENDING-only rule', () => {
  assert.equal(canDecide({ status: 'PENDING' }), true);
  assert.equal(canDecide({ status: 'APPROVED' }), false);
  assert.equal(canDecide(null), false);
  const request = { referenceNumber: 'AR-9', requesterName: 'Eve', requesterId: 'eve', area: 'application', role: 'Member' };
  assert.equal(decisionDescription(request, 'APPROVE'), 'Approve AR-9: Eve requests Member access for AdoptOps Application.');
  assert.equal(decisionDescription({ ...request, requesterName: '' }, 'DECLINE'), 'Decline AR-9: eve requests Member access for AdoptOps Application.');
  assert.equal(decisionDescription(null, 'APPROVE'), '');
});

test('accessRequestSummaryCards partition the total and hide Other at zero', () => {
  const cards = accessRequestSummaryCards({ Total: 9, Pending: 3, Approved: 5, Declined: 1, Other: 0 });
  assert.deepEqual(cards.map((c) => c.key), ['PENDING', 'APPROVED', 'DECLINED']);
  assert.equal(cards.reduce((sum, c) => sum + c.value, 0), 9);
  const withOther = accessRequestSummaryCards({ Total: 10, Pending: 3, Approved: 5, Declined: 1, Other: 1 });
  assert.equal(withOther.at(-1).key, 'OTHER');
  assert.equal(withOther.reduce((sum, c) => sum + c.value, 0), 10);
  assert.equal(accessRequestSummaryCards(null).reduce((sum, c) => sum + c.value, 0), 0);
});

test('requesterDisplay shows the name first and the identifiers underneath', () => {
  assert.deepEqual(requesterDisplay({ requesterName: 'Eve', requesterId: 'eve', requesterEmail: 'eve@x.com' }), { primary: 'Eve', secondary: 'eve · eve@x.com' });
  assert.deepEqual(requesterDisplay({ requesterId: 'eve@x.com', requesterEmail: 'eve@x.com' }), { primary: 'eve@x.com', secondary: '' });
  assert.deepEqual(requesterDisplay(null), { primary: '', secondary: '' });
});

test('formatTimestamp trims ISO strings to minute precision', () => {
  assert.equal(formatTimestamp('2026-09-15T10:03:22.123Z'), '2026-09-15 10:03');
  assert.equal(formatTimestamp(null), '');
});
