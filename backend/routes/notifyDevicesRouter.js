/**
 * Computers that receive desktop notifications, at most MAX_DEVICES per person.
 * Each browser keeps a random device ID; people can see and disconnect their computers.
 */
const express = require('express');
const { jwtMiddleware } = require('../middlewares/jwtMiddleware');
const { collections } = require('../repositories/jsonStore');
const { logFailure } = require('../utils/failureLog');

const router = express.Router();
const Device = collections.notifyDevices;
const MAX_DEVICES = 5;
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

const norm = (u) => String(u || '').trim().toLowerCase();

/** A readable name such as "Edge on Windows", worked out on the server from the browser's user agent. */
function describe(ua) {
  const s = String(ua || '');
  let browser = 'Browser';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\//.test(s)) browser = 'Opera';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Safari\//.test(s)) browser = 'Safari';
  let os = 'unknown system';
  if (/Windows/.test(s)) os = 'Windows';
  else if (/Android/.test(s)) os = 'Android';
  else if (/iPhone|iPad/.test(s)) os = 'iOS';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  return `${browser} on ${os}`;
}

function publicRow(d) {
  return { id: d.deviceId, name: d.name, address: d.address || null, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt || d.createdAt };
}

function handle(op, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      logFailure(`notifyDevices.${op}`, err, { path: req.path });
      res.status(500).json({ error: 'Server error' });
    }
  };
}

router.get('/notify-devices', jwtMiddleware, handle('list', async (req, res) => {
  const me = norm(req.user.username);
  const rows = await Device.find((d) => d.username === me);
  rows.sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  res.json({ max: MAX_DEVICES, devices: rows.map(publicRow) });
}));

// Registers this computer, or marks it as still active. Refused when the person already has the maximum.
router.post('/notify-devices', jwtMiddleware, handle('register', async (req, res) => {
  const deviceId = String(req.body?.deviceId || '');
  if (!ID_PATTERN.test(deviceId)) return res.status(400).json({ error: 'deviceId is not valid' });
  const me = norm(req.user.username);
  const now = new Date().toISOString();
  const address = String(req.ip || '').replace(/^::ffff:/, '') || null;
  const fields = { name: describe(req.get('user-agent')), address, lastSeenAt: now };
  const existing = await Device.findOne((d) => d.username === me && d.deviceId === deviceId);
  if (existing) {
    const updated = await Device.updateById(existing._id, fields);
    return res.json({ device: publicRow(updated) });
  }
  const count = await Device.count((d) => d.username === me);
  if (count >= MAX_DEVICES) {
    return res.status(409).json({ error: `You already have ${MAX_DEVICES} computers with notifications on. Disconnect one first.`, max: MAX_DEVICES });
  }
  const created = await Device.insert({ username: me, deviceId, ...fields });
  return res.status(201).json({ device: publicRow(created) });
}));

// Checks whether this computer is still connected, without registering it.
router.get('/notify-devices/:deviceId', jwtMiddleware, handle('check', async (req, res) => {
  const me = norm(req.user.username);
  const row = await Device.findOne((d) => d.username === me && d.deviceId === String(req.params.deviceId));
  if (!row) return res.status(404).json({ error: 'This computer is not connected' });
  await Device.updateById(row._id, { lastSeenAt: new Date().toISOString() });
  return res.json({ device: publicRow(row) });
}));

router.delete('/notify-devices/:deviceId', jwtMiddleware, handle('remove', async (req, res) => {
  const me = norm(req.user.username);
  const row = await Device.findOne((d) => d.username === me && d.deviceId === String(req.params.deviceId));
  if (!row) return res.status(404).json({ error: 'Not found' });
  await Device.deleteById(row._id);
  return res.json({ ok: true });
}));

module.exports = router;
