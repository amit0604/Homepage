/**
 * Legacy paths /api/lobby-chat — backed by chatMessages (__global__ conversation).
 */
const express = require('express');
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');
const { collections } = require('../repositories/jsonStore');
const { getSettings } = require('./settingsRouter');
const { isLobbyChatUiEnabledByDeploy } = require('../utils/lobbyChatUi');
const {
  GLOBAL_ID,
  ensureChatSchema,
  pruneOldMessages,
} = require('../utils/chatCore');
const { logFailure } = require('../utils/failureLog');

const router = express.Router();
const Msg = collections.chatMessages;

const MAX_LEN = 16000;
const MAX_MESSAGES_RETURN = 300;

function byCreatedAt(a, b) {
  return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
}

function toLegacyRow(m) {
  return {
    _id: m._id,
    text: m.text,
    fromUsername: m.fromUsername,
    fromDisplayName: m.fromDisplayName,
    createdAt: m.createdAt,
  };
}

async function isLobbyEnabled() {
  if (!isLobbyChatUiEnabledByDeploy()) return false;
  const settings = await getSettings();
  return settings.lobbyChatEnabled !== false;
}

router.get('/lobby-chat', async (req, res) => {
  try {
    await ensureChatSchema();
    await pruneOldMessages();
    if (!(await isLobbyEnabled())) {
      return res.json([]);
    }
    const all = await Msg.find((m) => String(m.conversationId) === GLOBAL_ID);
    const sorted = all.sort(byCreatedAt);
    const tail = sorted.slice(-MAX_MESSAGES_RETURN).map(toLegacyRow);
    res.json(tail);
  } catch (e) {
    logFailure('lobby_chat.get', e, { path: req.path });
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

router.post('/lobby-chat', jwtMiddleware, async (req, res) => {
  try {
    await ensureChatSchema();
    await pruneOldMessages();
    if (!(await isLobbyEnabled())) {
      return res.status(403).json({ error: 'Chat is disabled' });
    }
    const raw = req.body && req.body.text != null ? String(req.body.text) : '';
    const text = raw.replace(/\r\n/g, '\n').trim();
    if (!text) {
      return res.status(400).json({ error: 'Message text is required' });
    }
    if (text.length > MAX_LEN) {
      return res.status(400).json({ error: `Message must be at most ${MAX_LEN} characters` });
    }
    const u = req.user || {};
    const fromUsername = u.username != null ? String(u.username) : 'user';
    const fromDisplayName =
      u.displayName != null && String(u.displayName).trim()
        ? String(u.displayName).trim()
        : fromUsername;
    const msg = await Msg.insert({
      conversationId: GLOBAL_ID,
      text,
      fromUsername,
      fromDisplayName,
      attachments: [],
      reactions: {},
    });
    res.status(201).json(toLegacyRow(msg));
  } catch (e) {
    logFailure('lobby_chat.post', e, { path: req.path });
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

router.delete('/lobby-chat/:id', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    if (!(await isLobbyEnabled())) {
      return res.status(404).json({ error: 'Message not found' });
    }
    const row = await Msg.findById(req.params.id);
    if (!row || String(row.conversationId) !== GLOBAL_ID) {
      return res.status(404).json({ error: 'Message not found' });
    }
    const deleted = await Msg.deleteById(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json({ ok: true, deleted: deleted._id });
  } catch (e) {
    logFailure('lobby_chat.delete', e, { path: req.path });
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

module.exports = router;
