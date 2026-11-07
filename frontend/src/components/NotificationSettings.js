import React, { useEffect, useState } from 'react';
import {
  loadPrefs,
  notifySupport,
  requestNotifyPermission,
  savePrefs,
  showDesktopNotification,
} from '../utils/desktopNotify';

const STATUS = {
  granted: { tone: 'ok', text: 'This browser can show notifications.' },
  default: { tone: 'info', text: 'Turn notifications on and allow them when your browser asks.' },
  denied: { tone: 'bad', text: 'Your browser is blocking notifications from this site. Allow them in the site settings, next to the address bar.' },
  insecure: { tone: 'bad', text: 'Your browser blocks notifications on sites that aren\'t HTTPS. Run the setup script below, then restart your browser.' },
  unsupported: { tone: 'bad', text: 'This browser doesn\'t support desktop notifications. Use Chrome or Edge.' },
};

/** Builds a setup script with this site's address filled in, then saves it. */
async function downloadScript(file, type) {
  const r = await fetch(`notifications/${file}`);
  if (!r.ok) throw new Error('Could not load the script');
  let text = await r.text();
  const origin = /^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(window.location.origin) ? window.location.origin : '';
  text = text.replace(/__APP_URL__/g, origin);
  if (file.endsWith('.cmd')) text = text.replace(/\r?\n/g, '\r\n');
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Toggle({ id, checked, onChange, disabled, children }) {
  return (
    <label className={`admin-settings-toggle${disabled ? ' admin-settings-toggle--disabled' : ''}`} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="admin-settings-toggle__input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="admin-settings-toggle__track" aria-hidden="true">
        <span className="admin-settings-toggle__thumb" />
      </span>
      <span className="admin-settings-toggle__text">{children}</span>
    </label>
  );
}

/** The Notifications tab of the profile: on/off switches and how to set up this computer. */
function NotificationSettings({ user, chatEnabled }) {
  const [prefs, setPrefs] = useState(() => loadPrefs(user.username));
  const [support, setSupport] = useState(notifySupport);
  const [message, setMessage] = useState('');
  const canPing = !!(user.isAdmin || user.pingerAccess);

  useEffect(() => {
    const id = setInterval(() => setSupport(notifySupport()), 2000);
    return () => clearInterval(id);
  }, []);

  const update = (patch) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(user.username, next);
  };

  const toggleMain = async (on) => {
    setMessage('');
    if (!on) {
      update({ enabled: false });
      return;
    }
    const result = support === 'granted' ? 'granted' : await requestNotifyPermission();
    setSupport(notifySupport());
    if (result === 'granted') {
      update({ enabled: true });
      setMessage('Desktop notifications are on.');
    } else {
      update({ enabled: false });
      setMessage('Notifications are not allowed yet. Follow the steps below.');
    }
  };

  const test = () => {
    const note = showDesktopNotification('Test from PITUAH.iaf', { body: 'Desktop notifications are working.', tag: 'test' });
    setMessage(note ? 'Test sent. If nothing appeared, check step 3 below.' : 'Could not show a notification. Follow the steps below.');
  };

  const status = STATUS[support] || STATUS.unsupported;
  const blocked = support === 'insecure' || support === 'unsupported';

  return (
    <div className="notify-settings">
      <p className={`notify-settings__status notify-settings__status--${status.tone}`} role="status">
        {status.text}
      </p>

      <Toggle id="notify-enabled" checked={prefs.enabled && support === 'granted'} disabled={blocked} onChange={toggleMain}>
        <strong>Desktop notifications</strong>
        <span className="notify-settings__hint">On this computer and browser only</span>
      </Toggle>

      <fieldset className="notify-settings__kinds" disabled={!prefs.enabled || support !== 'granted'}>
        <legend>Notify me about</legend>
        {chatEnabled ? (
          <Toggle id="notify-chat" checked={prefs.chat} onChange={(v) => update({ chat: v })}>New chat messages</Toggle>
        ) : null}
        <Toggle id="notify-tickets" checked={prefs.tickets} onChange={(v) => update({ tickets: v })}>
          {user.isAdmin ? 'Support requests: new, assigned to me, and replies' : 'Replies and status changes on my requests'}
        </Toggle>
        <Toggle id="notify-news" checked={prefs.announcements} onChange={(v) => update({ announcements: v })}>New announcements</Toggle>
        {canPing ? (
          <Toggle id="notify-pinger" checked={prefs.pinger} onChange={(v) => update({ pinger: v })}>Pinger hosts going down, slow or back up</Toggle>
        ) : null}
        <Toggle id="notify-active" checked={prefs.whileActive} onChange={(v) => update({ whileActive: v })}>
          Also notify me while I&apos;m using this page
        </Toggle>
      </fieldset>

      <div className="notify-settings__actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={test} disabled={support !== 'granted'}>
          Send a test notification
        </button>
        {message ? <span className="notify-settings__message">{message}</span> : null}
      </div>

      <section className="notify-settings__guide" aria-labelledby="notify-guide-title">
        <h3 id="notify-guide-title">How to set up desktop notifications</h3>
        <ol>
          <li>
            Use <strong>Chrome</strong> or <strong>Edge</strong>. Turn on <em>Desktop notifications</em> above and choose{' '}
            <strong>Allow</strong> when the browser asks.
          </li>
          <li>
            If this site&apos;s address starts with <code>http://</code>, the browser blocks notifications until this computer
            is set up once. Download the script for your computer, run it, then close and reopen the browser:
            <div className="notify-settings__downloads">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadScript('pituah-notifications-setup.cmd', 'application/octet-stream').catch((e) => setMessage(e.message))}>
                Windows script (.cmd)
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadScript('pituah-notifications-setup.sh', 'text/x-sh').catch((e) => setMessage(e.message))}>
                Linux script (.sh)
              </button>
            </div>
            <span className="notify-settings__hint">
              On Windows, double-click the file. Run it as administrator to set up everyone on the computer. On Linux, run it
              with <code>sudo bash</code>. Your IT team can also set this for all computers with Group Policy.
            </span>
          </li>
          <li>
            Make sure your computer lets the browser show notifications. On Windows, open <strong>Settings → System →
            Notifications</strong>, turn on notifications for Chrome or Edge, and turn off <strong>Do not disturb</strong>.
          </li>
          <li>Keep at least one tab of this site open. Notifications stop when every tab is closed.</li>
        </ol>
      </section>
    </div>
  );
}

export default NotificationSettings;
