/**
 * Delivers messages written here to the other chat platform (see docs/CHAT_API.md).
 *
 * Each outgoing message is saved to an outbox first, so it survives restarts and outages.
 * An app with a webhook gets messages pushed to it, with retries. An app without one
 * collects them from GET /api/v1/chat/outbox and acknowledges each one.
 */
const crypto = require('crypto');
const { collections } = require('../repositories/jsonStore');
const { logFailure } = require('../utils/failureLog');

const Outbox = collections.chatOutbox;
const IntegrationKey = collections.integrationKeys;
const Msg = collections.chatMessages;

const TICK_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;
const RETRY_DELAYS_MS = [5000, 30000, 120000, 600000, 1800000, 3600000];
const MAX_RESPONSE_CHARS = 10000;
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;

let timer = null;
let running = false;
let runAgain = false;

function nowIso() {
  return new Date().toISOString();
}

function signBody(secret, timestamp, body) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `sha256=${mac}`;
}

async function setMessageDelivery(messageId, status, extra = {}) {
  await Msg.updateById(messageId, { delivery: { status, at: nowIso() }, ...extra });
}

function eventFor(row) {
  return {
    id: row._id,
    type: 'chat.message',
    createdAt: row.createdAt,
    conversation: row.conversation,
    message: row.message,
  };
}

/** Saves a message written here for delivery. Returns the message with its delivery status. */
async function enqueueOutbound(conv, msg) {
  let replyTo = null;
  if (msg.replyToMessageId) {
    const parent = await Msg.findById(msg.replyToMessageId);
    replyTo = { id: msg.replyToMessageId, externalId: parent?.externalId ?? null };
  }
  // Marked before it enters the outbox, so this can never overwrite a faster "delivered".
  const updated = await Msg.updateById(msg._id, { delivery: { status: 'pending', at: nowIso() } });
  await Outbox.insert({
    source: conv.source,
    conversationId: String(conv._id),
    messageId: String(msg._id),
    status: 'pending',
    attempts: 0,
    nextAttemptAt: nowIso(),
    conversation: { id: String(conv._id), externalId: conv.externalId, title: conv.title },
    message: {
      id: String(msg._id),
      text: msg.text || '',
      from: { username: msg.fromUsername, displayName: msg.fromDisplayName },
      attachments: (msg.attachments || []).map((a) => ({
        url: a.url,
        name: a.name,
        mime: a.mime,
        size: a.size,
      })),
      replyTo,
    },
  });
  kick();
  return updated || msg;
}

async function markDelivered(row, externalId) {
  await Outbox.updateById(row._id, { status: 'delivered', deliveredAt: nowIso(), lastError: null });
  await setMessageDelivery(row.messageId, 'delivered', externalId ? { externalId } : {});
}

async function markFailed(row, error) {
  await Outbox.updateById(row._id, { status: 'failed', lastError: error });
  await setMessageDelivery(row.messageId, 'failed');
}

/** Sends one request. Redirects count as failures, so a webhook cannot bounce to another address. */
async function postToWebhook(key, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(key.webhookUrl, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'PituahHomePage-ChatBridge/1.0',
      'X-Event-Id': String(payload.id),
      'X-Timestamp': timestamp,
      'X-Signature': signBody(key.webhookSecret, timestamp, body),
    },
    body,
  });
  const text = (await res.text().catch(() => '')).slice(0, MAX_RESPONSE_CHARS);
  return { ok: res.status >= 200 && res.status < 300, status: res.status, text };
}

function externalIdFromResponse(text) {
  try {
    const parsed = JSON.parse(text);
    const value = parsed && parsed.externalId;
    if (typeof value === 'string' || typeof value === 'number') {
      const id = String(value).trim();
      return id && id.length <= 200 ? id : null;
    }
  } catch {
    /* A webhook does not have to return JSON. */
  }
  return null;
}

