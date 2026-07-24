const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');
const { collections } = require('../repositories/jsonStore');
const { UPLOADS_DIR } = require('../repositories/jsonStore');
const { getSettings } = require('./settingsRouter');
const { isLobbyChatUiEnabledByDeploy } = require('../utils/lobbyChatUi');
const { stripConfiguredEmailSuffix, placeholderEmailForUsername } = require('../utils/userEmailDomain');
const { logFailure } = require('../utils/failureLog');
const {
  touchPresence,
  setTypingState,
  buildPresenceBundle,
  listPresenceByConversationId,
  countOnlineUsers,
  listOnlineUsers,
} = require('../utils/chatPresence');
const ldapSingleton = require('../services/ldapSingleton');
const {
  GLOBAL_ID,
  ensureChatSchema,
  pruneOldMessages,
  normUser,
  dmConvId,
  byCreatedAt,
  userInConversation,
  conversationLabel,
  viewerIsGroupChatAdmin,
  getHiddenConversationIdsForUser,
  hideConversationForUser,
  unhideConversationForUser,
  getLastRead,
  setLastRead,
  countUnreadForUser,
} = require('../utils/chatCore');

const router = express.Router();
const Conv = collections.chatConversations;
const Msg = collections.chatMessages;
const Reads = collections.chatReads;
const User = collections.users;
const Hidden = collections.chatHiddenConversations;

let ldapChatSvc;
function getLdapForChat() {
  if (!process.env.LDAP_URL || !process.env.LDAP_SEARCH_BASE) return null;
  if (!ldapChatSvc) {
    ldapChatSvc = require('../services/ldapSingleton');
  }
  return ldapChatSvc;
}

function escapeLdapFilterValue(str) {
  return String(str)
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

let userDisplayMapCache = { at: 0, map: null };
const USER_DISPLAY_MAP_MS = 60000;

async function getUserDisplayMap() {
  const now = Date.now();
  if (userDisplayMapCache.map && now - userDisplayMapCache.at < USER_DISPLAY_MAP_MS) {
    return userDisplayMapCache.map;
  }
  const all = await User.all();
  const m = new Map();
  for (let i = 0; i < all.length; i += 1) {
    const u = all[i];
    const un = u.username != null ? String(u.username) : '';
    if (!un) continue;
    const disp = u.displayName != null && String(u.displayName).trim()
      ? String(u.displayName).trim()
      : un;
    m.set(normUser(un), disp);
  }
  userDisplayMapCache = { at: now, map: m };
  return m;
}

/** DM peer logins (raw memberUsernames values) for conversations visible to viewer. */
function collectDmPeerLogins(conversations, viewer) {
  const v = normUser(viewer);
  const out = [];
  for (let i = 0; i < conversations.length; i += 1) {
    const c = conversations[i];
    if (String(c.type) !== 'dm') continue;
    const members = Array.isArray(c.memberUsernames) ? c.memberUsernames : [];
    const other = members.find((m) => normUser(m) !== v);
    if (other) out.push(String(other).trim());
  }
  return out;
}

/**
 * Copy of app display map + LDAP displayName for DM peers not present locally (so sidebar shows names, not only sAMAccountName).
 */
async function displayMapWithDmPeers(conversations, viewer) {
  const base = await getUserDisplayMap();
  const map = new Map(base);
  const peers = collectDmPeerLogins(conversations, viewer);
  const ad = getLdapForChat();
  if (!ad || peers.length === 0) return map;
  const done = new Set();
  for (let i = 0; i < peers.length; i += 1) {
    const raw = stripConfiguredEmailSuffix(String(peers[i] || '').trim());
    if (!raw) continue;
    const nu = normUser(raw);
    if (done.has(nu)) continue;
    done.add(nu);
    if (map.has(nu)) continue;
    try {
      const u = await ad.findUserByName(raw);
      if (u && (u.displayName || u.cn)) {
        const d = String(u.displayName || u.cn).trim();
        if (d) map.set(nu, d);
      }
    } catch {
      /* ignore per user */
    }
  }
  return map;
}

function attachReactionMembers(msg, displayMap) {
  const reactions = msg.reactions && typeof msg.reactions === 'object' ? msg.reactions : {};
  const reactionMembers = {};
  const keys = Object.keys(reactions);
  for (let i = 0; i < keys.length; i += 1) {
    const emoji = keys[i];
    const arr = reactions[emoji];
    if (!Array.isArray(arr)) continue;
    reactionMembers[emoji] = arr.map((uname) => {
      const nu = normUser(uname);
      return {
        username: uname,
        displayName: displayMap.get(nu) || uname,
      };
    });
  }
  return { ...msg, reactionMembers };
}

/** Users (other than author) whose conversation read cursor is at or after this message. */
function readersWhoSawMessage(msg, readsRows, displayMap) {
  const tMsg = new Date(msg.createdAt || 0).getTime();
  if (Number.isNaN(tMsg)) return [];
  const author = normUser(msg.fromUsername);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < readsRows.length; i += 1) {
    const row = readsRows[i];
    if (!row || !row.lastReadAt) continue;
    const nu = normUser(row.username);
    if (!nu || nu === author) continue;
    const tRead = new Date(row.lastReadAt).getTime();
    if (Number.isNaN(tRead) || tRead < tMsg) continue;
    if (seen.has(nu)) continue;
    seen.add(nu);
    const unRaw = row.username != null ? String(row.username) : '';
    out.push({
      username: unRaw || nu,
      displayName: displayMap.get(nu) || unRaw || nu,
    });
  }
  out.sort((a, b) =>
    String(a.displayName || '').localeCompare(String(b.displayName || ''), undefined, { sensitivity: 'base' }),
  );
  return out;
}

