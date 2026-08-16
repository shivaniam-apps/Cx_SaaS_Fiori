// Pure helpers for the Target Systems destination catalog: shape raw BTP
// destination-configuration records, classify each against the registered
// target systems, and derive a registration draft.
//
// No imports and nothing touching import.meta.env — this module must stay
// loadable by `node --test` outside Vite (.claude/rules/frontend-testing.md).

const EXPOSED = 'Exposed';
const MAPPED = 'Mapped';
const AVAILABLE = 'Available';

export const DESTINATION_STATUS = { EXPOSED, MAPPED, AVAILABLE };

// Raw records come straight from the BTP destination-configuration API, whose
// keys are capitalised (Name, Type, URL, ProxyType, Authentication). Read
// defensively so a shape change or a lower-cased mock does not blank the row.
export function normalizeDestination(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = raw.Name || raw.name || '';
  if (!name) return null;
  return {
    name,
    description: raw.Description || raw.description || '',
    type: raw.Type || raw.type || '',
    proxyType: raw.ProxyType || raw.proxyType || '',
    authentication: raw.Authentication || raw.authentication || '',
    url: raw.URL || raw.url || '',
    client: raw['sap-client'] || raw.sapClient || ''
  };
}

// A destination is Exposed when an active registered target system points at
// it, Mapped when the target system exists but is inactive, else Available.
export function classifyDestination(destination, systemsByDest) {
  const system = systemsByDest.get(destination.name) || null;
  let status = AVAILABLE;
  if (system) status = system.active === false ? MAPPED : EXPOSED;
  return { ...destination, status, system };
}

export function buildDestinationCatalog(rawDestinations, systems) {
  const systemsByDest = new Map(
    (systems || [])
      .filter((s) => s && s.destinationName)
      .map((s) => [s.destinationName, s])
  );
  return (rawDestinations || [])
    .map(normalizeDestination)
    .filter(Boolean)
    .map((d) => classifyDestination(d, systemsByDest))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Prefill for the Register dialog when exposing a not-yet-registered
// destination. Only the routing identity plus safely-derivable metadata; the
// admin confirms SID / environment / release. destinationName is the one field
// that must match the BTP catalog exactly, so it is never guessed here.
export function draftFromDestination(destination, emptyDraft) {
  return {
    ...emptyDraft,
    displayName: destination.description || destination.name,
    destinationName: destination.name,
    client: destination.client || emptyDraft.client || ''
  };
}
