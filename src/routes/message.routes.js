// src/routes/message.routes.js
const router = require('express').Router();
const { getMessages, getThread, editMessage, deleteMessage, pinMessage, toggleReaction } = require('../controllers/message.controller');
const { requireAuth } = require('../middleware/auth');

router.get('/channel/:channelId',        requireAuth, getMessages);
router.get('/:messageId/thread',         requireAuth, getThread);
router.patch('/:messageId',              requireAuth, editMessage);
router.delete('/:messageId',             requireAuth, deleteMessage);
router.patch('/:messageId/pin',          requireAuth, pinMessage);
router.post('/:messageId/react',         requireAuth, toggleReaction);

module.exports = router;
