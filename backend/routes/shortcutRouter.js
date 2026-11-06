const express = require('express');
const jwt = require('jsonwebtoken');
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');
const { collections } = require('../repositories/jsonStore');
const { logFailure } = require('../utils/failureLog');
const { isDangerousUrl } = require('../utils/safeUrl');
const { placeholderEmailForUsername } = require('../utils/userEmailDomain');

const router = express.Router();
const Shortcut = collections.shortcuts;
const User = collections.users;

function normLogin(u) {
  return String(u || '').trim().toLowerCase();
}

function isBearerAdmin(req) {
  const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || !process.env.JWT_SECRET) return false;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return Boolean(decoded.isAdmin);
  } catch {
    return false;
  }
}

function parseAdminOnlyFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'y' || v === 'admin';
  }
  return false;
}

/** Coerce man-page metadata for a shortcut; drops empty rows and trims strings. */
function normalizeManPageFields(body) {
  const out = {};

  if (body.summary !== undefined) {
    out.summary = body.summary == null ? '' : String(body.summary).trim();
  }

  if (body.useCases !== undefined) {
    const list = Array.isArray(body.useCases) ? body.useCases : [];
    out.useCases = list
      .map((row) => (row == null ? '' : String(row).trim()))
      .filter((row) => row.length > 0);
  }

  if (body.examples !== undefined) {
    const list = Array.isArray(body.examples) ? body.examples : [];
    out.examples = list
      .map((row) => {
        if (!row || typeof row !== 'object') return null;
        const title = row.title == null ? '' : String(row.title).trim();
        const text = row.body == null ? '' : String(row.body);
        if (!title && !text.trim()) return null;
        return { title, body: text };
      })
      .filter((row) => row !== null);
  }

  return out;
}

/** No bundled org shortcuts; admins add tiles in the dashboard. */
const DEFAULT_SHORTCUTS = [];

async function ensureDefaultShortcuts() {
  const existing = await Shortcut.all();
  if (existing.length > 0) return;
  for (let i = 0; i < DEFAULT_SHORTCUTS.length; i += 1) {
    const row = DEFAULT_SHORTCUTS[i];
    await Shortcut.insert({
      ...row,
      sortOrder: i,
    });
  }
}

router.get('/shortcuts', async (req, res) => {
  try {
    await ensureDefaultShortcuts();
    const list = await Shortcut.all();
    list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.title || '').localeCompare(b.title || ''));
    const isAdmin = isBearerAdmin(req);
    const visible = isAdmin ? list : list.filter((s) => !s.adminOnly);
    res.json(visible);
  } catch (error) {
    logFailure('shortcuts.list', error, { path: req.path });
    res.status(500).json({ message: error.message });
  }
});

router.post('/shortcuts', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const { title, description, url, category, imgSrc, alt, sortOrder, adminOnly } = req.body;
    if (!title || !url) {
      return res.status(400).send('Title and URL are required');
    }
    if (isDangerousUrl(url)) {
      return res.status(400).send('URL must be a normal web address');
    }
    const manPage = normalizeManPageFields(req.body);
    const created = await Shortcut.insert({
      title: String(title).trim(),
      description: description != null ? String(description) : '',
      url: String(url).trim(),
      category: category != null ? String(category).trim() : 'General',
      imgSrc: imgSrc != null ? String(imgSrc).trim() : '',
      alt: alt != null ? String(alt).trim() : String(title).trim(),
      sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
      adminOnly: parseAdminOnlyFlag(adminOnly),
      summary: manPage.summary !== undefined ? manPage.summary : '',
      useCases: manPage.useCases !== undefined ? manPage.useCases : [],
      examples: manPage.examples !== undefined ? manPage.examples : [],
    });
    res.status(201).json(created);
  } catch (error) {
    logFailure('shortcuts.create', error, { path: req.path });
    res.status(400).json({ message: error.message });
  }
});

router.put('/shortcuts/:id', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, url, category, imgSrc, alt, sortOrder, adminOnly } = req.body;
    if (url !== undefined && isDangerousUrl(url)) {
      return res.status(400).send('URL must be a normal web address');
    }
    const patch = {};
    if (title !== undefined) patch.title = String(title).trim();
    if (description !== undefined) patch.description = String(description);
    if (url !== undefined) patch.url = String(url).trim();
    if (category !== undefined) patch.category = String(category).trim();
    if (imgSrc !== undefined) patch.imgSrc = String(imgSrc).trim();
    if (alt !== undefined) patch.alt = String(alt).trim();
    if (sortOrder !== undefined) patch.sortOrder = Number(sortOrder) || 0;
    if (adminOnly !== undefined) patch.adminOnly = parseAdminOnlyFlag(adminOnly);
    Object.assign(patch, normalizeManPageFields(req.body));
    const updated = await Shortcut.updateById(id, patch);
    if (!updated) return res.status(404).send('Shortcut not found');
    if (!String(updated.title || '').trim() || !String(updated.url || '').trim()) {
      return res.status(400).send('Title and URL are required');
    }
    res.json(updated);
  } catch (error) {
    logFailure('shortcuts.update', error, { path: req.path, id: req.params.id });
    res.status(400).json({ message: error.message });
  }
});

