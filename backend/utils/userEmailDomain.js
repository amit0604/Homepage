function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** From `USER_EMAIL_DOMAIN` (e.g. in docker-compose); empty if unset — use full UPN or DOMAIN\\user at login. */
function getUserEmailDomain() {
  const d = (process.env.USER_EMAIL_DOMAIN || '').trim();
  return d.replace(/^@+/, '');
}

function stripConfiguredEmailSuffix(username) {
  if (username == null) return '';
  const s = String(username);
  const dom = getUserEmailDomain();
  if (!dom) return s;
  return s.replace(new RegExp(`@${escapeRegex(dom)}$`, 'i'), '');
}

/** Use when the login id is a bare sAMAccountName; keeps full UPN if already present. */
function toLoginEmailOrUpn(username) {
  if (username == null) return '';
  const s = String(username).trim();
  if (!s) return s;
  if (s.includes('@')) return s;
  const dom = getUserEmailDomain();
  if (!dom) return s;
  return `${s}@${dom}`;
}

/** Placeholder / synthetic email for local user rows when the id has no @. */
function placeholderEmailForUsername(username) {
  if (username == null) return '';
  const s = String(username).trim();
  if (!s) return s;
  if (s.includes('@')) return s;
  const dom = getUserEmailDomain();
  if (!dom) return s;
  return `${s}@${dom}`;
}

/**
 * Tries sAMAccountName, UPN (user@domain), and DOMAIN\\user (if LDAP_NETBIOS_DOMAIN) for AD bind.
 * Order: NetBIOS\\user, user@USER_EMAIL_DOMAIN, then bare sAM.
 */
function buildLdapLoginCandidates(input) {
  const s = String(input || '').trim();
  if (!s) return [];
  const out = [];
  const seen = new Set();
  const add = (v) => {
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  if (s.includes('@')) {
    add(s);
    return out;
  }
  const dom = getUserEmailDomain();
  const netbios = (process.env.LDAP_NETBIOS_DOMAIN || '').trim();
  if (netbios) add(`${netbios}\\${s}`);
  if (dom) add(`${s}@${dom}`);
  add(s);
  return out;
}

module.exports = {
  getUserEmailDomain,
  stripConfiguredEmailSuffix,
  toLoginEmailOrUpn,
  placeholderEmailForUsername,
  escapeRegex,
  buildLdapLoginCandidates,
};
