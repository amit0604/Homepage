const express = require('express');
const dns = require('dns').promises;
const net = require('net');
const os = require('os');
const fs = require('fs');
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');
const { collections } = require('../repositories/jsonStore');
const { resolveFaviconFromPage } = require('../utils/faviconResolve');
const { getUserEmailDomain } = require('../utils/userEmailDomain');
const { isLobbyChatUiEnabledByDeploy } = require('../utils/lobbyChatUi');
const { isCheckmkUiEnabledByDeploy } = require('../utils/checkmkUi');
const { logFailure } = require('../utils/failureLog');
const { isDangerousUrl } = require('../utils/safeUrl');
const ldapSingleton = require('../services/ldapSingleton');
const {
  buildDeploymentGetPayload,
  validatePatch,
  mergeDeployment,
  applyDeploymentToProcessEnv,
  applyTrustProxyToExpress,
  ldapKeysChanged,
} = require('../config/deploymentConfig');
const {
  defaultMotdConfig,
  normalizeMotd,
  needsRefresh,
  scheduleMotdRefreshIfNeeded,
  regenerateMotdNow,
} = require('../services/motdService');

const router = express.Router();
const Settings = collections.settings;
const DEFAULT_LOGO_URL = 'logo192.png';
const DEFAULT_FAVICON_URL = 'logo192.png';
/** Old installs stored this path; treat as unset so branding uses defaults. */
const LEGACY_BRAND_ICO_PATH = 'images/favicon.ico';

function normalizeLegacyAssetUrl(url) {
  const s = url != null ? String(url).trim() : '';
  if (!s || s === LEGACY_BRAND_ICO_PATH) return null;
  return s;
}

function effectiveLogoUrl(settings) {
  return normalizeLegacyAssetUrl(settings.logoUrl) || DEFAULT_LOGO_URL;
}

function effectiveFaviconUrl(settings) {
  const fav = normalizeLegacyAssetUrl(settings.faviconUrl);
  if (fav) return fav;
  const logo = normalizeLegacyAssetUrl(settings.logoUrl);
  if (logo) return logo;
  return DEFAULT_FAVICON_URL;
}

function normalizeContacts(contacts) {
  if (!Array.isArray(contacts)) return [];
  return contacts
    .map((c) => ({
      name: c && c.name != null ? String(c.name).trim() : '',
      phone: c && c.phone != null ? String(c.phone).trim() : '',
      title: c && c.title != null ? String(c.title).trim() : '',
    }))
    .filter((c) => c.name || c.phone || c.title);
}

function normalizePingerSshIdleMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 5;
  const r = Math.round(n);
  if (r < 1) return 1;
  if (r > 1440) return 1440;
  return r;
}

const PINGER_SSH_CMD_LIMIT = 200;
const PINGER_SSH_CMD_TYPE_MAX = 80;
const PINGER_SSH_CMD_LABEL_MAX = 120;
const PINGER_SSH_CMD_TEXT_MAX = 2000;

function normalizePingerSshCommonCommands(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length && out.length < PINGER_SSH_CMD_LIMIT; i += 1) {
    const row = raw[i];
    if (!row || typeof row !== 'object') continue;
    const command =
      row.command != null
        ? String(row.command).trim().slice(0, PINGER_SSH_CMD_TEXT_MAX)
        : '';
    if (!command) continue;
    const deviceType =
      row.deviceType != null
        ? String(row.deviceType).trim().slice(0, PINGER_SSH_CMD_TYPE_MAX)
        : '';
    const label =
      (row.label != null ? String(row.label).trim() : '') ||
      (command.length > 48 ? `${command.slice(0, 48)}…` : command);
    out.push({
      deviceType,
      label: label.slice(0, PINGER_SSH_CMD_LABEL_MAX),
      command,
    });
  }
  return out;
}

async function getSettings() {
  const existingSettings = await Settings.findOne((record) => record.key === 'app');

  if (existingSettings) {
    return existingSettings;
  }

  return Settings.insert({
    key: 'app',
    logoUrl: DEFAULT_LOGO_URL,
    faviconUrl: DEFAULT_FAVICON_URL,
    contacts: [],
    lobbyChatEnabled: true,
    deployment: {},
    motd: defaultMotdConfig(),
    pingerSshIdleTimeoutMinutes: 5,
    pingerSshCommonCommands: [],
  });
}

function publicContacts(settings) {
  const raw = settings.contacts;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return normalizeContacts(raw);
}

function resolvePrimaryIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || entry.internal) continue;
      if (entry.family === 'IPv4') return entry.address;
    }
  }
  return '';
}

function isRunningInDocker() {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

function hexToIpv4LittleEndian(hex) {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return '';
  const bytes = [];
  for (let i = 0; i < 8; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return `${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`;
}

function readDefaultGatewayIp() {
  try {
    const raw = fs.readFileSync('/proc/net/route', 'utf8');
    const lines = raw.split('\n').slice(1);
    for (let i = 0; i < lines.length; i += 1) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length < 3) continue;
      const destination = parts[1];
      const gatewayHex = parts[2];
      if (destination !== '00000000') continue;
      const ip = hexToIpv4LittleEndian(gatewayHex);
      if (ip) return ip;
    }
  } catch {
    /* ignore */
  }
  return '';
}

function normalizeIp(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  if (raw === '::1') return '127.0.0.1';
  return raw;
}

/** Express works this out from the connection, and from proxy headers only when TRUST_PROXY is on. */
function readClientIp(req) {
  const ip = normalizeIp(req.ip || req.socket?.remoteAddress || '');
  return net.isIP(ip) ? ip : '';
}

function normalizeHostName(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low === 'localhost' || low === 'ip6-localhost') return '';
  if (net.isIP(s)) return '';
  const noTrailingDot = s.replace(/\.$/, '');
  const firstLabel = noTrailingDot.split('.')[0].trim();
  return firstLabel || '';
}

const HOST_LOOKUP_TIMEOUT_MS = 1500;
const HOST_CACHE_MS = 5 * 60 * 1000;
const HOST_CACHE_MAX = 2000;
const hostCache = new Map();

/** Slow or missing DNS must not hold up the page, and each address is only looked up now and then. */
async function cachedHostName(ip) {
  const hit = hostCache.get(ip);
  if (hit && Date.now() - hit.at < HOST_CACHE_MS) return hit.name;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(''), HOST_LOOKUP_TIMEOUT_MS); });
  const name = await Promise.race([resolveHostNameForIp(ip), timeout]);
  clearTimeout(timer);
  if (hostCache.size >= HOST_CACHE_MAX) hostCache.clear();
  hostCache.set(ip, { at: Date.now(), name });
  return name;
}

async function resolveHostNameForIp(ip) {
  const target = String(ip || '').trim();
  if (!target || net.isIP(target) === 0) return '';
  try {
    const ptr = await dns.reverse(target);
    if (Array.isArray(ptr) && ptr.length > 0) {
      const picked = normalizeHostName(ptr[0]);
      if (picked) return picked;
    }
  } catch {
    /* ignore */
  }
  try {
    const svc = await dns.lookupService(target, 0);
    const picked = normalizeHostName(svc && svc.hostname);
    if (picked) return picked;
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * The visitor's computer, not this server. A browser never reveals its computer name, so the name
 * comes from a reverse DNS lookup of the visitor's address, which needs a PTR record on your DNS.
 */
async function resolveHostIdentity(req) {
  const clientIp = readClientIp(req);
  const isLoopback = clientIp === '127.0.0.1' || clientIp === '::1';
  if (isRunningInDocker()) {
    // Seen through Docker's own gateway, the real address is hidden, so showing this one would mislead.
    if (!clientIp || isLoopback || clientIp === readDefaultGatewayIp()) {
      return { computerName: '', ipAddress: '' };
    }
    return { computerName: await cachedHostName(clientIp), ipAddress: clientIp };
  }
  // Running directly on this computer: the visitor is the server itself.
  if (isLoopback) return { computerName: os.hostname() || '', ipAddress: resolvePrimaryIpAddress() };
  return { computerName: clientIp ? await cachedHostName(clientIp) : '', ipAddress: clientIp };
}

router.get('/settings/public', async (req, res) => {
  try {
    const settings = await getSettings();
    const lobbyInDb = settings.lobbyChatEnabled !== false;
    res.json({
      logoUrl: effectiveLogoUrl(settings),
      faviconUrl: effectiveFaviconUrl(settings),
      contacts: publicContacts(settings),
      userEmailDomain: getUserEmailDomain(),
      lobbyChatEnabled: lobbyInDb && isLobbyChatUiEnabledByDeploy(),
      checkmkUiEnabled: isCheckmkUiEnabledByDeploy(),
      pingerSshIdleTimeoutMinutes: normalizePingerSshIdleMinutes(settings.pingerSshIdleTimeoutMinutes),
      pingerSshCommonCommands: normalizePingerSshCommonCommands(settings.pingerSshCommonCommands),
    });
  } catch (error) {
    logFailure('settings.public', error, { path: req.path });
    res.status(500).json({ message: error.message });
  }
});

router.get('/settings/system-info', async (_req, res) => {
  try {
    const info = await resolveHostIdentity(_req);
    res.json(info);
  } catch (error) {
    logFailure('settings.system_info', error, { path: '/settings/system-info' });
    res.status(500).json({ message: 'Could not load system information' });
  }
});

/** Public: homepage message of the day (cached; may refresh in background). */
router.get('/motd', async (req, res) => {
  try {
    const settings = await getSettings();
    const motd = normalizeMotd(settings.motd);
    if (!motd.enabled) {
      return res.json({
        enabled: false,
        title: motd.title,
        body: '',
        cachedAt: null,
        stale: false,
      });
    }
    setImmediate(() => {
      scheduleMotdRefreshIfNeeded(Settings, getSettings).catch(() => {});
    });
    res.json({
      enabled: true,
      title: motd.title,
      body: String(motd.cachedBody || ''),
      cachedAt: motd.cachedAt,
      stale: needsRefresh(motd),
    });
  } catch (error) {
    logFailure('motd.get', error, { path: req.path });
    res.status(500).json({ message: error.message });
  }
});

/** Admin: full MOTD / Ollama configuration. */
router.get('/settings/motd', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(normalizeMotd(settings.motd));
  } catch (error) {
    logFailure('settings.motd.get', error, { path: req.path });
    res.status(500).json({ message: error.message });
  }
});