async function enrichMessages(msgs, opts = {}) {
  const displayMap = await getUserDisplayMap();
  const viewer = opts.viewer ? String(opts.viewer) : '';
  const readsRows = opts.readsRows;
  const vNorm = viewer ? normUser(viewer) : '';
  return msgs.map((row) => {
    const withR = attachReactionMembers(row, displayMap);
    if (readsRows && vNorm && normUser(withR.fromUsername) === vNorm) {
      return { ...withR, readBy: readersWhoSawMessage(withR, readsRows, displayMap) };
    }
    return withR;
  });
}

async function enrichOneMessage(msg, viewerUsername) {
  const displayMap = await getUserDisplayMap();
  const withR = attachReactionMembers(msg, displayMap);
  const v = viewerUsername != null ? normUser(String(viewerUsername)) : '';
  if (!v || normUser(withR.fromUsername) !== v) return withR;
  const cid = withR.conversationId != null ? String(withR.conversationId) : '';
  if (!cid) return withR;
  const rows = await Reads.find((r) => String(r.conversationId) === cid);
  return { ...withR, readBy: readersWhoSawMessage(withR, rows, displayMap) };
}

const MAX_TEXT = 16000;
const MAX_MSG_FETCH = 400;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const CHAT_EXT = /\.(txt|json|md|markdown|csv|log|xml|ya?ml|tsv)$/i;

function chatMimeOk(mime, originalname) {
  const m = String(mime || '').toLowerCase();
  if (
    m.startsWith('text/')
    || m === 'application/json'
    || m === 'application/xml'
    || m === 'application/csv'
    || m === 'application/x-yaml'
    || m === 'application/yaml'
  ) {
    return true;
  }
  if (m === 'application/octet-stream' && CHAT_EXT.test(String(originalname || ''))) return true;
  return CHAT_EXT.test(String(originalname || ''));
}

async function chatUploadsDir() {
  const dir = path.join(UPLOADS_DIR, 'chat');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const chatStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const dir = await chatUploadsDir();
      cb(null, dir);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname || '').slice(0, 16).toLowerCase();
    const safe = /^\.[a-z0-9._-]{1,12}$/i.test(ext) ? ext : '';
    cb(null, `${id}${safe}`);
  },
});

const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
  fileFilter: (req, file, cb) => {
    if (chatMimeOk(file.mimetype, file.originalname)) cb(null, true);
    else cb(new Error('Allowed: txt, json, md, csv, xml, yaml, log (max 10 MB).'));
  },
});

async function chatEnabled() {
  if (!isLobbyChatUiEnabledByDeploy()) return false;
  const s = await getSettings();
  return s.lobbyChatEnabled !== false;
}

async function listConversationsForUser(username) {
  await ensureChatSchema();
  await pruneOldMessages();
  const hidden = await getHiddenConversationIdsForUser(username);
  const allConv = await Conv.all();
  const byId = new Map(allConv.map((c) => [String(c._id), c]));
  const u = normUser(username);
  const mine = allConv.filter(
    (c) => userInConversation(username, c) && !hidden.has(String(c._id)),
  );
  const mineSet = new Set(mine.map((c) => String(c._id)));

  const allMsg = await Msg.all();
  const lastBy = new Map();
  for (let i = 0; i < allMsg.length; i += 1) {
    const m = allMsg[i];
    const cid = String(m.conversationId);
    const t = new Date(m.createdAt || 0).getTime();
    if (Number.isNaN(t)) continue;
    const prev = lastBy.get(cid) || 0;
    if (t > prev) lastBy.set(cid, t);
  }

  /* DM threads that have messages but no conversation row (or user not yet in list): heal + show in sidebar */
  const dmCidsToHeal = new Set();
  for (let i = 0; i < allMsg.length; i += 1) {
    const cid = String(allMsg[i].conversationId);
    if (!cid.startsWith('dm:')) continue;
    const inner = cid.slice(3);
    const parts = inner.split('::');
    if (parts.length !== 2) continue;
    const a = normUser(parts[0]);
    const b = normUser(parts[1]);
    if (a !== u && b !== u) continue;
    dmCidsToHeal.add(cid);
  }
  for (const cid of dmCidsToHeal) {
    if (mineSet.has(cid) || hidden.has(cid)) continue;
    let conv = byId.get(cid);
    if (!conv) {
      conv = await Conv.findById(cid);
      if (conv) byId.set(cid, conv);
    }
    if (!conv) {
      const inner = cid.slice(3);
      const parts = inner.split('::');
      const a = normUser(parts[0]);
      const b = normUser(parts[1]);
      conv = await Conv.insert({
        _id: cid,
        type: 'dm',
        memberUsernames: [a, b],
        title: null,
      });
      byId.set(cid, conv);
    }
    if (!userInConversation(username, conv)) continue;
    mine.push(conv);
    mineSet.add(cid);
  }

  mine.sort((a, b) => (lastBy.get(String(b._id)) || 0) - (lastBy.get(String(a._id)) || 0));
  return { list: mine, lastBy };
}

