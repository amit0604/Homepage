const VALID = new Set(['none', 'ssh', 'http', 'both']);

function normalizeConnectMode(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (s === 'web' || s === 'https' || s === 'http/s') return 'http';
  if (VALID.has(s)) return s;
  return 'none';
}

function sanitizeWebUrl(raw) {
  return String(raw ?? '')
    .trim()
    .slice(0, 2048);
}

module.exports = {
  normalizeConnectMode,
  sanitizeWebUrl,
};
