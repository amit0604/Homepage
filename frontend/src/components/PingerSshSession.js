import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';

function wsUrl(token, hostId) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({ token, hostId: String(hostId) });
  return `${proto}//${window.location.host}/api/pinger/ssh-ws?${qs}`;
}

const emptyCreds = (host) => ({
  hostname: host?.ip ? String(host.ip).trim() : '',
  port: 22,
  username: '',
  authMethod: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  acceptHostKeyChange: false,
});

export default function PingerSshSession({
  host,
  commonCommands = [],
  idleMinutes,
  onPhaseChange,
  onClose,
  initialCredentials,
}) {
  const wrapRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const disposedRef = useRef(false);
  const refreshRef = useRef(() => {});
  const authSnapshotRef = useRef(null);

  const [view, setView] = useState(initialCredentials ? 'terminal' : 'form');
  const [creds, setCreds] = useState(() => ({
    ...emptyCreds(host),
    ...(initialCredentials || {}),
  }));
  const [fingerprint, setFingerprint] = useState({ loading: false, fp: '', known: '', changed: false, error: '' });
  const [phase, setPhase] = useState('login');
  const [connected, setConnected] = useState(false);
  const [cmdsOpen, setCmdsOpen] = useState(commonCommands.length > 0);

  const label = host?.hostname != null ? String(host.hostname) : host?.ip || 'Host';

  const setPhaseBoth = useCallback(
    (p) => {
      setPhase(p);
      onPhaseChange?.(p, creds.username);
    },
    [onPhaseChange, creds.username],
  );

  const refreshTerminal = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const ws = wsRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      term.scrollToBottom();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));
      }
    } catch {
      /* ignore */
    }
  }, []);

  refreshRef.current = refreshTerminal;

  const loadFingerprint = useCallback(async (port) => {
    if (!host?._id) return;
    setFingerprint((f) => ({ ...f, loading: true, error: '' }));
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(
        `/api/pinger/ssh-fingerprint?hostId=${encodeURIComponent(host._id)}&port=${encodeURIComponent(port)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Fingerprint probe failed');
      setFingerprint({
        loading: false,
        fp: data.fingerprint || '',
        known: data.known || '',
        changed: !!data.changed,
        error: data.error || '',
      });
    } catch (e) {
      setFingerprint({ loading: false, fp: '', known: '', changed: false, error: e.message || 'Probe failed' });
    }
  }, [host?._id]);

  useEffect(() => {
    if (view === 'form') {
      loadFingerprint(creds.port);
    }
  }, [view, creds.port, loadFingerprint]);

  const startTerminal = useCallback(
    (authPayload) => {
      const wrap = wrapRef.current;
      if (!wrap || !host?._id) return undefined;

      const token = localStorage.getItem('token');
      if (!token) return undefined;

      disposedRef.current = false;
      setConnected(false);
      setPhaseBoth('connecting');

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "ui-monospace, 'Cascadia Code', 'Consolas', monospace",
        theme: {
          background: '#12191f',
          foreground: '#e7ecef',
          cursor: '#c8dfdb',
          selectionBackground: '#3368a0',
        },
      });
      const fit = new FitAddon();
      const webLinks = new WebLinksAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(webLinks);
      term.loadAddon(search);
      term.open(wrap);
      requestAnimationFrame(() => fit.fit());

      termRef.current = term;
      fitRef.current = fit;

      const ws = new WebSocket(wsUrl(token, host._id));
      wsRef.current = ws;

      const sub = term.onData((d) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'i', d }));
        }
      });
      const onResize = () => refreshRef.current();

      ws.onopen = () => {
        const a = authPayload || creds;
        ws.send(
          JSON.stringify({
            t: 'auth',
            hostId: host._id,
            hostname: a.hostname,
            port: Number(a.port) || 22,
            username: a.username,
            authMethod: a.authMethod,
            password: a.authMethod === 'password' ? a.password : undefined,
            privateKey: a.authMethod === 'privateKey' ? a.privateKey : undefined,
            passphrase: a.authMethod === 'privateKey' ? a.passphrase : undefined,
            acceptHostKeyChange: !!a.acceptHostKeyChange,
          }),
        );
        requestAnimationFrame(() => {
          refreshRef.current();
          term.focus();
        });
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.t === 'o' && msg.d != null) {
            term.write(String(msg.d));
          }
          if (msg.t === 'f') {
            requestAnimationFrame(() => refreshRef.current());
          }
          if (msg.t === 's' && msg.phase) {
            setPhaseBoth(msg.phase);
          }
          if (msg.t === 'hk') {
            if (msg.fingerprint) {
              setFingerprint({
                loading: false,
                fp: msg.fingerprint,
                known: msg.known ? 'yes' : '',
                changed: !!msg.changed,
                error: '',
              });
            }
          }
          if (msg.t === 'a' && msg.ok) {
            setConnected(true);
            setPhaseBoth('connected');
            requestAnimationFrame(() => refreshRef.current());
          }
          if (msg.t === 'x') {
            setConnected(false);
            setPhaseBoth('disconnected');
            const r = msg.reason ? String(msg.reason) : '';
            if (r) term.writeln(`\r\n\x1b[33m${r}\x1b[0m`);
            setView('form');
          }
        } catch {
          /* ignore */
        }
      };

      ws.onerror = () => {
        term.writeln('\r\n\x1b[31mWebSocket error.\x1b[0m');
        setPhaseBoth('disconnected');
      };

      ws.onclose = () => {
        if (disposedRef.current) return;
        setConnected(false);
        setPhaseBoth('disconnected');
        term.writeln('\r\n\x1b[33mConnection closed.\x1b[0m');
      };

      window.addEventListener('resize', onResize);

      return () => {
        disposedRef.current = true;
        window.removeEventListener('resize', onResize);
        try {
          sub.dispose();
        } catch {
          /* ignore */
        }
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
        try {
          term.dispose();
        } catch {
          /* ignore */
        }
        termRef.current = null;
        fitRef.current = null;
      };
    },
    [host?._id, creds, setPhaseBoth],
  );

  useEffect(() => {
    if (view !== 'terminal') return undefined;
    const auth = authSnapshotRef.current || creds;
    return startTerminal(auth);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connect once per terminal view
  }, [view]);

  useEffect(() => {
    if (connected || phase === 'connected') {
      requestAnimationFrame(() => refreshRef.current());
    }
  }, [cmdsOpen, connected, phase]);

  const handleConnect = (e) => {
    e.preventDefault();
    if (!creds.username.trim()) return;
    if (fingerprint.changed && !creds.acceptHostKeyChange) return;
    authSnapshotRef.current = { ...creds };
    setView('terminal');
  };

  const handleReconnect = () => {
    setView('form');
    setPhaseBoth('login');
    setConnected(false);
  };

  const pasteCmd = (cmd) => {
    if (!connected || !wsRef.current) return;
    let line = String(cmd ?? '');
    line = line.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    while (line.endsWith('\n')) line = line.slice(0, -1);
    if (line.length) {
      wsRef.current.send(JSON.stringify({ t: 'i', d: line }));
    }
    termRef.current?.focus();
  };

  if (view === 'form') {
    return (
      <div className="pinger-ssh-session pinger-ssh-session--form">
        <form className="pinger-ssh-cred-form" onSubmit={handleConnect}>
          <div className="pinger-ssh-cred-form__grid">
            <label className="pinger-ssh-cred-form__field">
              <span>Hostname</span>
              <input type="text" readOnly value={creds.hostname} className="pinger-ssh-cred-form__input" />
            </label>
            <label className="pinger-ssh-cred-form__field">
              <span>Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={creds.port}
                className="pinger-ssh-cred-form__input"
                onChange={(ev) => setCreds((c) => ({ ...c, port: Number(ev.target.value) || 22 }))}
              />
            </label>
            <label className="pinger-ssh-cred-form__field pinger-ssh-cred-form__field--full">
              <span>Username</span>
              <input
                type="text"
                autoComplete="username"
                value={creds.username}
                className="pinger-ssh-cred-form__input"
                onChange={(ev) => setCreds((c) => ({ ...c, username: ev.target.value }))}
              />
            </label>
          </div>

          <fieldset className="pinger-ssh-cred-form__auth">
            <legend>Authentication</legend>
            <label className="pinger-ssh-cred-form__radio">
              <input
                type="radio"
                name={`auth-${host._id}`}
                checked={creds.authMethod === 'password'}
                onChange={() => setCreds((c) => ({ ...c, authMethod: 'password' }))}
              />
              Password
            </label>
            <label className="pinger-ssh-cred-form__radio">
              <input
                type="radio"
                name={`auth-${host._id}`}
                checked={creds.authMethod === 'privateKey'}
                onChange={() => setCreds((c) => ({ ...c, authMethod: 'privateKey' }))}
              />
              Private key (PEM / OpenSSH)
            </label>
          </fieldset>

          {creds.authMethod === 'password' ? (
            <label className="pinger-ssh-cred-form__field pinger-ssh-cred-form__field--full">
              <span>Password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={creds.password}
                className="pinger-ssh-cred-form__input"
                onChange={(ev) => setCreds((c) => ({ ...c, password: ev.target.value }))}
              />
            </label>
          ) : (
            <>
              <label className="pinger-ssh-cred-form__field pinger-ssh-cred-form__field--full">
                <span>Private key</span>
                <textarea
                  rows={5}
                  value={creds.privateKey}
                  className="pinger-ssh-cred-form__textarea"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  onChange={(ev) => setCreds((c) => ({ ...c, privateKey: ev.target.value }))}
                />
              </label>
              <label className="pinger-ssh-cred-form__field pinger-ssh-cred-form__field--full">
                <span>Key passphrase (optional)</span>
                <input
                  type="password"
                  value={creds.passphrase}
                  className="pinger-ssh-cred-form__input"
                  onChange={(ev) => setCreds((c) => ({ ...c, passphrase: ev.target.value }))}
                />
              </label>
            </>
          )}

          <div className="pinger-ssh-cred-form__fp">
            <span className="pinger-ssh-cred-form__fp-label">Host key fingerprint</span>
            {fingerprint.loading ? (
              <p className="pinger-ssh-cred-form__fp-meta">Probing host…</p>
            ) : fingerprint.error ? (
              <p className="pinger-ssh-cred-form__fp-warn">{fingerprint.error}</p>
            ) : fingerprint.fp ? (
              <>
                <code className="pinger-ssh-cred-form__fp-code">{fingerprint.fp}</code>
                {fingerprint.changed ? (
                  <label className="pinger-ssh-cred-form__fp-changed">
                    <input
                      type="checkbox"
                      checked={creds.acceptHostKeyChange}
                      onChange={(ev) =>
                        setCreds((c) => ({ ...c, acceptHostKeyChange: ev.target.checked }))
                      }
                    />
                    Host key changed — I trust the new key
                  </label>
                ) : (
                  <p className="pinger-ssh-cred-form__fp-meta">
                    {fingerprint.known ? 'Known host (TOFU)' : 'First connection — fingerprint will be saved'}
                  </p>
                )}
              </>
            ) : (
              <p className="pinger-ssh-cred-form__fp-meta">Connect to load fingerprint</p>
            )}
          </div>

          <div className="pinger-ssh-cred-form__actions">
            <button type="submit" className="login-submit pinger-add-modal__submit" disabled={fingerprint.changed && !creds.acceptHostKeyChange}>
              Connect
            </button>
            <button type="button" className="pinger-ssh-modal__tool-btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="pinger-ssh-session pinger-ssh-session--term">
      <div className={`pinger-ssh-modal__workspace${cmdsOpen && commonCommands.length ? ' pinger-ssh-modal__workspace--cmds' : ''}`}>
        <div className="pinger-ssh-modal__term-host">
          <div ref={wrapRef} className="pinger-ssh-terminal-wrap pinger-ssh-terminal-wrap--v2" />
        </div>
        {cmdsOpen && commonCommands.length > 0 ? (
          <aside className="pinger-ssh-cmd-panel pinger-ssh-cmd-panel--v2" aria-label="Common commands">
            <div className="pinger-ssh-cmd-panel__head">Commands</div>
            <ul className="pinger-ssh-cmd-panel__list">
              {commonCommands.map((c, i) => {
                const key = `${c.label || ''}-${c.command || ''}-${i}`;
                return (
                  <li key={key}>
                    <button type="button" className="pinger-ssh-cmd-panel__btn" disabled={!connected} onMouseDown={(e) => e.preventDefault()} onClick={() => pasteCmd(c.command)}>
                      <span className="pinger-ssh-cmd-panel__btn-label">{c.label || c.command}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
        ) : null}
      </div>
      {phase === 'disconnected' && (
        <div className="pinger-ssh-session__reconnect">
          <button type="button" className="login-submit pinger-add-modal__submit" onClick={handleReconnect}>
            Reconnect
          </button>
        </div>
      )}
      <p className="pinger-ssh-session__meta">
        {label} · {creds.username || '—'} · idle {idleMinutes} min
        {commonCommands.length > 0 ? (
          <button type="button" className="pinger-ssh-session__cmds-toggle" onClick={() => setCmdsOpen((o) => !o)}>
            {cmdsOpen ? 'Hide commands' : 'Commands'}
          </button>
        ) : null}
      </p>
    </div>
  );
}