function serializeConv(c, viewer, unread, jwtIsAppAdmin, displayMap) {
  let title = conversationLabel(c, viewer);
  if (String(c.type) === 'dm' && displayMap && displayMap instanceof Map) {
    const members = Array.isArray(c.memberUsernames) ? c.memberUsernames : [];
    const other = members.find((m) => normUser(m) !== normUser(viewer));
    if (other) {
      const nu = normUser(other);
      const resolved = displayMap.get(nu);
      title = resolved || other;
    }
  }
  const base = {
    id: c._id,
    type: c.type,
    title,
    memberUsernames: c.memberUsernames || [],
    unread: typeof unread === 'number' ? unread : 0,
  };
  if (String(c.type) === 'group') {
    base.isChatAdmin = viewerIsGroupChatAdmin(c, viewer, !!jwtIsAppAdmin);
    base.memberCount = Array.isArray(c.memberUsernames) ? c.memberUsernames.length : 0;
  }
  return base;
}

/** Public + auth summary for header badge */
router.get('/chat/summary', async (req, res) => {
  try {
    const enabled = await chatEnabled();
    let onlineNow = 0;
    if (enabled) {
      await ensureChatSchema();
      onlineNow = await countOnlineUsers();
    }
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!enabled) {
      return res.json({ enabled: false, unreadTotal: 0, onlineNow: 0 });
    }
    if (!token || !process.env.JWT_SECRET) {
      return res.json({ enabled: true, unreadTotal: 0, onlineNow });
    }
    try {
      const jwt = require('jsonwebtoken');
      const d = jwt.verify(token, process.env.JWT_SECRET);
      const viewer = d.username != null ? String(d.username) : '';
      if (!viewer) return res.json({ enabled: true, unreadTotal: 0, onlineNow });
      const { list } = await listConversationsForUser(viewer);
      let total = 0;
      for (let i = 0; i < list.length; i += 1) {
        total += await countUnreadForUser(viewer, list[i]._id);
      }
      return res.json({ enabled: true, unreadTotal: total, onlineNow });
    } catch {
      return res.json({ enabled: true, unreadTotal: 0, onlineNow });
    }
  } catch (e) {
    logFailure('chat.summary', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Error' });
  }
});

/** Auth-only compact list for "Find someone" online popup. */
router.get('/chat/online-users', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const map = await getUserDisplayMap();
    const list = await listOnlineUsers();
    const users = list.map((u) => {
      const nu = normUser(u);
      return {
        username: String(u),
        displayName: map.get(nu) || String(u),
      };
    });
    res.json({ users });
  } catch (e) {
    logFailure('chat.onlineUsers', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Error' });
  }
});

/** Per-user lobby chat UI prefs (e.g. right tips panel visibility). */
router.get('/chat/preferences', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const viewer = normUser(req.user.username);
    const row = await User.findOne((u) => normUser(u.username) === viewer);
    const deskHidden = !!(row && row.chatDeskHidden);
    res.json({ deskHidden });
  } catch (e) {
    logFailure('chat.preferences.get', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Error' });
  }
});

router.patch('/chat/preferences', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ message: 'JSON body required' });
    }
    if (typeof req.body.deskHidden !== 'boolean') {
      return res.status(400).json({ message: 'deskHidden (boolean) required' });
    }
    const viewer = normUser(req.user.username);
    const deskHidden = !!req.body.deskHidden;
    let row = await User.findOne((u) => normUser(u.username) === viewer);
    const isAdminBearer = Boolean(req.user.isAdmin);
    if (!row) {
      row = await User.insert({
        username: req.user.username,
        displayName: req.user.displayName || req.user.username,
        email: placeholderEmailForUsername(req.user.username),
        groups: [],
        isAdmin: isAdminBearer,
      });
    }
    const updated = await User.updateById(row._id, { chatDeskHidden: deskHidden });
    if (!updated) return res.status(500).json({ message: 'Update failed' });
    res.json({ deskHidden: !!updated.chatDeskHidden });
  } catch (e) {
    logFailure('chat.preferences.patch', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Error' });
  }
});