router.put('/settings/motd', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const settings = await getSettings();
    const prev = normalizeMotd(settings.motd);
    const merged = normalizeMotd({ ...prev, ...(req.body && typeof req.body === 'object' ? req.body : {}) });
    const promptChanged =
      merged.aiPrompt !== prev.aiPrompt ||
      merged.ollamaUrl !== prev.ollamaUrl ||
      merged.ollamaModel !== prev.ollamaModel;
    if (promptChanged) {
      merged.cachedBody = '';
      merged.cachedAt = null;
    }
    await Settings.updateById(settings._id, { motd: merged });
    setImmediate(() => {
      scheduleMotdRefreshIfNeeded(Settings, getSettings).catch(() => {});
    });
    res.json(normalizeMotd(merged));
  } catch (error) {
    logFailure('settings.motd.put', error, { path: req.path });
    res.status(400).json({ message: error.message });
  }
});

router.post('/settings/motd/regenerate', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const next = await regenerateMotdNow(Settings, getSettings);
    res.json(normalizeMotd(next));
  } catch (error) {
    logFailure('settings.motd.regenerate', error, { path: req.path });
    res.status(400).json({ message: error.message });
  }
});

/** Admin: resolve favicon URL for a page (shortcut tile images). */
router.get('/settings/resolve-favicon', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const raw = req.query.url;
    if (!raw || typeof raw !== 'string' || !String(raw).trim()) {
      return res.status(400).json({ message: 'url query parameter is required' });
    }
    const imgSrc = await resolveFaviconFromPage(String(raw).trim());
    res.json({ imgSrc });
  } catch (err) {
    logFailure('settings.resolve_favicon', err, {
      path: req.path,
      url: typeof req.query.url === 'string' ? req.query.url.slice(0, 500) : '',
    });
    res.status(400).json({ message: err.message || 'Could not resolve favicon' });
  }
});

router.put('/settings/logo', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const { logoUrl } = req.body;
    const normalizedLogoUrl = typeof logoUrl === 'string' ? logoUrl.trim() : '';

    if (!normalizedLogoUrl) {
      return res.status(400).json({ message: 'Logo URL is required' });
    }
    if (isDangerousUrl(normalizedLogoUrl)) {
      return res.status(400).json({ message: 'Logo must be an image address' });
    }

    const settings = await getSettings();
    const updatedSettings = await Settings.updateById(settings._id, {
      logoUrl: normalizedLogoUrl,
    });

    res.json({
      logoUrl: updatedSettings.logoUrl,
    });
  } catch (error) {
    logFailure('settings.logo', error, { path: req.path });
    res.status(400).json({ message: error.message });
  }
});

