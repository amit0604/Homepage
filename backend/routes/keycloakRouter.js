/**
 * Keycloak SSO — OIDC Authorization Code flow
 *
 * GET /api/auth/sso/login
 *   Redirect to Keycloak auth endpoint so the browser completes SPNEGO with Keycloak
 *   (Authorization: Negotiate targets the Keycloak SPN — do NOT use OIDC silent mode
 *   unless Keycloak succeeds without browser auth; silent mode returns login_required for Kerberos).
 *
 * GET /api/auth/sso/callback?code=...&state=...
 *   Keycloak redirects here after successful authentication.
 *   Exchanges the auth code, mints a local JWT, returns an HTML page that
 *   stores the token in localStorage and redirects back to the app root.
 *
 * GET /api/auth/sso/logout
 *   RP-initiated Keycloak logout (ends Keycloak SSO session); then redirects to post-logout
 *   which clears the app token. Used when the JWT includes sso:true (Header Logout link).
 *
 * GET /api/auth/sso/post-logout
 *   Clears localStorage token after Keycloak redirects here. Optionally sets sso_pause_until
 *   so auto SSO waits (KEYCLOAK_SSO_COOLDOWN_AFTER_LOGOUT_MS). Whitelist this URL under
 *   Keycloak client "Valid post logout redirect URIs".
 *
 * GET /api/auth/sso/status
 *   Returns { enabled, reachable } — used by the SPA to decide whether to run SSO at startup.
 */

const express = require('express');
const { signAppToken } = require('../utils/appJwt');
const keycloakService = require('../services/keycloakService');
const ldapSingleton = require('../services/ldapSingleton');
const { collections } = require('../repositories/jsonStore');
const { placeholderEmailForUsername, getUserEmailDomain } = require('../utils/userEmailDomain');

const router = express.Router();
const User = collections.users;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive the callback URI from env or from the request Host header. */
function getRedirectUri(req) {
  const env = String(process.env.KEYCLOAK_REDIRECT_URI || '').trim();
  if (env) return env;
  // Auto-detect: works when TRUST_PROXY=1 is set (handles X-Forwarded-Proto/Host)
  return `${req.protocol}://${req.get('host')}/api/auth/sso/callback`;
}

/** After Keycloak end-session redirect; whitelist in KC client ("Valid post logout redirect URIs"). */
function getPostLogoutRedirectUri(req) {
  const env = String(process.env.KEYCLOAK_POST_LOGOUT_REDIRECT_URI || '').trim();
  if (env) return env;
  return `${req.protocol}://${req.get('host')}/api/auth/sso/post-logout`;
}

/**
 * Idle window (ms) after Keycloak RP logout before the SPA may auto SSO again —
 * reduces Kerberos immediately logging back in. 0 disables.
 * Env KEYCLOAK_SSO_COOLDOWN_AFTER_LOGOUT_MS — max 600000 (10 min).
 */
function parseSsoCooldownAfterLogoutMs() {
  const raw = process.env.KEYCLOAK_SSO_COOLDOWN_AFTER_LOGOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 10000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 600000);
}

// Lazy-init LDAP service for group lookups (best-effort after Keycloak SSO)
function getAdService() {
  if (!(process.env.LDAP_URL || '').trim()) return null;
  return ldapSingleton;
}

function groupDnLower(g) {
  return String(g.dn || g.distinguishedName || '').trim().toLowerCase();
}

function userHasPingerAccess(isAdmin, groups) {
  if (isAdmin) return true;
  const pingerDn = String(process.env.LDAP_PINGER_GROUP_DN || '').trim().toLowerCase();
  if (!pingerDn || !Array.isArray(groups)) return false;
  return groups.some((g) => groupDnLower(g) === pingerDn);
}

/**
 * Single LDAP round-trip: find the AD user (same identifiers as form login) and their groups.
 * Resolves sAMAccountName for username parity with POST /login (LDAP).
 */
