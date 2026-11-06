/**
 * Requests API for other support apps (see docs/REQUESTS_API.md).
 *
 * Each connected app has its own API key. The key decides the ticket's `source`, so an app
 * can only read and change the requests it created itself.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');
const { collections } = require('../repositories/jsonStore');
const { logFailure } = require('../utils/failureLog');
const { sendWebhookTest, deliveryStats, retryFailed, kick } = require('../services/chatBridge');
const integrationChatRouter = require('./integrationChatRouter');

const router = express.Router();
const Ticket = collections.tickets;
const IntegrationKey = collections.integrationKeys;

const STATUSES = ['pending', 'in progress', 'closed'];
const KEY_PREFIX = 'sc_';
const MAX = { title: 200, description: 20000, name: 80, user: 200, department: 120, url: 2000, externalId: 200, phone: 40, comment: 10000 };
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

function hashKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function readBearerOrHeader(req) {
  const header = req.header('X-API-Key');
  if (header) return header.trim();
  const auth = req.header('Authorization') || '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

function safeEqualHex(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function apiKeyAuth(req, res, next) {
  try {
    const key = readBearerOrHeader(req);
    if (!key || !key.startsWith(KEY_PREFIX)) {
      return res.status(401).json({ error: 'A valid API key is required' });
    }
    const hash = hashKey(key);
    const rows = await IntegrationKey.all();
    const row = rows.find((r) => safeEqualHex(String(r.keyHash || ''), hash));
    if (!row) return res.status(401).json({ error: 'A valid API key is required' });
    req.integration = row;
    IntegrationKey.updateById(row._id, { lastUsedAt: new Date().toISOString() }).catch(() => {});
    return next();
  } catch (err) {
    logFailure('integration.auth', err, { path: req.path });
    return res.status(500).json({ error: 'Server error' });
  }
}

/** Runs after key auth so each connected app gets its own allowance. */
const perKeyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200,
  keyGenerator: (req) => String(req.integration?._id || 'unknown'),
  validate: false,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests; slow down and try again shortly.' },
});

/** Slows repeated guessing with bad keys, before any key lookup happens. */
const authAttemptLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2400,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests; slow down and try again shortly.' },
});

class ValidationError extends Error {}

