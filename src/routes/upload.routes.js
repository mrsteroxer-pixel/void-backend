// src/routes/upload.routes.js
const router = require('express').Router();
const {
  uploadFiles,
  updateAvatar,
  updateSpaceIcon,
  updateSpaceBanner,
  uploadCustomEmoji,
  listEmoji,
} = require('../controllers/upload.controller');
const { requireAuth } = require('../middleware/auth');

// Message attachments (up to 10 files, 100MB each — free on VOID)
router.post('/files',                       requireAuth, uploadFiles);

// User avatar (animated GIFs free)
router.post('/avatar',                      requireAuth, updateAvatar);

// Space assets
router.post('/space/:spaceId/icon',         requireAuth, updateSpaceIcon);
router.post('/space/:spaceId/banner',       requireAuth, updateSpaceBanner);

// Custom emoji (animated free)
router.post('/space/:spaceId/emoji',        requireAuth, uploadCustomEmoji);
router.get('/space/:spaceId/emoji',         requireAuth, listEmoji);

module.exports = router;
