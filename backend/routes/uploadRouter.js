const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');
const { UPLOADS_DIR } = require('../repositories/jsonStore');

const router = express.Router();

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function extensionForMime(mime) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  return map[mime] || '';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext =
      extensionForMime(file.mimetype) ||
      path.extname(file.originalname || '').slice(0, 8).toLowerCase();
    const safeExt = /^\.(jpe?g|png|gif|webp)$/.test(ext) ? ext : extensionForMime(file.mimetype) || '.img';
    const id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
    cb(null, `${id}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, GIF, or WebP images are allowed'));
    }
  },
});

router.post('/uploads/image', jwtMiddleware, isAdminMiddleware, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: err.message || 'Upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    const url = `/api/uploads/files/${req.file.filename}`;
    res.status(201).json({ url });
  });
});

module.exports = router;
