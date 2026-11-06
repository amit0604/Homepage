const { collections } = require('../repositories/jsonStore');
const { normUser } = require('./chatCore');

const Presence = collections.chatPresence;

const ONLINE_MS = 120000;
const TYPING_STALE_MS = 8000;

/** Last-seen only needs to be roughly right, and every save rewrites a file, so save it now and then. */
const TOUCH_INTERVAL_MS = 15000;
const lastTouchedAt = new Map();

async function touchPresence(username) {
  const u = normUser(username);
  if (!u) return;
  const touchedAt = Date.now();
  if (touchedAt - (lastTouchedAt.get(u) || 0) < TOUCH_INTERVAL_MS) return;
  lastTouchedAt.set(u, touchedAt);
  const nowIso = new Date().toISOString();
  const row = await Presence.findOne((r) => normUser(r.username) === u);
  if (row) {
    await Presence.updateById(row._id, { lastSeenAt: nowIso });
  } else {
    await Presence.insert({ username: u, lastSeenAt: nowIso });
  }
}

async function setTypingState(username, conversationId, typing) {
  const u = normUser(username);
  if (!u) return;
  const cid = conversationId != null ? String(conversationId) : '';
  const nowIso = new Date().toISOString();
  const row = await Presence.findOne((r) => normUser(r.username) === u);
  if (typing && cid) {
    const patch = { lastSeenAt: nowIso, typingConversationId: cid, typingAt: nowIso };
    if (row) await Presence.updateById(row._id, patch);
    else await Presence.insert({ username: u, ...patch });
  } else {
    const patch = { lastSeenAt: nowIso, typingConversationId: null, typingAt: null };
    if (row) await Presence.updateById(row._id, patch);
    else await Presence.insert({ username: u, lastSeenAt: nowIso });
  }
}

