// src/routes/monetization.routes.js
const router = require('express').Router();
const {
  listTiers, createTier, updateTier, deleteTier,
  subscribe, cancelSubscription, mySubscriptions,
  checkGatedAccess,
  getMyPoints, redeemPoints,
  getRevenueSummary,
} = require('../controllers/monetization.controller');
const { requireAuth } = require('../middleware/auth');

// ── Tiers ─────────────────────────────────────────────────────
router.get('/tiers/space/:spaceId',   requireAuth, listTiers);
router.post('/tiers/space/:spaceId',  requireAuth, createTier);
router.patch('/tiers/:tierId',        requireAuth, updateTier);
router.delete('/tiers/:tierId',       requireAuth, deleteTier);

// ── Subscriptions ─────────────────────────────────────────────
router.post('/subscribe/:tierId',     requireAuth, subscribe);
router.delete('/subscribe/:tierId',   requireAuth, cancelSubscription);
router.get('/my-subscriptions',       requireAuth, mySubscriptions);

// ── Gated channel access check ────────────────────────────────
router.get('/access/:channelId',      requireAuth, checkGatedAccess);

// ── Creator points ────────────────────────────────────────────
router.get('/points',                 requireAuth, getMyPoints);
router.post('/points/redeem',         requireAuth, redeemPoints);

// ── Revenue dashboard ─────────────────────────────────────────
router.get('/revenue/:spaceId',       requireAuth, getRevenueSummary);

module.exports = router;
