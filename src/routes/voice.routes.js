// src/routes/voice.routes.js
const router = require('express').Router();
const { getVoiceState, getSpaceVoiceState } = require('../controllers/voice.controller');
const { requireAuth } = require('../middleware/auth');

router.get('/channel/:channelId',    requireAuth, getVoiceState);
router.get('/space/:spaceId',        requireAuth, getSpaceVoiceState);

module.exports = router;
