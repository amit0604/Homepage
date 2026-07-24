/**
 * Human-friendly label from a decoded JWT. Backend includes `displayName` for LDAP and local logins.
 */
export function userDisplayName(decoded) {
  if (!decoded) return 'User';
  const d = decoded.displayName != null ? String(decoded.displayName).trim() : '';
  if (d) return d;
  const u = decoded.username != null ? String(decoded.username).trim() : '';
  return u || 'User';
}
