const { Client } = require('ssh2');
const { pingerSshAlgorithms } = require('./pingerSshAlgorithms');
const { formatSha256Fingerprint } = require('./pingerSshHostKeys');
const { getStoredFingerprint } = require('./pingerSshHostKeys');
const { terminalErrorLine } = require('./pingerSshErrors');

/**
 * TCP + SSH handshake to read host key fingerprint without completing authentication.
 * @returns {Promise<{ fingerprint?: string, known?: string, changed?: boolean, error?: string }>}
 */
function probeSshFingerprint(host, port, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    let capturedFp = '';

    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch (_) {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      done({ error: terminalErrorLine({ message: 'ETIMEDOUT' }, host, port) });
    }, timeoutMs);

    conn.on('ready', () => {
      clearTimeout(timer);
      done({ error: 'Unexpected authentication success during fingerprint probe.' });
    });

    conn.on('error', async (err) => {
      clearTimeout(timer);
      if (capturedFp) {
        const known = await getStoredFingerprint(host, port);
        done({
          fingerprint: capturedFp,
          known: known || undefined,
          changed: !!(known && known !== capturedFp),
        });
        return;
      }
      done({ error: terminalErrorLine(err, host, port) });
    });

    conn.connect({
      host,
      port,
      username: 'fingerprint-probe',
      readyTimeout: timeoutMs,
      algorithms: pingerSshAlgorithms(),
      hostHash: 'sha256',
      hostVerifier: (hashed) => {
        capturedFp = formatSha256Fingerprint(hashed);
        return false;
      },
    });
  });
}

module.exports = { probeSshFingerprint };
