/**
 * Local Apple-style emoji PNGs (emoji-datasource-apple), synced into public/emoji-vendor/apple/.
 * Fully offline after `npm install` + `npm run build` (or `npm start`); no CDN.
 */

/**
 * Base URL for PNGs on the deployed site (CRA copies public/ into build root).
 */
export function appleEmojiImgBaseHref() {
  const raw = String(process.env.PUBLIC_URL || '').trim();
  if (!raw || raw === '.') {
    return '/emoji-vendor/apple/';
  }
  if (/^https?:\/\//i.test(raw)) {
    return `${raw.replace(/\/+$/, '')}/emoji-vendor/apple/`;
  }
  let path = raw.replace(/\/+$/, '');
  if (!path.startsWith('/')) path = `/${path}`;
  return `${path}/emoji-vendor/apple/`;
}

/** @param {string} emoji */
export function emojiUnicodeHexParts(emoji) {
  const str = String(emoji || '').normalize('NFC');
  const parts = [];
  for (let i = 0; i < str.length; ) {
    const cp = str.codePointAt(i);
    if (cp === undefined) break;
    i += cp > 0xffff ? 2 : 1;
    if (cp === 0xfe0e) continue;
    parts.push(cp.toString(16).toLowerCase());
  }
  return parts;
}

/**
 * Same filename rules as emoji-datasource-apple; try full codepoint list then strip trailing FE0F.
 * @param {string} emoji
 * @returns {string[]}
 */
export function appleEmojiImgCandidates(emoji) {
  const hexParts = emojiUnicodeHexParts(emoji);
  if (hexParts.length === 0) return [];

  const base = appleEmojiImgBaseHref();
  const urls = [];
  let cur = [...hexParts];
  const seen = new Set();
  const pushCur = () => {
    const name = `${cur.join('-')}.png`;
    const full = `${base}${name}`;
    if (!seen.has(full)) {
      seen.add(full);
      urls.push(full);
    }
  };

  pushCur();
  while (cur.length > 1 && cur[cur.length - 1] === 'fe0f') {
    cur = cur.slice(0, -1);
    pushCur();
  }

  return urls;
}
