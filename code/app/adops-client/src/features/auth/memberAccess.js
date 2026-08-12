// Pure gate predicates over the /core/userInfo scopes payload. Components
// consume these; the rules live once, here, and are unit-testable.

export function hasMemberAccess(userInfo) {
  const scopes = userInfo?.scopes;
  if (!scopes) return false;
  return Boolean(scopes.Member || scopes.Approver || scopes.Activator || scopes.Admin);
}

export function hasApproverAccess(userInfo) {
  const scopes = userInfo?.scopes;
  if (!scopes) return false;
  return Boolean(scopes.Approver || scopes.Activator);
}

export function hasActivatorAccess(userInfo) {
  return Boolean(userInfo?.scopes?.Activator);
}

export function hasAdminAccess(userInfo) {
  return Boolean(userInfo?.scopes?.Admin);
}
