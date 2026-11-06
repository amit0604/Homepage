const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { collections, UPLOADS_DIR } = require('../repositories/jsonStore');
const { userInConversation } = require('../utils/chatCore');

const Msg = collections.chatMessages;
const Conv = collections.chatConversations;

function safeChatFilename(raw) {
  const base = path.basename(String(raw || ''));
  if (!base || base !== String(raw || '').trim()) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(base) || base.length > 200) return null;
  return base;
}

function attachmentMatchesUrl(attUrl, publicUrl) {
  if (!attUrl) return false;
  const u = String(attUrl).replace(/\?.*$/, '');
  return u === publicUrl;
}

/**
 * Chat uploads are not served by anonymous static file access (except when linked from Everyone / global).
 * JWT: allow if user is in the conversation for any message that references this file.
 * No JWT: allow only if referenced from a global channel message.
 */
async function serveChatFile(req, res) {
  try {
    const filename = safeChatFilename(req.params.filename);
    if (!filename) {
      return res.status(400).json({ message: 'Invalid file' });
    }

    const chatDir = path.join(UPLOADS_DIR, 'chat');
    const abs = path.resolve(path.join(chatDir, filename));
    const rootResolved = path.resolve(chatDir);
    if (!abs.startsWith(rootResolved + path.sep) && abs !== rootResolved) {
      return res.status(400).json({ message: 'Invalid path' });
    }

    const publicUrl = `/api/uploads/files/chat/${filename}`;

    let viewer = '';
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (token && process.env.JWT_SECRET) {
      try {
        const d = jwt.verify(token, process.env.JWT_SECRET);
        viewer = d.username != null ? String(d.username) : '';
      } catch {
        viewer = '';
      }
    }

    const rows = await Msg.readOnlyAll();
    let allowed = false;
    for (let i = 0; i < rows.length; i += 1) {
      const m = rows[i];
      const att = m.attachments;
      if (!Array.isArray(att)) continue;
      const hit = att.some((a) => a && attachmentMatchesUrl(a.url, publicUrl));
      if (!hit) continue;
      const conv = await Conv.findById(m.conversationId);
      if (!conv) continue;
      if (String(conv.type) === 'global') {
        allowed = true;
        break;
      }
      if (viewer && userInConversation(viewer, conv)) {
        allowed = true;
        break;
      }
    }

    if (!allowed) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!fs.existsSync(abs)) {
      return res.status(404).json({ message: 'Not found' });
    }

    // Always a download, never a page: an upload must not be able to run in this site.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return res.sendFile(abs);
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Error' });
  }
}

module.exports = serveChatFile;