router.get('/chat/conversations', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const viewer = String(req.user.username || '');
    const { list } = await listConversationsForUser(viewer);
    const displayMap = await displayMapWithDmPeers(list, viewer);
    const presenceByConv = await listPresenceByConversationId(list, viewer);
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      const unread = await countUnreadForUser(viewer, c._id);
      const row = serializeConv(c, viewer, unread, !!req.user.isAdmin, displayMap);
      row.listPresence = presenceByConv.get(String(c._id)) ?? null;
      out.push(row);
    }
    res.json({ conversations: out });
  } catch (e) {
    logFailure('chat.conversations.list', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Error' });
  }
});

/** App admins: list another user's sidebar (same shape as GET /chat/conversations). Read-only audit. */
router.get('/chat/admin/user-conversations', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const forUsername = stripConfiguredEmailSuffix(String(req.query.forUsername || '').trim());
    if (!forUsername) {
      return res.status(400).json({ message: 'forUsername query is required' });
    }
    const { list } = await listConversationsForUser(forUsername);
    const displayMap = await displayMapWithDmPeers(list, forUsername);
    const presenceByConv = await listPresenceByConversationId(list, forUsername);
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      const unread = await countUnreadForUser(forUsername, c._id);
      const row = serializeConv(c, forUsername, unread, true, displayMap);
      row.listPresence = presenceByConv.get(String(c._id)) ?? null;
      out.push(row);
    }
    res.json({ conversations: out, forUsername });
  } catch (e) {
    logFailure('chat.admin.userConversations', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Error' });
  }
});

router.get('/chat/directory', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 1) {
      return res.json({ users: [] });
    }
    const me = normUser(req.user.username);
    const byNorm = new Map();

    const addHit = (usernameRaw, displayNameRaw, source) => {
      const un = stripConfiguredEmailSuffix(String(usernameRaw || '').trim());
      if (!un || normUser(un) === me) return;
      const nu = normUser(un);
      const disp = String(displayNameRaw || '').trim() || un;
      const prev = byNorm.get(nu);
      if (!prev) {
        byNorm.set(nu, { username: un, displayName: disp, source });
        return;
      }
      if (source === 'app') {
        byNorm.set(nu, { username: un, displayName: disp, source: 'app' });
      }
    };

    const all = await User.all();
    for (let i = 0; i < all.length; i += 1) {
      const u = all[i];
      const un = u.username != null ? String(u.username) : '';
      const dn = u.displayName != null ? String(u.displayName) : '';
      const em = u.email != null ? String(u.email) : '';
      if (!un) continue;
      const hay = `${un} ${dn} ${em}`.toLowerCase();
      if (!hay.includes(q)) continue;
      addHit(un, dn.trim() || un, 'app');
    }

    if (q.length >= 2) {
      const ad = getLdapForChat();
      if (ad) {
        try {
          const esc = escapeLdapFilterValue(q);
          const filter =
            '(&(objectCategory=person)(objectClass=user)' +
            `(|(sAMAccountName=*${esc}*)(displayName=*${esc}*)(cn=*${esc}*)(mail=*${esc}*)(givenName=*${esc}*)(sn=*${esc}*)))`;
          const adUsers = await ad.findUsers(filter);
          const slice = Array.isArray(adUsers) ? adUsers.slice(0, 50) : [];
          for (let j = 0; j < slice.length; j += 1) {
            const u = slice[j];
            const sam = u.sAMAccountName != null ? String(u.sAMAccountName).trim() : '';
            if (!sam) continue;
            const disp = u.displayName || u.cn || sam;
            addHit(sam, disp, 'ad');
          }
        } catch (ldapErr) {
          logFailure('chat.directory.ldap', ldapErr, { path: req.path });
        }
      }
    }

    const hits = [...byNorm.values()]
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .slice(0, 40);
    res.json({ users: hits });
  } catch (e) {
    logFailure('chat.directory', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Error' });
  }
});

router.post('/chat/conversations/dm', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const otherRaw = req.body && req.body.withUsername != null ? String(req.body.withUsername) : '';
    const other = stripConfiguredEmailSuffix(otherRaw.trim());
    if (!other) {
      return res.status(400).json({ message: 'withUsername is required' });
    }
    const id = dmConvId(req.user.username, other);
    if (!id) {
      return res.status(400).json({ message: 'Invalid DM target' });
    }
    let conv = await Conv.findById(id);
    if (!conv) {
      conv = await Conv.insert({
        _id: id,
        type: 'dm',
        memberUsernames: [normUser(req.user.username), normUser(other)],
        title: null,
      });
    }
    await unhideConversationForUser(req.user.username, id);
    const displayMap = await displayMapWithDmPeers([conv], String(req.user.username));
    res.status(201).json(serializeConv(conv, String(req.user.username), 0, !!req.user.isAdmin, displayMap));
  } catch (e) {
    logFailure('chat.dm.create', e, { path: req.path });
    res.status(400).json({ message: e.message || 'Error' });
  }
});

