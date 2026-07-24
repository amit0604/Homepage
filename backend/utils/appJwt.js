const jwt = require('jsonwebtoken');

/**
 * Derives jwt.sign `{ expiresIn: ... }` from JWT_EXPIRES_IN.
 * Omitting expiresIn ⇒ no `exp` claim — JWT stays valid until signature/secret rotates.
 *
 * Accepted:
 * - Unset → no expiry (default)
 * - Empty / 0 / false / none / never / off → no expiry
 * - Any jsonwebtoken `expiresIn` string (e.g. 24h, 365d, 7200)
 */
function jwtExpiresInSignOption() {
  if (!Object.prototype.hasOwnProperty.call(process.env, 'JWT_EXPIRES_IN')) {
    return undefined;
  }
  const raw = process.env.JWT_EXPIRES_IN;
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return undefined;
  const lowered = s.toLowerCase();
  if (lowered === '0' || lowered === 'false' || lowered === 'none' || lowered === 'never' || lowered === 'off') {
    return undefined;
  }
  const n = Number(s);
  if (Number.isFinite(n) && n <= 0) return undefined;
  return s;
}

/** Sign an app JWT (LDAP / local-admin / SSO). Caller supplies claims; optional `sso: true`. */
function signAppToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  const expiresIn = jwtExpiresInSignOption();
  const opts = {};
  if (expiresIn != null && expiresIn !== undefined) opts.expiresIn = expiresIn;
  return jwt.sign(payload, secret, opts);
}

module.exports = { signAppToken, jwtExpiresInSignOption };
