// src/controllers/voice.controller.js
const db = require('../config/db');
const { getVoiceRooms } = require('../socket/voice.socket');

// ── GET VOICE STATE FOR A CHANNEL ────────────────────────────────
const getVoiceState = async (req, res) => {
  try {
    const { channelId } = req.params;

    // Verify access
    const access = await db.query(
      `SELECT c.id, c.name, c.type FROM channels c
       JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2
       WHERE c.id = $1 AND c.type = 'voice'`,
      [channelId, req.user.id]
    );
    if (!access.rows.length) return res.status(403).json({ error: 'Access denied' });

    const rooms = getVoiceRooms();
    const participants = rooms[channelId] || [];

    return res.json({
      channel_id:   channelId,
      channel_name: access.rows[0].name,
      participants,
      count: participants.length,
    });
  } catch (err) {
    console.error('getVoiceState error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET ALL ACTIVE VOICE CHANNELS IN A SPACE ─────────────────────
const getSpaceVoiceState = async (req, res) => {
  try {
    const { spaceId } = req.params;

    const memberRes = await db.query(
      'SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!memberRes.rows.length) return res.status(403).json({ error: 'Not a member' });

    // Get all voice channels in the space
    const chansRes = await db.query(
      `SELECT id, name FROM channels WHERE space_id = $1 AND type = 'voice'`,
      [spaceId]
    );

    const rooms = getVoiceRooms();
    const result = chansRes.rows.map(ch => ({
      channel_id:   ch.id,
      channel_name: ch.name,
      participants: rooms[ch.id] || [],
      count:        (rooms[ch.id] || []).length,
    }));

    return res.json({ voice_channels: result });
  } catch (err) {
    console.error('getSpaceVoiceState error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { getVoiceState, getSpaceVoiceState };