async function attempt(row, key) {
  let result;
  try {
    result = await postToWebhook(key, eventFor(row));
  } catch (err) {
    result = { ok: false, error: err.name === 'TimeoutError' ? 'Timed out' : 'Could not connect' };
  }
  if (result.ok) {
    await markDelivered(row, externalIdFromResponse(result.text));
    return true;
  }
  const error = result.error || `Webhook returned HTTP ${result.status}`;
  const attempts = (row.attempts || 0) + 1;
  if (attempts > RETRY_DELAYS_MS.length) {
    await Outbox.updateById(row._id, { attempts });
    await markFailed(row, error);
    return false;
  }
  await Outbox.updateById(row._id, {
    attempts,
    lastError: error,
    nextAttemptAt: new Date(Date.now() + RETRY_DELAYS_MS[attempts - 1]).toISOString(),
  });
  return false;
}

async function cleanUp(rows, keysBySource) {
  const now = Date.now();
  const staleIds = new Set();
  for (const row of rows) {
    const age = now - new Date(row.createdAt).getTime();
    if (row.status !== 'pending') {
      if (age > KEEP_FINISHED_MS) staleIds.add(row._id);
    } else if (!keysBySource.has(row.source)) {
      await markFailed(row, 'The app is no longer connected');
    } else if (!keysBySource.get(row.source).webhookUrl && age > POLL_EXPIRES_MS) {
      await markFailed(row, 'The app did not collect this message in time');
    }
  }
  if (staleIds.size > 0) await Outbox.keepWhere((r) => !staleIds.has(r._id));
}

async function processOutbox() {
  const keys = await IntegrationKey.all();
  const keysBySource = new Map(keys.map((k) => [k.source, k]));
  const rows = await Outbox.all();
  await cleanUp(rows, keysBySource);

  const now = Date.now();
  const pending = rows
    .filter((r) => r.status === 'pending' && keysBySource.get(r.source)?.webhookUrl)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // A message that is still retrying holds back later ones in its conversation, to keep them in order.
  const held = new Set();
  for (const row of pending) {
    if (!held.has(row.conversationId)) {
      if (new Date(row.nextAttemptAt).getTime() > now) {
        held.add(row.conversationId);
      } else {
        // eslint-disable-next-line no-await-in-loop
        const delivered = await attempt(row, keysBySource.get(row.source));
        if (!delivered) held.add(row.conversationId);
      }
    }
  }
}

async function runWorker() {
  if (running) {
    runAgain = true;
    return;
  }
  running = true;
  try {
    do {
      runAgain = false;
      // eslint-disable-next-line no-await-in-loop
      await processOutbox();
    } while (runAgain);
  } catch (err) {
    logFailure('chatBridge.worker', err, {});
  } finally {
    running = false;
  }
}

function kick() {
  setImmediate(runWorker);
}

function startChatBridge() {
  if (timer) return;
  timer = setInterval(runWorker, TICK_MS);
  timer.unref();
  kick();
}

/** Sends a harmless test event straight away, so an admin can check the webhook. */
async function sendWebhookTest(key) {
  const payload = {
    id: `test-${crypto.randomUUID()}`,
    type: 'test',
    createdAt: nowIso(),
    message: 'This is a test from Pituah Home Page.',
  };
  try {
    const result = await postToWebhook(key, payload);
    return result.ok
      ? { ok: true, status: result.status }
      : { ok: false, status: result.status, error: `Webhook returned HTTP ${result.status}` };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'Timed out' : 'Could not connect' };
  }
}

async function deliveryStats() {
  const stats = new Map();
  const rows = await Outbox.all();
  for (const row of rows) {
    if (!stats.has(row.source)) stats.set(row.source, { pending: 0, failed: 0, lastError: null });
    const s = stats.get(row.source);
    if (row.status === 'pending') {
      s.pending += 1;
      if (row.lastError) s.lastError = row.lastError;
    } else if (row.status === 'failed') {
      s.failed += 1;
      if (row.lastError) s.lastError = row.lastError;
    }
  }
  return stats;
}

async function retryFailed(source) {
  const rows = await Outbox.find((r) => r.source === source && r.status === 'failed');
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await Outbox.updateById(row._id, { status: 'pending', attempts: 0, lastError: null, nextAttemptAt: nowIso() });
    // eslint-disable-next-line no-await-in-loop
    await setMessageDelivery(row.messageId, 'pending');
  }
  kick();
  return rows.length;
}

module.exports = {
  enqueueOutbound,
  startChatBridge,
  sendWebhookTest,
  deliveryStats,
  retryFailed,
  markDelivered,
  markFailed,
  eventFor,
  kick,
};
