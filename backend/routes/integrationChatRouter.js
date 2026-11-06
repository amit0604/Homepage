/**
 * Chat API for other chat platforms (see docs/CHAT_API.md). Mounted behind API key auth.
 *
 * The API key decides the conversation's `source`, so a platform can only see and post to
 * the conversations it created. People from the other platform never become local users:
 * their messages are stored under a name prefixed with the source, so they cannot pose
 * as someone who signs in here.
 */
const express = require('express');
const { collections } = require('../repositories/jsonStore');
const { getSettings } = require('./settingsRouter');
const { isLobbyChatUiEnabledByDeploy } = require('../utils/lobbyChatUi');
const { stripConfiguredEmailSuffix } = require('../utils/userEmailDomain');
const { logFailure } = require('../utils/failureLog');
const {
  ensureChatSchema,
  normUser,
  byCreatedAt,
  unhideConversationForUser,
} = require('../utils/chatCore');
const { eventFor, markDelivered, markFailed } = require('../services/chatBridge');

const router = express.Router();
const Conv = collections.chatConversations;
const Msg = collections.chatMessages;
const Outbox = collections.chatOutbox;

const MAX = { title: 200, externalId: 200, name: 120, member: 200, text: 16000, url: 2000, fileName: 200 };
const MAX_MEMBERS = 1000;
const MAX_ATTACHMENTS = 5;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 400;

class ValidationError extends Error {}

function textField(body, field, max, { required = false } = {}) {
  const raw = body[field];
  if (raw === undefined || raw === null) {
    if (required) throw new ValidationError(`${field} is required`);
    return undefined;
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new ValidationError(`${field} must be a string`);
  }
  const value = String(raw).replace(/\r\n/g, '\n').trim();
  if (required && !value) throw new ValidationError(`${field} is required`);
  if (value.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return value;
}

/** Only http(s) links are kept, because the chat renders these as links. */
function webUrl(value, field) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new ValidationError(`${field} must be a valid http or https URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${field} must be a valid http or https URL`);
  }
  return parsed.href;
}

function membersField(body) {
  if (body.members === undefined) return undefined;
  if (!Array.isArray(body.members)) throw new ValidationError('members must be a list of usernames');
  if (body.members.length > MAX_MEMBERS) throw new ValidationError(`members can have at most ${MAX_MEMBERS} names`);
  const set = new Set();
  for (const raw of body.members) {
    if (typeof raw !== 'string') throw new ValidationError('members must be a list of usernames');
    const name = normUser(stripConfiguredEmailSuffix(raw.trim()));
    if (name.length > MAX.member) throw new ValidationError(`Each member must be at most ${MAX.member} characters`);
    if (name) set.add(name);
  }
  return [...set];
}

function attachmentsField(body) {
  if (body.attachments === undefined) return [];
  if (!Array.isArray(body.attachments)) throw new ValidationError('attachments must be a list');
  if (body.attachments.length > MAX_ATTACHMENTS) {
    throw new ValidationError(`attachments can have at most ${MAX_ATTACHMENTS} items`);
  }
  return body.attachments.map((a) => {
    if (!a || typeof a !== 'object') throw new ValidationError('Each attachment needs a url');
    const url = textField(a, 'url', MAX.url, { required: true });
    return {
      url: webUrl(url, 'attachments.url'),
      name: textField(a, 'name', MAX.fileName) || 'Attachment',
      external: true,
    };
  });
}

function serializeConversation(c) {
  return {
    id: c._id,
    source: c.source,
    externalId: c.externalId,
    title: c.title,
    kind: c.bridgeKind || 'group',
    members: c.memberUsernames || [],
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function serializeMessage(m) {
  return {
    id: m._id,
    conversationId: m.conversationId,
    externalId: m.externalId ?? null,
    origin: m.external ? 'external' : 'local',
    text: m.text || '',
    from: {
      id: m.external ? m.externalAuthorId ?? null : m.fromUsername,
      displayName: m.fromDisplayName,
    },
    attachments: (m.attachments || []).map((a) => ({ url: a.url, name: a.name })),
    replyToId: m.replyToMessageId ?? null,
    delivery: m.delivery ? m.delivery.status : null,
    createdAt: m.createdAt,
  };
}

function handle(op, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      logFailure(`integration.chat.${op}`, err, { path: req.path, source: req.integration?.source });
      res.status(500).json({ error: 'Server error' });
    }
  };
}

