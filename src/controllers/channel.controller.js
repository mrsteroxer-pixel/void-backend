// src/controllers/channel.controller.js
const { z } = require('zod');
const db = require('../config/db');

const createSchema = z.object({
  name:      z.string().min(1).max(64).regex(/^[a-z0-9-_]+$/, 'Lowercase, numbers, hyphens only'),
  type:      z.enum(['text', 'voice', 'announcement', 'gated']).default('text'),
  topic:     z.string().max(256).optional(),
  is_nsfw:   z.boolean().default(false),
  is_gated:  z.boolean().default(false),
  required_tier_id: z.string().uuid().optional(),
});

// ── LIST CHANNELS ────────────────────────────────────────────────
const listChannels = async (req, res) => {
  try {
    const { spaceId } = req.params;

    const memberRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!memberRes.rows.length) return res.status(403).json({ error: 'Not a member' });

    const channelsRes = await db.query(
      `SELECT c.*,
        (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = FALSE) AS message_count
       FROM channels c
       WHERE c.space_id = $1
       ORDER BY c.position ASC, c.created_at ASC`,
      [spaceId]
    );

    return res.json({ channels: channelsRes.rows });
  } catch (err) {
    console.error('List channels error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── CREATE CHANNEL ───────────────────────────────────────────────
const createChannel = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const body = createSchema.parse(req.body);

    // Must be admin+
    const memberRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!memberRes.rows.length) return res.status(403).json({ error: 'Not a member' });
    if (!['owner', 'admin'].includes(memberRes.rows[0].role)) {
      return res.status(403).json({ error: 'Only admins can create channels' });
    }

    // Get next position
    const posRes = await db.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM channels WHERE space_id = $1',
      [spaceId]
    );

    const chanRes = await db.query(
      `INSERT INTO channels (space_id, name, type, topic, is_nsfw, is_gated, required_tier_id, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [spaceId, body.name, body.type, body.topic ?? null,
       body.is_nsfw, body.is_gated, body.required_tier_id ?? null,
       posRes.rows[0].next_pos]
    );

    return res.status(201).json({ channel: chanRes.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.errors });
    console.error('Create channel error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── DELETE CHANNEL ───────────────────────────────────────────────
const deleteChannel = async (req, res) => {
  try {
    const { channelId } = req.params;

    const chanRes = await db.query(
      `SELECT c.space_id, sm.role FROM channels c
       JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2
       WHERE c.id = $1`,
      [channelId, req.user.id]
    );
    if (!chanRes.rows.length) return res.status(404).json({ error: 'Channel not found' });
    if (!['owner', 'admin'].includes(chanRes.rows[0].role)) {
      return res.status(403).json({ error: 'Only admins can delete channels' });
    }

    await db.query('DELETE FROM channels WHERE id = $1', [channelId]);
    return res.json({ deleted: true, id: channelId });
  } catch (err) {
    console.error('Delete channel error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { listChannels, createChannel, deleteChannel };
