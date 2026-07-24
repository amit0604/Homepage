function faviconAllowPrivateHosts() {
  return String(process.env.FAVICON_ALLOW_PRIVATE || '').toLowerCase() === 'true';
}

/** Self-signed / corporate TLS: skip certificate verification for favicon HTTP fetches (lab default true). */
function faviconTlsInsecure() {
  return String(process.env.FAVICON_TLS_INSECURE || '').toLowerCase() === 'true';
}

async function faviconFetch(url, options) {
  if (faviconTlsInsecure()) {
    const { fetch: undiciFetch, Agent } = require('undici');
    return undiciFetch(url, {
      ...options,
      dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
    });
  }
  return fetch(url, options);
}

function maxImageBytes() {
  const n = Number(process.env.FAVICON_MAX_IMAGE_BYTES);
  return Number.isFinite(n) && n > 4096 ? n : 2 * 1024 * 1024;
}

function isBlockedFaviconHost(hostname) {
  if (faviconAllowPrivateHosts()) return false;
  const h = String(hostname).toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const m = h.match(ipv4);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    if (
      a === 127
      || a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
    ) {
      return true;
    }
  }
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc00:') || h.startsWith('fd')) return true;
  return false;
}

function attrFromTag(tag, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reDQ = new RegExp(`\\b${esc}\\s*=\\s*"([^"]*)"`, 'i');
  const reSQ = new RegExp(`\\b${esc}\\s*=\\s*'([^']*)'`, 'i');
  const reUQ = new RegExp(`\\b${esc}\\s*=\\s*([^\\s>]+)`, 'i');
  let m = tag.match(reDQ);
  if (m) return m[1].trim();
  m = tag.match(reSQ);
  if (m) return m[1].trim();
  m = tag.match(reUQ);
  if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  return null;
}

function parseSizesPx(sizesStr) {
  let px = 0;
  const s = String(sizesStr || '').trim();
  if (!s) return px;
  for (const part of s.split(/\s+/)) {
    const sm = part.match(/^(\d+)x(\d+)$/i);
    if (sm) px = Math.max(px, +sm[1], +sm[2]);
  }
  return px;
}

function mergeScore(scoreByUrl, url, score) {
  if (!url) return;
  const prev = scoreByUrl.get(url);
  if (prev == null || score > prev) scoreByUrl.set(url, score);
}

/**
 * Walk raw HTML and yield full tag strings (e.g. `<link …>`) without cutting at `>` inside quoted attrs.
 * Fixes long `href="data:image/png;base64,…"` and `content="data:…"` values.
 */
function forEachTagOpen(html, localName, fn) {
  const lower = html.toLowerCase();
  const needle = `<${localName.toLowerCase()}`;
  let i = 0;
  while (i < html.length) {
    const start = lower.indexOf(needle, i);
    if (start === -1) break;
    const afterName = start + needle.length;
    if (afterName < html.length && /[a-zA-Z0-9]/.test(html[afterName])) {
      i = afterName;
      continue;
    }
    let j = afterName;
    let quote = null;
    for (; j < html.length; j += 1) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        fn(html.slice(start, j + 1));
        break;
      }
    }
    i = j + 1;
  }
}

function collectHtmlIconHints(html, pageBaseUrl) {
  const scoreByUrl = new Map();
  const manifestHrefs = [];

  forEachTagOpen(html, 'link', (tag) => {
    const rel = (attrFromTag(tag, 'rel') || '').toLowerCase();
    if (!rel) return;

    if (rel.includes('manifest')) {
      const href = attrFromTag(tag, 'href');
      if (href && !href.startsWith('data:')) {
        try {
          manifestHrefs.push(new URL(href, pageBaseUrl).href);
        } catch (_) {
          /* skip */
        }
      }
      return;
    }

    const relParts = rel.split(/\s+/).filter(Boolean);
    const looksLikeIconRel =
      rel.includes('mask-icon')
      || relParts.some((p) => p === 'icon' || p.endsWith('-icon') || p.includes('apple-touch'));
    if (!looksLikeIconRel) return;
    const href = attrFromTag(tag, 'href');
    if (!href) return;
    const px = parseSizesPx(attrFromTag(tag, 'sizes'));
    let score = 1500 + px;
    if (rel.includes('apple-touch-icon')) {
      score = 9000 + px;
    } else if (rel.includes('mask-icon')) {
      score = 1300 + px;
    } else if (rel.includes('shortcut') || rel.includes('icon')) {
      score = 3500 + px + Math.min(px, 256);
    }
    if (href.startsWith('data:')) {
      if (isValidDataImageUrl(href)) mergeScore(scoreByUrl, href, score);
      return;
    }
    let abs;
    try {
      abs = new URL(href, pageBaseUrl).href;
    } catch {
      return;
    }
    mergeScore(scoreByUrl, abs, score);
  });

  forEachTagOpen(html, 'meta', (tag) => {
    const prop = (attrFromTag(tag, 'property') || '').toLowerCase();
    const name = (attrFromTag(tag, 'name') || '').toLowerCase();
    const isOg =
      prop === 'og:image' || prop === 'og:image:url' || prop === 'og:image:secure_url';
    const isTw = name === 'twitter:image' || name === 'twitter:image:src';
    if (!isOg && !isTw) return;
    const content = attrFromTag(tag, 'content');
    if (!content) return;
    if (content.startsWith('data:')) {
      if (isValidDataImageUrl(content)) mergeScore(scoreByUrl, content, isOg ? 800 : 780);
      return;
    }
    try {
      const abs = new URL(content, pageBaseUrl).href;
      mergeScore(scoreByUrl, abs, isOg ? 800 : 780);
    } catch (_) {
      /* skip */
    }
  });

  return { scoreByUrl, manifestHrefs: [...new Set(manifestHrefs)] };
}

