/**
 * Minimal Checkmk REST client: hosts in DOWN (1) or UNREACH (2).
 * Uses domain-type `host` (Livestatus), not `host_status`. Query field is `state`.
 * https://docs.checkmk.com/latest/en/rest_api.html — Bearer: automation user + secret (two tokens after "Bearer").
 */

const API_SUFFIX = '/check_mk/api/1.0';

/**
 * Expected: site root only, e.g. https://host/mysite — NOT .../check_mk/ (we append /check_mk/api/1.0).
 */
function normalizeCheckmkBaseUrl(raw) {
  let base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  base = base.replace(/\/check_mk\/?$/i, '');
  return base.replace(/\/+$/, '');
}

function checkmkConfigured() {
  const base = normalizeCheckmkBaseUrl(process.env.CHECKMK_BASE_URL);
  const user = String(process.env.CHECKMK_AUTOMATION_USER || '').trim();
  const secret = String(process.env.CHECKMK_AUTOMATION_SECRET || '').trim();
  return Boolean(base && user && secret);
}

function apiRoot() {
  const base = normalizeCheckmkBaseUrl(process.env.CHECKMK_BASE_URL);
  return `${base}${API_SUFFIX}`;
}

function checkmkTlsInsecure() {
  return String(process.env.CHECKMK_TLS_INSECURE || '').toLowerCase() === 'true';
}

function formatFetchError(err) {
  if (!err || typeof err !== 'object') return String(err);
  const parts = [err.message || 'fetch failed'];
  const c = err.cause;
  if (c) {
    if (c.message) parts.push(c.message);
    if (c.code) parts.push(`(${c.code})`);
  }
  if (err.code) parts.push(`(${err.code})`);
  return [...new Set(parts)].join(' ');
}

function bearerHeader() {
  const user = String(process.env.CHECKMK_AUTOMATION_USER || '').trim();
  const secret = String(process.env.CHECKMK_AUTOMATION_SECRET || '').trim();
  return `Bearer ${user} ${secret}`;
}

function hostStateLabel(n) {
  const s = Number(n);
  if (s === 0) return 'UP';
  if (s === 1) return 'DOWN';
  if (s === 2) return 'UNREACH';
  if (s === 3) return 'PENDING';
  return s != null && !Number.isNaN(s) ? `STATE_${s}` : 'UNKNOWN';
}

/** Livestatus `last_state_change` is unix epoch seconds (often float). */
function parseLastStateChangeSec(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? raw / 1000 : raw;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? n / 1000 : n;
}

function formatDownDurationSince(lastChangeSec) {
  if (lastChangeSec == null || !Number.isFinite(lastChangeSec)) return '—';
  const now = Math.floor(Date.now() / 1000);
  const elapsed = Math.max(0, now - Math.floor(lastChangeSec));
  if (elapsed < 60) return '<1m';
  const m = Math.floor(elapsed / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

/** Livestatus Hosts.state: 0 UP, 1 DOWN, 2 UNREACH. Operators must be lowercase (Checkmk ExprSchema). */
function downHostsQuery() {
  return {
    op: 'or',
    expr: [
      { op: '=', left: 'state', right: '1' },
      { op: '=', left: 'state', right: '2' },
    ],
  };
}

function normalizeRow(item) {
  const ext = item && typeof item === 'object' ? item.extensions || item : {};
  const hostName =
    ext.name != null
      ? String(ext.name).trim()
      : ext.host_name != null
        ? String(ext.host_name).trim()
        : item && item.id != null
          ? String(item.id).trim()
          : item && item.title != null
            ? String(item.title).trim()
            : '';
  const state = ext.state != null ? ext.state : ext.host_state != null ? ext.host_state : null;
  const aliasRaw = ext.alias != null ? String(ext.alias).trim() : '';
  const depthRaw = ext.scheduled_downtime_depth != null ? ext.scheduled_downtime_depth : ext.scheduledDowntimeDepth;
  const depth = depthRaw != null ? Number(depthRaw) : 0;
  const lastSec = parseLastStateChangeSec(
    ext.last_state_change != null ? ext.last_state_change : ext.lastStateChange,
  );
  const downtimeSummary =
    Number.isFinite(depth) && depth > 0
      ? 'Scheduled downtime'
      : formatDownDurationSince(lastSec);
  return {
    hostName,
    alias: aliasRaw || null,
    state: state != null ? Number(state) : null,
    stateLabel: hostStateLabel(state),
    downtimeSummary,
  };
}

let cache = { at: 0, payload: null };
const TTL_MS = Math.max(
  5000,
  Math.min(120000, Number(process.env.CHECKMK_CACHE_MS) || 30000),
);

async function checkmkFetch(url, opts) {
  if (checkmkTlsInsecure()) {
    const { fetch: undiciFetch, Agent } = require('undici');
    return undiciFetch(url, {
      ...opts,
      dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
    });
  }
  return fetch(url, opts);
}

async function fetchDownHostsFromApi() {
  const root = apiRoot();
  const sp = new URLSearchParams();
  sp.set('query', JSON.stringify(downHostsQuery()));
  sp.append('columns', 'name');
  sp.append('columns', 'state');
  sp.append('columns', 'alias');
  sp.append('columns', 'last_state_change');
  sp.append('columns', 'scheduled_downtime_depth');
  const url = `${root}/domain-types/host/collections/all?${sp.toString()}`;

  const timeout = Math.max(3000, Number(process.env.CHECKMK_TIMEOUT_MS) || 15000);
  const opts = {
    method: 'GET',
    headers: {
      Authorization: bearerHeader(),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeout),
  };

  const res = await checkmkFetch(url, opts);

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { _raw: text };
  }

  if (!res.ok) {
    const msg =
      (body && (body.detail || body.message || body.title)) ||
      `Checkmk HTTP ${res.status}`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }

  const value = Array.isArray(body.value) ? body.value : [];
  const hosts = value.map(normalizeRow).filter((h) => h.hostName);
  return { hosts };
}

/** Self-signed Checkmk: set CHECKMK_TLS_INSECURE=true (see checkmkFetch). */
async function getDownHostsCached() {
  if (!checkmkConfigured()) {
    return {
      configured: false,
      hosts: [],
      message:
        'Checkmk is not configured. Set CHECKMK_BASE_URL, CHECKMK_AUTOMATION_USER, CHECKMK_AUTOMATION_SECRET.',
    };
  }

  const now = Date.now();
  if (cache.payload && now - cache.at < TTL_MS) {
    return { ...cache.payload, cached: true };
  }

  try {
    const { hosts } = await fetchDownHostsFromApi();
    const payload = {
      configured: true,
      hosts,
      cached: false,
    };
    cache = { at: now, payload };
    return payload;
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    const err = new Error(formatFetchError(e) || 'Checkmk request failed');
    err.status = status;
    throw err;
  }
}

module.exports = {
  checkmkConfigured,
  getDownHostsCached,
};
