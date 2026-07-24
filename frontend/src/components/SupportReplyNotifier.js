import React, { useCallback, useEffect, useRef, useState } from 'react';
import { jwtDecode } from 'jwt-decode';

const POLL_MS = 45000;

function normUser(u) {
  if (u == null) return '';
  const s = String(u).trim().toLowerCase();
  const i = s.indexOf('@');
  return i >= 0 ? s.slice(0, i) : s;
}

function getLatestSupportComment(ticket) {
  const owner = normUser(ticket.createdBy);
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  let best = null;
  for (let i = 0; i < comments.length; i += 1) {
    const c = comments[i];
    if (normUser(c.commentedBy) === owner) continue;
    const d = c.commentDate;
    if (!d) continue;
    if (!best || d > best.commentDate) {
      best = { ...c, commentDate: d };
    }
  }
  return best;
}

function loadSeen(username) {
  try {
    const raw = localStorage.getItem(`supportReplySeen:${username}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSeen(username, map) {
  localStorage.setItem(`supportReplySeen:${username}`, JSON.stringify(map));
}

/** Drop seen keys for tickets no longer returned by the API (e.g. deleted), so localStorage stays bounded. */
function pruneSeenToTickets(seen, tickets) {
  const allowed = new Set();
  for (let i = 0; i < tickets.length; i += 1) {
    const id = tickets[i]?._id;
    if (id != null) allowed.add(String(id));
  }
  const out = {};
  for (const k of Object.keys(seen)) {
    if (allowed.has(String(k))) out[k] = seen[k];
  }
  return out;
}

function bootstrapSeen(username, tickets) {
  const seen = pruneSeenToTickets(loadSeen(username), tickets);
  const next = { ...seen };
  for (let i = 0; i < tickets.length; i += 1) {
    const t = tickets[i];
    if (!t || !t._id) continue;
    const latest = getLatestSupportComment(t);
    if (latest) next[t._id] = latest.commentDate;
  }
  saveSeen(username, next);
  localStorage.setItem(`supportReplyBoot:${username}`, '1');
}

function findNewReplyItems(username, tickets) {
  let seen = loadSeen(username);
  const pruned = pruneSeenToTickets(seen, tickets);
  if (Object.keys(pruned).length !== Object.keys(seen).length) {
    seen = pruned;
    saveSeen(username, seen);
  }
  const items = [];
  for (let i = 0; i < tickets.length; i += 1) {
    const t = tickets[i];
    if (!t || !t._id) continue;
    const latest = getLatestSupportComment(t);
    if (!latest) continue;
    const prev = seen[t._id];
    if (!prev || latest.commentDate > prev) {
      const preview = String(latest.commentText || '').trim();
      items.push({
        ticketId: t._id,
        title: t.title || 'Request',
        commentDate: latest.commentDate,
        preview: preview.length > 160 ? `${preview.slice(0, 157)}…` : preview,
      });
    }
  }
  return items;
}

/**
 * Polls the user's tickets and shows a modal when support (non-owner) adds a comment.
 */
function SupportReplyNotifier({ onOpenRequests }) {
  const [payload, setPayload] = useState(null);
  const shownRef = useRef(false);
  const usernameRef = useRef(null);

  const runCheck = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;

    let decoded;
    try {
      decoded = jwtDecode(token);
    } catch {
      return;
    }

    if (!decoded?.username) return;
    if (decoded.isAdmin) return;

    const username = decoded.username;
    usernameRef.current = username;

    try {
      const response = await fetch(`/api/tickets/requests/${encodeURIComponent(username)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return;
      const tickets = await response.json();
      if (!Array.isArray(tickets)) return;

      const booted = localStorage.getItem(`supportReplyBoot:${username}`);
      if (!booted) {
        bootstrapSeen(username, tickets);
        return;
      }

      const items = findNewReplyItems(username, tickets);
      if (items.length === 0) return;

      if (shownRef.current) return;
      shownRef.current = true;
      setPayload(items);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    runCheck();
    const id = setInterval(runCheck, POLL_MS);
    return () => clearInterval(id);
  }, [runCheck]);

  const handleDismiss = () => {
    const u = usernameRef.current;
    if (u && payload && payload.length) {
      const seen = loadSeen(u);
      const next = { ...seen };
      for (let i = 0; i < payload.length; i += 1) {
        next[payload[i].ticketId] = payload[i].commentDate;
      }
      saveSeen(u, next);
    }
    shownRef.current = false;
    setPayload(null);
  };

  const handleViewRequests = () => {
    handleDismiss();
    if (onOpenRequests) onOpenRequests();
  };

  if (!payload || payload.length === 0) return null;

  return (
    <div
      className="support-reply-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="support-reply-modal-title"
    >
      <div className="support-reply-modal">
        <h2 id="support-reply-modal-title" className="support-reply-modal-title">
          {payload.length === 1
            ? 'New reply on your request'
            : `New replies on ${payload.length} requests`}
        </h2>
        <ul className="support-reply-modal-list">
          {payload.map((item) => (
            <li key={item.ticketId} className="support-reply-modal-item">
              <div className="support-reply-modal-item-title">{item.title}</div>
              {item.preview ? (
                <div className="support-reply-modal-preview">{item.preview}</div>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="support-reply-modal-actions">
          <button type="button" className="support-reply-btn secondary" onClick={handleDismiss}>
            Dismiss
          </button>
          <button type="button" className="support-reply-btn primary" onClick={handleViewRequests}>
            View my requests
          </button>
        </div>
      </div>
    </div>
  );
}

export default SupportReplyNotifier;
