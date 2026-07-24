/** In-memory failed SSH auth rate limit per user+IP (not persisted). */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 12;
const buckets = new Map();

function bucketKey(userId, ip) {
  return `${String(userId || 'anon')}:${String(ip || 'unknown')}`;
}

function recordAuthFailure(userId, ip) {
  const key = bucketKey(userId, ip);
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > WINDOW_MS) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count;
}

function isAuthRateLimited(userId, ip) {
  const key = bucketKey(userId, ip);
  const b = buckets.get(key);
  if (!b) return false;
  if (Date.now() - b.start > WINDOW_MS) {
    buckets.delete(key);
    return false;
  }
  return b.count >= MAX_FAILURES;
}

function clearAuthFailures(userId, ip) {
  buckets.delete(bucketKey(userId, ip));
}

module.exports = { recordAuthFailure, isAuthRateLimited, clearAuthFailures, MAX_FAILURES, WINDOW_MS };
