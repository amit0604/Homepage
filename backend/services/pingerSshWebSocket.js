const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { Client } = require('ssh2');
const { collections } = require('../repositories/jsonStore');
const { normalizeConnectMode } = require('../utils/pingerConnect');
const { logFailure } = require('../utils/failureLog');
const { pingerSshAlgorithms } = require('../utils/pingerSshAlgorithms');
const { verifyHostKeyFromHash } = require('../utils/pingerSshHostKeys');
const {
  isAuthRateLimited,
  recordAuthFailure,
  clearAuthFailures,
} = require('../utils/pingerSshRateLimit');
const { terminalErrorLine } = require('../utils/pingerSshErrors');

const PingerHost = collections.pingerHosts;
const Settings = collections.settings;

const AUTH_WAIT_MS = 120000;
const USER_MAX = 256;
const PASS_MAX = 8192;
const KEY_MAX = 65536;

function envFlag(name) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function pingerSshLog(msg, extra) {
  if (!envFlag('PINGER_SSH_DEBUG')) return;
  if (extra !== undefined) console.log('[pinger-ssh]', msg, extra);
  else console.log('[pinger-ssh]', msg);
}

function pingerSshLogSession(meta) {
  try {
    console.log('[pinger-ssh]', JSON.stringify({ event: 'ssh_session', ...meta }));
  } catch (_) {
    /* metadata only — never log terminal content */
  }
}

async function getIdleTimeoutMs() {
  const row = await Settings.findOne((r) => r.key === 'app');
  const n = Number(row && row.pingerSshIdleTimeoutMinutes);
  let min = 5;
  if (Number.isFinite(n)) {
    min = Math.min(Math.max(Math.round(n), 1), 1440);
  }
  return min * 60 * 1000;
}

function clientIp(request) {
  const xf = request.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return request.socket?.remoteAddress || '';
}

function sendJson(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function sendOut(ws, text, stderr = false) {
  sendJson(ws, { t: 'o', d: text, stderr: !!stderr });
}

function sendErr(ws, text) {
  sendOut(ws, `\r\n\x1b[31m${text}\x1b[0m\r\n`);
}

function attachPingerSshWebSocket(httpServer) {
  const wss = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    let pathname = '';
    try {
      const host = request.headers.host || 'localhost';
      pathname = new URL(request.url || '/', `http://${host}`).pathname;
    } catch (_) {
      socket.destroy();
      return;
    }
    if (pathname !== '/api/pinger/ssh-ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, request) => {
    handleSshSession(ws, request).catch((err) => {
      logFailure('pinger.ssh.ws', err, { path: '/api/pinger/ssh-ws' });
      sendErr(ws, err.message || 'SSH session failed');
    });
  });

  return wss;
}

