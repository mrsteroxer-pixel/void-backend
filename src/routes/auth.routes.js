// src/routes/auth.routes.js
const router = require('express').Router();
const { register, login, refresh, logout, me } = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

// Strict rate limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/register', authLimiter, register);
router.post('/login',    authLimiter, login);
router.post('/refresh',  refresh);
router.post('/logout',   requireAuth, logout);
router.get('/me',        requireAuth, me);

module.exports = router;