router.post('/chat/conversations/group', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const title = req.body && req.body.title != null ? String(req.body.title).trim() : '';
    if (!title) {
      return res.status(400).json({ message: 'title is required' });
    }
    const rawMembers = Array.isArray(req.body.members) ? req.body.members : [];
    const set = new Set();
    set.add(normUser(req.user.username));
    for (let i = 0; i < rawMembers.length; i += 1) {
      const m = stripConfiguredEmailSuffix(String(rawMembers[i] || '').trim());
      if (m) set.add(normUser(m));
    }
    const memberUsernames = [...set];
    if (memberUsernames.length < 2) {
      return res.status(400).json({ message: 'Add at least one other member' });
    }
    const creatorNorm = normUser(req.user.username);
    const memberNormSet = new Set(memberUsernames.map((m) => normUser(m)));
    const adminSet = new Set([creatorNorm]);
    const rawAdmins = Array.isArray(req.body.adminUsernames) ? req.body.adminUsernames : [];
    for (let i = 0; i < rawAdmins.length; i += 1) {
      const a = normUser(stripConfiguredEmailSuffix(String(rawAdmins[i] || '').trim()));
      if (a && memberNormSet.has(a)) adminSet.add(a);
    }
    const adminUsernames = [...adminSet];
    const conv = await Conv.insert({
      type: 'group',
      title,
      memberUsernames,
      createdBy: String(req.user.username || ''),
      adminUsernames,
    });
    const displayMap = await getUserDisplayMap();
    res.status(201).json(serializeConv(conv, String(req.user.username), 0, !!req.user.isAdmin, displayMap));
  } catch (e) {
    logFailure('chat.group.create', e, { path: req.path });
    res.status(400).json({ message: e.message || 'Error' });
  }
});

async function deleteConversationAndMessages(convId) {
  const id = String(convId);
  await Msg.keepWhere((m) => String(m.conversationId) !== id);
  await Conv.deleteById(id);
  await Reads.keepWhere((r) => String(r.conversationId) !== id);
  await Hidden.keepWhere((h) => String(h.conversationId) !== id);
}

router.delete('/chat/conversations/:id', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const id = String(req.params.id);
    if (id === GLOBAL_ID) {
      return res.status(403).json({ message: 'You cannot remove the Everyone channel' });
    }
    const conv = await Conv.findById(id);
    if (!conv || !userInConversation(req.user.username, conv)) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    const appAdmin = !!req.user.isAdmin;
    const purge = req.query.purge === '1' || req.query.purge === 'true';

    if (String(conv.type) === 'dm') {
      await hideConversationForUser(req.user.username, id);
      return res.json({ ok: true, action: 'removed_from_list' });
    }

    if (String(conv.type) === 'group') {
      if (purge) {
        if (!viewerIsGroupChatAdmin(conv, req.user.username, appAdmin)) {
          return res.status(403).json({ message: 'Only group admins can delete the group for everyone' });
        }
        await deleteConversationAndMessages(id);
        return res.json({ ok: true, action: 'deleted' });
      }
      const me = normUser(req.user.username);
      const members = (Array.isArray(conv.memberUsernames) ? conv.memberUsernames : []).filter(
        (m) => normUser(m) !== me,
      );
      let admins = (Array.isArray(conv.adminUsernames) ? conv.adminUsernames : [])
        .map((a) => normUser(a))
        .filter((a) => members.some((m) => normUser(m) === a));
      if (admins.length === 0 && members.length > 0) {
        admins = [normUser(members[0])];
      }
      if (members.length < 2) {
        await deleteConversationAndMessages(id);
        return res.json({ ok: true, action: 'dissolved' });
      }
      await Conv.updateById(id, {
        memberUsernames: members.map((m) => normUser(m)),
        adminUsernames: admins,
      });
      return res.json({ ok: true, action: 'left' });
    }

    return res.status(400).json({ message: 'Unsupported conversation type' });
  } catch (e) {
    logFailure('chat.conversation.delete', e, { path: req.path });
    res.status(400).json({ message: e.message || 'Error' });
  }
});

router.get('/chat/conversations/:id/members', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const id = String(req.params.id);
    const conv = await Conv.findById(id);
    if (!conv || !userInConversation(req.user.username, conv)) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    const appAdmin = !!req.user.isAdmin;
    const displayMap = await getUserDisplayMap();
    const adminSet = new Set(
      (Array.isArray(conv.adminUsernames) ? conv.adminUsernames : []).map((a) => normUser(a)),
    );
    if (String(conv.type) === 'global') {
      return res.json({
        members: [],
        isChatAdmin: false,
        notice: 'Everyone is an open channel',
      });
    }
    const memberList = Array.isArray(conv.memberUsernames) ? conv.memberUsernames : [];
    const members = memberList.map((un) => {
      const nu = normUser(un);
      return {
        username: un,
        displayName: displayMap.get(nu) || un,
        isChatAdmin: adminSet.has(nu),
      };
    });
    res.json({
      members,
      isChatAdmin: viewerIsGroupChatAdmin(conv, req.user.username, appAdmin),
    });
  } catch (e) {
    logFailure('chat.members', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Error' });
  }
});

