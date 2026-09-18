// ---------------------------------------------------------------------------
// Transport verification on a follow-on system (S10).
//
// The activation manifest (activation-manifest.js) tells a basis admin how
// to verify each item after the transport was imported into QA or PROD.
// This module turns those hints into the checks AdoptOps can run itself
// through the ZADO READ unit - the only ZADO service published on
// follow-on systems - and into an import status per transport and system:
//
//   TRANSPORT_IMPORTED  E070 on the follow-on system knows the request
//                       (the object list travels with the import) with
//                       status R -> the transport arrived.
//   ROLE_EXISTS         RoleInventory (AGR_DEFINE) lists the PFCG role.
//   ROLE_HAS_USERS      RoleInventory lists the role with assigned users
//                       (assignments are client-local, never transported).
//   MANUAL              no read-unit check exists yet (ICF nodes, OData
//                       services, task lists, spaces, pages): the manifest
//                       hint stays the verification.
//
// Pure except for verifyTransportImport, which takes its readers injected
// so the CAP handler, the mock mode and the tests share one code path.
// ---------------------------------------------------------------------------

const VERIFY_KIND = Object.freeze({
  TRANSPORT_IMPORTED: 'TRANSPORT_IMPORTED',
  ROLE_EXISTS: 'ROLE_EXISTS',
  ROLE_HAS_USERS: 'ROLE_HAS_USERS',
  MANUAL: 'MANUAL'
});

const VERDICT = Object.freeze({
  VERIFIED: 'VERIFIED',
  NOT_FOUND: 'NOT_FOUND',
  MANUAL: 'MANUAL',
  UNKNOWN: 'UNKNOWN'
});

const IMPORT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  IMPORTED: 'IMPORTED',
  IMPORT_FAILED: 'IMPORT_FAILED',
  UNKNOWN: 'UNKNOWN'
});

const IMPORT_SOURCE = Object.freeze({ READ_UNIT: 'READ_UNIT', OPERATOR: 'OPERATOR' });

// Statuses an operator may record by hand (the runbook outcome).
const RECORDABLE_IMPORT_STATUSES = Object.freeze([IMPORT_STATUS.IMPORTED, IMPORT_STATUS.IMPORT_FAILED, IMPORT_STATUS.PENDING]);

// The role a manifest entry is about: the planner's key carries it, the
// object name is the fallback for steps planned before the key contract.
function roleNameOf(entry) {
  const key = entry.objectKey && typeof entry.objectKey === 'object' ? entry.objectKey : null;
  return String(key?.role || entry.object || '').trim().toUpperCase();
}

// Which read-unit check verifies a manifest entry. Pure.
function verificationReadFor(entry) {
  switch (entry.stepType) {
    case 'CREATE_PFCG_ROLE':
    case 'ADD_CATALOG_TO_ROLE':
    case 'ADD_SPACE_TO_ROLE':
    case 'GENERATE_PROFILE':
      return { kind: VERIFY_KIND.ROLE_EXISTS, roleName: roleNameOf(entry) };
    case 'ASSIGN_ROLE_TO_USERS':
      return { kind: VERIFY_KIND.ROLE_HAS_USERS, roleName: roleNameOf(entry) };
    case 'ADD_TO_TRANSPORT':
    case 'APPEND_TO_TRANSPORT':
      return { kind: VERIFY_KIND.TRANSPORT_IMPORTED };
    default:
      return { kind: VERIFY_KIND.MANUAL };
  }
}

function manifestEntries(manifest) {
  if (!manifest) return [];
  return [...(manifest.transportable || []), ...(manifest.localReplay || [])]
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
}

// Distinct PFCG roles the manifest needs read on the follow-on system.
function roleNamesFor(manifest) {
  const names = new Set();
  for (const entry of manifestEntries(manifest)) {
    const spec = verificationReadFor(entry);
    if (spec.roleName) names.add(spec.roleName);
  }
  return [...names];
}

