const fs = require('fs/promises');
const path = require('path');
const { collections, UPLOADS_DIR } = require('../repositories/jsonStore');
const { stripConfiguredEmailSuffix } = require('./userEmailDomain');

const LobbyLegacy = collections.lobbyChat;
const Conv = collections.chatConversations;
const Msg = collections.chatMessages;
const Reads = collections.chatReads;
const Hidden = collections.chatHiddenConversations;

const GLOBAL_ID = '__global__';

function retentionMs() {
  const d = Number(process.env.CHAT_RETENTION_DAYS);
  const days = Number.isFinite(d) && d > 0 ? d : 30;
  return days * 24 * 60 * 60 * 1000;
}

function normUser(u) {
  if (u == null) return '';
  return stripConfiguredEmailSuffix(String(u).trim()).toLowerCase();
}

function dmConvId(a, b) {
  const x = normUser(a);
  const y = normUser(b);
  if (!x || !y || x === y) return null;
  const [s, t] = x < y ? [x, y] : [y, x];
  return `dm:${s}::${t}`;
}

function byCreatedAt(a, b) {
  return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
}

let schemaReady = false;
let lastChatMaintenanceAt = 0;

function chatMaintenanceIntervalMs() {
  const n = Number(process.env.CHAT_GC_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
}

async function collectReferencedChatFilenames() {
  const all = await Msg.all();
  const names = new Set();
  const prefix = '/api/uploads/files/chat/';
  for (let i = 0; i < all.length; i += 1) {
    const m = all[i];
    const att = Array.isArray(m.attachments) ? m.attachments : [];
    for (let j = 0; j < att.length; j += 1) {
      const a = att[j];
      const url = a && a.url != null ? String(a.url) : '';
      if (!url.startsWith(prefix)) continue;
      const base = url.slice(prefix.length).split('/')[0];
      if (base && !base.includes('..')) names.add(base);
    }
  }
  return names;
}

/** Remove chat upload files on disk that are not linked from any message. */
async function pruneOrphanChatUploads() {
  const dir = path.join(UPLOADS_DIR, 'chat');
  let deletedFiles = 0;
  try {
    const refs = await collectReferencedChatFilenames();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (let i = 0; i < entries.length; i += 1) {
      const ent = entries[i];
      if (!ent.isFile()) continue;
      if (refs.has(ent.name)) continue;
      try {
        await fs.unlink(path.join(dir, ent.name));
        deletedFiles += 1;
      } catch {
        /* ignore per file */
      }
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { deletedFiles: 0 };
    throw e;
  }
  return { deletedFiles };
}

/** Remove read-state rows for conversations that no longer exist. */
async function pruneStaleChatReads() {
  const convs = await Conv.all();
  const convIds = new Set(convs.map((c) => String(c._id)));
  return Reads.keepWhere((r) => convIds.has(String(r.conversationId)));
}

/** Remove hidden rows pointing at deleted conversations. */
async function pruneStaleChatHidden() {
  const convs = await Conv.all();
  const convIds = new Set(convs.map((c) => String(c._id)));
  return Hidden.keepWhere((h) => convIds.has(String(h.conversationId)));
}

async function getHiddenConversationIdsForUser(username) {
  const u = normUser(username);
  const rows = await Hidden.find((h) => normUser(h.username) === u);
  return new Set(rows.map((r) => String(r.conversationId)));
}

async function hideConversationForUser(username, conversationId) {
  const u = normUser(username);
  const cid = String(conversationId);
  const existing = await Hidden.findOne(
    (h) => normUser(h.username) === u && String(h.conversationId) === cid,
  );
  if (existing) return;
  await Hidden.insert({ username: u, conversationId: cid });
}

async function unhideConversationForUser(username, conversationId) {
  const u = normUser(username);
  const cid = String(conversationId);
  const row = await Hidden.findOne(
    (h) => normUser(h.username) === u && String(h.conversationId) === cid,
  );
  if (row) await Hidden.deleteById(row._id);
}

function viewerIsGroupChatAdmin(conversation, viewerUsername, jwtIsAppAdmin) {
  if (!conversation || conversation.type !== 'group') return false;
  if (jwtIsAppAdmin) return true;
  const v = normUser(viewerUsername);
  const admins = Array.isArray(conversation.adminUsernames)
    ? conversation.adminUsernames.map((a) => normUser(a))
    : [];
  return admins.includes(v);
}

/**
 * After message retention prune: optionally GC reads + orphan files (throttled).
 */
async function maybeRunChatMaintenance() {
  const now = Date.now();
  if (now - lastChatMaintenanceAt < chatMaintenanceIntervalMs()) {
    return null;
  }
  lastChatMaintenanceAt = now;
  const reads = await pruneStaleChatReads();
  const hid = await pruneStaleChatHidden();
  const files = await pruneOrphanChatUploads();
  return { readsRemoved: reads.removed, hiddenRemoved: hid.removed, filesDeleted: files.deletedFiles };
}

const PRUNE_INTERVAL_MS = 60 * 1000;
let lastPruneAt = 0;

/** Runs on every chat write, so it scans all messages at most once a minute. */
async function pruneOldMessages() {
  if (Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = Date.now();
  const cut = Date.now() - retentionMs();
  await Msg.keepWhere((m) => {
    if (!m.createdAt) return false;
    const t = new Date(m.createdAt).getTime();
    if (Number.isNaN(t)) return false;
    return t >= cut;
  });
  await maybeRunChatMaintenance();
}

async function ensureChatSchema() {
  if (schemaReady) return;
  await pruneOldMessages();
  const existingGlobal = await Conv.findById(GLOBAL_ID);
  if (!existingGlobal) {
    await Conv.insert({
      _id: GLOBAL_ID,
      type: 'global',
      title: 'Everyone',
      memberUsernames: [],
    });
  }
  const hasNew = await Msg.findOne((m) => String(m.conversationId) === GLOBAL_ID);
  if (!hasNew) {
    const legacy = await LobbyLegacy.all();
    const sorted = [...legacy].sort(byCreatedAt);
    for (let i = 0; i < sorted.length; i += 1) {
      const row = sorted[i];
      await Msg.insert({
        conversationId: GLOBAL_ID,
        text: row.text != null ? String(row.text) : '',
        fromUsername: row.fromUsername != null ? String(row.fromUsername) : '',
        fromDisplayName:
          row.fromDisplayName != null && String(row.fromDisplayName).trim()
            ? String(row.fromDisplayName).trim()
            : String(row.fromUsername || ''),
        createdAt: row.createdAt,
        attachments: [],
        reactions: {},
      });
    }
  }
  await migrateGroupChatAdmins();
  schemaReady = true;
}

async function migrateGroupChatAdmins() {
  const all = await Conv.all();
  for (let i = 0; i < all.length; i += 1) {
    const c = all[i];
    if (String(c.type) !== 'group') continue;
    if (Array.isArray(c.adminUsernames) && c.adminUsernames.length > 0) continue;
    const members = Array.isArray(c.memberUsernames) ? c.memberUsernames : [];
    const creator = c.createdBy != null ? normUser(String(c.createdBy)) : '';
    let seed = '';
    if (creator && members.some((m) => normUser(m) === creator)) seed = creator;
    else if (members[0]) seed = normUser(members[0]);
    if (seed) {
      await Conv.updateById(c._id, { adminUsernames: [seed] });
    }
  }
}

function userInConversation(username, conversation) {
  if (!conversation) return false;
  const u = normUser(username);
  if (conversation.type === 'global') return true;
  const members = Array.isArray(conversation.memberUsernames) ? conversation.memberUsernames : [];
  return members.some((m) => normUser(m) === u);
}

function conversationLabel(conversation, viewerUsername) {
  if (!conversation) return '';
  if (conversation.type === 'global') return conversation.title || 'Everyone';
  if (conversation.type === 'group') return conversation.title || 'Group';
  if (conversation.type === 'dm') {
    const members = Array.isArray(conversation.memberUsernames) ? conversation.memberUsernames : [];
    const other = members.find((m) => normUser(m) !== normUser(viewerUsername));
    return other || 'Direct message';
  }
  return 'Chat';
}

async function getLastRead(username, conversationId) {
  const u = normUser(username);
  const cid = String(conversationId);
  const row = await Reads.findOne((r) => normUser(r.username) === u && String(r.conversationId) === cid);
  return row && row.lastReadAt ? row.lastReadAt : null;
}

async function setLastRead(username, conversationId, iso) {
  const u = normUser(username);
  const cid = String(conversationId);
  const existing = await Reads.findOne((r) => normUser(r.username) === u && String(r.conversationId) === cid);
  const at = iso || new Date().toISOString();
  if (existing) {
    await Reads.updateById(existing._id, { lastReadAt: at });
  } else {
    await Reads.insert({ username: u, conversationId: cid, lastReadAt: at });
  }
}

/** Messages grouped by conversation and sorted by time, so reads do not scan every message. */
function buildMessageIndex(records) {
  const byConversation = new Map();
  for (let i = 0; i < records.length; i += 1) {
    const m = records[i];
    const cid = String(m.conversationId);
    const t = new Date(m.createdAt || 0).getTime();
    if (!byConversation.has(cid)) byConversation.set(cid, []);
    byConversation.get(cid).push({ t: Number.isNaN(t) ? 0 : t, m });
  }
  for (const list of byConversation.values()) list.sort((a, b) => a.t - b.t);
  return byConversation;
}

const messageIndex = () => Msg.derived('byConversation', buildMessageIndex);

/** The newest messages in a conversation, oldest first. The rows are shared, so do not change them. */
async function latestMessages(conversationId, limit) {
  const list = (await messageIndex()).get(String(conversationId)) || [];
  return list.slice(-limit).map((row) => row.m);
}

/** When each conversation last had a message, and which ones exist. */
async function conversationActivity() {
  const index = await messageIndex();
  const lastBy = new Map();
  for (const [cid, list] of index) {
    if (list.length > 0 && list[list.length - 1].t > 0) lastBy.set(cid, list[list.length - 1].t);
  }
  return { lastBy, conversationIds: [...index.keys()] };
}

async function countUnreadForUser(username, conversationId) {
  const u = normUser(username);
  const last = await getLastRead(username, conversationId);
  const after = last ? new Date(last).getTime() : 0;
  const list = (await messageIndex()).get(String(conversationId)) || [];
  // Sorted by time, so everything newer than the last read is at the end.
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (list[mid].t <= after) low = mid + 1;
    else high = mid;
  }
  let n = 0;
  for (let i = low; i < list.length; i += 1) {
    if (normUser(list[i].m.fromUsername) !== u) n += 1;
  }
  return n;
}

module.exports = {
  GLOBAL_ID,
  retentionMs,
  normUser,
  dmConvId,
  byCreatedAt,
  ensureChatSchema,
  pruneOldMessages,
  userInConversation,
  conversationLabel,
  viewerIsGroupChatAdmin,
  getHiddenConversationIdsForUser,
  hideConversationForUser,
  unhideConversationForUser,
  getLastRead,
  setLastRead,
  countUnreadForUser,
  latestMessages,
  conversationActivity,
};
