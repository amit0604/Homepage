/**
 * Message of the day — optional Ollama-backed text, cached in settings (key app → motd).
 */
const { fetch } = require('undici');

function defaultMotdConfig() {
  return {
    enabled: false,
    title: 'Message of the day',
    aiPrompt:
      'Write a short, friendly message for a company IT home page (at most 3 short sentences, plain text only, no markdown, lists, or headings).',
    ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    ollamaModel: (process.env.OLLAMA_MODEL || 'llama3.2').trim() || 'llama3.2',
    /** Daily refresh at this local time on the server (HH:mm, 24h). */
    regenerateAt: '08:00',
    cachedBody: '',
    cachedAt: null,
    lastError: '',
  };
}

function normalizeMotd(raw) {
  const d = defaultMotdConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d;
  if (typeof raw.enabled === 'boolean') d.enabled = raw.enabled;
  if (typeof raw.title === 'string') {
    const t = raw.title.trim().slice(0, 100);
    d.title = t || d.title;
  }
  if (typeof raw.aiPrompt === 'string') d.aiPrompt = raw.aiPrompt.slice(0, 8000);
  if (typeof raw.ollamaUrl === 'string' && raw.ollamaUrl.trim()) {
    d.ollamaUrl = raw.ollamaUrl.trim().replace(/\/$/, '');
  }
  if (typeof raw.ollamaModel === 'string' && raw.ollamaModel.trim()) {
    d.ollamaModel = raw.ollamaModel.trim().slice(0, 120);
  }
  if (typeof raw.regenerateAt === 'string' && raw.regenerateAt.trim()) {
    const canon = canonicalRegenerateAt(raw.regenerateAt);
    if (canon) d.regenerateAt = canon;
  }
  if (typeof raw.cachedBody === 'string') d.cachedBody = raw.cachedBody.slice(0, 8000);
  if (typeof raw.cachedAt === 'string' && raw.cachedAt) d.cachedAt = raw.cachedAt;
  if (typeof raw.lastError === 'string') d.lastError = raw.lastError.slice(0, 1000);
  return d;
}

/** True when stored motd omits keys from the current default schema (upgrade / merge needed). */
function motdDocumentNeedsMerge(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
  const template = defaultMotdConfig();
  return Object.keys(template).some((k) => !Object.prototype.hasOwnProperty.call(raw, k));
}

/** @returns {string|null} canonical "HH:mm" or null */
function canonicalRegenerateAt(input) {
  const s = String(input || '').trim();
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return null;
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function boundaryForLocalDay(anchor, hour, minute) {
  return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), hour, minute, 0, 0);
}

function addLocalDays(anchor, delta) {
  const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + delta, 12, 0, 0, 0);
  return d;
}

/**
 * Parse "HH:mm" used in motd.regenerateAt → hour/minute numbers.
 * Falls back to 08:00 if invalid.
 */
function parseRegenerateClock(motd) {
  const canon = canonicalRegenerateAt(motd && motd.regenerateAt) || canonicalRegenerateAt(defaultMotdConfig().regenerateAt);
  if (!canon) return { hour: 8, minute: 0 };
  const [hs, ms] = canon.split(':');
  return { hour: parseInt(hs, 10), minute: parseInt(ms, 10) };
}

/**
 * True when cache is empty or last generation is older than the most recent
 * scheduled daily boundary (server local clock).
 */
function needsRefresh(motd) {
  const m = normalizeMotd(motd);
  if (!m.enabled) return false;
  const promptOk = String(m.aiPrompt || '').trim().length > 0;
  if (!promptOk) return false;
  if (!String(m.cachedBody || '').trim()) return true;

  const cached = m.cachedAt ? new Date(m.cachedAt) : null;
  if (!cached || Number.isNaN(cached.getTime())) return true;

  const { hour, minute } = parseRegenerateClock(m);
  const now = new Date();
  const todayBoundary = boundaryForLocalDay(now, hour, minute);
  const lastDueBoundary =
    now.getTime() < todayBoundary.getTime()
      ? boundaryForLocalDay(addLocalDays(now, -1), hour, minute)
      : todayBoundary;

  return cached.getTime() < lastDueBoundary.getTime();
}

async function generateViaOllama(motd) {
  const base = String(motd.ollamaUrl || '').replace(/\/$/, '');
  const url = `${base}/api/generate`;
  const body = {
    model: motd.ollamaModel || 'llama3.2',
    prompt: String(motd.aiPrompt || '').trim(),
    stream: false,
  };

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 120000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tid);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${errText.slice(0, 280)}`);
  }

  const data = await res.json().catch(() => ({}));
  const text = data && (data.response ?? data.message?.content ?? data.text);
  const cleaned = String(text || '').trim().replace(/\r\n/g, '\n').slice(0, 8000);
  if (!cleaned) {
    throw new Error('Empty response from Ollama');
  }
  return cleaned;
}

let refreshInFlight = false;

/**
 * Background refresh when cache is stale or empty (non-blocking caller).
 */
async function scheduleMotdRefreshIfNeeded(Settings, getSettings) {
  if (refreshInFlight) return;
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return;
  }
  let motd = normalizeMotd(settings.motd);
  if (!needsRefresh(motd)) return;

  refreshInFlight = true;
  try {
    const text = await generateViaOllama(motd);
    settings = await getSettings();
    motd = normalizeMotd(settings.motd);
    await Settings.updateById(settings._id, {
      motd: {
        ...motd,
        cachedBody: text,
        cachedAt: new Date().toISOString(),
        lastError: '',
      },
    });
  } catch (e) {
    try {
      settings = await getSettings();
      motd = normalizeMotd(settings.motd);
      await Settings.updateById(settings._id, {
        motd: {
          ...motd,
          lastError: String(e.message || e).slice(0, 1000),
        },
      });
    } catch {
      /* ignore */
    }
  } finally {
    refreshInFlight = false;
  }
}

/**
 * Synchronous regenerate (admin); returns updated motd or throws.
 */
async function regenerateMotdNow(Settings, getSettings) {
  const settings = await getSettings();
  const motd = normalizeMotd(settings.motd);
  if (!String(motd.aiPrompt || '').trim()) {
    throw new Error('AI prompt is empty');
  }
  const text = await generateViaOllama(motd);
  const next = {
    ...motd,
    cachedBody: text,
    cachedAt: new Date().toISOString(),
    lastError: '',
  };
  await Settings.updateById(settings._id, { motd: next });
  return next;
}

module.exports = {
  defaultMotdConfig,
  normalizeMotd,
  motdDocumentNeedsMerge,
  needsRefresh,
  generateViaOllama,
  scheduleMotdRefreshIfNeeded,
  regenerateMotdNow,
};
