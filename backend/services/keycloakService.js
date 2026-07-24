/**
 * KeycloakService — OIDC Authorization Code SSO via Keycloak.
 *
 * Why not proxy SPNEGO?
 *   Kerberos tickets are issued for a specific service principal (SPN).
 *   The browser's ticket is for HTTP/home.test.pituah.iaf — forwarding it to
 *   Keycloak's token endpoint fails because the ticket is for the wrong SPN.
 *   The correct approach is to redirect the browser to Keycloak so Keycloak
 *   handles the Kerberos handshake directly with the browser.
 *
 * Flow:
 *   1. Frontend detects no token → redirects to GET /api/auth/sso/login
 *   2. Backend redirects to Keycloak /auth (see KEYCLOAK_PROMPT / KEYCLOAK_IDP_HINT).
 *   3. Keycloak sends WWW-Authenticate: Negotiate to the browser directly.
 *   4. Browser sends Kerberos ticket for HTTP/keycloak.test… to Keycloak.
 *   5. Keycloak validates → redirects to /api/auth/sso/callback?code=...
 *   6. Backend exchanges code for OIDC tokens → mints local JWT → HTML page sets localStorage.
 *   7. On failure Keycloak redirects with error=(login_required | interaction_required);
 *      we send the browser back so the LDAP form can be used.
 *
 * Important: do NOT use prompt=none if you rely on Kerberos in the browser. OIDC silent mode
 * often prevents SPNEGO from running, Keycloak responds with login_required and SSO never succeeds.
 *
 * Required env vars:
 *   KEYCLOAK_ENABLED=true
 *   KEYCLOAK_URL=https://keycloak.example.com
 *   KEYCLOAK_REALM=master
 *   KEYCLOAK_CLIENT_ID=homepage
 *   KEYCLOAK_CLIENT_SECRET=<secret>
 *
 * Optional:
 *   KEYCLOAK_REDIRECT_URI=https://home.example.com/api/auth/sso/callback
 *     Auto-detected from request Host header if unset (works behind TRUST_PROXY=1).
 *   KEYCLOAK_IDP_HINT=kerberos
 *     Alias of your Kerberos IdP broker in Keycloak → Identity providers (kc_idp_hint).
 *     Omit/unset unless you must force a broker; wrong alias ⇒ login_required.
 *   KEYCLOAK_PROMPT
 *     OIDC prompt. Leave unset so Keycloak runs normal auth incl. SPNEGO (recommended).
 *     Set KEYCLOAK_PROMPT=none only if you explicitly want silent-only (Kerberos rarely works).
 *   KEYCLOAK_ADMIN_ROLE=admin
 *     Keycloak realm role that grants isAdmin. Default: admin.
 *   KEYCLOAK_TIMEOUT_MS=5000
 *   KEYCLOAK_TLS_INSECURE=false
 */

const crypto = require('crypto');

function keycloakTlsInsecure() {
  return String(process.env.KEYCLOAK_TLS_INSECURE || '').toLowerCase() === 'true';
}

async function keycloakFetch(url, opts) {
  if (keycloakTlsInsecure()) {
    const { fetch: undiciFetch, Agent } = require('undici');
    return undiciFetch(url, {
      ...opts,
      dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
    });
  }
  return fetch(url, opts);
}

class KeycloakService {
  isEnabled() {
    return (
      String(process.env.KEYCLOAK_ENABLED || '').toLowerCase() === 'true' &&
      Boolean((process.env.KEYCLOAK_URL || '').trim()) &&
      Boolean((process.env.KEYCLOAK_REALM || '').trim()) &&
      Boolean((process.env.KEYCLOAK_CLIENT_ID || '').trim())
    );
  }

  getRealmUrl() {
    const base = String(process.env.KEYCLOAK_URL || '').trim().replace(/\/+$/, '');
    const realm = String(process.env.KEYCLOAK_REALM || '').trim();
    return `${base}/realms/${encodeURIComponent(realm)}`;
  }

  getTimeout() {
    return Math.max(2000, Number(process.env.KEYCLOAK_TIMEOUT_MS) || 5000);
  }

