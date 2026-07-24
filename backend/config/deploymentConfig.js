/**
 * Deployment settings stored in settings.json (key app → deployment) override process.env
 * for whitelisted keys (never JWT_SECRET).
 * Exception: LOCAL_ADMIN_USERNAME / LOCAL_ADMIN_PASSWORD use host/compose bootstrap env when set.
 */
const { collections } = require('../repositories/jsonStore');

const Settings = collections.settings;

/** Keys controllable from Admin → Settings (not in UI: JWT_SECRET only). */
const ALLOWED_DEPLOYMENT_KEYS = [
  'CHAT_RETENTION_DAYS',
  'CHAT_GC_INTERVAL_MS',
  'LOBBY_CHAT_UI',
  'LDAP_URL',
  'LDAP_SEARCH_BASE',
  'LDAP_ADMIN_GROUP_DN',
  'LDAP_PINGER_GROUP_DN',
  'LDAP_ADMIN',
  'LDAP_PASSWORD',
  'LDAP_NETBIOS_DOMAIN',
  'LDAP_DISPLAY_NAME_LOOKUP',
  'LDAP_LOOKUP_TIMEOUT_MS',
  'LDAP_DISPLAY_NAME_PAUSE_SEC',
  'LOCAL_ADMIN_USERNAME',
  'LOCAL_ADMIN_PASSWORD',
  'USER_EMAIL_DOMAIN',
  'KEYCLOAK_ENABLED',
  'KEYCLOAK_URL',
  'KEYCLOAK_REALM',
  'KEYCLOAK_CLIENT_ID',
  'KEYCLOAK_CLIENT_SECRET',
  'KEYCLOAK_REDIRECT_URI',
  'KEYCLOAK_POST_LOGOUT_REDIRECT_URI',
  'KEYCLOAK_SSO_COOLDOWN_AFTER_LOGOUT_MS',
  'KEYCLOAK_IDP_HINT',
  'KEYCLOAK_PROMPT',
  'KEYCLOAK_ADMIN_ROLE',
  'KEYCLOAK_TIMEOUT_MS',
  'KEYCLOAK_TLS_INSECURE',
  'CHECKMK_UI',
  'CHECKMK_BASE_URL',
  'CHECKMK_AUTOMATION_USER',
  'CHECKMK_AUTOMATION_SECRET',
  'CHECKMK_TLS_INSECURE',
  'CHECKMK_TIMEOUT_MS',
  'CHECKMK_CACHE_MS',
  'PINGER_WARN_MS',
  'PINGER_CACHE_MS',
  'TRUST_PROXY',
  'JWT_EXPIRES_IN',
  'CORS_ORIGIN',
];

const SECRET_KEYS = new Set([
  'LDAP_PASSWORD',
  'CHECKMK_AUTOMATION_SECRET',
  'KEYCLOAK_CLIENT_SECRET',
  'LOCAL_ADMIN_PASSWORD',
]);

/** Mask these in Docker / console logs (never log raw secrets). */
const LOG_MASK_KEYS = new Set([...SECRET_KEYS, 'JWT_SECRET']);

/** Logged at startup in addition to {@link ALLOWED_DEPLOYMENT_KEYS} (compose / host only; not stored in deployment JSON). */
const STARTUP_LOG_EXTRA_KEYS = [
  'JWT_SECRET',
  'PORT',
  'NODE_ENV',
  'DATA_DIR',
  'SERVE_STATIC_FRONTEND',
  'OLLAMA_URL',
  'OLLAMA_MODEL',
];

/** Bootstrap (Docker/host) env wins over the JSON store for these keys when the var is set at startup. */
const LOCAL_ADMIN_ENV_OVERRIDES_STORE = new Set(['LOCAL_ADMIN_USERNAME', 'LOCAL_ADMIN_PASSWORD']);

