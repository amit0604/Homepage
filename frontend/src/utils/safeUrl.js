/**
 * Returns the link if it is safe to open, otherwise an empty string.
 * The server refuses unsafe links, and this also covers anything saved before it did.
 */
export function safeLink(value) {
  const raw = String(value ?? '').trim();
  // eslint-disable-next-line no-control-regex
  const compact = raw.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  return /^(javascript|data|vbscript|file|blob):/.test(compact) ? '' : raw;
}