function text(body, field, max, { required = false } = {}) {
  const raw = body[field];
  if (raw === undefined || raw === null) {
    if (required) throw new ValidationError(`${field} is required`);
    return undefined;
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new ValidationError(`${field} must be a string`);
  }
  const value = String(raw).trim();
  if (required && !value) throw new ValidationError(`${field} is required`);
  if (value.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return value;
}

/** Only http(s) links are kept, because the admin UI renders this value as a link. */
function externalUrl(body) {
  const value = text(body, 'externalUrl', MAX.url);
  if (value === undefined || value === '') return value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError('externalUrl must be a valid http or https URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('externalUrl must be a valid http or https URL');
  }
  return value;
}

function status(body) {
  const value = text(body, 'status', 20);
  if (value === undefined) return undefined;
  const norm = value.toLowerCase();
  if (!STATUSES.includes(norm)) {
    throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`);
  }
  return norm;
}

/** Fields an app may set. Identity fields such as source and _id are never taken from the body. */
function ticketFields(body, { creating }) {
  const out = {
    title: text(body, 'title', MAX.title, { required: creating }),
    description: text(body, 'description', MAX.description, { required: creating }),
    createdBy: text(body, 'createdBy', MAX.user, { required: creating }),
    department: text(body, 'department', MAX.department),
    assignedTo: text(body, 'assignedTo', MAX.user),
    phoneNumber: text(body, 'phoneNumber', MAX.phone),
    externalUrl: externalUrl(body),
    status: status(body),
  };
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}

function closeFields(previousStatus, nextStatus, actor) {
  if (nextStatus === undefined) return {};
  const wasClosed = String(previousStatus || '').toLowerCase() === 'closed';
  const isClosed = nextStatus === 'closed';
  if (!wasClosed && isClosed) return { closedAt: new Date().toISOString(), closedBy: actor };
  if (wasClosed && !isClosed) return { closedAt: null, closedBy: null };
  return {};
}

function serialize(t) {
  return {
    id: t._id,
    source: t.source,
    externalId: t.externalId ?? null,
    externalUrl: t.externalUrl ?? null,
    title: t.title,
    description: t.description,
    status: t.status,
    createdBy: t.createdBy,
    assignedTo: t.assignedTo ?? null,
    department: t.department ?? null,
    phoneNumber: t.phoneNumber ?? null,
    comments: Array.isArray(t.comments) ? t.comments : [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    closedAt: t.closedAt ?? null,
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
      logFailure(`integration.${op}`, err, { path: req.path, source: req.integration?.source });
      res.status(500).json({ error: 'Server error' });
    }
  };
}

async function ownTicket(req) {
  const row = await Ticket.findById(req.params.id);
  return row && row.source === req.integration.source ? row : null;
}

const api = express.Router();
api.use(authAttemptLimiter, apiKeyAuth, perKeyLimiter);

api.get('/whoami', (req, res) => {
  res.json({ name: req.integration.name, source: req.integration.source });
});

// Creates a request. With an externalId already seen for this app, updates it instead, so retries are safe.
api.post('/requests', handle('upsert', async (req, res) => {
  const body = req.body || {};
  const { source } = req.integration;
  const externalId = text(body, 'externalId', MAX.externalId) || null;

  if (externalId) {
    const existing = await Ticket.findOne((t) => t.source === source && t.externalId === externalId);
    if (existing) {
      const fields = ticketFields(body, { creating: false });
      const updated = await Ticket.updateById(existing._id, {
        ...fields,
        ...closeFields(existing.status, fields.status, source),
      });
      res.json(serialize(updated));
      return;
    }
  }

  const fields = ticketFields(body, { creating: true });
  const created = await Ticket.insert({
    status: 'pending',
    comments: [],
    ...fields,
    ...closeFields('pending', fields.status, source),
    source,
    externalId,
  });
  res.status(201).json(serialize(created));
}));

api.get('/requests', handle('list', async (req, res) => {
  const { source } = req.integration;
  const wantStatus = req.query.status != null ? String(req.query.status).toLowerCase() : null;
  if (wantStatus && !STATUSES.includes(wantStatus)) {
    throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`);
  }
  const externalId = req.query.externalId != null ? String(req.query.externalId) : null;
  let since = null;
  if (req.query.updatedSince != null) {
    since = new Date(String(req.query.updatedSince));
    if (Number.isNaN(since.getTime())) throw new ValidationError('updatedSince must be an ISO 8601 date');
  }
  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_PAGE) : DEFAULT_PAGE;
  const offsetRaw = Number(req.query.offset);
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  const rows = (await Ticket.find((t) => t.source === source))
    .filter((t) => !wantStatus || String(t.status).toLowerCase() === wantStatus)
    .filter((t) => externalId === null || t.externalId === externalId)
    .filter((t) => !since || new Date(t.updatedAt || t.createdAt) >= since)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ total: rows.length, limit, offset, requests: rows.slice(offset, offset + limit).map(serialize) });
}));

api.get('/requests/:id', handle('get', async (req, res) => {
  const row = await ownTicket(req);
  if (!row) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  res.json(serialize(row));
}));

api.patch('/requests/:id', handle('update', async (req, res) => {
  const row = await ownTicket(req);
  if (!row) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  const fields = ticketFields(req.body || {}, { creating: false });
  ['title', 'description', 'createdBy'].forEach((k) => {
    if (fields[k] === '') throw new ValidationError(`${k} cannot be empty`);
  });
  const updated = await Ticket.updateById(row._id, {
    ...fields,
    ...closeFields(row.status, fields.status, row.source),
  });
  res.json(serialize(updated));
}));

api.post('/requests/:id/comments', handle('comment', async (req, res) => {
  const row = await ownTicket(req);
  if (!row) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  const body = req.body || {};
  const commentText = text(body, 'text', MAX.comment, { required: true });
  const author = text(body, 'author', MAX.user) || row.source;
  const updated = await Ticket.updateById(row._id, (t) => ({
    comments: [
      ...(t.comments || []),
      { commentedBy: author, commentText, commentDate: new Date().toISOString() },
    ],
  }));
  res.status(201).json(serialize(updated));
}));