async function resolveLdapUserAndGroups(tokenUsername, email, samAccountNameHint) {
  const adService = getAdService();
  if (!adService) return { adUser: null, groups: [] };
  const candidates = [samAccountNameHint, email, tokenUsername].filter(Boolean);
  try {
    const adUser = await adService.findAdUserByAnyCandidate(candidates);
    if (!adUser) return { adUser: null, groups: [] };
    const groups = await adService.findUserGroupsForAdUser(adUser);
    return { adUser, groups: Array.isArray(groups) ? groups : [] };
  } catch (err) {
    console.warn('[keycloak-sso] LDAP user/group lookup failed:', err.message);
    return { adUser: null, groups: [] };
  }
}

function usernameOrEmailMatchesLocalUser(u, accountName, tokenUsername, emailSet) {
  const acc = String(accountName || '').trim().toLowerCase();
  const tok = String(tokenUsername || '').trim().toLowerCase();
  const uu = String(u.username || '').trim().toLowerCase();
  if (acc && uu === acc) return true;
  if (tok && uu === tok) return true;
  const ue = u.email ? String(u.email).trim().toLowerCase() : '';
  if (ue && emailSet && emailSet.has(ue)) return true;
  return false;
}

function resolveIsAdmin(kcRoles, groups, localUser) {
  if (localUser?.isAdmin) return true;
  const kcAdminRole = keycloakService.adminRole();
  if (kcRoles.some((r) => String(r).toLowerCase() === kcAdminRole)) return true;
  const adminDn = String(process.env.LDAP_ADMIN_GROUP_DN || '').trim().toLowerCase();
  if (adminDn) return groups.some((g) => groupDnLower(g) === adminDn);
  return groups.some((g) => g.cn === 'Domain Admins');
}