router.put('/chat/conversations/:id/admins', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const id = String(req.params.id);
    const conv = await Conv.findById(id);
    if (!conv || String(conv.type) !== 'group') {
      return res.status(404).json({ message: 'Group not found' });
    }
    if (!viewerIsGroupChatAdmin(conv, req.user.username, !!req.user.isAdmin)) {
      return res.status(403).json({ message: 'Only group admins can change admins' });
    }
    const raw = req.body && Array.isArray(req.body.adminUsernames) ? req.body.adminUsernames : [];
    const memberSet = new Set((conv.memberUsernames || []).map((m) => normUser(m)));
    const next = [];
    const seen = new Set();
    for (let i = 0; i < raw.length; i += 1) {
      const u = normUser(stripConfiguredEmailSuffix(String(raw[i] || '').trim()));
      if (!u || !memberSet.has(u) || seen.has(u)) continue;
      seen.add(u);
      next.push(u);
    }
    if (next.length < 1) {
      return res.status(400).json({ message: 'At least one group admin required (must be a member)' });
    }
    await Conv.updateById(id, { adminUsernames: next });
    res.json({ ok: true, adminUsernames: next });
  } catch (e) {
    logFailure('chat.admins', e, { path: req.path });
    res.status(400).json({ message: e.message || 'Error' });
  }
});

router.post('/chat/conversations/:id/members', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const id = String(req.params.id);
    const conv = await Conv.findById(id);
    if (!conv || String(conv.type) !== 'group') {
      return res.status(404).json({ message: 'Group not found' });
    }
    const appAdmin = !!req.user.isAdmin;
    if (!viewerIsGroupChatAdmin(conv, req.user.username, appAdmin)) {
      return res.status(403).json({ message: 'Only group admins can add or remove members' });
    }
    const me = normUser(req.user.username);
    const rawAdd = Array.isArray(req.body && req.body.add) ? req.body.add : [];
    const rawRemove = Array.isArray(req.body && req.body.remove) ? req.body.remove : [];
    let members = [...new Set((conv.memberUsernames || []).map((m) => normUser(m)))];
    for (let i = 0; i < rawRemove.length; i += 1) {
      const r = normUser(stripConfiguredEmailSuffix(String(rawRemove[i] || '').trim()));
      if (!r) continue;
      if (r === me) {
        return res.status(400).json({ message: 'Use Leave to remove yourself from the group' });
      }
      members = members.filter((m) => normUser(m) !== r);
    }
    for (let j = 0; j < rawAdd.length; j += 1) {
      const a = normUser(stripConfiguredEmailSuffix(String(rawAdd[j] || '').trim()));
      if (a && !members.includes(a)) members.push(a);
    }
    if (members.length < 2) {
      await deleteConversationAndMessages(id);
      return res.json({ ok: true, action: 'dissolved' });
    }
    let admins = (Array.isArray(conv.adminUsernames) ? conv.adminUsernames : [])
      .map((x) => normUser(x))
      .filter((a) => members.includes(a));
    if (admins.length === 0) {
      admins = [members[0]];
    }
    await Conv.updateById(id, { memberUsernames: members, adminUsernames: admins });
    res.json({ ok: true, memberUsernames: members, adminUsernames: admins });
  } catch (e) {
    logFailure('chat.members.update', e, { path: req.path });
    res.status(400).json({ message: e.message || 'Error' });
  }
});

function canDeleteChatMessage(reqUser, conv, msgRow) {
  if (!reqUser || !msgRow) return false;
  if (normUser(msgRow.fromUsername) === normUser(reqUser.username)) return true;
  if (reqUser.isAdmin) return true;
  if (conv && String(conv.type) === 'group' && viewerIsGroupChatAdmin(conv, reqUser.username, !!reqUser.isAdmin)) {
    return true;
  }
  return false;
}

function canPinMessage(reqUser, conv) {
  if (!reqUser || !conv) return false;
  if (String(conv.type) === 'global') return !!reqUser.isAdmin;
  return userInConversation(reqUser.username, conv);
}

async function loadMessages(convId, viewer) {
  const rows = await Msg.find((m) => String(m.conversationId) === String(convId));
  return rows.sort(byCreatedAt).slice(-MAX_MSG_FETCH);
}

router.get('/chat/conversations/:id/messages', async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const id = String(req.params.id);
    const conv = await Conv.findById(id);
    if (!conv) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    const asRaw = req.query.as != null ? String(req.query.as).trim() : '';
    let viewer = '';
    let jwtIsAdmin = false;
    if (token && process.env.JWT_SECRET) {
      try {
        const jwt = require('jsonwebtoken');
        const d = jwt.verify(token, process.env.JWT_SECRET);
        viewer = d.username != null ? String(d.username) : '';
        jwtIsAdmin = !!d.isAdmin;
      } catch {
        viewer = '';
      }
    }
    const impersonate =
      jwtIsAdmin && asRaw ? stripConfiguredEmailSuffix(asRaw) : '';
    const membershipUser = impersonate || viewer;

    if (String(conv.type) !== 'global') {
      if (!membershipUser || !userInConversation(membershipUser, conv)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }
    const enrichViewer = impersonate || viewer;
    const messages = await loadMessages(id, enrichViewer);
    let readsRows = [];
    if (enrichViewer) {
      readsRows = await Reads.find((r) => String(r.conversationId) === id);
    }
    const enriched = await enrichMessages(messages, { viewer: enrichViewer, readsRows });
    if (enrichViewer) {
      await touchPresence(enrichViewer);
    }
    const displayMap = await getUserDisplayMap();
    const presence = await buildPresenceBundle(conv, enrichViewer || '', displayMap);
    let pinnedMessage = null;
    if (conv.pinnedMessageId) {
      const pinRow = await Msg.findById(String(conv.pinnedMessageId));
      if (!pinRow || String(pinRow.conversationId) !== id) {
        await Conv.updateById(id, { pinnedMessageId: null });
      } else {
        pinnedMessage = await enrichOneMessage(pinRow, enrichViewer);
      }
    }
    res.json({ messages: enriched, presence, pinnedMessage });
  } catch (e) {
    logFailure('chat.messages.get', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Error' });
  }
});

