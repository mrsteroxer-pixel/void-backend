// src/middleware/upload.js
const multer = require('multer');
const path   = require('path');
const crypto = require('crypto');
const fs     = require('fs');

const UPLOAD_DIR     = process.env.UPLOAD_DIR || 'uploads';
const MAX_SIZE_BYTES = (parseInt(process.env.MAX_FILE_SIZE_MB) || 100) * 1024 * 1024;

const ALLOWED_TYPES = (process.env.ALLOWED_FILE_TYPES || '').split(',').map(t => t.trim());
const IMAGE_TYPES   = (process.env.ALLOWED_IMAGE_TYPES || '').split(',').map(t => t.trim());

// Sub-directories
const DIRS = {
  attachments: path.join(UPLOAD_DIR, 'attachments'),
  avatars:     path.join(UPLOAD_DIR, 'avatars'),
  banners:     path.join(UPLOAD_DIR, 'banners'),
  emoji:       path.join(UPLOAD_DIR, 'emoji'),
};

// Create dirs on startup
Object.values(DIRS).forEach(dir => fs.mkdirSync(dir, { recursive: true }));

// ── Storage engine ────────────────────────────────────────────
const makeStorage = (subdir) => multer.diskStorage({
  destination: (req, file, cb) => cb(null, subdir),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = crypto.randomBytes(16).toString('hex');
    cb(null, `${name}${ext}`);
  },
});

// ── File filter ───────────────────────────────────────────────
const makeFilter = (allowedTypes) => (req, file, cb) => {
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type not allowed: ${file.mimetype}`), false);
  }
};

// ── Uploaders ─────────────────────────────────────────────────
const uploadAttachment = multer({
  storage:  makeStorage(DIRS.attachments),
  limits:   { fileSize: MAX_SIZE_BYTES },
  fileFilter: makeFilter(ALLOWED_TYPES),
}).array('files', 10);  // up to 10 files at once — free on VOID

const uploadAvatar = multer({
  storage:  makeStorage(DIRS.avatars),
  limits:   { fileSize: 8 * 1024 * 1024 },  // 8MB for avatars
  fileFilter: makeFilter(IMAGE_TYPES),
}).single('avatar');

const uploadBanner = multer({
  storage:  makeStorage(DIRS.banners),
  limits:   { fileSize: 10 * 1024 * 1024 },
  fileFilter: makeFilter(IMAGE_TYPES),
}).single('banner');

const uploadEmoji = multer({
  storage:  makeStorage(DIRS.emoji),
  limits:   { fileSize: 1 * 1024 * 1024 },  // 1MB emoji
  fileFilter: makeFilter(IMAGE_TYPES),
}).single('emoji');

// ── Wrap multer in a promise for async/await ──────────────────
const promisifyUpload = (uploader) => (req, res) =>
  new Promise((resolve, reject) => {
    uploader(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          reject({ status: 413, message: `File too large. Max ${process.env.MAX_FILE_SIZE_MB || 100}MB` });
        } else {
          reject({ status: 400, message: err.message });
        }
      } else if (err) {
        reject({ status: 400, message: err.message });
      } else {
        resolve();
      }
    });
  });

module.exports = {
  uploadAttachment: promisifyUpload(uploadAttachment),
  uploadAvatar:     promisifyUpload(uploadAvatar),
  uploadBanner:     promisifyUpload(uploadBanner),
  uploadEmoji:      promisifyUpload(uploadEmoji),
  DIRS,
};