async function readBodyUpTo(response, maxBytes) {
  const cl = response.headers.get('content-length');
  if (cl != null && cl !== '') {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) return null;
    if (Number.isFinite(n) && n >= 0 && n <= maxBytes) {
      const ab = await response.arrayBuffer();
      const buf = Buffer.from(ab);
      if (buf.length > maxBytes) return null;
      return buf;
    }
  }
  if (!response.body) {
    const ab = await response.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length > maxBytes) return null;
    return buf;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch (_) {
          /* ignore */
        }
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch {
    try {
      await reader.cancel();
    } catch (_) {
      /* ignore */
    }
    return null;
  }
}

function looksLikeImageBuffer(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return true;
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return true;
  const head = buf.toString('utf8', 0, Math.min(256, buf.length)).trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return true;
  return false;
}

function dataUrlHeaderImpliesRasterImage(headerLc) {
  return /image\/(png|jpeg|pjpeg|gif|webp|x-icon|vnd\.microsoft\.icon|bmp|avif)/i.test(headerLc);
}

function dataUrlMaxChars() {
  const b = maxImageBytes();
  return Math.min(Math.floor(b * 1.4) + 512, 4 * 1024 * 1024);
}

/** Inline data URLs from HTML/manifest (e.g. data:image/png;base64,…). */
function isValidDataImageUrl(rawInput) {
  const s = String(rawInput || '').trim();
  if (!s.startsWith('data:')) return false;
  if (!/^data:image\//i.test(s)) return false;
  if (s.length > dataUrlMaxChars()) return false;
  const comma = s.indexOf(',');
  if (comma < 10) return false;
  const header = s.slice(5, comma).toLowerCase();
  const payload = s.slice(comma + 1);
  const maxB = maxImageBytes();
  const headerCompact = header.replace(/\s/g, '');
  const isBase64 = /(?:^|[;,])base64(?:$|[;,])/i.test(headerCompact) || /\bbase64\b/i.test(header);

  if (isBase64) {
    try {
      const b64 = payload.replace(/\s/g, '');
      if (!b64) return false;
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > maxB || buf.length === 0) return false;
      if (header.includes('svg')) {
        const txt = buf.toString('utf8').trimStart().slice(0, 400).toLowerCase();
        return txt.startsWith('<svg') || txt.startsWith('<?xml');
      }
      if (looksLikeImageBuffer(buf)) return true;
      if (dataUrlHeaderImpliesRasterImage(header) && buf.length >= 8) return true;
      return false;
    } catch {
      return false;
    }
  }

  if (header.includes('svg')) {
    let decoded;
    try {
      decoded = decodeURIComponent(payload);
    } catch {
      decoded = payload;
    }
    if (decoded.length > maxB) return false;
    const head = decoded.trimStart().slice(0, 300).toLowerCase();
    return head.startsWith('<svg') || head.startsWith('<?xml');
  }

  return false;
}

