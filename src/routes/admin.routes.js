// src/routes/admin.routes.js
const router = require('express').Router();
const {
  getSpaceOverview,
  updateMemberRole,
  takeModAction,
  deleteMessageMod,
  getModLog,
  updateChannelSettings,
  getBanList,
} = require('../controllers/admin.controller');
const { requireAuth } = require('../middleware/auth');

// Space overview (members, channels, recent actions)
router.get('/space/:spaceId',                         requireAuth, getSpaceOverview);

// Member management
router.patch('/space/:spaceId/members/:userId/role',  requireAuth, updateMemberRole);

// Moderation actions (warn, mute, kick, ban, unban)
router.post('/space/:spaceId/actions',                requireAuth, takeModAction);

// Delete a message as moderator
router.delete('/space/:spaceId/messages/:messageId',  requireAuth, deleteMessageMod);

// Moderation log
router.get('/space/:spaceId/log',                     requireAuth, getModLog);

// Channel settings (slowmode, nsfw, topic)
router.patch('/channels/:channelId/settings',         requireAuth, updateChannelSettings);

// Ban list
router.get('/space/:spaceId/bans',                    requireAuth, getBanList);

module.exports = router;