function formatLastSeenLabel(iso, nowMs) {
  if (!iso) return 'unknown';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const delta = Math.max(0, nowMs - t);
  if (delta < 60_000) return 'just now';
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`;
  if (delta < 7 * 86400_000) return `${Math.floor(delta / 86400_000)}d ago`;
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  } catch {
    return 'earlier';
  }
}

/** @param {object|undefined} pr — presence row */
function peerOnlineFields(pr, nowMs) {
  const lastSeenAt = pr && pr.lastSeenAt ? String(pr.lastSeenAt) : null;
  let online = false;
  if (lastSeenAt) {
    const t = new Date(lastSeenAt).getTime();
    if (!Number.isNaN(t) && nowMs - t < ONLINE_MS) online = true;
  }
  return {
    online,
    lastSeenAt,
    lastSeenLabel: online ? 'online' : formatLastSeenLabel(lastSeenAt, nowMs),
  };
}

/**
 * Sidebar list: one presence summary per conversation (single DB read).
 * @returns {Map<string, object|null>} conversation id → payload or null
 */
async function listPresenceByConversationId(conversations, viewerUsername) {
  const allPresence = await Presence.all();
  const byUser = new Map();
  for (let i = 0; i < allPresence.length; i += 1) {
    const r = allPresence[i];
    byUser.set(normUser(r.username), r);
  }
  const nowMs = Date.now();
  const vNorm = normUser(viewerUsername);
  const out = new Map();
  for (let i = 0; i < conversations.length; i += 1) {
    const c = conversations[i];
    const id = String(c._id);
    const t = String(c.type);
    if (t === 'global') {
      out.set(id, null);
      continue;
    }
    if (t === 'dm') {
      const members = Array.isArray(c.memberUsernames) ? c.memberUsernames : [];
      const other = members.find((m) => normUser(m) !== vNorm);
      if (!other) {
        out.set(id, null);
        continue;
      }
      const pr = byUser.get(normUser(other));
      out.set(id, { kind: 'dm', ...peerOnlineFields(pr, nowMs) });
      continue;
    }
    if (t === 'group') {
      const members = Array.isArray(c.memberUsernames) ? c.memberUsernames : [];
      let othersCount = 0;
      let onlineCount = 0;
      for (let j = 0; j < members.length; j += 1) {
        const m = members[j];
        if (normUser(m) === vNorm) continue;
        othersCount += 1;
        const pr = byUser.get(normUser(m));
        if (peerOnlineFields(pr, nowMs).online) onlineCount += 1;
      }
      out.set(id, { kind: 'group', onlineCount, othersCount });
      continue;
    }
    out.set(id, null);
  }
  return out;
}

/**
 * @param {object} conv — conversation row
 * @param {string} viewerUsername
 * @param {Map<string,string>} displayMap
 */
async function buildPresenceBundle(conv, viewerUsername, displayMap) {
  const nowMs = Date.now();
  const vNorm = normUser(viewerUsername);
  const typing = [];
  const peers = [];

  const allPresence = await Presence.all();
  const byUser = new Map();
  for (let i = 0; i < allPresence.length; i += 1) {
    const r = allPresence[i];
    byUser.set(normUser(r.username), r);
  }

  if (String(conv.type) === 'global') {
    for (let i = 0; i < allPresence.length; i += 1) {
      const r = allPresence[i];
      const nu = normUser(r.username);
      if (!nu || nu === vNorm) continue;
      if (String(r.typingConversationId) !== String(conv._id) || !r.typingAt) continue;
      const tt = new Date(r.typingAt).getTime();
      if (Number.isNaN(tt) || nowMs - tt >= TYPING_STALE_MS) continue;
      const unRaw = r.username != null ? String(r.username) : nu;
      typing.push({
        username: unRaw,
        displayName: displayMap.get(nu) || unRaw,
      });
    }
    typing.sort((a, b) =>
      String(a.displayName || '').localeCompare(String(b.displayName || ''), undefined, {
        sensitivity: 'base',
      }),
    );
    return { typing, peers: [] };
  }

  const members = Array.isArray(conv.memberUsernames) ? conv.memberUsernames : [];
  for (let i = 0; i < members.length; i += 1) {
    const un = members[i];
    const nu = normUser(un);
    if (!nu || nu === vNorm) continue;
    const pr = byUser.get(nu);
    let isTyping = false;
    if (pr && String(pr.typingConversationId) === String(conv._id) && pr.typingAt) {
      const tt = new Date(pr.typingAt).getTime();
      if (!Number.isNaN(tt) && nowMs - tt < TYPING_STALE_MS) isTyping = true;
    }
    if (isTyping) {
      typing.push({
        username: un != null ? String(un) : nu,
        displayName: displayMap.get(nu) || un || nu,
      });
    }
    const { online, lastSeenAt, lastSeenLabel } = peerOnlineFields(pr, nowMs);
    peers.push({
      username: un != null ? String(un) : nu,
      displayName: displayMap.get(nu) || un || nu,
      online,
      lastSeenAt,
      lastSeenLabel,
    });
  }
  typing.sort((a, b) =>
    String(a.displayName || '').localeCompare(String(b.displayName || ''), undefined, {
      sensitivity: 'base',
    }),
  );
  peers.sort((a, b) =>
    String(a.displayName || '').localeCompare(String(b.displayName || ''), undefined, {
      sensitivity: 'base',
    }),
  );
  return { typing, peers };
}

/** Count distinct users with lastSeenAt within ONLINE_MS (lobby “online now”). */
async function countOnlineUsers() {
  const allPresence = await Presence.all();
  const nowMs = Date.now();
  let n = 0;
  for (let i = 0; i < allPresence.length; i += 1) {
    if (peerOnlineFields(allPresence[i], nowMs).online) n += 1;
  }
  return n;
}

/** Distinct usernames currently online (last seen within ONLINE_MS). */
async function listOnlineUsers() {
  const allPresence = await Presence.all();
  const nowMs = Date.now();
  const seen = new Set();
  const out = [];
  for (let i = 0; i < allPresence.length; i += 1) {
    const row = allPresence[i];
    if (!peerOnlineFields(row, nowMs).online) continue;
    const nu = normUser(row.username);
    if (!nu || seen.has(nu)) continue;
    seen.add(nu);
    out.push(row.username != null ? String(row.username) : nu);
  }
  out.sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
  return out;
}

module.exports = {
  touchPresence,
  setTypingState,
  buildPresenceBundle,
  listPresenceByConversationId,
  countOnlineUsers,
  listOnlineUsers,
  ONLINE_MS,
  TYPING_STALE_MS,
};