/** Runs one operation at a time per key, so two copies of a retry cannot both be inserted. */
const locks = new Map();
function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  const tail = next.catch(() => {}).finally(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  locks.set(key, tail);
  return next;
}

async function ownConversation(req) {
  const row = await Conv.findById(req.params.id);
  return row && row.source === req.integration.source ? row : null;
}

router.use(async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!isLobbyChatUiEnabledByDeploy() || settings.lobbyChatEnabled === false) {
      res.status(403).json({ error: 'Chat is disabled in this app' });
      return;
    }
    await ensureChatSchema();
    next();
  } catch (err) {
    logFailure('integration.chat.guard', err, { path: req.path, source: req.integration?.source });
    res.status(500).json({ error: 'Server error' });
  }
});

// Creates a conversation, or updates the one with this externalId, so syncing again is safe.
router.post('/conversations', handle('conversation.upsert', async (req, res) => {
  const body = req.body || {};
  const { source } = req.integration;
  const externalId = textField(body, 'externalId', MAX.externalId, { required: true });
  const kind = textField(body, 'kind', 20);
  if (kind !== undefined && kind !== 'group' && kind !== 'direct') {
    throw new ValidationError('kind must be group or direct');
  }
  const members = membersField(body);

  await withLock(`conv:${source}:${externalId}`, async () => {
    const existing = await Conv.findOne((c) => c.source === source && c.externalId === externalId);
    if (existing) {
      const title = textField(body, 'title', MAX.title);
      if (title === '') throw new ValidationError('title cannot be empty');
      const patch = {};
      if (title !== undefined) patch.title = title;
      if (kind !== undefined) patch.bridgeKind = kind;
      if (members !== undefined) {
        if (members.length === 0) throw new ValidationError('members needs at least one username');
        patch.memberUsernames = members;
      }
      const updated = await Conv.updateById(existing._id, patch);
      res.json(serializeConversation(updated));
      return;
    }

    const title = textField(body, 'title', MAX.title, { required: true });
    if (!members || members.length === 0) {
      throw new ValidationError('members needs at least one username, so someone can see the conversation');
    }
    const created = await Conv.insert({
      type: 'group',
      title,
      memberUsernames: members,
      adminUsernames: [],
      createdBy: source,
      source,
      externalId,
      bridgeKind: kind || 'group',
    });
    res.status(201).json(serializeConversation(created));
  });
}));

router.get('/conversations', handle('conversation.list', async (req, res) => {
  const { source } = req.integration;
  const externalId = req.query.externalId != null ? String(req.query.externalId) : null;
  const rows = await Conv.find(
    (c) => c.source === source && (externalId === null || c.externalId === externalId),
  );
  res.json({ total: rows.length, conversations: rows.map(serializeConversation) });
}));

router.get('/conversations/:id', handle('conversation.get', async (req, res) => {
  const conv = await ownConversation(req);
  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  res.json(serializeConversation(conv));
}));