router.post('/chat/conversations/:id/read', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const id = String(req.params.id);
    const conv = await Conv.findById(id);
    if (!conv || !userInConversation(req.user.username, conv)) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    await setLastRead(req.user.username, id, new Date().toISOString());
    res.json({ ok: true });
  } catch (e) {
    logFailure('chat.read', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Error' });
  }
});

router.post('/chat/presence/ping', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    await touchPresence(req.user.username);
    res.json({ ok: true });
  } catch (e) {
    logFailure('chat.presence.ping', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Error' });
  }
});

router.post('/chat/conversations/:id/typing', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const id = String(req.params.id);
    const conv = await Conv.findById(id);
    if (!conv || !userInConversation(req.user.username, conv)) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    const typing = !!(req.body && req.body.typing);
    await setTypingState(req.user.username, id, typing);
    res.json({ ok: true });
  } catch (e) {
    logFailure('chat.typing', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Error' });
  }
});

router.put('/chat/conversations/:id/pin', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const id = String(req.params.id);
    const conv = await Conv.findById(id);
    if (!conv || !userInConversation(req.user.username, conv)) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    if (!canPinMessage(req.user, conv)) {
      return res.status(403).json({ message: 'You cannot pin messages in this chat' });
    }
    const raw = req.body && req.body.messageId;
    if (raw === null || raw === '') {
      await Conv.updateById(id, { pinnedMessageId: null });
      return res.json({ ok: true, pinnedMessageId: null });
    }
    const mid = String(raw).trim();
    if (!mid) {
      return res.status(400).json({ message: 'messageId required' });
    }
    const msgRow = await Msg.findById(mid);
    if (!msgRow || String(msgRow.conversationId) !== id) {
      return res.status(404).json({ message: 'Message not found' });
    }
    await Conv.updateById(id, { pinnedMessageId: String(msgRow._id) });
    res.json({ ok: true, pinnedMessageId: String(msgRow._id) });
  } catch (e) {
    logFailure('chat.pin', e, { path: req.path });
    res.status(400).json({ message: e.message || 'Error' });
  }
});

router.post('/chat/conversations/:id/messages', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    await pruneOldMessages();
    const id = String(req.params.id);
    const conv = await Conv.findById(id);
    if (!conv || !userInConversation(req.user.username, conv)) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    const raw = req.body && req.body.text != null ? String(req.body.text) : '';
    const text = raw.replace(/\r\n/g, '\n').trim();
    const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
    if (!text && attachments.length === 0) {
      return res.status(400).json({ message: 'Message text or attachment required' });
    }
    if (text.length > MAX_TEXT) {
      return res.status(400).json({ message: `Text at most ${MAX_TEXT} characters` });
    }
    const cleanAttach = [];
    for (let i = 0; i < attachments.length; i += 1) {
      const a = attachments[i];
      if (!a || typeof a !== 'object') continue;
      const url = a.url != null ? String(a.url).trim() : '';
      if (!url.startsWith('/api/uploads/files/chat/')) continue;
      cleanAttach.push({
        url,
        name: a.name != null ? String(a.name).slice(0, 200) : 'file',
        mime: a.mime != null ? String(a.mime).slice(0, 120) : '',
        size: Number(a.size) || 0,
      });
      if (cleanAttach.length >= 5) break;
    }
    const u = req.user || {};
    const fromUsername = u.username != null ? String(u.username) : 'user';
    const fromDisplayName =
      u.displayName != null && String(u.displayName).trim()
        ? String(u.displayName).trim()
        : fromUsername;
    let replyToMessageId = null;
    let replyPreview = null;
    const rawReplyId =
      req.body && req.body.replyToMessageId != null ? String(req.body.replyToMessageId).trim() : '';
    if (rawReplyId) {
      const parent = await Msg.findById(rawReplyId);
      if (parent && String(parent.conversationId) === id) {
        replyToMessageId = String(parent._id);
        const pt =
          parent.text != null ? String(parent.text).replace(/\r\n/g, '\n').trim().slice(0, 400) : '';
        replyPreview = {
          fromUsername: parent.fromUsername != null ? String(parent.fromUsername) : '',
          fromDisplayName:
            parent.fromDisplayName != null && String(parent.fromDisplayName).trim()
              ? String(parent.fromDisplayName).trim()
              : String(parent.fromUsername || ''),
          text: pt.length > 220 ? `${pt.slice(0, 220)}…` : pt,
        };
      }
    }
    const msg = await Msg.insert({
      conversationId: id,
      text,
      fromUsername,
      fromDisplayName,
      attachments: cleanAttach,
      reactions: {},
      ...(replyToMessageId ? { replyToMessageId, replyPreview } : {}),
    });
    await setLastRead(fromUsername, id, new Date().toISOString());
    /* If recipients had removed this DM from their sidebar, bring it back when there is new activity. */
    const members = Array.isArray(conv.memberUsernames) ? conv.memberUsernames : [];
    const senderNorm = normUser(fromUsername);
    for (let i = 0; i < members.length; i += 1) {
      const mem = members[i];
      if (normUser(mem) === senderNorm) continue;
      await unhideConversationForUser(mem, id);
    }
    res.status(201).json({ message: await enrichOneMessage(msg, req.user.username) });
  } catch (e) {
    logFailure('chat.messages.post', e, { path: req.path });
    res.status(400).json({ message: e.message || 'Error' });
  }
});

