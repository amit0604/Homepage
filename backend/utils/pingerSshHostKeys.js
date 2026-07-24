const crypto = require('crypto');
const { collections } = require('../repositories/jsonStore');

const HostKeys = collections.pingerSshHostKeys;

function targetKey(host, port) {
  return `${String(host).trim().toLowerCase()}:${Number(port)}`;
}

function formatSha256Fingerprint(hashBase64) {
  const hex = Buffer.from(hashBase64, 'base64').toString('hex').toUpperCase();
  const parts = hex.match(/.{1,2}/g) || [];
  return `SHA256:${parts.join(':')}`;
}

function hashHostKeyBase64(hostKey) {
  const buf = Buffer.isBuffer(hostKey) ? hostKey : Buffer.from(hostKey);
  return crypto.createHash('sha256').update(buf).digest('base64');
}

async function getStoredFingerprint(host, port) {
  const tk = targetKey(host, port);
  const row = await HostKeys.findOne((r) => r.target === tk);
  return row ? String(row.fingerprintSha256 || '') : '';
}

async function saveFingerprint(host, port, fingerprintSha256) {
  const tk = targetKey(host, port);
  const fp = String(fingerprintSha256 || '').trim();
  if (!fp) return;
  const existing = await HostKeys.findOne((r) => r.target === tk);
  if (existing) {
    await HostKeys.update(existing._id, {
      fingerprintSha256: fp,
      updatedAt: new Date().toISOString(),
    });
  } else {
    await HostKeys.insert({
      target: tk,
      host: String(host).trim(),
      port: Number(port),
      fingerprintSha256: fp,
      updatedAt: new Date().toISOString(),
    });
  }
}

/**
 * @returns {{ accept: boolean, fingerprint: string, changed: boolean, known: boolean }}
 */
async function verifyHostKeyFromHash(host, port, hashBase64, allowChanged) {
  const fp = formatSha256Fingerprint(String(hashBase64 || ''));
  const known = await getStoredFingerprint(host, port);
  if (!known) {
    await saveFingerprint(host, port, fp);
    return { accept: true, fingerprint: fp, changed: false, known: false };
  }
  if (known === fp) {
    return { accept: true, fingerprint: fp, changed: false, known: true };
  }
  if (allowChanged) {
    await saveFingerprint(host, port, fp);
    return { accept: true, fingerprint: fp, changed: true, known: true };
  }
  return { accept: false, fingerprint: fp, changed: true, known: true, previous: known };
}

async function verifyHostKey(host, port, hostKey, allowChanged) {
  const fp = formatSha256Fingerprint(hashHostKeyBase64(hostKey));
  const known = await getStoredFingerprint(host, port);
  if (!known) {
    await saveFingerprint(host, port, fp);
    return { accept: true, fingerprint: fp, changed: false, known: false };
  }
  if (known === fp) {
    return { accept: true, fingerprint: fp, changed: false, known: true };
  }
  if (allowChanged) {
    await saveFingerprint(host, port, fp);
    return { accept: true, fingerprint: fp, changed: true, known: true };
  }
  return { accept: false, fingerprint: fp, changed: true, known: true, previous: known };
}

module.exports = {
  formatSha256Fingerprint,
  hashHostKeyBase64,
  getStoredFingerprint,
  verifyHostKey,
  verifyHostKeyFromHash,
  targetKey,
};