/** Tiny HTML page that sets localStorage and redirects — used for success and error. */
function htmlRedirect(script) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Signing in…</title></head><body>
<script>${script}</script>
<p style="font-family:sans-serif;padding:2rem">Signing in, please wait…</p>
</body></html>`;
}

// ---------------------------------------------------------------------------
// GET /api/auth/sso/login
// ---------------------------------------------------------------------------
router.get('/auth/sso/login', (req, res) => {
  if (!keycloakService.isEnabled()) {
    console.warn('[keycloak-sso] /sso/login called but SSO is not enabled');
    return res.redirect('/?sso_error=disabled');
  }

  const redirectUri = getRedirectUri(req);
  const state = keycloakService.createState();
  const loginUrl = keycloakService.buildLoginUrl(state, redirectUri);

  console.log(`[keycloak-sso] /sso/login → redirecting to Keycloak`);
  console.log(`[keycloak-sso]   redirect_uri: ${redirectUri}`);
  console.log(`[keycloak-sso]   login_url:    ${loginUrl}`);

  return res.redirect(loginUrl);
});

// ---------------------------------------------------------------------------
// GET /api/auth/sso/logout → Keycloak end-session → post-logout
// ---------------------------------------------------------------------------
router.get('/auth/sso/logout', (req, res) => {
  if (!keycloakService.isEnabled()) {
    console.log('[keycloak-sso] /sso/logout — SSO disabled, clearing session client-side only');
    return res.redirect('/api/auth/sso/post-logout');
  }

  const clientId = String(process.env.KEYCLOAK_CLIENT_ID || '').trim();
  if (!clientId) {
    console.warn('[keycloak-sso] /sso/logout — KEYCLOAK_CLIENT_ID missing');
    return res.redirect('/api/auth/sso/post-logout');
  }

  const realmBase = `${keycloakService.getRealmUrl()}/protocol/openid-connect`;
  const postLogoutAbsolute = getPostLogoutRedirectUri(req);
  const post = encodeURIComponent(postLogoutAbsolute);
  const url = `${realmBase}/logout?client_id=${encodeURIComponent(clientId)}&post_logout_redirect_uri=${post}`;
  console.log(`[keycloak-sso] RP-initiated logout → Keycloak (post_logout_redirect_uri=${postLogoutAbsolute})`);

  return res.redirect(url);
});

// ---------------------------------------------------------------------------
// GET /api/auth/sso/post-logout — clear app token after Keycloak session ends
// ---------------------------------------------------------------------------
router.get('/auth/sso/post-logout', (req, res) => {
  const cooldownMs = parseSsoCooldownAfterLogoutMs();
  const pauseJs =
    cooldownMs > 0
      ? `sessionStorage.setItem('sso_pause_until',String(Date.now()+${cooldownMs}));`
      : `sessionStorage.removeItem('sso_pause_until');`;

  console.log(`[keycloak-sso] /post-logout — clearing token; SSO auto pause=${cooldownMs}ms`);

  return res.send(
    htmlRedirect(
      `try{localStorage.removeItem('token');sessionStorage.removeItem('sso_attempted');sessionStorage.removeItem('sso_failed');${pauseJs}}catch(e){}` +
        `window.location.replace('/');`,
    ),
  );
});

// ---------------------------------------------------------------------------
// GET /api/auth/sso/callback
// ---------------------------------------------------------------------------
router.get('/auth/sso/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Keycloak returned an error (e.g. interaction_required when prompt=none and
  // no Kerberos ticket available) — redirect back so frontend shows LDAP form
  if (error) {
    const desc = error_description || error;
    const promptNote =
      error === 'login_required' &&
      String(process.env.KEYCLOAK_PROMPT || '').toLowerCase() === 'none'
        ? ' (often caused by OIDC prompt=none — omit KEYCLOAK_PROMPT so SPNEGO can run)'
        : '';
    console.log(`[keycloak-sso] callback error from Keycloak: ${error} — ${desc}${promptNote}`);
    const errJson = JSON.stringify(String(error));
    return res.send(htmlRedirect(
      `try{sessionStorage.setItem('sso_failed',${errJson});}catch(e){}` +
      `window.location.replace('/');`,
    ));
  }

  if (!code) {
    console.warn('[keycloak-sso] callback received without code or error');
    return res.redirect('/?sso_error=no_code');
  }

  // CSRF check
  try {
    keycloakService.verifyState(state);
  } catch (err) {
    console.warn('[keycloak-sso] state verification failed:', err.message);
    return res.redirect('/?sso_error=invalid_state');
  }

  try {
    const redirectUri = getRedirectUri(req);
    const tokenData = await keycloakService.exchangeCode(code, redirectUri);
    const userInfo = keycloakService.parseUserFromIdToken(tokenData.id_token);

    const {
      username: tokenUsername,
      displayName: tokenDisplayName,
      email: tokenEmail,
      roles,
      samAccountNameHint,
    } = userInfo;

    const { adUser, groups } = await resolveLdapUserAndGroups(
      tokenUsername,
      tokenEmail,
      samAccountNameHint,
    );
    const groupNames = groups.map((g) => g.cn).filter(Boolean);

    let accountName = adUser && adUser.sAMAccountName
      ? String(adUser.sAMAccountName).trim()
      : String(samAccountNameHint || '').trim();

    if (!accountName && tokenUsername && !/\s/.test(String(tokenUsername))) {
      accountName = String(tokenUsername).trim();
    }

    // When Keycloak puts display name in preferred_username, derive bare id from USER_EMAIL_DOMAIN e-mail (matches LDAP behaviour).
    if ((!accountName || /\s/.test(accountName)) && tokenEmail) {
      const dom = getUserEmailDomain();
      if (dom) {
        const low = tokenEmail.trim().toLowerCase();
        const suffix = `@${dom.toLowerCase()}`;
        if (low.endsWith(suffix)) {
          const local = low.slice(0, -suffix.length);
          if (local && !local.includes('@') && !/\s/.test(local)) {
            accountName = local;
          }
        }
      }
    }

    if (!accountName) {
      accountName = String(tokenUsername || '').trim();
    }

    if (!accountName) {
      throw new Error('Could not resolve application username from Keycloak or LDAP');
    }

    const display =
      (adUser && String(adUser.displayName || adUser.cn || '').trim())
      || String(tokenDisplayName || '').trim()
      || accountName;

    const upn = adUser && adUser.userPrincipalName ? String(adUser.userPrincipalName).trim() : null;
    const mailFromAd = adUser && adUser.mail ? String(adUser.mail).trim() : '';
    const effectiveEmail =
      mailFromAd
      || (tokenEmail && tokenEmail.trim())
      || (upn || placeholderEmailForUsername(accountName));

    const emailMatchSet = new Set(
      [tokenEmail, mailFromAd, upn, placeholderEmailForUsername(accountName)]
        .filter(Boolean)
        .map((e) => String(e).trim().toLowerCase()),
    );

    console.log(
      `[keycloak-sso] authenticated tokenUser="${tokenUsername}" → canonical="${accountName}" ` +
      `roles=[${roles.join(', ')}]`,
    );

    const localUser = await User.findOne((u) =>
      usernameOrEmailMatchesLocalUser(u, accountName, tokenUsername, emailMatchSet),
    );

    const isAdmin = resolveIsAdmin(roles, groups, localUser);
    const pingerAccess = userHasPingerAccess(isAdmin, groups);

    console.log(`[keycloak-sso] user="${accountName}" isAdmin=${isAdmin} pingerAccess=${pingerAccess}`);
    console.log(`[keycloak-sso] LDAP groups for "${accountName}": [${groupNames.join(', ') || 'none'}]`);

    if (localUser) {
      await User.updateById(localUser._id, {
        username: accountName,
        displayName: display,
        email: effectiveEmail,
        groups: groupNames,
        isAdmin,
      });
    } else {
      await User.insert({
        username: accountName,
        displayName: display,
        email: effectiveEmail,
        groups: groupNames,
        isAdmin,
      });
    }

    // Mint local JWT (same shape as LDAP login — username = sAMAccountName when LDAP resolves)
    const token = signAppToken({
      username: accountName,
      isAdmin,
      displayName: display,
      pingerAccess,
      sso: true,
    });

    console.log(`[keycloak-sso] JWT issued for "${accountName}" — SSO complete`);

    // Return HTML that stores the token and returns to the app
    return res.send(htmlRedirect(
      `try{localStorage.setItem('token',${JSON.stringify(token)});sessionStorage.removeItem('sso_pause_until');}catch(e){}` +
      `window.location.replace('/');`,
    ));
  } catch (err) {
    console.error('[keycloak-sso] callback processing error:', err.message);
    return res.send(htmlRedirect(
      `try{sessionStorage.setItem('sso_failed','server_error');}catch(e){}` +
      `window.location.replace('/');`,
    ));
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/sso/status
// ---------------------------------------------------------------------------
router.get('/auth/sso/status', async (req, res) => {
  const enabled = keycloakService.isEnabled();
  if (!enabled) {
    return res.json({
      enabled: false,
      reachable: false,
      config: {
        KEYCLOAK_ENABLED:   process.env.KEYCLOAK_ENABLED   || '(unset)',
        KEYCLOAK_URL:       process.env.KEYCLOAK_URL       || '(unset)',
        KEYCLOAK_REALM:     process.env.KEYCLOAK_REALM     || '(unset)',
        KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID || '(unset)',
      },
    });
  }
  const reachable = await keycloakService.isReachable();
  console.log(`[keycloak-sso] status check — enabled=${enabled} reachable=${reachable}`);
  return res.json({
    enabled: true,
    reachable,
    realm:    process.env.KEYCLOAK_REALM,
    url:      process.env.KEYCLOAK_URL,
    clientId: process.env.KEYCLOAK_CLIENT_ID,
  });
});

module.exports = router;
