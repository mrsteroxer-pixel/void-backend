// src/controllers/upload.controller.js
const path  = require('path');
const fs    = require('fs');
const sharp = require('sharp');
const db    = require('../config/db');
const {
  uploadAttachment,
  uploadAvatar,
  uploadBanner,
  uploadEmoji,
  DIRS,
} = require('../middleware/upload');

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

// ── Helper: build public URL ──────────────────────────────────
const fileUrl = (filepath) =>
  `${BASE_URL}/uploads/${filepath.replace(/\\/g, '/').split('uploads/')[1]}`;

// ── Helper: detect if image is animated (GIF/WEBP) ───────────
const isAnimated = (mimetype) =>
  mimetype === 'image/gif' || mimetype === 'image/webp';

// ── UPLOAD MESSAGE ATTACHMENTS ───────────────────────────────
const uploadFiles = async (req, res) => {
  try {
    await uploadAttachment(req, res);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const { message_id } = req.body;

    const saved = [];
    for (const file of req.files) {
      let width = null, height = null;
      const isImg = file.mimetype.startsWith('image/');

      // Generate thumbnail for images (except animated GIFs — preserve them)
      if (isImg && file.mimetype !== 'image/gif') {
        try {
          const meta = await sharp(file.path).metadata();
          width  = meta.width;
          height = meta.height;
        } catch (_) {}
      }

      const url = fileUrl(file.path);

      // Persist to DB if linked to a message
      if (message_id) {
        const attRes = await db.query(
          `INSERT INTO attachments (message_id, url, filename, mime_type, size_bytes, width, height, is_animated)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [message_id, url, file.originalname, file.mimetype,
           file.size, width, height, isAnimated(file.mimetype)]
        );
        saved.push(attRes.rows[0]);
      } else {
        saved.push({
          url,
          filename:    file.originalname,
          mime_type:   file.mimetype,
          size_bytes:  file.size,
          width,
          height,
          is_animated: isAnimated(file.mimetype),
        });
      }
    }

    return res.status(201).json({ attachments: saved });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Upload files error:', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
};

// ── UPLOAD / UPDATE AVATAR ─────────────────────────────────────
// Animated avatars are FREE on VOID — no paywall
const updateAvatar = async (req, res) => {
  try {
    await uploadAvatar(req, res);

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const file = req.file;
    const animated = isAnimated(file.mimetype);
    let finalPath = file.path;

    // Resize static images to 256x256, preserve animated GIFs as-is
    if (!animated) {
      const resizedPath = file.path.replace(/(\.[^.]+)$/, '_256$1');
      await sharp(file.path)
        .resize(256, 256, { fit: 'cover', position: 'centre' })
        .toFile(resizedPath);
      fs.unlinkSync(file.path);
      finalPath = resizedPath;
    }

    const url = fileUrl(finalPath);

    // Delete old avatar file if it was local
    const oldRes = await db.query('SELECT avatar_url FROM users WHERE id = $1', [req.user.id]);
    if (oldRes.rows[0]?.avatar_url?.includes('/uploads/')) {
      const oldPath = oldRes.rows[0].avatar_url.replace(BASE_URL, '').replace('/uploads/', 'uploads/');
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    await db.query(
      'UPDATE users SET avatar_url = $1, avatar_animated = $2 WHERE id = $3',
      [url, animated, req.user.id]
    );

    return res.json({ avatar_url: url, avatar_animated: animated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Avatar upload error:', err);
    return res.status(500).json({ error: 'Avatar upload failed' });
  }
};

// ── UPLOAD SPACE ICON ─────────────────────────────────────────
const updateSpaceIcon = async (req, res) => {
  try {
    const { spaceId } = req.params;

    // Must be owner/admin
    const memberRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!memberRes.rows.length || !['owner', 'admin'].includes(memberRes.rows[0].role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    await uploadAvatar(req, res);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const file     = req.file;
    const animated = isAnimated(file.mimetype);
    let finalPath  = file.path;

    if (!animated) {
      const resizedPath = file.path.replace(/(\.[^.]+)$/, '_128$1');
      await sharp(file.path)
        .resize(128, 128, { fit: 'cover' })
        .toFile(resizedPath);
      fs.unlinkSync(file.path);
      finalPath = resizedPath;
    }

    const url = fileUrl(finalPath);

    await db.query(
      'UPDATE spaces SET icon_url = $1, icon_animated = $2 WHERE id = $3',
      [url, animated, spaceId]
    );

    return res.json({ icon_url: url, icon_animated: animated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Space icon upload error:', err);
    return res.status(500).json({ error: 'Icon upload failed' });
  }
};

// ── UPLOAD SPACE BANNER ───────────────────────────────────────
const updateSpaceBanner = async (req, res) => {
  try {
    const { spaceId } = req.params;

    const memberRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!memberRes.rows.length || !['owner', 'admin'].includes(memberRes.rows[0].role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    await uploadBanner(req, res);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const url = fileUrl(req.file.path);
    await db.query('UPDATE spaces SET banner_url = $1 WHERE id = $2', [url, spaceId]);

    return res.json({ banner_url: url });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Banner upload error:', err);
    return res.status(500).json({ error: 'Banner upload failed' });
  }
};

// ── UPLOAD CUSTOM EMOJI ───────────────────────────────────────
// Free on VOID — animated emoji included, no Nitro needed
const uploadCustomEmoji = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { name } = req.body;

    if (!name || !/^[a-z0-9_]+$/.test(name)) {
      return res.status(400).json({ error: 'Emoji name must be lowercase letters, numbers, underscores only' });
    }

    const memberRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!memberRes.rows.length || !['owner', 'admin', 'moderator'].includes(memberRes.rows[0].role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    await uploadEmoji(req, res);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const file     = req.file;
    const animated = isAnimated(file.mimetype);
    let finalPath  = file.path;

    // Resize static emoji to 64x64
    if (!animated) {
      const resizedPath = file.path.replace(/(\.[^.]+)$/, '_64$1');
      await sharp(file.path)
        .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toFile(resizedPath);
      fs.unlinkSync(file.path);
      finalPath = resizedPath;
    }

    const url = fileUrl(finalPath);

    const emojiRes = await db.query(
      `INSERT INTO custom_emoji (space_id, name, url, is_animated, uploaded_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (space_id, name) DO UPDATE SET url = $3, is_animated = $4
       RETURNING *`,
      [spaceId, name, url, animated, req.user.id]
    );

    return res.status(201).json({ emoji: emojiRes.rows[0] });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Emoji upload error:', err);
    return res.status(500).json({ error: 'Emoji upload failed' });
  }
};

// ── LIST CUSTOM EMOJI FOR SPACE ───────────────────────────────
const listEmoji = async (req, res) => {
  try {
    const { spaceId } = req.params;

    const memberRes = await db.query(
      'SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!memberRes.rows.length) return res.status(403).json({ error: 'Not a member' });

    const emojiRes = await db.query(
      'SELECT * FROM custom_emoji WHERE space_id = $1 ORDER BY name ASC',
      [spaceId]
    );

    return res.json({ emoji: emojiRes.rows });
  } catch (err) {
    console.error('List emoji error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  uploadFiles,
  updateAvatar,
  updateSpaceIcon,
  updateSpaceBanner,
  uploadCustomEmoji,
  listEmoji,
};
