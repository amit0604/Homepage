import { useEffect, useRef, useState } from 'react';
import {
  PREFS_EVENT,
  appIsInUse,
  claimNotifyLeader,
  loadPrefs,
  notifySupport,
  pollInterval,
  releaseNotifyLeader,
  showDesktopNotification,
} from '../utils/desktopNotify';

const norm = (u) => String(u || '').trim().toLowerCase().split('@')[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function getJson(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/**
 * Watches for new chat messages, ticket updates, announcements and Pinger state changes,
 * and shows a desktop notification for each. The first check only records what is already
 * there, so opening the app never floods you with old news.
 */
function DesktopNotifier({ user, chatEnabled, onOpen }) {
  const username = user?.username || '';
  const [prefs, setPrefs] = useState(() => loadPrefs(username));
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    // Only a real change restarts the checks. A restart takes a new snapshot, so an update
    // landing during it would never be reported.
    const onChange = () => {
      const next = loadPrefs(username);
      setPrefs((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    onChange();
    const onStorage = (ev) => { if (ev.key && ev.key.startsWith('sc_notify_prefs:')) onChange(); };
    window.addEventListener(PREFS_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PREFS_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [username]);

  useEffect(() => {
    if (!user || !prefs.enabled) return undefined;
    const tabId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const me = norm(user.username);
    const canPing = !!(user.isAdmin || user.pingerAccess);
    const seen = { chat: null, tickets: null, ticketCursor: null, news: null, hosts: null };
    const timers = [];
    let stopped = false;

    const ready = () => !stopped && notifySupport() === 'granted' && claimNotifyLeader(tabId);
    const notify = (title, options) => {
      if (!prefs.whileActive && appIsInUse()) return;
      showDesktopNotification(title, options);
    };

    const checkChat = async () => {
      const d = await getJson('/api/chat/conversations');
      const rows = Array.isArray(d.conversations) ? d.conversations : [];
      const now = new Map(rows.map((c) => [String(c.id), { unread: Number(c.unread) || 0, title: c.title || 'Chat' }]));
      if (seen.chat) {
        for (const [id, c] of now) {
          const before = seen.chat.get(id)?.unread || 0;
          if (c.unread > before) {
            notify(`New message in ${c.title}`, {
              body: `${plural(c.unread, 'unread message')}`,
              tag: `chat-${id}`,
              onClick: () => onOpenRef.current({ type: 'chat', id }),
            });
          }
        }
      }
      seen.chat = now;
    };

    const checkTickets = async () => {
      const q = seen.ticketCursor ? `?since=${encodeURIComponent(seen.ticketCursor)}` : '';
      const d = await getJson(`/api/tickets/changes${q}`);
      const rows = Array.isArray(d.tickets) ? d.tickets : [];
      if (!seen.tickets) {
        seen.tickets = new Map(rows.map((t) => [t.id, t]));
        seen.ticketCursor = d.now;
        return;
      }
      for (const t of rows) {
        const before = seen.tickets.get(t.id);
        const open = () => onOpenRef.current({ type: 'ticket', id: t.id, mine: norm(t.createdBy) === me });
        const tag = `ticket-${t.id}`;
        if (!before) {
          if (user.isAdmin && norm(t.createdBy) !== me) {
            notify('New support request', { body: `${t.title} — from ${t.createdBy}`, tag, onClick: open });
          } else if (norm(t.createdBy) === me && t.commentCount > 0 && norm(t.lastCommentBy) !== me) {
            notify('New reply on your request', { body: t.title, tag, onClick: open });
          } else if (norm(t.assignedTo) === me && norm(t.assignedBy) !== me) {
            notify('Request assigned to you', { body: t.title, tag, onClick: open });
          }
        } else {
          if (norm(t.assignedTo) === me && norm(before.assignedTo) !== me && norm(t.assignedBy) !== me) {
            notify('Request assigned to you', { body: t.title, tag, onClick: open });
          }
          if (norm(t.createdBy) === me) {
            if (t.status !== before.status && norm(t.closedBy) !== me) {
              notify('Your request was updated', { body: `${t.title} is now ${t.status}`, tag, onClick: open });
            } else if (t.commentCount > before.commentCount && norm(t.lastCommentBy) !== me) {
              notify('New reply on your request', { body: t.title, tag, onClick: open });
            }
          } else if (user.isAdmin && t.commentCount > before.commentCount && norm(t.lastCommentBy) === norm(t.createdBy)) {
            notify('Requester replied', { body: `${t.title} — ${t.createdBy}`, tag, onClick: open });
          }
        }
        seen.tickets.set(t.id, t);
      }
      seen.ticketCursor = d.now;
    };

    const checkNews = async () => {
      const list = await getJson('/api/notifications');
      const visible = (Array.isArray(list) ? list : []).filter((n) => n.isVisible);
      const ids = new Set(visible.map((n) => String(n._id)));
      if (seen.news) {
        for (const n of visible) {
          if (!seen.news.has(String(n._id))) {
            notify(n.title || 'New announcement', {
              body: n.description || '',
              tag: `news-${n._id}`,
              onClick: () => onOpenRef.current({ type: 'news' }),
            });
          }
        }
      }
      seen.news = ids;
    };

    const checkHosts = async () => {
      const d = await getJson('/api/pinger/status');
      const hosts = Array.isArray(d.hosts) ? d.hosts : [];
      const now = new Map(hosts.map((h) => [String(h._id), h]));
      if (seen.hosts) {
        for (const [id, h] of now) {
          const before = seen.hosts.get(id)?.state;
          const known = ['up', 'warn', 'down'];
          if (before && before !== h.state && known.includes(before) && known.includes(h.state)) {
            const name = h.hostname || h.ip || 'A host';
            let title = `${name} is up`;
            if (h.state === 'down') title = `${name} is down`;
            else if (h.state === 'warn') title = `${name} is responding slowly`;
            else if (before === 'down') title = `${name} is back up`;
            notify(title, {
              body: `${h.ip || ''}${h.type ? ` · ${h.type}` : ''}`,
              tag: `host-${id}`,
              onClick: () => onOpenRef.current({ type: 'pinger' }),
            });
          }
        }
      }
      seen.hosts = now;
    };

    const every = (fn, ms) => {
      const run = async () => {
        if (!ready()) return;
        try {
          await fn();
        } catch {
          /* Try again next time. */
        }
      };
      run();
      timers.push(setInterval(run, pollInterval(ms)));
    };

    if (prefs.chat && chatEnabled) every(checkChat, 20000);
    if (prefs.tickets) every(checkTickets, 30000);
    if (prefs.announcements) every(checkNews, 60000);
    if (prefs.pinger && canPing) every(checkHosts, 30000);

    return () => {
      stopped = true;
      timers.forEach(clearInterval);
      releaseNotifyLeader(tabId);
    };
  }, [user, prefs, chatEnabled]);

  return null;
}

export default DesktopNotifier;
