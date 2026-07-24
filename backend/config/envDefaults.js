/**
 * Apply defaults when variables are unset (after dotenv).
 * Docker/image can omit these; local `node app.js` gets the same behavior.
 */
function applyEnvDefaults() {
  const setIfEmpty = (key, value) => {
    const v = process.env[key];
    if (v === undefined || v === '') process.env[key] = value;
  };

  setIfEmpty('NODE_ENV', 'production');
  setIfEmpty('PORT', '80');
  setIfEmpty('CORS_ORIGIN', '');
  setIfEmpty('LDAP_DISPLAY_NAME_LOOKUP', 'true');
  setIfEmpty('LDAP_LOOKUP_TIMEOUT_MS', '1500');
  setIfEmpty('LDAP_DISPLAY_NAME_PAUSE_SEC', '120');
  setIfEmpty('FAVICON_ALLOW_PRIVATE', 'true');
  setIfEmpty('FAVICON_TLS_INSECURE', 'true');
  setIfEmpty('PINGER_WARN_MS', '200');
  setIfEmpty('PINGER_CACHE_MS', '25000');
  setIfEmpty('FAVICON_MAX_IMAGE_BYTES', String(2 * 1024 * 1024));
  setIfEmpty('FAILURE_LOG_MAX_BYTES', String(10 * 1024 * 1024));
  setIfEmpty('CHAT_RETENTION_DAYS', '30');
  setIfEmpty('CHAT_GC_INTERVAL_MS', String(60 * 60 * 1000));
  setIfEmpty('KEYCLOAK_ENABLED', 'false');
  setIfEmpty('KEYCLOAK_TIMEOUT_MS', '5000');
  setIfEmpty('KEYCLOAK_TLS_INSECURE', 'false');
  setIfEmpty('KEYCLOAK_ADMIN_ROLE', 'admin');
  setIfEmpty('KEYCLOAK_SSO_COOLDOWN_AFTER_LOGOUT_MS', '10000');
}

module.exports = { applyEnvDefaults };