api.use('/chat', integrationChatRouter);

router.use('/v1', api);

// Key management for admins. The full key is returned only once, when it is created.
function publicKey(row, stats) {
  const delivery = stats?.get(row.source);
  return {
    id: row._id,
    name: row.name,
    source: row.source,
    keyPreview: row.keyPreview,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt || null,
    webhookUrl: row.webhookUrl || null,
    delivery: {
      pending: delivery?.pending || 0,
      failed: delivery?.failed || 0,
      lastError: delivery?.lastError || null,
    },
  };
}

function webhookSecret() {
  return `whsec_${crypto.randomBytes(32).toString('base64url')}`;
}

router.get('/integrations/keys', jwtMiddleware, isAdminMiddleware, handle('keys.list', async (req, res) => {
  const rows = await IntegrationKey.all();
  const stats = await deliveryStats();
  res.json(rows.map((row) => publicKey(row, stats)));
}));

router.post('/integrations/keys', jwtMiddleware, isAdminMiddleware, handle('keys.create', async (req, res) => {
  const name = text(req.body || {}, 'name', MAX.name, { required: true });
  const source = slugify(name);
  if (!source) throw new ValidationError('name must contain letters or numbers');
  const taken = await IntegrationKey.findOne((r) => r.source === source);
  if (taken) {
    res.status(409).json({ error: `An app named "${taken.name}" is already connected` });
    return;
  }
  const key = `${KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const row = await IntegrationKey.insert({
    name,
    source,
    keyHash: hashKey(key),
    keyPreview: `${key.slice(0, 7)}…${key.slice(-4)}`,
    createdBy: req.user.username,
  });
  res.status(201).json({ ...publicKey(row), key });
}));

router.delete('/integrations/keys/:id', jwtMiddleware, isAdminMiddleware, handle('keys.revoke', async (req, res) => {
  const removed = await IntegrationKey.deleteById(req.params.id);
  if (!removed) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  res.json({ ok: true });
}));

// Sets or clears the address that receives messages written here. A secret is created the first time.
router.put('/integrations/keys/:id/webhook', jwtMiddleware, isAdminMiddleware, handle('webhook.set', async (req, res) => {
  const row = await IntegrationKey.findById(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  const url = text(req.body || {}, 'webhookUrl', MAX.url);
  if (!url) {
    const cleared = await IntegrationKey.updateById(row._id, { webhookUrl: null, webhookSecret: null });
    res.json(publicKey(cleared));
    return;
  }
  const checked = externalUrl({ externalUrl: url });
  const secret = row.webhookSecret ? null : webhookSecret();
  const updated = await IntegrationKey.updateById(row._id, {
    webhookUrl: checked,
    ...(secret ? { webhookSecret: secret } : {}),
  });
  kick();
  res.json({ ...publicKey(updated), ...(secret ? { webhookSecret: secret } : {}) });
}));

router.post('/integrations/keys/:id/webhook/rotate-secret', jwtMiddleware, isAdminMiddleware, handle('webhook.rotate', async (req, res) => {
  const row = await IntegrationKey.findById(req.params.id);
  if (!row || !row.webhookUrl) {
    res.status(404).json({ error: 'This app has no webhook' });
    return;
  }
  const secret = webhookSecret();
  await IntegrationKey.updateById(row._id, { webhookSecret: secret });
  res.json({ webhookSecret: secret });
}));

router.post('/integrations/keys/:id/webhook/test', jwtMiddleware, isAdminMiddleware, handle('webhook.test', async (req, res) => {
  const row = await IntegrationKey.findById(req.params.id);
  if (!row || !row.webhookUrl) {
    res.status(404).json({ error: 'This app has no webhook' });
    return;
  }
  res.json(await sendWebhookTest(row));
}));

router.post('/integrations/keys/:id/retry-failed', jwtMiddleware, isAdminMiddleware, handle('webhook.retry', async (req, res) => {
  const row = await IntegrationKey.findById(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  res.json({ retried: await retryFailed(row.source) });
}));

module.exports = router;