const SECTION_KEYS = {
  chat: ['CHAT_RETENTION_DAYS', 'CHAT_GC_INTERVAL_MS', 'LOBBY_CHAT_UI'],
  ldap: [
    'LDAP_URL',
    'LDAP_SEARCH_BASE',
    'LDAP_ADMIN',
    'LDAP_PASSWORD',
    'LDAP_ADMIN_GROUP_DN',
    'LDAP_PINGER_GROUP_DN',
    'LDAP_NETBIOS_DOMAIN',
    'LDAP_DISPLAY_NAME_LOOKUP',
    'LDAP_LOOKUP_TIMEOUT_MS',
    'LDAP_DISPLAY_NAME_PAUSE_SEC',
    'USER_EMAIL_DOMAIN',
  ],
  localAdmin: ['LOCAL_ADMIN_USERNAME', 'LOCAL_ADMIN_PASSWORD'],
  keycloak: [
    'KEYCLOAK_ENABLED',
    'KEYCLOAK_URL',
    'KEYCLOAK_REALM',
    'KEYCLOAK_CLIENT_ID',
    'KEYCLOAK_CLIENT_SECRET',
    'KEYCLOAK_REDIRECT_URI',
    'KEYCLOAK_POST_LOGOUT_REDIRECT_URI',
    'KEYCLOAK_SSO_COOLDOWN_AFTER_LOGOUT_MS',
    'KEYCLOAK_IDP_HINT',
    'KEYCLOAK_PROMPT',
    'KEYCLOAK_ADMIN_ROLE',
    'KEYCLOAK_TIMEOUT_MS',
    'KEYCLOAK_TLS_INSECURE',
  ],
  checkmk: [
    'CHECKMK_UI',
    'CHECKMK_BASE_URL',
    'CHECKMK_AUTOMATION_USER',
    'CHECKMK_AUTOMATION_SECRET',
    'CHECKMK_TLS_INSECURE',
    'CHECKMK_TIMEOUT_MS',
    'CHECKMK_CACHE_MS',
  ],
  pinger: ['PINGER_WARN_MS', 'PINGER_CACHE_MS'],
  advanced: ['TRUST_PROXY', 'JWT_EXPIRES_IN', 'CORS_ORIGIN'],
};

let bootstrapEnvSnapshot = null;

function captureBootstrapEnvSnapshot() {
  if (bootstrapEnvSnapshot) return;
  bootstrapEnvSnapshot = {};
  for (let i = 0; i < ALLOWED_DEPLOYMENT_KEYS.length; i += 1) {
    const k = ALLOWED_DEPLOYMENT_KEYS[i];
    if (process.env[k] !== undefined) {
      bootstrapEnvSnapshot[k] = process.env[k];
    }
  }
}

function valueToEnvString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/**
 * Apply deployment object + bootstrap fallbacks to process.env.
 * @param {Record<string, unknown>} deployment - stored overrides (flat keys)
 */
function applyDeploymentToProcessEnv(deployment) {
  captureBootstrapEnvSnapshot();
  const dep = deployment && typeof deployment === 'object' ? deployment : {};

  for (let i = 0; i < ALLOWED_DEPLOYMENT_KEYS.length; i += 1) {
    const k = ALLOWED_DEPLOYMENT_KEYS[i];
    if (
      LOCAL_ADMIN_ENV_OVERRIDES_STORE.has(k) &&
      bootstrapEnvSnapshot[k] !== undefined
    ) {
      process.env[k] = bootstrapEnvSnapshot[k];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(dep, k)) {
      const val = dep[k];
      if (val === null || val === undefined) {
        if (bootstrapEnvSnapshot[k] !== undefined) {
          process.env[k] = bootstrapEnvSnapshot[k];
        } else {
          delete process.env[k];
        }
      } else {
        process.env[k] = valueToEnvString(val);
      }
    } else if (bootstrapEnvSnapshot[k] !== undefined) {
      process.env[k] = bootstrapEnvSnapshot[k];
    }
  }
}

/**
 * Merge deployment from settings into `process.env`.
 * @returns {Promise<object|null>} `app` settings row if present, otherwise null
 */
async function loadDeploymentFromDatabaseIntoEnv() {
  captureBootstrapEnvSnapshot();
  const row = await Settings.findOne((r) => r.key === 'app');
  const deployment = row && row.deployment && typeof row.deployment === 'object' ? row.deployment : {};
  applyDeploymentToProcessEnv(deployment);
  return row || null;
}

function formatEnvValueForStartupLog(key, raw) {
  if (raw === undefined) return null;
  if (LOG_MASK_KEYS.has(key)) {
    const s = String(raw).trim();
    return s ? '********' : '';
  }
  return String(raw);
}

/**
 * Echo effective configuration to stdout (Docker logs): compose/host env after Admin → Deployment
 * settings have been merged into `process.env`. Secrets are redacted.
 * @param {object|null} [appSettingsRow] — optional `settings` row (`key: app`) for branding / MOTD / lobby fields
 */
