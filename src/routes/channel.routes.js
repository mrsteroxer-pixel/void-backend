// src/routes/channel.routes.js
const router = require('express').Router();
const { listChannels, createChannel, deleteChannel } = require('../controllers/channel.controller');
const { requireAuth } = require('../middleware/auth');

router.get('/space/:spaceId',    requireAuth, listChannels);
router.post('/space/:spaceId',   requireAuth, createChannel);
router.delete('/:channelId',     requireAuth, deleteChannel);

module.exports = router;