// Import status from the TransportStatus read: { supported, row, error }.
function importStatusFrom(transportStatus, targetSystem) {
  const systemLabel = targetSystem?.displayName || targetSystem?.systemId || 'the follow-on system';
  if (transportStatus?.error) {
    return { status: IMPORT_STATUS.UNKNOWN, detail: `TransportStatus read failed on ${systemLabel}: ${transportStatus.error}` };
  }
  if (transportStatus?.supported === false) {
    return {
      status: IMPORT_STATUS.UNKNOWN,
      detail: `The ZADO add-on on ${systemLabel} has no TransportStatus entity (older than S10) - record the import by hand.`
    };
  }
  const row = transportStatus?.row || null;
  if (!row) {
    return { status: IMPORT_STATUS.PENDING, detail: `Request not known to ${systemLabel} (no E070 row) - not imported yet.` };
  }
  if (row.RequestStatus === 'R') {
    return {
      status: IMPORT_STATUS.IMPORTED,
      detail: `Request known to ${systemLabel} with status R (${row.ObjectCount ?? 0} object(s) in E071).`
    };
  }
  return {
    status: IMPORT_STATUS.PENDING,
    detail: `Request known to ${systemLabel} with status ${row.RequestStatus || '?'} - this looks like the source system, not an import.`
  };
}

function roleDetail(role) {
  return `PFCG role exists (${role.UserCount ?? 0} user(s), ${role.MenuTcodeCount ?? 0} menu transaction(s)).`;
}

function verdictFor(entry, spec, { rolesByName, rolesError, importStatus }) {
  switch (spec.kind) {
    case VERIFY_KIND.ROLE_EXISTS: {
      if (rolesError) return { verdict: VERDICT.UNKNOWN, detail: `RoleInventory read failed: ${rolesError}` };
      const role = rolesByName.get(spec.roleName);
      if (!role) return { verdict: VERDICT.NOT_FOUND, detail: `PFCG role ${spec.roleName} not found (AGR_DEFINE).` };
      const menuNote = ['ADD_SPACE_TO_ROLE', 'ADD_CATALOG_TO_ROLE'].includes(entry.stepType) ? ' Menu node not readable through the read unit - check PFCG.' : '';
      const profileNote = entry.stepType === 'GENERATE_PROFILE' ? ' Profile generation not readable through the read unit - regenerate after import.' : '';
      return { verdict: VERDICT.VERIFIED, detail: `${roleDetail(role)}${menuNote}${profileNote}` };
    }
    case VERIFY_KIND.ROLE_HAS_USERS: {
      if (rolesError) return { verdict: VERDICT.UNKNOWN, detail: `RoleInventory read failed: ${rolesError}` };
      const role = rolesByName.get(spec.roleName);
      if (!role) return { verdict: VERDICT.NOT_FOUND, detail: `PFCG role ${spec.roleName} not found (AGR_DEFINE).` };
      if (Number(role.UserCount) > 0) return { verdict: VERDICT.VERIFIED, detail: `${role.UserCount} user(s) assigned on this system.` };
      return { verdict: VERDICT.NOT_FOUND, detail: 'Role exists but no users are assigned on this system yet (assignments are client-local).' };
    }
    case VERIFY_KIND.TRANSPORT_IMPORTED: {
      if (importStatus.status === IMPORT_STATUS.IMPORTED) return { verdict: VERDICT.VERIFIED, detail: importStatus.detail };
      if (importStatus.status === IMPORT_STATUS.UNKNOWN) return { verdict: VERDICT.UNKNOWN, detail: importStatus.detail };
      return { verdict: VERDICT.NOT_FOUND, detail: importStatus.detail };
    }
    default:
      return { verdict: VERDICT.MANUAL, detail: entry.verification || 'Verify by hand on this system.' };
  }
}

// Verdict per manifest entry plus the counts persisted on TransportImports.
function buildVerification({ manifest, roles = [], rolesError = null, importStatus, targetSystem, checkedAt }) {
  const rolesByName = new Map((roles || []).map((r) => [String(r.RoleName || '').toUpperCase(), r]));
  const items = manifestEntries(manifest).map((entry) => {
    const spec = verificationReadFor(entry);
    const { verdict, detail } = verdictFor(entry, spec, { rolesByName, rolesError, importStatus });
    return {
      sequence: entry.sequence,
      stepType: entry.stepType,
      object: entry.object,
      group: entry.group,
      transportable: (manifest.transportable || []).includes(entry),
      kind: spec.kind,
      verdict,
      detail
    };
  });
  const count = (verdict) => items.filter((i) => i.verdict === verdict).length;
  return {
    targetSystem: targetSystem
      ? { id: targetSystem.ID, name: targetSystem.displayName, environment: targetSystem.environment || '' }
      : null,
    checkedAt: checkedAt || null,
    importStatus: importStatus.status,
    importDetail: importStatus.detail,
    items,
    counts: {
      verified: count(VERDICT.VERIFIED),
      notFound: count(VERDICT.NOT_FOUND),
      manual: count(VERDICT.MANUAL),
      unknown: count(VERDICT.UNKNOWN)
    }
  };
}

