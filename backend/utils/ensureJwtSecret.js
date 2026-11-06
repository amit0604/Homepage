const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

/** Values known to be public or guessable. These appeared in earlier versions of this project. */
const KNOWN_WEAK = new Set(['12331234', 'change-me', 'changeme', 'secret']);
const MIN_LENGTH = 32;

/**
 * Sign-in tokens are only as safe as this secret. A missing or weak value is replaced by a random
 * one kept in the data volume, so it survives restarts and never appears in configuration files.
 */
async function ensureJwtSecret(dataDir) {
  const current = String(process.env.JWT_SECRET || '');
  if (current.length >= MIN_LENGTH && !KNOWN_WEAK.has(current)) return;

  if (current) {
    console.warn('[security] JWT_SECRET is weak or known, so it was ignored. Using the generated secret in the data volume.');
  }
  const file = path.join(dataDir, '.jwt-secret');
  let secret = '';
  try {
    secret = (await fs.readFile(file, 'utf8')).trim();
  } catch {
    /* First start: created below. */
  }
  if (secret.length < MIN_LENGTH) {
    secret = crypto.randomBytes(48).toString('base64url');
    await fs.writeFile(file, secret, { mode: 0o600 });
    console.log('[security] Generated a new JWT secret in the data volume. Everyone will need to sign in again.');
  }
  process.env.JWT_SECRET = secret;
}

module.exports = { ensureJwtSecret };