router.delete('/shortcuts/:id', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const deleted = await Shortcut.deleteById(req.params.id);
    if (!deleted) return res.status(404).send('Shortcut not found');
    res.json(deleted);
  } catch (error) {
    logFailure('shortcuts.delete', error, { path: req.path, id: req.params.id });
    res.status(500).json({ message: error.message });
  }
});

router.post('/shortcuts/import', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const { shortcuts } = req.body;
    if (!Array.isArray(shortcuts)) {
      return res.status(400).json({ message: 'Body must include a shortcuts array' });
    }
    const created = [];
    const skipped = [];
    for (const row of shortcuts) {
      if (!row || typeof row !== 'object') {
        skipped.push({ reason: 'invalid row' });
        continue;
      }
      const title = row.title != null ? String(row.title).trim() : '';
      const url = row.url != null ? String(row.url).trim() : '';
      if (!title || !url) {
        skipped.push({ title: title || '(empty)', reason: 'missing title or url' });
        continue;
      }
      if (isDangerousUrl(url)) {
        skipped.push({ title, reason: 'unsafe url' });
        continue;
      }
      const description = row.description != null ? String(row.description).trim() : '';
      const category =
        row.category != null && String(row.category).trim() !== ''
          ? String(row.category).trim()
          : 'General';
      const imgSrc = row.imgSrc != null ? String(row.imgSrc).trim() : '';
      const altRaw = row.alt != null ? String(row.alt).trim() : '';
      const alt = altRaw || title;
      let sortOrder = 0;
      if (row.sortOrder != null && String(row.sortOrder).trim() !== '') {
        const n = Number(row.sortOrder);
        if (!Number.isNaN(n)) sortOrder = n;
      }
      const manPage = normalizeManPageFields(row);
      const record = await Shortcut.insert({
        title,
        description,
        url,
        category,
        imgSrc,
        alt,
        sortOrder,
        adminOnly: parseAdminOnlyFlag(row.adminOnly),
        summary: manPage.summary !== undefined ? manPage.summary : '',
        useCases: manPage.useCases !== undefined ? manPage.useCases : [],
        examples: manPage.examples !== undefined ? manPage.examples : [],
      });
      created.push(record);
    }
    res.status(201).json({
      imported: created.length,
      skipped: skipped.length,
      shortcuts: created,
      skipDetails: skipped,
    });
  } catch (error) {
    logFailure('shortcuts.import', error, {
      path: req.path,
      count: Array.isArray(req.body?.shortcuts) ? req.body.shortcuts.length : 0,
    });
    res.status(500).json({ message: error.message || 'Import failed' });
  }
});

/** Per-user starred shortcuts (persisted on the user record). */
router.get('/shortcut-favorites', jwtMiddleware, async (req, res) => {
  try {
    const row = await User.findOne((u) => normLogin(u.username) === normLogin(req.user.username));
    if (!row) return res.json({ ids: [] });
    const ids = Array.isArray(row.favoriteShortcutIds) ? row.favoriteShortcutIds.map(String) : [];
    res.json({ ids });
  } catch (error) {
    logFailure('shortcuts.favorites.get', error, { path: req.path });
    res.status(500).json({ message: error.message || 'Server error' });
  }
});

router.patch('/shortcut-favorites', jwtMiddleware, async (req, res) => {
  try {
    const { shortcutId, favorite } = req.body;
    const id = shortcutId != null ? String(shortcutId).trim() : '';
    if (!id) return res.status(400).json({ message: 'shortcutId required' });
    const sc = await Shortcut.findOne((s) => String(s._id) === id);
    if (!sc) return res.status(404).json({ message: 'Shortcut not found' });
    const isAdminBearer = Boolean(req.user.isAdmin);
    if (sc.adminOnly && !isAdminBearer) {
      return res.status(403).json({ message: 'Not allowed for this shortcut' });
    }

    let row = await User.findOne((u) => normLogin(u.username) === normLogin(req.user.username));
    if (!row) {
      row = await User.insert({
        username: req.user.username,
        displayName: req.user.displayName || req.user.username,
        email: placeholderEmailForUsername(req.user.username),
        groups: [],
        isAdmin: isAdminBearer,
      });
    }
    const add = typeof favorite !== 'boolean'
      ? null
      : favorite;
    if (add === null) {
      return res.status(400).json({ message: 'favorite (boolean) required' });
    }
    const prev = Array.isArray(row.favoriteShortcutIds)
      ? row.favoriteShortcutIds.map(String).filter(Boolean)
      : [];
    const next = add ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id);
    const updated = await User.updateById(row._id, { favoriteShortcutIds: next });
    if (!updated) return res.status(500).json({ message: 'Update failed' });
    res.json({ ids: Array.isArray(updated.favoriteShortcutIds) ? updated.favoriteShortcutIds.map(String) : [] });
  } catch (error) {
    logFailure('shortcuts.favorites.patch', error, { path: req.path });
    res.status(500).json({ message: error.message || 'Server error' });
  }
});

module.exports = router;
