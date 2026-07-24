/**
 * Structured failure lines to stderr (visible in `docker logs`).
 * Caps total bytes per process so a tight loop cannot grow logs without bound.
 */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_ENTRY_CHARS = 14000;

function maxBytesCap() {
  const n = Number(process.env.FAILURE_LOG_MAX_BYTES);
  return Number.isFinite(n) && n > 1024 ? n : DEFAULT_MAX_BYTES;
}

let sessionBytes = 0;
let cappedWarned = false;

function truncateStr(s, max) {
  if (s == null) return '';
  const t = String(s);
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…(+${t.length - max} chars)`;
}

function logFailure(tag, err, meta = {}) {
  const cap = maxBytesCap();
  if (sessionBytes >= cap) return;

  const message =
    err && typeof err === 'object' && err.message != null ? String(err.message) : String(err || 'error');
  const stack = err && typeof err === 'object' && err.stack ? truncateStr(String(err.stack), 3500) : undefined;

  let payload;
  try {
    payload = JSON.stringify({
      ts: new Date().toISOString(),
      tag,
      message,
      stack,
      ...meta,
    });
  } catch {
    payload = JSON.stringify({
      ts: new Date().toISOString(),
      tag,
      message: truncateStr(message, 2000),
    });
  }

  let line = `[support-center][failure] ${payload}\n`;
  if (line.length > MAX_ENTRY_CHARS) {
    line = `[support-center][failure] ${truncateStr(payload, MAX_ENTRY_CHARS - 40)}\n`;
  }

  const bufLen = Buffer.byteLength(line, 'utf8');
  if (sessionBytes + bufLen > cap) {
    if (!cappedWarned) {
      cappedWarned = true;
      process.stderr.write(
        `[support-center] failureLog: cap ${cap} bytes reached; further failure logs suppressed until restart.\n`,
      );
    }
    sessionBytes = cap;
    return;
  }
  sessionBytes += bufLen;
  process.stderr.write(line);
}

module.exports = { logFailure, maxBytesCap };
