const ping = require('ping');
const { normalizeConnectMode, sanitizeWebUrl } = require('./pingerConnect');
const { isValidHostAddress } = require('./safeUrl');

function getWarnMs() {
  const n = Number(process.env.PINGER_WARN_MS);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

function getCacheMs() {
  const n = Number(process.env.PINGER_CACHE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 25000;
}

function idsSignature(hosts) {
  return hosts
    .map((h) => h._id)
    .sort()
    .join('|');
}

function toState(alive, ms) {
  if (!alive) return 'down';
  if (ms != null && Number.isFinite(ms) && ms >= getWarnMs()) return 'warn';
  return 'up';
}

let cache = {
  at: 0,
  idsSig: '',
  list: [],
};

function invalidatePingerCache() {
  cache = { at: 0, idsSig: '', list: [] };
}

async function probeTarget(target) {
  const t = String(target || '').trim();
  if (!t) {
    return { alive: false, ms: null, error: 'empty target' };
  }
  // Rows saved before addresses were validated must not reach ping as options.
  if (!isValidHostAddress(t)) {
    return { alive: false, ms: null, error: 'invalid address' };
  }
  try {
    const res = await ping.promise.probe(t, {
      timeout: 5,
    });
    let ms = null;
    if (res.time !== undefined && res.time !== 'unknown') {
      const parsed = parseFloat(String(res.time));
      if (Number.isFinite(parsed)) ms = parsed;
    }
    return { alive: Boolean(res.alive), ms };
  } catch (e) {
    return { alive: false, ms: null, error: e.message || 'probe failed' };
  }
}

/**
 * @param {Array<{_id: string, hostname: string, ip: string, type?: string, sortOrder?: number}>} hosts
 */
async function getStatusForHosts(hosts) {
  const sorted = [...hosts].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a._id).localeCompare(String(b._id)),
  );
  const sig = idsSignature(sorted);
  const ttl = getCacheMs();
  if (cache.list.length && Date.now() - cache.at < ttl && cache.idsSig === sig) {
    return {
      hosts: cache.list,
      checkedAt: new Date(cache.at).toISOString(),
      warnMs: getWarnMs(),
      fromCache: true,
    };
  }

  const merged = await Promise.all(
    sorted.map(async (row) => {
      const target = String(row.ip || '').trim();
      const probe = await probeTarget(target);
      const state = toState(probe.alive, probe.ms);
      return {
        _id: row._id,
        hostname: row.hostname != null ? String(row.hostname) : '',
        ip: row.ip != null ? String(row.ip) : '',
        type: row.type != null ? String(row.type) : '',
        sortOrder: row.sortOrder ?? 0,
        connectMode: normalizeConnectMode(row.connectMode),
        webUrl: sanitizeWebUrl(row.webUrl),
        alive: probe.alive,
        ms: probe.ms,
        state,
        error: probe.error || null,
      };
    }),
  );

  const at = Date.now();
  cache = { at, idsSig: sig, list: merged };
  return {
    hosts: merged,
    checkedAt: new Date(at).toISOString(),
    warnMs: getWarnMs(),
    fromCache: false,
  };
}

module.exports = {
  getStatusForHosts,
  invalidatePingerCache,
  getWarnMs,
};
