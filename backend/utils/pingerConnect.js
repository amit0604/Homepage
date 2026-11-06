const { isDangerousUrl } = require('./safeUrl');

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
  const value = String(raw ?? '').trim().slice(0, 2048);
  return isDangerousUrl(value) ? '' : value;
}

module.exports = {
  normalizeConnectMode,
  sanitizeWebUrl,
};