// A message from the other platform. It is never sent back there, which prevents loops.
router.post('/conversations/:id/messages', handle('message.post', async (req, res) => {
  const conv = await ownConversation(req);
  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const body = req.body || {};
  const { source } = req.integration;
  const externalId = textField(body, 'externalId', MAX.externalId) || null;
  const text = textField(body, 'text', MAX.text) || '';
  const attachments = attachmentsField(body);
  if (!text && attachments.length === 0) throw new ValidationError('text or attachments is required');

  const from = body.from;
  if (!from || typeof from !== 'object') throw new ValidationError('from is required');
  const authorId = textField(from, 'id', MAX.name);
  const displayName = textField(from, 'displayName', MAX.name);
  if (!authorId && !displayName) throw new ValidationError('from needs an id or a displayName');

  const replyToExternalId = textField(body, 'replyToExternalId', MAX.externalId);
  const replyToId = textField(body, 'replyToId', MAX.externalId);

  const save = async () => {
    if (externalId) {
      const seen = await Msg.findOne((m) => String(m.conversationId) === String(conv._id) && m.externalId === externalId);
      if (seen) {
        res.json(serializeMessage(seen));
        return;
      }
    }
    let replyFields = {};
    if (replyToExternalId || replyToId) {
      const parent = await Msg.findOne((m) => String(m.conversationId) === String(conv._id)
        && (replyToId ? String(m._id) === replyToId : m.externalId === replyToExternalId));
      if (parent) {
        const snippet = String(parent.text || '').trim();
        replyFields = {
          replyToMessageId: String(parent._id),
          replyPreview: {
            fromUsername: String(parent.fromUsername || ''),
            fromDisplayName: String(parent.fromDisplayName || parent.fromUsername || ''),
            text: snippet.length > 220 ? `${snippet.slice(0, 220)}…` : snippet,
          },
        };
      }
    }
    const msg = await Msg.insert({
      conversationId: String(conv._id),
      text,
      fromUsername: `${source}:${normUser(authorId || displayName)}`,
      fromDisplayName: displayName || authorId,
      attachments,
      reactions: {},
      external: true,
      source,
      externalId,
      externalAuthorId: authorId || null,
      ...replyFields,
    });
    const members = Array.isArray(conv.memberUsernames) ? conv.memberUsernames : [];
    for (const member of members) {
      // eslint-disable-next-line no-await-in-loop
      await unhideConversationForUser(member, String(conv._id));
    }
    res.status(201).json(serializeMessage(msg));
  };

  if (externalId) await withLock(`msg:${conv._id}:${externalId}`, save);
  else await save();
}));

router.get('/conversations/:id/messages', handle('message.list', async (req, res) => {
  const conv = await ownConversation(req);
  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  let since = null;
  if (req.query.since != null) {
    since = new Date(String(req.query.since));
    if (Number.isNaN(since.getTime())) throw new ValidationError('since must be an ISO 8601 date');
  }
  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_PAGE) : DEFAULT_PAGE;
  const rows = (await Msg.find((m) => String(m.conversationId) === String(conv._id)))
    .filter((m) => !since || new Date(m.createdAt) > since)
    .sort(byCreatedAt);
  res.json({ total: rows.length, messages: rows.slice(-limit).map(serializeMessage) });
}));

router.delete('/conversations/:id/messages/:messageId', handle('message.delete', async (req, res) => {
  const conv = await ownConversation(req);
  const msg = conv ? await Msg.findById(req.params.messageId) : null;
  if (!msg || String(msg.conversationId) !== String(conv._id)) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  if (!msg.external) {
    res.status(403).json({ error: 'Only messages from your platform can be deleted' });
    return;
  }
  await Msg.deleteById(msg._id);
  res.json({ ok: true });
}));

// For apps with no webhook: collect messages written here, then acknowledge each one.
router.get('/outbox', handle('outbox.list', async (req, res) => {
  if (req.integration.webhookUrl) {
    res.status(409).json({ error: 'This app has a webhook, so messages are pushed to it' });
    return;
  }
  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_PAGE) : DEFAULT_PAGE;
  const rows = (await Outbox.find((r) => r.source === req.integration.source && r.status === 'pending'))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json({ total: rows.length, events: rows.slice(0, limit).map(eventFor) });
}));

router.post('/outbox/:id/ack', handle('outbox.ack', async (req, res) => {
  const row = await Outbox.findById(req.params.id);
  if (!row || row.source !== req.integration.source) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  const body = req.body || {};
  const externalId = textField(body, 'externalId', MAX.externalId) || null;
  const error = textField(body, 'error', 300);
  if (error) await markFailed(row, error);
  else await markDelivered(row, externalId);
  res.json({ ok: true });
}));

module.exports = router;
