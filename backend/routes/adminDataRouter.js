/**
 * Full JSON store + uploads backup/restore (admin only).
 *
 * Large sites: default export is a streaming ZIP (collections.json + uploads/**) — no per-file size cap.
 * Legacy single-file JSON/gzip with base64 uploads (v1) is still supported for import.
 */
const express = require('express');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const multer = require('multer');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');
const {
  DATA_DIR,
  UPLOADS_DIR,
  DEFAULT_COLLECTIONS,
  loadAllCollectionsSnapshot,
  replaceAllCollectionsFromSnapshot,
} = require('../repositories/jsonStore');

const EXPORT_FORMAT = 'support-center-full-export';
/** Legacy: single JSON file with optional base64 uploads object. */
const EXPORT_VERSION_LEGACY = 1;
/** ZIP package or JSON collections-only (no embedded uploads). */
const EXPORT_VERSION_PACKAGE = 2;

const router = express.Router();

const importUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) =>
      cb(null, `sc-import-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.bin`),
  }),
  limits: { fileSize: 64 * 1024 * 1024 * 1024 },
});

function safeRelUploadPath(rel) {
  const norm = String(rel || '').trim().replace(/\\/g, '/');
  if (!norm || norm.includes('..')) return null;
  const segments = norm.split('/').filter((p) => p.length > 0);
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] === '..') return null;
  }
  const joined = path.join(UPLOADS_DIR, ...segments);
  const resolved = path.resolve(joined);
  const root = path.resolve(UPLOADS_DIR);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return null;
  }
  return segments.join('/');
}

function normalizeZipEntryPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

async function writeUploadsFromPayload(uploadsObj) {
  if (!uploadsObj || typeof uploadsObj !== 'object') {
    return { written: 0, skipped: 0 };
  }
  let written = 0;
  let skipped = 0;
  const entries = Object.entries(uploadsObj);
  for (let i = 0; i < entries.length; i += 1) {
    const rel = entries[i][0];
    const b64 = entries[i][1];
    const safe = safeRelUploadPath(rel);
    if (!safe) {
      skipped += 1;
      continue;
    }
    try {
      const buf = Buffer.from(String(b64), 'base64');
      const dest = path.join(UPLOADS_DIR, ...safe.split('/'));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buf);
      written += 1;
    } catch {
      skipped += 1;
    }
  }
  return { written, skipped };
}