  /** Probe OIDC discovery to confirm Keycloak is reachable. */
  async isReachable() {
    if (!this.isEnabled()) return false;
    const url = `${this.getRealmUrl()}/.well-known/openid-configuration`;
    try {
      const r = await keycloakFetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.getTimeout()),
      });
      if (r.status !== 200) {
        console.warn(`[keycloak] discovery returned HTTP ${r.status}: ${url}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[keycloak] reachability probe failed (${url}):`, err.message);
      return false;
    }
  }

  /**
   * Build the Keycloak authorization URL to redirect the browser to.
   * @param {string} state  Signed state token (CSRF protection)
   * @param {string} redirectUri  Where Keycloak should redirect after auth
   */
  buildLoginUrl(state, redirectUri) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: String(process.env.KEYCLOAK_CLIENT_ID || '').trim(),
      redirect_uri: redirectUri,
      scope: 'openid',
      state,
    });

    const prompt = String(process.env.KEYCLOAK_PROMPT || '').trim();
    if (prompt) params.set('prompt', prompt);

    const idpHint = String(process.env.KEYCLOAK_IDP_HINT || '').trim();
    if (idpHint) params.set('kc_idp_hint', idpHint);

    return `${this.getRealmUrl()}/protocol/openid-connect/auth?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for OIDC tokens.
   * @param {string} code  Auth code from Keycloak callback
   * @param {string} redirectUri  Must match the one used in buildLoginUrl
   */
  async exchangeCode(code, redirectUri) {
    const tokenUrl = `${this.getRealmUrl()}/protocol/openid-connect/token`;
    const clientId     = String(process.env.KEYCLOAK_CLIENT_ID     || '').trim();
    const clientSecret = String(process.env.KEYCLOAK_CLIENT_SECRET || '').trim();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
    });
    if (clientSecret) body.set('client_secret', clientSecret);

    console.log(`[keycloak] exchanging auth code → ${tokenUrl}`);

    const r = await keycloakFetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(this.getTimeout()),
    });

    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* raw */ }

    if (!r.ok) {
      const msg = data.error_description || data.error || `HTTP ${r.status}`;
      console.error(`[keycloak] code exchange failed (${r.status}): ${msg} | ${text.slice(0, 300)}`);
      throw new Error(`Keycloak code exchange failed: ${msg}`);
    }

    return data;
  }

  /**
   * Decode the ID token payload.
   * Authenticity is guaranteed by the Keycloak HTTPS response — no need to re-verify sig here.
   * @returns {{ username, displayName, email, roles }}
   */
  parseUserFromIdToken(idToken) {
    if (!idToken) throw new Error('No id_token in Keycloak response');
    const parts = String(idToken).split('.');
    if (parts.length !== 3) throw new Error('Invalid id_token format');

    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const pad = (4 - (padded.length % 4)) % 4;
      payload = JSON.parse(Buffer.from(padded + '='.repeat(pad), 'base64').toString('utf8'));
    }

    const preferred = String(payload.preferred_username || '').trim();
    const sub = String(payload.sub || '').trim();

    function firstClaim(...keys) {
      for (let k = 0; k < keys.length; k += 1) {
        const raw = payload[keys[k]];
        if (raw == null) continue;
        const s = String(raw).trim();
        if (s) return s;
      }
      return '';
    }

    /** Explicit LDAP / mapper claims only — not preferred_username (often full name). */
    const samAccountNameHint = firstClaim(
      'sAMAccountName',
      'SAMAccountName',
      'samaccountname',
      'sam_account_name',
    );

    return {
      username: preferred || sub || '',
      displayName: String(payload.name || preferred || sub || '').trim(),
      email: String(payload.email || '').trim(),
      roles: Array.isArray(payload.realm_access?.roles) ? payload.realm_access.roles : [],
      subject: sub,
      samAccountNameHint,
    };
  }

  /** Keycloak realm role that maps to isAdmin. Env: KEYCLOAK_ADMIN_ROLE (default "admin"). */
  adminRole() {
    return String(process.env.KEYCLOAK_ADMIN_ROLE || 'admin').trim().toLowerCase();
  }

  /** Generate a short-lived signed state token (CSRF protection for the OIDC flow). */
  createState() {
    const nonce = crypto.randomBytes(16).toString('hex');
    // Simple HMAC-signed state — no extra dependency needed
    const payload = Buffer.from(JSON.stringify({ nonce, iat: Date.now() })).toString('base64url');
    const sig = crypto
      .createHmac('sha256', process.env.JWT_SECRET || 'fallback')
      .update(payload)
      .digest('base64url');
    return `${payload}.${sig}`;
  }

  /** Verify a state token. Throws if tampered or expired (>10 min). */
  verifyState(state) {
    if (!state || typeof state !== 'string') throw new Error('Missing state');
    const [payload, sig] = state.split('.');
    if (!payload || !sig) throw new Error('Malformed state');
    const expected = crypto
      .createHmac('sha256', process.env.JWT_SECRET || 'fallback')
      .update(payload)
      .digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new Error('State signature invalid');
    }
    const { iat } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Date.now() - iat > 10 * 60 * 1000) throw new Error('State expired');
  }
}

module.exports = new KeycloakService();