function logEffectiveConfigurationAtStartup(appSettingsRow = null) {
  const keySet = new Set([...ALLOWED_DEPLOYMENT_KEYS, ...STARTUP_LOG_EXTRA_KEYS]);
  const sorted = Array.from(keySet).sort();
  console.log('[config] Effective environment (Docker / host + Admin deployment settings):');
  for (let i = 0; i < sorted.length; i += 1) {
    const k = sorted[i];
    if (!Object.prototype.hasOwnProperty.call(process.env, k)) continue;
    const disp = formatEnvValueForStartupLog(k, process.env[k]);
    if (disp === null) continue;
    console.log(`[config]   ${k}=${disp}`);
  }

  if (!appSettingsRow || typeof appSettingsRow !== 'object') {
    return;
  }
  console.log('[config] App settings from store (settings.json, other than deployment keys above):');
  const logo = appSettingsRow.logoUrl != null ? String(appSettingsRow.logoUrl) : '';
  const fav = appSettingsRow.faviconUrl != null ? String(appSettingsRow.faviconUrl) : '';
  if (logo) console.log(`[config]   logoUrl=${logo}`);
  if (fav) console.log(`[config]   faviconUrl=${fav}`);
  console.log(`[config]   lobbyChatEnabled=${appSettingsRow.lobbyChatEnabled !== false}`);
  const motdRaw = appSettingsRow.motd && typeof appSettingsRow.motd === 'object' ? appSettingsRow.motd : {};
  const prompt = typeof motdRaw.aiPrompt === 'string' ? motdRaw.aiPrompt : '';
  console.log(`[config]   motd.enabled=${!!motdRaw.enabled}`);
  if (motdRaw.title != null && String(motdRaw.title).trim()) {
    const t = String(motdRaw.title).trim().slice(0, 100);
    console.log(`[config]   motd.title=${t}${String(motdRaw.title).length > 100 ? '…' : ''}`);
  }
  if (motdRaw.ollamaUrl != null && String(motdRaw.ollamaUrl).trim()) {
    console.log(`[config]   motd.ollamaUrl=${String(motdRaw.ollamaUrl).trim()}`);
  }
  if (motdRaw.ollamaModel != null && String(motdRaw.ollamaModel).trim()) {
    console.log(`[config]   motd.ollamaModel=${String(motdRaw.ollamaModel).trim()}`);
  }
  if (motdRaw.regenerateAt != null && String(motdRaw.regenerateAt).trim()) {
    console.log(`[config]   motd.regenerateAt=${String(motdRaw.regenerateAt).trim()}`);
  }
  if (prompt.length > 0) {
    console.log(`[config]   motd.aiPrompt.length=${prompt.length}`);
  }
  const contacts = Array.isArray(appSettingsRow.contacts) ? appSettingsRow.contacts : [];
  console.log(`[config]   contacts.count=${contacts.length}`);
}

function maskSecret(_key, storedValue) {
  if (storedValue === null || storedValue === undefined || String(storedValue).trim() === '') {
    return '';
  }
  return '********';
}

/** Effective value for API: deployment override or current process.env */
function effectiveValue(k, deployment) {
  captureBootstrapEnvSnapshot();
  const dep = deployment && typeof deployment === 'object' ? deployment : {};
  if (
    LOCAL_ADMIN_ENV_OVERRIDES_STORE.has(k) &&
    bootstrapEnvSnapshot[k] !== undefined
  ) {
    if (SECRET_KEYS.has(k)) {
      return String(bootstrapEnvSnapshot[k]).trim() !== ''
        ? maskSecret(k, bootstrapEnvSnapshot[k])
        : '';
    }
    return bootstrapEnvSnapshot[k];
  }
  if (Object.prototype.hasOwnProperty.call(dep, k)) {
    if (SECRET_KEYS.has(k)) {
      return dep[k] != null && String(dep[k]).trim() !== ''
        ? maskSecret(k, dep[k])
        : '';
    }
    return dep[k];
  }
  if (SECRET_KEYS.has(k)) {
    return process.env[k] ? maskSecret(k, 'x') : '';
  }
  return process.env[k] != null ? process.env[k] : '';
}

function buildDeploymentGetPayload(deployment) {
  const dep = deployment && typeof deployment === 'object' ? deployment : {};
  const sections = {};
  const keys = Object.keys(SECTION_KEYS);
  for (let s = 0; s < keys.length; s += 1) {
    const sec = keys[s];
    const list = SECTION_KEYS[sec];
    sections[sec] = {};
    for (let j = 0; j < list.length; j += 1) {
      const k = list[j];
      sections[sec][k] = effectiveValue(k, dep);
    }
  }
  return {
    sections,
    precedence:
      'Stored settings override Docker/host environment when a key is saved. Exception: LOCAL_ADMIN_USERNAME and LOCAL_ADMIN_PASSWORD always follow host/compose environment when those variables are set.',
    allowedKeys: [...ALLOWED_DEPLOYMENT_KEYS],
  };
}

/**
 * Accept either a flat map of env keys or nested { chat: { CHAT_RETENTION_DAYS: 30 }, ... }.
 */
