// src/routes/invite.routes.js
const router = require('express').Router();
const { createInvite, validateInvite, listInvites, revokeInvite } = require('../controllers/invite.controller');
const { requireAuth } = require('../middleware/auth');

// Public — check if an invite code is valid (shown on join page)
router.get('/validate/:code', validateInvite);

// Protected — manage invites
router.post('/',                    requireAuth, createInvite);
router.get('/space/:spaceId',       requireAuth, listInvites);
router.delete('/:inviteId/revoke',  requireAuth, revokeInvite);

module.exports = router;