// Deterministic readers for mock mode: a released transport has arrived,
// its roles exist without users; anything else is not there yet.
function mockReaders({ transport }) {
  const released = transport?.Status === 'RELEASED';
  return {
    async readTransportStatus({ trkorr }) {
      return {
        supported: true,
        row: released
          ? { Trkorr: trkorr, RequestType: 'K', RequestStatus: 'R', Owner: transport.Owner || '', ObjectCount: Number(transport.ObjectCount) || 3, SystemId: 'MCK', Client: '200' }
          : null
      };
    },
    async readRoles({ roleNames }) {
      return released
        ? roleNames.map((name) => ({ RoleName: name, RoleText: `${name} (mock)`, RoleType: 'SINGLE', UserCount: 0, MenuTcodeCount: 4, AuthTcodeCount: 4 }))
        : [];
    }
  };
}

// The verification run. readers = { readTransportStatus({ targetSystem, trkorr }),
// readRoles({ targetSystem, roleNames }) }; a reader that throws degrades
// its verdicts to UNKNOWN instead of failing the run - the row still says
// when and by whom the system was checked.
async function verifyTransportImport({ transport, targetSystem, manifest, readers, now = new Date() }) {
  const checkedAt = now.toISOString();
  const trkorr = transport.TransportRequestId;

  let transportStatus;
  try {
    transportStatus = await readers.readTransportStatus({ targetSystem, trkorr });
  } catch (error) {
    transportStatus = { supported: true, row: null, error: error?.message || String(error) };
  }
  const importStatus = importStatusFrom(transportStatus, targetSystem);

  let roles = [];
  let rolesError = null;
  const roleNames = roleNamesFor(manifest);
  if (roleNames.length) {
    try {
      roles = await readers.readRoles({ targetSystem, roleNames });
    } catch (error) {
      rolesError = error?.message || String(error);
    }
  }

  const verification = manifest ? buildVerification({ manifest, roles, rolesError, importStatus, targetSystem, checkedAt }) : null;
  return { checkedAt, importStatus, transportStatus, verification };
}

// Columns of the TransportImports row for a verification result.
function importRowFrom({ result, checkedBy }) {
  const row = result.transportStatus?.row || null;
  const counts = result.verification?.counts || null;
  return {
    ImportStatus: result.importStatus.status,
    Source: IMPORT_SOURCE.READ_UNIT,
    RequestStatus: row?.RequestStatus || null,
    ObjectCount: row ? Number(row.ObjectCount) || 0 : null,
    ImportedAt: result.importStatus.status === IMPORT_STATUS.IMPORTED ? result.checkedAt : null,
    CheckedAt: result.checkedAt,
    CheckedBy: checkedBy || null,
    Note: result.importStatus.detail.slice(0, 500),
    VerifiedAt: result.verification ? result.checkedAt : null,
    VerifiedCount: counts ? counts.verified : null,
    NotFoundCount: counts ? counts.notFound : null,
    ManualCount: counts ? counts.manual : null,
    UnknownCount: counts ? counts.unknown : null,
    VerificationJson: result.verification ? JSON.stringify(result.verification) : null
  };
}

// Columns of the TransportImports row for an operator record.
function operatorRowFrom({ status, note, checkedBy, now = new Date() }) {
  const at = now.toISOString();
  return {
    ImportStatus: status,
    Source: IMPORT_SOURCE.OPERATOR,
    ImportedAt: status === IMPORT_STATUS.IMPORTED ? at : null,
    CheckedAt: at,
    CheckedBy: checkedBy || null,
    Note: String(note || '').trim().slice(0, 500)
  };
}

module.exports = {
  VERIFY_KIND,
  VERDICT,
  IMPORT_STATUS,
  IMPORT_SOURCE,
  RECORDABLE_IMPORT_STATUSES,
  verificationReadFor,
  roleNamesFor,
  importStatusFrom,
  buildVerification,
  mockReaders,
  verifyTransportImport,
  importRowFrom,
  operatorRowFrom
};
