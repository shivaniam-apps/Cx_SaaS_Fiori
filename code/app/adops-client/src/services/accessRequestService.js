import axios from 'axios';
import { getServiceErrorMessage } from './adminService.js';
import { mapMyRequest, mapAdminRequest } from '../features/auth/accessRequestModel.js';

// Access-request data layer. Submission and "my requests" ride on CoreService
// (any authenticated user, including role-less ones behind the Member gate);
// triage reads, the KPI summary and decisions ride on AdminService, where the
// server enforces the Admin scope. Thin: HTTP + OData unwrapping only -
// decision logic lives in features/auth/accessRequestModel.js.
const http = axios.create({ timeout: 120000 });

export { getServiceErrorMessage };

function unwrapCollection(data) {
  if (Array.isArray(data?.value)) return data.value;
  return Array.isArray(data) ? data : [];
}

// --- Requester side (CoreService) -------------------------------------------

export async function submitAccessRequest({ area, role, justification, urgency = 'NORMAL' }) {
  const response = await http.post('/core/submitAccessRequest', {
    requestedArea: area,
    requestedRole: role,
    justification,
    urgency
  });
  return response.data;
}

export async function fetchMyAccessRequests() {
  const response = await http.get('/core/getMyAccessRequests()');
  return unwrapCollection(response.data).map(mapMyRequest);
}

// --- Admin triage (AdminService) --------------------------------------------

// Bounded, server-filtered, server-sorted read. `filter` is a ready OData
// $filter expression (buildAccessRequestFilter); spaces are %20-encoded
// because CAP's parser rejects '+' inside $filter/$orderby.
export async function fetchAccessRequests({ filter = '', top = 200 } = {}) {
  const params = [
    ['$orderby', 'RequestedAt desc'],
    ['$top', String(top)],
    ['$count', 'true']
  ];
  if (filter) params.push(['$filter', filter]);
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const response = await http.get(`/catalog/AdminService/AccessRequests?${query}`);
  return {
    items: unwrapCollection(response.data).map(mapAdminRequest),
    count: Number(response.data?.['@odata.count'] ?? unwrapCollection(response.data).length)
  };
}

export async function fetchAccessRequestSummary() {
  const response = await http.get('/catalog/AdminService/queryAccessRequestSummary()');
  return response.data || {};
}

export async function decideAccessRequest({ id, decision, decisionNotes = '', grantRole = false }) {
  const response = await http.post('/catalog/AdminService/decideAccessRequest', {
    ID: id,
    decision,
    decisionNotes,
    grantRole
  });
  return mapAdminRequest(response.data);
}
