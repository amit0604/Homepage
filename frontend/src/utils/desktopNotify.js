/**
 * Desktop notifications: per-browser settings, browser support checks, and showing a notification.
 * Settings live in this browser only, because permission to notify is per browser and computer.
 */

const PREFS_PREFIX = 'sc_notify_prefs:';
const LEADER_KEY = 'sc_notify_leader';
const LEADER_STALE_MS = 25000;
export const PREFS_EVENT = 'sc:notify-prefs';

export const DEFAULT_PREFS = {
  enabled: false,
  chat: true,
  tickets: true,
  announcements: true,
  pinger: true,
  whileActive: false,
};

export function loadPrefs(username) {
  try {
    const raw = localStorage.getItem(PREFS_PREFIX + String(username || '').toLowerCase());
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(username, prefs) {
  try {
    localStorage.setItem(PREFS_PREFIX + String(username || '').toLowerCase(), JSON.stringify(prefs));
  } catch {
    /* Still applies until the page reloads. */
  }
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: prefs }));
}

/**
 * What the browser allows right now:
 * unsupported, insecure (needs HTTPS or the setup script), denied, default (not asked yet) or granted.
 */
export function notifySupport() {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return window.isSecureContext === false ? 'insecure' : 'unsupported';
  }
  if (window.isSecureContext === false) return 'insecure';
  return Notification.permission;
}

export async function requestNotifyPermission() {
  if (!('Notification' in window)) return notifySupport();
  try {
    return await Notification.requestPermission();
  } catch {
    return notifySupport();
  }
}

/** True when the person is looking at this tab right now. */
export function appIsInUse() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** Shows a notification. The same tag replaces an older one, so repeats don't pile up. */
export function showDesktopNotification(title, { body = '', tag, onClick } = {}) {
  if (notifySupport() !== 'granted') return null;
  try {
    const note = new Notification(title, { body, tag, icon: 'iaf-logo.png', badge: 'logo192.png' });
    note.onclick = () => {
      window.focus();
      if (typeof onClick === 'function') onClick();
      note.close();
    };
    return note;
  } catch {
    return null;
  }
}

/**
 * Only one open tab shows notifications, so several tabs don't each show the same one.
 * The tab that last claimed the role keeps it until it stops checking in.
 */
export function claimNotifyLeader(tabId) {
  try {
    const now = Date.now();
    const raw = localStorage.getItem(LEADER_KEY);
    const current = raw ? JSON.parse(raw) : null;
    if (!current || current.id === tabId || now - current.at > LEADER_STALE_MS) {
      localStorage.setItem(LEADER_KEY, JSON.stringify({ id: tabId, at: now }));
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function releaseNotifyLeader(tabId) {
  try {
    const raw = localStorage.getItem(LEADER_KEY);
    if (raw && JSON.parse(raw).id === tabId) localStorage.removeItem(LEADER_KEY);
  } catch {
    /* Another tab takes over when this one goes stale. */
  }
}

/** How often to check, in milliseconds. Tests can shorten it with localStorage sc_notify_poll_ms. */
export function pollInterval(normalMs) {
  try {
    const n = Number(localStorage.getItem('sc_notify_poll_ms'));
    if (Number.isFinite(n) && n >= 1000) return n;
  } catch {
    /* Use the normal interval. */
  }
  return normalMs;
}
