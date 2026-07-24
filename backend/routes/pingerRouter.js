const express = require('express');
const { jwtMiddleware, pingerAccessMiddleware, pingerWriteMiddleware } = require('../middlewares/jwtMiddleware');
const { collections } = require('../repositories/jsonStore');
const { getStatusForHosts, invalidatePingerCache } = require('../utils/pingerProbe');
const { resolvePingerType } = require('../utils/pingerType');
const { normalizeConnectMode, sanitizeWebUrl } = require('../utils/pingerConnect');
const { logFailure } = require('../utils/failureLog');
const { probeSshFingerprint } = require('../utils/pingerSshFingerprintProbe');
const { getStoredFingerprint } = require('../utils/pingerSshHostKeys');

const router = express.Router();
const PingerHost = collections.pingerHosts;

function sortHosts(list) {
  return [...list].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a._id).localeCompare(String(b._id)),
  );
}

function parseImportHostList(body) {
  if (body == null) return null;
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && Array.isArray(body.hosts)) return body.hosts;
  return null;
}

/** JSON export: { hosts: [ { name, ip, type, connectMode, webUrl } ] } in sort order (name mirrors stored hostname). */
router.get('/pinger/hosts/export', jwtMiddleware, pingerAccessMiddleware, async (req, res) => {
  try {
    const all = sortHosts(await PingerHost.all());
    const hosts = all.map((r) => ({
      name: r.hostname != null ? String(r.hostname) : '',
      ip: r.ip != null ? String(r.ip) : '',
      type: r.type != null ? String(r.type) : '',
      connectMode: normalizeConnectMode(r.connectMode),
      webUrl: sanitizeWebUrl(r.webUrl),
    }));
    res.json({ hosts });
  } catch (e) {
    logFailure('pinger.hosts.export', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Export failed' });
  }
});

/** JSON import: required `name` (or `hostname`), `ip`, and `type`; optional `connectMode`, `webUrl`. Other keys ignored. Appends rows. */
router.post('/pinger/hosts/import', jwtMiddleware, pingerAccessMiddleware, pingerWriteMiddleware, async (req, res) => {
  try {
    const list = parseImportHostList(req.body);
    if (!list) {
      return res.status(400).json({ message: 'Body must be { hosts: [...] } or a JSON array' });
    }
    if (list.length === 0) {
      return res.json({ imported: 0, skipped: 0, hosts: [], skipDetails: [] });
    }
    let existing = sortHosts(await PingerHost.all());
    let maxOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder ?? 0), -1);
    const created = [];
    const skipDetails = [];
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        skipDetails.push({ index: i, reason: 'not an object' });
        continue;
      }
      const hostname = String(
        row.name !== undefined && row.name !== null ? row.name : row.hostname ?? '',
      ).trim();
      const ip = String(row.ip !== undefined && row.ip !== null ? row.ip : '').trim();
      if (!hostname || !ip) {
        skipDetails.push({ index: i, reason: 'missing name or ip' });
        continue;
      }
      const typeRaw = row.type !== undefined && row.type !== null ? String(row.type) : '';
      const resolvedType = resolvePingerType(typeRaw, existing);
      const connectMode = normalizeConnectMode(
        row.connectMode !== undefined && row.connectMode !== null ? row.connectMode : 'none',
      );
      const webUrl = sanitizeWebUrl(row.webUrl);
      maxOrder += 1;
      const inserted = await PingerHost.insert({
        hostname,
        ip,
        type: resolvedType,
        sortOrder: maxOrder,
        connectMode,
        webUrl,
      });
      created.push(inserted);
      existing = sortHosts([...existing, inserted]);
    }
    invalidatePingerCache();
    res.status(201).json({
      imported: created.length,
      skipped: skipDetails.length,
      hosts: created,
      skipDetails,
    });
  } catch (e) {
    logFailure('pinger.hosts.import', e, { path: req.path });
    res.status(400).json({ message: e.message || 'Import failed' });
  }
});

router.get('/pinger/status', jwtMiddleware, pingerAccessMiddleware, async (req, res) => {
  try {
    const forceFresh =
      req.query.fresh === '1' ||
      req.query.fresh === 'true' ||
      String(req.query.fresh || '').toLowerCase() === 'yes';
    if (forceFresh) {
      invalidatePingerCache();
    }
    let all = sortHosts(await PingerHost.all());
    const payload = await getStatusForHosts(all);
    const enrich = (rows) => {
      const byId = new Map(all.map((r) => [String(r._id), r]));
      return rows.map((h) => ({
        ...h,
        lastDownSince: byId.get(String(h._id))?.lastDownSince ?? null,
      }));
    };
    payload.hosts = enrich(payload.hosts);
    if (!payload.fromCache) {
      await PingerHost.syncDownTimestamps(payload.hosts);
      all = sortHosts(await PingerHost.all());
      payload.hosts = enrich(payload.hosts);
    }
    delete payload.fromCache;
    res.json(payload);
  } catch (e) {
    logFailure('pinger.status', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Pinger status failed' });
  }
});

router.post('/pinger/hosts', jwtMiddleware, pingerAccessMiddleware, pingerWriteMiddleware, async (req, res) => {
  try {
    const { hostname, ip, type, connectMode, webUrl } = req.body || {};
    const h = String(hostname || '').trim();
    const target = String(ip || '').trim();
    if (!h || !target) {
      return res.status(400).json({ message: 'hostname and ip are required' });
    }
    const existing = await PingerHost.all();
    const maxOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder ?? 0), -1);
    const resolvedType = resolvePingerType(type, existing);
    const created = await PingerHost.insert({
      hostname: h,
      ip: target,
      type: resolvedType,
      sortOrder: maxOrder + 1,
      connectMode: normalizeConnectMode(connectMode),
      webUrl: sanitizeWebUrl(webUrl),
    });
    invalidatePingerCache();
    res.status(201).json(created);
  } catch (e) {
    logFailure('pinger.hosts.create', e, { path: req.path });
    res.status(400).json({ message: e.message || 'Create failed' });
  }
});

