import React, { useEffect, useState } from 'react';
import {
  deviceId,
  listDevices,
  loadPrefs,
  registerDevice,
  removeDevice,
  notifySupport,
  requestNotifyPermission,
  savePrefs,
  SECTION_MUTE_CHOICES,
  sectionMuted,
  showDesktopNotification,
} from '../utils/desktopNotify';

const STATUS = {
  granted: { tone: 'ok', text: 'This browser can show notifications.' },
  default: { tone: 'info', text: 'Turn notifications on and allow them when your browser asks.' },
  denied: { tone: 'bad', text: 'Your browser is blocking notifications from this site. Allow them in the site settings, next to the address bar.' },
  insecure: { tone: 'bad', text: 'Your browser blocks notifications on sites that aren\'t HTTPS. Run the setup script below, then restart your browser.' },
  unsupported: { tone: 'bad', text: 'This browser doesn\'t support desktop notifications. Use Chrome, Edge or Firefox.' },
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

/** Mute a section for a while, or show when its mute ends with a way to unmute. */
function SectionMute({ prefs, section, onChange }) {
  const muted = sectionMuted(prefs, section);
  if (muted) {
    const until = prefs.mutedUntil[section];
    const label = until === -1 ? 'Muted' : `Muted until ${new Date(until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
    return (
      <span className="notify-mute">
        <span className="notify-mute__label">🔕 {label}</span>
        <button type="button" className="notify-mute__link" onClick={() => onChange(section, null)}>Unmute</button>
      </span>
    );
  }
  return (
    <select
      className="notify-mute__select"
      aria-label={`Mute ${section} notifications`}
      value=""
      onChange={(e) => onChange(section, Number(e.target.value))}
    >
      <option value="" disabled>Mute…</option>
      {SECTION_MUTE_CHOICES.map(([ms, label]) => (
        <option key={ms} value={ms}>{label}</option>
      ))}
    </select>
  );
}

/** The Notifications tab of the profile: on/off switches and how to set up this computer. */
function NotificationSettings({ user, chatEnabled }) {
  const [prefs, setPrefs] = useState(() => loadPrefs(user.username));
  const [support, setSupport] = useState(notifySupport);
  const [message, setMessage] = useState('');
  const canPing = !!(user.isAdmin || user.pingerAccess);
  const [devices, setDevices] = useState([]);
  const [maxDevices, setMaxDevices] = useState(5);
  const thisDevice = deviceId();

  const loadDevices = async () => {
    const { status, data } = await listDevices().catch(() => ({ status: 0, data: {} }));
    if (status === 200) {
      setDevices(data.devices || []);
      if (data.max) setMaxDevices(data.max);
    }
  };

  useEffect(() => {
    loadDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disconnect = async (id) => {
    await removeDevice(id).catch(() => {});
    if (id === thisDevice) update({ enabled: false });
    setMessage(id === thisDevice ? 'This computer is disconnected.' : 'Computer disconnected. It stops getting notifications within a minute.');
    loadDevices();
  };

  useEffect(() => {
    const id = setInterval(() => setSupport(notifySupport()), 2000);
    return () => clearInterval(id);
  }, []);

  const update = (patch) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(user.username, next);
  };

  const muteSection = (section, ms) => {
    const next = { ...(prefs.mutedUntil || {}) };
    if (ms == null) delete next[section];
    else next[section] = ms === -1 ? -1 : Date.now() + ms;
    update({ mutedUntil: next });
  };

  const toggleMain = async (on) => {
    setMessage('');
    if (!on) {
      update({ enabled: false });
      await removeDevice(thisDevice).catch(() => {});
      loadDevices();
      return;
    }
    const result = support === 'granted' ? 'granted' : await requestNotifyPermission();
    setSupport(notifySupport());
    if (result === 'granted') {
      const reg = await registerDevice().catch(() => ({ status: 0, data: {} }));
      if (reg.status === 200 || reg.status === 201) {
        update({ enabled: true });
        setMessage('Desktop notifications are on.');
      } else {
        update({ enabled: false });
        setMessage(reg.data.error || 'Could not connect this computer. Try again.');
      }
      loadDevices();
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
          <div className="notify-kind"><Toggle id="notify-chat" checked={prefs.chat} onChange={(v) => update({ chat: v })}>New chat messages</Toggle><SectionMute prefs={prefs} section="chat" onChange={muteSection} /></div>
        ) : null}
        <div className="notify-kind">
        <Toggle id="notify-tickets" checked={prefs.tickets} onChange={(v) => update({ tickets: v })}>
          {user.isAdmin ? 'Support requests: new, assigned to me, and replies' : 'Replies and status changes on my requests'}
        </Toggle>
        <SectionMute prefs={prefs} section="tickets" onChange={muteSection} />
        </div>
        <div className="notify-kind"><Toggle id="notify-news" checked={prefs.announcements} onChange={(v) => update({ announcements: v })}>New announcements</Toggle><SectionMute prefs={prefs} section="announcements" onChange={muteSection} /></div>
        {canPing ? (
          <div className="notify-kind"><Toggle id="notify-pinger" checked={prefs.pinger} onChange={(v) => update({ pinger: v })}>Pinger hosts going down, slow or back up</Toggle><SectionMute prefs={prefs} section="pinger" onChange={muteSection} /></div>
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

      <section className="notify-devices" aria-labelledby="notify-devices-title">
        <h3 id="notify-devices-title">
          Connected computers <span className="notify-devices__count">{devices.length} of {maxDevices}</span>
        </h3>
        {devices.length === 0 ? (
          <p className="notify-settings__hint">No computers get your notifications yet.</p>
        ) : (
          <ul className="notify-devices__list">
            {devices.map((d) => (
              <li key={d.id} className="notify-devices__row">
                <div className="notify-devices__info">
                  <span className="notify-devices__name">
                    {d.name}
                    {d.id === thisDevice ? <span className="notify-devices__this">This computer</span> : null}
                  </span>
                  <span className="notify-settings__hint">
                    {d.address ? `${d.address} · ` : ''}last active {new Date(d.lastSeenAt).toLocaleString()}
                  </span>
                </div>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => disconnect(d.id)}>
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="notify-settings__hint">
          You can get notifications on up to {maxDevices} computers. Disconnect one you no longer use to add another.
        </p>
      </section>

      <section className="notify-settings__guide" aria-labelledby="notify-guide-title">
        <h3 id="notify-guide-title">How to set up desktop notifications</h3>
        <ol>
          <li>
            Use <strong>Chrome</strong>, <strong>Edge</strong> or <strong>Firefox</strong>. Turn on <em>Desktop notifications</em> above and choose{' '}
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
              On Windows, double-click the file. Run it as administrator to set up everyone on the computer. On Linux,
              including Debian and Ubuntu, run it with <code>sudo bash</code>, or with <code>su -c</code> where sudo
              isn&apos;t installed. The scripts set up Chrome, Edge, Chromium and Firefox. Your IT team can also set this
              for all computers with Group Policy.
            </span>
          </li>
          <li>
            Make sure your computer lets the browser show notifications. On Windows, open <strong>Settings → System →
            Notifications</strong>, turn on notifications for your browser, and turn off <strong>Do not disturb</strong>.
          </li>
          <li>Keep at least one tab of this site open. Notifications stop when every tab is closed.</li>
        </ol>
      </section>
    </div>
  );
}

export default NotificationSettings;