async function handleSshSession(ws, request) {
  const hostHeader = request.headers.host || 'localhost';
  const url = new URL(request.url || '/', `http://${hostHeader}`);
  const token = url.searchParams.get('token');
  const hostId = url.searchParams.get('hostId');

  if (!token) {
    sendErr(ws, 'Missing token.');
    ws.close();
    return;
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_) {
    sendErr(ws, 'Session expired — sign in again.');
    ws.close();
    return;
  }
  if (!decoded.isAdmin && !decoded.pingerAccess) {
    sendErr(ws, 'Pinger access required.');
    ws.close();
    return;
  }

  const userId = decoded.id || decoded.sub || decoded.username || 'user';
  const ip = clientIp(request);

  let conn = null;
  let stream = null;
  let cleaned = false;
  let shellReady = false;
  let idleTimer = null;
  let fitDebounce = null;
  let motdFitUntil = 0;
  let pendingCols = 80;
  let pendingRows = 24;
  let sessionHost = '';
  let sessionPort = 22;
  let sessionUser = '';
  const sessionStarted = Date.now();

  const authTimer = setTimeout(() => {
    if (!shellReady && !cleaned) {
      sendErr(ws, 'Authentication timed out.');
      cleanup('auth timeout');
    }
  }, AUTH_WAIT_MS);

  function scheduleFit(delayMs = 120) {
    if (fitDebounce) clearTimeout(fitDebounce);
    fitDebounce = setTimeout(() => {
      fitDebounce = null;
      sendJson(ws, { t: 'f' });
    }, delayMs);
  }

  function scheduleMotdFit() {
    if (Date.now() > motdFitUntil) return;
    scheduleFit(180);
  }

  function cleanup(reason) {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(authTimer);
    if (fitDebounce) clearTimeout(fitDebounce);
    if (idleTimer) clearInterval(idleTimer);
    try {
      if (stream) stream.close();
    } catch (_) {
      /* ignore */
    }
    try {
      if (conn) conn.end();
    } catch (_) {
      /* ignore */
    }
    pingerSshLogSession({
      action: 'disconnect',
      host: sessionHost,
      port: sessionPort,
      user: sessionUser,
      reason: reason || '',
      durationMs: Date.now() - sessionStarted,
    });
    if (reason) {
      sendOut(ws, `\r\n\x1b[33m${reason}\x1b[0m\r\n`);
    }
    sendJson(ws, { t: 'x', reason: reason || '' });
    try {
      ws.close();
    } catch (_) {
      /* ignore */
    }
  }

  function startIdleTimer(idleMs) {
    lastActivity = Date.now();
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivity >= idleMs) {
        cleanup('Connection closed (idle timeout).');
      }
    }, 4000);
  }

  let lastActivity = Date.now();
  function touch() {
    lastActivity = Date.now();
  }

  function openShell(idleMs) {
    conn.shell(
      { term: 'xterm-256color', cols: pendingCols, rows: pendingRows },
      (err, sshStream) => {
        if (err || !sshStream) {
          sendErr(ws, terminalErrorLine(err || new Error('Shell failed'), sessionHost, sessionPort));
          cleanup('shell error');
          return;
        }
        stream = sshStream;
        shellReady = true;
        clearTimeout(authTimer);
        clearAuthFailures(userId, ip);
        motdFitUntil = Date.now() + 10000;
        sendJson(ws, { t: 's', phase: 'connected' });
        sendJson(ws, { t: 'a', ok: true });
        startIdleTimer(idleMs);
        scheduleFit(80);
        pingerSshLogSession({
          action: 'connected',
          host: sessionHost,
          port: sessionPort,
          user: sessionUser,
        });

        sshStream.on('data', (chunk) => {
          touch();
          sendOut(ws, chunk.toString('utf8'), false);
          scheduleMotdFit();
        });
        sshStream.on('close', () => {
          cleanup(`Connection to ${sessionHost} closed.`);
        });
        if (sshStream.stderr) {
          sshStream.stderr.on('data', (chunk) => {
            touch();
            const text = chunk.toString('utf8');
            sendOut(ws, `\x1b[33m${text}\x1b[0m`, true);
            scheduleMotdFit();
          });
        }
      },
    );
  }

  function beginSsh(auth) {
    if (isAuthRateLimited(userId, ip)) {
      sendErr(ws, 'Too many failed login attempts — try again later.');
      sendJson(ws, { t: 's', phase: 'disconnected' });
      return;
    }

    const rowPromise = hostId
      ? PingerHost.findById(hostId)
      : Promise.resolve(null);

    rowPromise.then(async (row) => {
      if (hostId && !row) {
        sendErr(ws, 'Host not found.');
        sendJson(ws, { t: 's', phase: 'disconnected' });
        return;
      }
      if (row) {
        const mode = normalizeConnectMode(row.connectMode);
        if (mode !== 'ssh' && mode !== 'both') {
          sendErr(ws, 'SSH is not enabled for this host.');
          sendJson(ws, { t: 's', phase: 'disconnected' });
          return;
        }
      }

      const sshHost = String((row && row.ip) || auth.hostname || '').trim();
      if (!sshHost) {
        sendErr(ws, 'Host has no address.');
        sendJson(ws, { t: 's', phase: 'disconnected' });
        return;
      }

      const port = Math.min(
        65535,
        Math.max(1, Number(auth.port) || 22),
      );
      const username = String(auth.username || '')
        .trim()
        .slice(0, USER_MAX);
      if (!username) {
        sendErr(ws, 'Username is required.');
        sendJson(ws, { t: 's', phase: 'disconnected' });
        return;
      }

      sessionHost = sshHost;
      sessionPort = port;
      sessionUser = username;

      const authMethod = auth.authMethod === 'privateKey' ? 'privateKey' : 'password';
      const connectOpts = {
        host: sshHost,
        port,
        username,
        tryKeyboard: true,
        readyTimeout: 25000,
        algorithms: pingerSshAlgorithms(),
        hostHash: 'sha256',
      };

      if (authMethod === 'privateKey') {
        const key = String(auth.privateKey || '').slice(0, KEY_MAX);
        if (!key.trim()) {
          sendErr(ws, 'Private key is required.');
          sendJson(ws, { t: 's', phase: 'disconnected' });
          return;
        }
        connectOpts.privateKey = key;
        const pp = auth.passphrase != null ? String(auth.passphrase).slice(0, PASS_MAX) : '';
        if (pp) connectOpts.passphrase = pp;
      } else {
        connectOpts.password =
          auth.password != null ? String(auth.password).slice(0, PASS_MAX) : '';
      }

      sendJson(ws, { t: 's', phase: 'connecting' });
      sendOut(ws, `\r\nConnecting to ${sshHost} port ${port}…\r\n`);

      const idleMs = await getIdleTimeoutMs();
      let failureHandled = false;

      conn = new Client();

      conn.on('banner', (message) => {
        const text = Buffer.isBuffer(message) ? message.toString('utf8') : String(message || '');
        if (text.trim()) {
          sendOut(ws, `\r\n${text.replace(/\n/g, '\r\n')}\r\n`);
          scheduleFit(100);
        }
      });

      conn.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
        if (instructions && String(instructions).trim()) {
          sendOut(ws, `\r\n${String(instructions).replace(/\n/g, '\r\n')}\r\n`);
        }
        if (!prompts.length) {
          finish([]);
          return;
        }
        const responses = prompts.map((p) => {
          if (p.echo) return username;
          if (authMethod === 'privateKey') return connectOpts.passphrase || '';
          return connectOpts.password || '';
        });
        finish(responses);
      });

      conn.on('ready', () => {
        touch();
        openShell(idleMs);
      });

      conn.on('error', (err) => {
        if (failureHandled || shellReady) return;
        failureHandled = true;
        recordAuthFailure(userId, ip);
        const line = terminalErrorLine(err, sshHost, port);
        sendErr(ws, line);
        sendJson(ws, { t: 's', phase: 'disconnected' });
        logFailure('pinger.ssh.session', err, {
          target: `${sshHost}:${port}`,
          user: username,
        });
      });

      conn.on('close', () => {
        if (!shellReady && !cleaned && !failureHandled) {
          failureHandled = true;
          recordAuthFailure(userId, ip);
          sendErr(
            ws,
            'Permission denied (publickey,password).',
          );
          sendJson(ws, { t: 's', phase: 'disconnected' });
        }
      });

      connectOpts.hostVerifier = async (hashed) => {
        try {
          const hashB64 = Buffer.isBuffer(hashed) ? hashed.toString('base64') : String(hashed);
          const result = await verifyHostKeyFromHash(
            sshHost,
            port,
            hashB64,
            !!auth.acceptHostKeyChange,
          );
          sendJson(ws, {
            t: 'hk',
            fingerprint: result.fingerprint,
            known: result.known,
            changed: result.changed,
            previous: result.previous || undefined,
          });
          if (!result.accept) {
            sendErr(
              ws,
              `WARNING: Host key changed! ${result.fingerprint} (was ${result.previous})`,
            );
            failureHandled = true;
            sendJson(ws, { t: 's', phase: 'disconnected' });
            return false;
          }
          return true;
        } catch (e) {
          logFailure('pinger.ssh.hostkey', e, { target: `${sshHost}:${port}` });
          return true;
        }
      };

      try {
        conn.connect(connectOpts);
      } catch (e) {
        sendErr(ws, terminalErrorLine(e, sshHost, port));
        sendJson(ws, { t: 's', phase: 'disconnected' });
      }
    });
  }

  ws.on('close', () => cleanup(''));
  ws.on('error', () => cleanup(''));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    if (msg.t === 'r') {
      const cols = Number(msg.cols);
      const rows = Number(msg.rows);
      if (cols > 0 && rows > 0) {
        pendingCols = cols;
        pendingRows = rows;
      }
      if (shellReady && stream) {
        try {
          stream.setWindow(rows, cols, 0, 0);
        } catch (_) {
          /* ignore */
        }
      }
      return;
    }

    if (msg.t === 'auth' && !shellReady) {
      beginSsh(msg);
      return;
    }

    if (msg.t === 'i' && shellReady && stream && msg.d != null) {
      touch();
      stream.write(String(msg.d));
    }
  });

  sendJson(ws, { t: 's', phase: 'login' });
  sendOut(ws, '\r\nWaiting for credentials…\r\n');
}

module.exports = attachPingerSshWebSocket;