router.post('/chat/messages/:messageId/react', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    await ensureChatSchema();
    const messageId = String(req.params.messageId);
    const emojiRaw = req.body && req.body.emoji != null ? String(req.body.emoji) : '';
    const emoji = [...emojiRaw].slice(0, 4).join('').trim();
    if (!emoji || emoji.length > 8) {
      return res.status(400).json({ message: 'emoji is required' });
    }
    const row = await Msg.findById(messageId);
    if (!row) {
      return res.status(404).json({ message: 'Message not found' });
    }
    const conv = await Conv.findById(row.conversationId);
    if (!conv || !userInConversation(req.user.username, conv)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const reactions = { ...(row.reactions && typeof row.reactions === 'object' ? row.reactions : {}) };
    const me = normUser(req.user.username);
    const key = emoji;
    let hadInKey = null;
    const prevKeys = Object.keys(reactions);
    for (let i = 0; i < prevKeys.length; i += 1) {
      const k = prevKeys[i];
      const list = reactions[k];
      if (!Array.isArray(list)) continue;
      if (list.some((uname) => normUser(uname) === me)) hadInKey = k;
    }
    const toggleOffSame = hadInKey === key;
    for (let i = 0; i < prevKeys.length; i += 1) {
      const k = prevKeys[i];
      let list = Array.isArray(reactions[k]) ? [...reactions[k]] : [];
      list = list.filter((uname) => normUser(uname) !== me);
      if (list.length === 0) delete reactions[k];
      else reactions[k] = list;
    }
    if (!toggleOffSame) {
      const arr = Array.isArray(reactions[key]) ? [...reactions[key]] : [];
      arr.push(me);
      reactions[key] = arr;
    }
    const updated = await Msg.updateById(messageId, { reactions });
    res.json({ message: await enrichOneMessage(updated, req.user.username) });
  } catch (e) {
    logFailure('chat.react', e, { path: req.path });
    res.status(400).json({ message: e.message || 'Error' });
  }
});

router.delete('/chat/messages/:messageId', jwtMiddleware, async (req, res) => {
  try {
    if (!(await chatEnabled())) {
      return res.status(403).json({ message: 'Chat is disabled' });
    }
    const messageId = String(req.params.messageId);
    const row = await Msg.findById(messageId);
    if (!row) {
      return res.status(404).json({ message: 'Message not found' });
    }
    const conv = await Conv.findById(row.conversationId);
    if (!conv || !userInConversation(req.user.username, conv)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (!canDeleteChatMessage(req.user, conv, row)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    await Msg.deleteById(messageId);
    const convAfter = await Conv.findById(row.conversationId);
    if (convAfter && String(convAfter.pinnedMessageId) === String(messageId)) {
      await Conv.updateById(convAfter._id, { pinnedMessageId: null });
    }
    res.json({ ok: true });
  } catch (e) {
    logFailure('chat.message.delete', e, { path: req.path });
    res.status(400).json({ message: e.message || 'Error' });
  }
});

router.post('/chat/attachments', jwtMiddleware, (req, res) => {
  chatUpload.single('file')(req, res, async (err) => {
    try {
      if (!(await chatEnabled())) {
        return res.status(403).json({ message: 'Chat is disabled' });
      }
      if (err) {
        return res.status(400).json({ message: err.message || 'Upload failed' });
      }
      if (!req.file) {
        return res.status(400).json({ message: 'No file' });
      }
      const url = `/api/uploads/files/chat/${req.file.filename}`;
      res.status(201).json({
        url,
        name: req.file.originalname || req.file.filename,
        mime: req.file.mimetype || '',
        size: req.file.size || 0,
      });
    } catch (e) {
      logFailure('chat.attachments', e, { path: req.path });
      res.status(500).json({ message: e.message || 'Error' });
    }
  });
});

module.exports = router;