async function fetchValidFaviconUrl(urlStr) {
  const raw = String(urlStr || '').trim();
  if (raw.startsWith('data:')) {
    return isValidDataImageUrl(raw) ? raw : null;
  }

  const max = maxImageBytes();
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (isBlockedFaviconHost(u.hostname)) return null;

  try {
    const r = await faviconFetch(urlStr, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'SupportCenter-FaviconBot/1.1',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.6',
      },
    });
    if (!r.ok) return null;

    const ctRaw = (r.headers.get('content-type') || '').toLowerCase();
    const ct = ctRaw.split(';')[0].trim();
    if (ct === 'text/html' || ct === 'application/xhtml+xml') return null;

    const buf = await readBodyUpTo(r, max);
    if (!buf || buf.length === 0) return null;

    const asciiStart = buf.toString('utf8', 0, Math.min(64, buf.length)).trimStart();
    if (asciiStart.startsWith('<!doctype') || asciiStart.startsWith('<html')) return null;

    if (ct.startsWith('image/')) return urlStr;
    if (looksLikeImageBuffer(buf)) return urlStr;
    return null;
  } catch {
    return null;
  }
}

async function mergeIconsFromWebManifest(manifestAbsUrl, scoreByUrl) {
  let origin;
  try {
    origin = new URL(manifestAbsUrl);
  } catch {
    return;
  }
  if (isBlockedFaviconHost(origin.hostname)) return;

  try {
    const r = await faviconFetch(manifestAbsUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: {
        Accept: 'application/manifest+json,application/json;q=0.9,*/*;q=0.1',
        'User-Agent': 'SupportCenter-FaviconBot/1.1',
      },
    });
    if (!r.ok) return;
    const text = await r.text();
    if (text.length > 800000) return;
    const j = JSON.parse(text);
    const icons = Array.isArray(j.icons) ? j.icons : [];
    const base = new URL(manifestAbsUrl);

    for (let i = 0; i < icons.length; i += 1) {
      const ic = icons[i];
      if (!ic || typeof ic !== 'object') continue;
      const src = ic.src != null ? String(ic.src).trim() : '';
      if (!src) continue;
      const px = parseSizesPx(ic.sizes != null ? String(ic.sizes) : '');
      if (src.startsWith('data:')) {
        if (isValidDataImageUrl(src)) mergeScore(scoreByUrl, src, 5000 + px);
        continue;
      }
      try {
        const abs = new URL(src, base).href;
        const host = new URL(abs).hostname;
        if (isBlockedFaviconHost(host)) continue;
        mergeScore(scoreByUrl, abs, 5000 + px);
      } catch (_) {
        /* skip */
      }
    }
  } catch {
    /* invalid JSON or network */
  }
}

function sortedCandidateUrls(scoreByUrl, originUrl) {
  const icoFallback = new URL('/favicon.ico', originUrl).href;
  mergeScore(scoreByUrl, icoFallback, 400);

  return [...scoreByUrl.entries()]
    .sort((a, b) => b[1] - a[1])
    .map((e) => e[0]);
}

/**
 * @param {string} rawInput Page URL (shortcut link or any http(s) page)
 * @returns {Promise<string>} Absolute URL of a favicon image
 */
async function resolveFaviconFromPage(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) throw new Error('URL is required');
  let pageUrl;
  try {
    pageUrl = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(pageUrl.protocol)) {
    throw new Error('Only http(s) URLs are supported');
  }
  if (isBlockedFaviconHost(pageUrl.hostname)) {
    throw new Error(
      'This host cannot be used for favicon fetch. Set FAVICON_ALLOW_PRIVATE=true for LAN/private URLs.',
    );
  }

  const pageRes = await faviconFetch(pageUrl.href, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
      'User-Agent': 'SupportCenter-FaviconBot/1.1',
    },
  });
  if (!pageRes.ok) throw new Error(`Could not load page (HTTP ${pageRes.status})`);

  const finalPageUrl = new URL(pageRes.url);
  if (isBlockedFaviconHost(finalPageUrl.hostname)) {
    throw new Error('Redirect led to a blocked host');
  }

  let html = await pageRes.text();
  if (html.length > 900000) html = html.slice(0, 900000);

  const { scoreByUrl, manifestHrefs } = collectHtmlIconHints(html, finalPageUrl);

  for (let i = 0; i < manifestHrefs.length; i += 1) {
    await mergeIconsFromWebManifest(manifestHrefs[i], scoreByUrl);
  }

  const candidates = sortedCandidateUrls(scoreByUrl, finalPageUrl.origin);

  for (let i = 0; i < candidates.length; i += 1) {
    const item = candidates[i];
    const rawCand = String(item || '').trim();
    if (rawCand.startsWith('data:')) {
      const ok = await fetchValidFaviconUrl(rawCand);
      if (ok) return ok;
      continue;
    }
    let cand;
    try {
      cand = new URL(rawCand);
    } catch {
      continue;
    }
    if (isBlockedFaviconHost(cand.hostname)) continue;
    const ok = await fetchValidFaviconUrl(rawCand);
    if (ok) return ok;
  }

  throw new Error('No favicon found for this site');
}

module.exports = { resolveFaviconFromPage };
