// src/routes/dm.routes.js
const router = require('express').Router();
const { getOrCreateThread, listThreads, getMessages, deleteMessage, createGroupDM } = require('../controllers/dm.controller');
const { requireAuth } = require('../middleware/auth');

router.get('/threads',               requireAuth, listThreads);
router.post('/threads/group',        requireAuth, createGroupDM);
router.get('/threads/:threadId',     requireAuth, getMessages);
router.post('/with/:userId',         requireAuth, getOrCreateThread);
router.delete('/messages/:messageId',requireAuth, deleteMessage);

module.exports = router;