/** Must be registered before PUT /pinger/hosts/:id or Express treats "reorder" as an id. */
router.put('/pinger/hosts/reorder', jwtMiddleware, pingerAccessMiddleware, pingerWriteMiddleware, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'ids must be a non-empty array' });
    }
    const all = await PingerHost.all();
    const normalized = ids.map((id) => String(id).trim());
    const idSet = new Set(all.map((r) => String(r._id)));
    if (normalized.length !== all.length || new Set(normalized).size !== all.length) {
      return res.status(400).json({ message: 'ids must list each host exactly once' });
    }
    for (let i = 0; i < normalized.length; i += 1) {
      if (!idSet.has(normalized[i])) {
        return res.status(400).json({ message: 'Unknown host id in ids' });
      }
    }
    await PingerHost.reorderByIds(normalized);
    invalidatePingerCache();
    const next = sortHosts(await PingerHost.all());
    res.json({ ok: true, hosts: next });
  } catch (e) {
    logFailure('pinger.hosts.reorder', e, { path: req.path });
    res.status(400).json({ message: e.message || 'Reorder failed' });
  }
});

router.put('/pinger/hosts/:id', jwtMiddleware, pingerAccessMiddleware, pingerWriteMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { hostname, ip, type, sortOrder, connectMode, webUrl } = req.body || {};
    const patch = {};
    if (hostname !== undefined) patch.hostname = String(hostname).trim();
    if (ip !== undefined) patch.ip = String(ip).trim();
    if (type !== undefined) {
      const all = await PingerHost.all();
      patch.type = resolvePingerType(type, all, id);
    }
    if (sortOrder !== undefined) patch.sortOrder = Number(sortOrder) || 0;
    if (connectMode !== undefined) patch.connectMode = normalizeConnectMode(connectMode);
    if (webUrl !== undefined) patch.webUrl = sanitizeWebUrl(webUrl);
    const updated = await PingerHost.updateById(id, patch);
    if (!updated) return res.status(404).json({ message: 'Host not found' });
    if (!String(updated.hostname || '').trim() || !String(updated.ip || '').trim()) {
      return res.status(400).json({ message: 'hostname and ip are required' });
    }
    invalidatePingerCache();
    res.json(updated);
  } catch (e) {
    logFailure('pinger.hosts.update', e, { path: req.path, id: req.params.id });
    res.status(400).json({ message: e.message || 'Update failed' });
  }
});

/** SSH host key fingerprint (TOFU) — TCP handshake only, no credentials stored. */
router.get('/pinger/ssh-fingerprint', jwtMiddleware, pingerAccessMiddleware, async (req, res) => {
  try {
    const hostId = String(req.query.hostId || '').trim();
    const port = Math.min(65535, Math.max(1, Number(req.query.port) || 22));
    if (!hostId) {
      return res.status(400).json({ message: 'hostId is required' });
    }
    const row = await PingerHost.findById(hostId);
    if (!row) return res.status(404).json({ message: 'Host not found' });
    const sshHost = String(row.ip || '').trim();
    if (!sshHost) return res.status(400).json({ message: 'Host has no address' });
    const known = await getStoredFingerprint(sshHost, port);
    const probe = await probeSshFingerprint(sshHost, port);
    if (probe.error) {
      return res.json({
        hostname: row.hostname || sshHost,
        host: sshHost,
        port,
        error: probe.error,
        known: known || undefined,
      });
    }
    const fp = probe.fingerprint || '';
    const changed = !!(known && fp && known !== fp);
    res.json({
      hostname: row.hostname || sshHost,
      host: sshHost,
      port,
      fingerprint: fp,
      known: known || undefined,
      changed,
    });
  } catch (e) {
    logFailure('pinger.ssh.fingerprint', e, { path: req.path });
    res.status(500).json({ message: e.message || 'Fingerprint probe failed' });
  }
});

router.delete('/pinger/hosts/:id', jwtMiddleware, pingerAccessMiddleware, pingerWriteMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await PingerHost.deleteById(id);
    if (!deleted) return res.status(404).json({ message: 'Host not found' });
    invalidatePingerCache();
    res.json(deleted);
  } catch (e) {
    logFailure('pinger.hosts.delete', e, { path: req.path, id: req.params.id });
    res.status(400).json({ message: e.message || 'Delete failed' });
  }
});

module.exports = router;
