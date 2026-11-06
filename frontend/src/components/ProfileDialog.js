import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

function formatDate(seconds) {
  if (!seconds) return null;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

/** Read-only account details. Nothing here can be edited by the user. */
function ProfileDialog({ user, onClose, onLogout }) {
  const [profile, setProfile] = useState(null);
  const closeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem('token');
    fetch('/api/profile', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setProfile(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (ev) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const p = profile || {};
  const displayName = p.displayName || user.displayName || user.username;
  const groups = Array.isArray(p.groups) ? p.groups.filter(Boolean) : [];
  const rows = [
    ['Username', p.username || user.username],
    ['Email', p.email],
    ['Role', (p.isAdmin ?? user.isAdmin) ? 'Administrator' : 'User'],
    ['Pinger access', (p.pingerAccess ?? user.pingerAccess) ? 'Yes' : 'No'],
    ['Sign-in method', p.signInMethod],
    ['Signed in', formatDate(user.iat)],
    ['Session expires', user.exp ? formatDate(user.exp) : 'When you log out'],
  ].filter(([, value]) => value);

  return createPortal(
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal-content profile"
        onClick={(ev) => ev.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
      >
        <header className="profile__head">
          <span className="profile__avatar" aria-hidden="true">
            {String(displayName || '?').trim().charAt(0).toUpperCase()}
          </span>
          <div className="profile__names">
            <h2 id="profile-title" className="profile__name">{displayName}</h2>
            <p className="profile__hint">Your profile is read-only.</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="close-button"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </header>

        <dl className="profile__list">
          {rows.map(([label, value]) => (
            <div key={label} className="profile__row">
              <dt>{label}</dt>
              <dd dir="auto">{value}</dd>
            </div>
          ))}
          {groups.length > 0 ? (
            <div className="profile__row">
              <dt>Groups</dt>
              <dd className="profile__groups">
                {groups.map((g) => (
                  <span key={g} className="profile__group" dir="auto">{g}</span>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="button-container">
          <button type="button" className="btn btn-secondary" onClick={onLogout}>
            Log out
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default ProfileDialog;
