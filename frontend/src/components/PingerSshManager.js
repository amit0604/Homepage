import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import PingerSshSession from './PingerSshSession';
import { sshCommonCommandsForHost } from './pingerSshUtils';

function sessionLabel(host, username, phase) {
  const name = host?.hostname != null ? String(host.hostname) : host?.ip || 'Host';
  const u = username ? ` · ${username}` : '';
  return `${name}${u}`;
}

export default function PingerSshManager({
  sessions,
  activeId,
  onSelectTab,
  onSessionMeta,
  onCloseSession,
  idleMinutes,
  commonCommandsCatalog,
}) {
  const active = sessions.find((s) => s.id === activeId) || sessions[0];

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (!sessions.length) return null;

  const modal = (
    <div className="pinger-ssh-overlay" role="presentation">
      <div
        className="modal-content pinger-ssh-modal pinger-ssh-modal--v2"
        dir="ltr"
        lang="en"
        role="dialog"
        aria-modal="true"
        onClick={(ev) => ev.stopPropagation()}
      >
        <header className="pinger-ssh-modal__toolbar">
          <div className="pinger-ssh-modal__tabs" role="tablist">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={s.id === activeId}
                className={`pinger-ssh-tab${s.id === activeId ? ' pinger-ssh-tab--active' : ''}`}
                onClick={() => onSelectTab(s.id)}
              >
                <span
                  className={`pinger-ssh-tab__dot pinger-ssh-tab__dot--${s.phase || 'login'}`}
                  aria-hidden
                />
                <span className="pinger-ssh-tab__label">{sessionLabel(s.host, s.username, s.phase)}</span>
                <span
                  className="pinger-ssh-tab__close"
                  role="button"
                  tabIndex={0}
                  aria-label="Close tab"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onCloseSession(s.id);
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      ev.stopPropagation();
                      onCloseSession(s.id);
                    }
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="pinger-ssh-modal__tool-btn pinger-ssh-modal__tool-btn--close"
            onClick={() => onCloseSession(activeId)}
            aria-label="Close SSH panel"
          >
            ×
          </button>
        </header>

        <div className="pinger-ssh-manager__body">
          {active ? (
            <PingerSshSession
              key={active.id}
              host={active.host}
              commonCommands={sshCommonCommandsForHost(active.host, commonCommandsCatalog)}
              idleMinutes={idleMinutes}
              initialCredentials={active.reconnectCreds}
              onPhaseChange={(phase, username) => onSessionMeta(active.id, phase, username)}
              onClose={() => onCloseSession(active.id)}
            />
          ) : null}
        </div>

        <footer className="pinger-ssh-modal__footer">
          SSH sessions run over WSS · credentials are not stored · idle {idleMinutes} min
        </footer>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