async function appendUploadDirToArchive(archive, currentAbs, relFromUploadRoot) {
  let entries;
  try {
    entries = await fs.readdir(currentAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (let i = 0; i < entries.length; i += 1) {
    const ent = entries[i];
    const name = ent.name;
    const abs = path.join(currentAbs, name);
    const rel = relFromUploadRoot ? `${relFromUploadRoot}/${name}` : name;
    const relPosix = rel.split(path.sep).join('/');
    if (ent.isDirectory()) {
      await appendUploadDirToArchive(archive, abs, relPosix);
    } else {
      const st = await fs.stat(abs);
      if (!st.isFile()) continue;
      archive.file(abs, { name: `uploads/${relPosix}` });
    }
  }
}

async function importFromZipFile(zipPath) {
  const directory = await unzipper.Open.file(zipPath);
  const files = directory.files || [];

  let manifest = null;
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    if (f.type && f.type !== 'File') continue;
    const p = normalizeZipEntryPath(f.path);
    if (p !== 'collections.json') continue;
    if (typeof f.buffer !== 'function') continue;
    const b = await f.buffer();
    manifest = JSON.parse(b.toString('utf8'));
    break;
  }

  if (!manifest || manifest.format !== EXPORT_FORMAT) {
    throw new Error('Invalid backup: collections.json missing or wrong format field');
  }
  if (!manifest.collections || typeof manifest.collections !== 'object') {
    throw new Error('Invalid backup: missing collections object');
  }

  const ver = Number(manifest.version);
  if (ver !== EXPORT_VERSION_LEGACY && ver !== EXPORT_VERSION_PACKAGE) {
    throw new Error(`Unsupported export version: ${manifest.version}`);
  }

  await replaceAllCollectionsFromSnapshot(manifest.collections);

  if (manifest.uploads && typeof manifest.uploads === 'object') {
    await writeUploadsFromPayload(manifest.uploads);
  }

  let written = 0;
  let skipped = 0;
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    if (f.type && f.type !== 'File') continue;
    const p = normalizeZipEntryPath(f.path);
    if (!p.startsWith('uploads/')) continue;
    if (p === 'uploads/' || p.endsWith('/')) continue;
    const rel = p.slice('uploads/'.length);
    const safe = safeRelUploadPath(rel);
    if (!safe) {
      skipped += 1;
      continue;
    }
    if (typeof f.stream !== 'function') {
      skipped += 1;
      continue;
    }
    const dest = path.join(UPLOADS_DIR, ...safe.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await new Promise((resolve, reject) => {
      const ws = fsSync.createWriteStream(dest);
      const rs = f.stream();
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
    written += 1;
  }

  return { uploadsWritten: written, uploadsSkippedInvalid: skipped };
}

router.get('/admin/data/export', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fmt = String(req.query.format || 'zip').toLowerCase();

  try {
    if (fmt === 'zip') {
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (err) => {
        if (!res.headersSent) {
          res.status(500).json({ message: err.message || 'Archive error' });
        }
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="support-center-export-${stamp}.zip"`,
      );
      archive.pipe(res);

      const collections = await loadAllCollectionsSnapshot();
      const manifest = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION_PACKAGE,
        exportedAt: new Date().toISOString(),
        dataDirNote: DATA_DIR,
        collectionsList: [...DEFAULT_COLLECTIONS],
        transport: 'zip',
        collections,
      };
      archive.append(JSON.stringify(manifest, null, 2), { name: 'collections.json' });
      await appendUploadDirToArchive(archive, UPLOADS_DIR, '');
      await archive.finalize();
      return undefined;
    }

    const collections = await loadAllCollectionsSnapshot();
    const payload = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION_PACKAGE,
      exportedAt: new Date().toISOString(),
      dataDirNote: DATA_DIR,
      collectionsList: [...DEFAULT_COLLECTIONS],
      transport: 'json-collections-only',
      collections,
    };
    const json = JSON.stringify(payload);

    if (fmt === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="support-center-export-${stamp}.json"`,
      );
      return res.send(json);
    }

    if (fmt === 'gzip' || fmt === 'json-gzip') {
      const gz = zlib.gzipSync(Buffer.from(json, 'utf8'));
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="support-center-export-${stamp}.json.gz"`,
      );
      return res.send(gz);
    }

    if (fmt === 'legacy-json' || fmt === 'legacy-gzip') {
      const { uploads } = await gatherUploadsAsBase64Legacy();
      const legacy = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION_LEGACY,
        exportedAt: new Date().toISOString(),
        dataDirNote: DATA_DIR,
        collectionsList: [...DEFAULT_COLLECTIONS],
        collections,
        uploads,
        uploadExportNote:
          'Legacy single-file format with base64 uploads. Prefer format=zip for large / multi-GB sites.',
      };
      const legacyJson = JSON.stringify(legacy);
      if (fmt === 'legacy-json') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="support-center-export-legacy-${stamp}.json"`,
        );
        return res.send(legacyJson);
      }
      const gz = zlib.gzipSync(Buffer.from(legacyJson, 'utf8'));
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="support-center-export-legacy-${stamp}.json.gz"`,
      );
      return res.send(gz);
    }

    return res.status(400).json({
      message:
        'Unknown format. Use format=zip (default), json, gzip, or legacy-json / legacy-gzip.',
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ message: err.message || 'Export failed' });
    }
  }
});

/** Legacy exporter: embed all uploads as base64 (may use huge RAM on large sites). */
async function gatherUploadsAsBase64Legacy() {
  const uploads = {};
  async function walk(currentAbs, relPosix) {
    let entries;
    try {
      entries = await fs.readdir(currentAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (let i = 0; i < entries.length; i += 1) {
      const ent = entries[i];
      const name = ent.name;
      const abs = path.join(currentAbs, name);
      const rel = relPosix ? `${relPosix}/${name}` : name;
      if (ent.isDirectory()) {
        await walk(abs, rel);
      } else {
        const buf = await fs.readFile(abs);
        uploads[rel.split(path.sep).join('/')] = buf.toString('base64');
      }
    }
  }
  try {
    await fs.access(UPLOADS_DIR);
    await walk(UPLOADS_DIR, '');
  } catch {
    /* ignore */
  }
  return { uploads };
}

router.post(
  '/admin/data/import',
  jwtMiddleware,
  isAdminMiddleware,
  importUpload.single('file'),
  async (req, res) => {
    req.setTimeout(0);
    res.setTimeout(0);

    const cleanup = async () => {
      if (req.file && req.file.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
    };

    try {
      if (!req.file || !req.file.path) {
        return res.status(400).json({ message: 'Missing file upload (field name: file)' });
      }

      const fp = req.file.path;
      const fh = await fs.open(fp, 'r');
      const magic = Buffer.alloc(4);
      await fh.read(magic, 0, 4, 0);
      await fh.close();

      if (magic[0] === 0x50 && magic[1] === 0x4b) {
        const result = await importFromZipFile(fp);
        await cleanup();
        return res.json({
          ok: true,
          message: 'Import completed',
          collectionsReplaced: DEFAULT_COLLECTIONS.length,
          uploadsWritten: result.uploadsWritten,
          uploadsSkippedInvalid: result.uploadsSkippedInvalid,
        });
      }

      let body = await fs.readFile(fp);
      if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
        try {
          // A small file can expand to fill all memory, so the result has a ceiling.
          body = zlib.gunzipSync(body, { maxOutputLength: 1024 * 1024 * 1024 });
        } catch {
          await cleanup();
          return res.status(400).json({ message: 'Invalid gzip file' });
        }
      }

      let result;
      try {
        const data = JSON.parse(body.toString('utf8'));
        if (!data || data.format !== EXPORT_FORMAT) {
          await cleanup();
          return res.status(400).json({ message: 'Not a support-center export file' });
        }
        const ver = Number(data.version);
        if (!data.collections || typeof data.collections !== 'object') {
          await cleanup();
          return res.status(400).json({ message: 'Missing collections object' });
        }

        await replaceAllCollectionsFromSnapshot(data.collections);

        if (ver === EXPORT_VERSION_LEGACY) {
          const up = await writeUploadsFromPayload(data.uploads || {});
          result = { uploadsWritten: up.written, uploadsSkippedInvalid: up.skipped };
        } else if (ver === EXPORT_VERSION_PACKAGE) {
          result = { uploadsWritten: 0, uploadsSkippedInvalid: 0 };
        } else {
          await cleanup();
          return res.status(400).json({
            message: `Unsupported export version ${data.version} in JSON file (use .zip for full restore with files)`,
          });
        }
      } catch (e) {
        await cleanup();
        if (e instanceof SyntaxError) {
          return res.status(400).json({ message: 'Invalid JSON' });
        }
        throw e;
      }

      await cleanup();
      return res.json({
        ok: true,
        message: 'Import completed',
        collectionsReplaced: DEFAULT_COLLECTIONS.length,
        uploadsWritten: result.uploadsWritten,
        uploadsSkippedInvalid: result.uploadsSkippedInvalid,
      });
    } catch (err) {
      await cleanup();
      res.status(400).json({ message: err.message || 'Import failed' });
    }
  },
);

module.exports = router;