function flattenDeploymentPatchInput(body) {
  if (!body || typeof body !== 'object') return body;
  const topKeys = Object.keys(body);
  const hasAllowedTop = topKeys.some((k) => ALLOWED_DEPLOYMENT_KEYS.includes(k));
  if (hasAllowedTop) return body;
  const out = {};
  const sectionIds = Object.keys(SECTION_KEYS);
  for (let i = 0; i < sectionIds.length; i += 1) {
    const sec = sectionIds[i];
    const block = body[sec];
    if (!block || typeof block !== 'object') continue;
    const list = SECTION_KEYS[sec];
    for (let j = 0; j < list.length; j += 1) {
      const k = list[j];
      if (Object.prototype.hasOwnProperty.call(block, k)) {
        out[k] = block[k];
      }
    }
  }
  return out;
}

function validatePatch(rawPatch) {
  const patch =
    rawPatch && typeof rawPatch === 'object' ? flattenDeploymentPatchInput(rawPatch) : rawPatch;
  if (!patch || typeof patch !== 'object') {
    throw new Error('Body must be a JSON object of env keys');
  }
  const cleaned = {};
  const entries = Object.entries(patch);
  for (let i = 0; i < entries.length; i += 1) {
    const key = entries[i][0];
    const val = entries[i][1];
    if (!ALLOWED_DEPLOYMENT_KEYS.includes(key)) {
      continue;
    }
    if (val === null) {
      cleaned[key] = null;
      continue;
    }
    if (SECRET_KEYS.has(key)) {
      if (val === '' || val === undefined) continue;
      if (String(val).trim() === '********') continue;
      cleaned[key] = String(val);
      continue;
    }
    cleaned[key] = val;
  }

  const nRetention = cleaned.CHAT_RETENTION_DAYS !== undefined
    ? Number(cleaned.CHAT_RETENTION_DAYS)
    : null;
  if (nRetention != null && (!Number.isFinite(nRetention) || nRetention < 1)) {
    throw new Error('CHAT_RETENTION_DAYS must be at least 1');
  }
  const nGc = cleaned.CHAT_GC_INTERVAL_MS !== undefined ? Number(cleaned.CHAT_GC_INTERVAL_MS) : null;
  if (nGc != null && (!Number.isFinite(nGc) || nGc < 60000)) {
    throw new Error('CHAT_GC_INTERVAL_MS must be at least 60000 (1 minute)');
  }

  return cleaned;
}

/**
 * Merge patch into existing deployment; secret keys omitted or ******** keep previous.
 */
function mergeDeployment(existingDeployment, patch) {
  const next = {
    ...(existingDeployment && typeof existingDeployment === 'object' ? existingDeployment : {}),
  };
  const keys = Object.keys(patch);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (!ALLOWED_DEPLOYMENT_KEYS.includes(k)) continue;
    const v = patch[k];
    if (v === null) {
      delete next[k];
      continue;
    }
    if (SECRET_KEYS.has(k)) {
      if (v === undefined || String(v).trim() === '' || String(v).trim() === '********') {
        continue;
      }
      next[k] = String(v);
      continue;
    }
    if (typeof v === 'boolean') {
      next[k] = v;
    } else {
      next[k] = v;
    }
  }
  return next;
}

function ldapKeysChanged(patch) {
  const ldapLike = [
    'LDAP_URL',
    'LDAP_SEARCH_BASE',
    'LDAP_ADMIN',
    'LDAP_PASSWORD',
    'LDAP_ADMIN_GROUP_DN',
    'LDAP_PINGER_GROUP_DN',
    'LDAP_NETBIOS_DOMAIN',
  ];
  return ldapLike.some((k) => Object.prototype.hasOwnProperty.call(patch, k));
}

/**
 * Apply Express `trust proxy` from `process.env.TRUST_PROXY` (after deployment merge or admin save).
 * @param {import('express').Express | undefined} app
 */
function applyTrustProxyToExpress(app) {
  if (!app || typeof app.set !== 'function') return;
  const raw = process.env.TRUST_PROXY;
  const on =
    raw === '1' ||
    raw === 'true' ||
    String(raw || '').toLowerCase() === 'yes';
  app.set('trust proxy', on ? 1 : false);
}

module.exports = {
  ALLOWED_DEPLOYMENT_KEYS,
  SECRET_KEYS,
  LOCAL_ADMIN_ENV_OVERRIDES_STORE,
  SECTION_KEYS,
  captureBootstrapEnvSnapshot,
  applyDeploymentToProcessEnv,
  loadDeploymentFromDatabaseIntoEnv,
  logEffectiveConfigurationAtStartup,
  buildDeploymentGetPayload,
  validatePatch,
  mergeDeployment,
  ldapKeysChanged,
  applyTrustProxyToExpress,
  maskSecret,
  flattenDeploymentPatchInput,
};