router.put('/settings/favicon', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const { faviconUrl } = req.body;
    const normalized =
      typeof faviconUrl === 'string' && faviconUrl.trim() ? faviconUrl.trim() : '';

    if (!normalized) {
      return res.status(400).json({ message: 'Favicon URL is required' });
    }
    if (isDangerousUrl(normalized)) {
      return res.status(400).json({ message: 'Favicon must be an image address' });
    }

    const settings = await getSettings();
    const updatedSettings = await Settings.updateById(settings._id, {
      faviconUrl: normalized,
    });

    res.json({
      faviconUrl: updatedSettings.faviconUrl,
    });
  } catch (error) {
    logFailure('settings.favicon', error, { path: req.path });
    res.status(400).json({ message: error.message });
  }
});

router.put('/settings/contacts', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts)) {
      return res.status(400).json({ message: 'contacts must be an array' });
    }
    const list = normalizeContacts(contacts);
    const settings = await getSettings();
    const updated = await Settings.updateById(settings._id, { contacts: list });
    res.json({ contacts: publicContacts(updated) });
  } catch (error) {
    logFailure('settings.contacts', error, { path: req.path });
    res.status(400).json({ message: error.message });
  }
});

/** Admin: deployment / integration settings (override Docker env). */
router.get('/settings/deployment', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const settings = await getSettings();
    const deployment = settings.deployment && typeof settings.deployment === 'object' ? settings.deployment : {};
    res.json(buildDeploymentGetPayload(deployment));
  } catch (error) {
    logFailure('settings.deployment.get', error, { path: req.path });
    res.status(500).json({ message: error.message });
  }
});

router.put('/settings/deployment', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const patch = validatePatch(req.body);
    const settings = await getSettings();
    const prevDep = settings.deployment && typeof settings.deployment === 'object' ? settings.deployment : {};
    const merged = mergeDeployment(prevDep, patch);
    const updated = await Settings.updateById(settings._id, { deployment: merged });
    applyDeploymentToProcessEnv(merged);
    applyTrustProxyToExpress(req.app);

    if (ldapKeysChanged(patch)) {
      try {
        ldapSingleton.reinitialize();
      } catch (e) {
        console.warn('[settings.deployment] LDAP reinitialize:', e.message);
      }
    }

    const keys = Object.keys(patch);
    const restartRecommended = keys.some(
      (k) =>
        (k.startsWith('KEYCLOAK_') && k !== 'KEYCLOAK_CLIENT_SECRET') || k.startsWith('CHECKMK_'),
    );

    res.json({
      ok: true,
      ...buildDeploymentGetPayload(updated.deployment || {}),
      restartRecommended,
    });
  } catch (error) {
    logFailure('settings.deployment.put', error, { path: req.path });
    res.status(400).json({ message: error.message });
  }
});

/** Admin: show or hide the homepage lobby chat. */
router.put('/settings/lobby-chat', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const raw = req.body && req.body.lobbyChatEnabled;
    if (typeof raw !== 'boolean') {
      return res.status(400).json({ message: 'lobbyChatEnabled must be a boolean' });
    }
    const settings = await getSettings();
    const updated = await Settings.updateById(settings._id, { lobbyChatEnabled: raw });
    res.json({ lobbyChatEnabled: updated.lobbyChatEnabled !== false });
  } catch (error) {
    logFailure('settings.lobby_chat', error, { path: req.path });
    res.status(400).json({ message: error.message });
  }
});

/** Admin: Pinger in-browser SSH (idle timeout, saved CLI snippets). */
router.put('/settings/pinger-ssh', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'pingerSshIdleTimeoutMinutes')) {
      patch.pingerSshIdleTimeoutMinutes = normalizePingerSshIdleMinutes(body.pingerSshIdleTimeoutMinutes);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'pingerSshCommonCommands')) {
      patch.pingerSshCommonCommands = normalizePingerSshCommonCommands(body.pingerSshCommonCommands);
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }
    const settings = await getSettings();
    const updated = await Settings.updateById(settings._id, patch);
    res.json({
      pingerSshIdleTimeoutMinutes: normalizePingerSshIdleMinutes(updated.pingerSshIdleTimeoutMinutes),
      pingerSshCommonCommands: normalizePingerSshCommonCommands(updated.pingerSshCommonCommands),
    });
  } catch (error) {
    logFailure('settings.pinger_ssh', error, { path: req.path });
    res.status(400).json({ message: error.message });
  }
});

const routerExport = router;
module.exports = routerExport;
module.exports.getSettings = getSettings;
module.exports.normalizePingerSshIdleMinutes = normalizePingerSshIdleMinutes;
module.exports.normalizePingerSshCommonCommands = normalizePingerSshCommonCommands;
