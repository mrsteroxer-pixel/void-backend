// src/routes/ai.routes.js
const router = require('express').Router();
const {
  summariseChannel,
  draftMessage,
  smartReplies,
  checkModeration,
  getMySummaries,
} = require('../controllers/ai.controller');
const { requireAuth } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

// AI endpoints get their own rate limiter — API calls cost money
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 20,
  message: { error: 'Too many AI requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/summary/:channelId',   requireAuth, aiLimiter, summariseChannel);
router.post('/draft',               requireAuth, aiLimiter, draftMessage);
router.get('/replies/:channelId',   requireAuth, aiLimiter, smartReplies);
router.post('/moderate',            requireAuth, aiLimiter, checkModeration);
router.get('/summaries',            requireAuth, getMySummaries);

module.exports = router;
