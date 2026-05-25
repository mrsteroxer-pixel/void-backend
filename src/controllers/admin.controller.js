// src/controllers/admin.controller.js
const { z }  = require('zod');
const db     = require('../config/db');

// ═══════════════════════════════════════════════════════════════
//  SPACE MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// ── GET SPACE OVERVIEW ────────────────────────────────────────
const getSpaceOverview = async (req, res) => {
  try {
    const { spaceId } = req.params;

    const memberRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!memberRes.rows.length || !['owner', 'admin', 'moderator'].includes(memberRes.rows[0].role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const [spaceRes, membersRes, channelsRes, recentActionsRes] = await Promise.all([
      db.query('SELECT * FROM spaces WHERE id = $1', [spaceId]),
      db.query(
        `SELECT u.id, u.handle, u.display_name, u.avatar_url, u.status,
                u.is_banned, u.created_at AS joined_platform_at,
                sm.role, sm.joined_at, sm.muted_until
         FROM space_members sm
         JOIN users u ON u.id = sm.user_id
         WHERE sm.space_id = $1
         ORDER BY sm.role ASC, sm.joined_at ASC`,
        [spaceId]
      ),
      db.query(
        'SELECT id, name, type, is_gated, slowmode_secs FROM channels WHERE space_id = $1 ORDER BY position ASC',
        [spaceId]
      ),
      db.query(
        `SELECT ma.*, u.handle AS moderator_handle, t.handle AS target_handle
         FROM mod_actions ma
         JOIN users u ON u.id = ma.moderator_id
         LEFT JOIN users t ON t.id = ma.target_user_id
         WHERE ma.space_id = $1
         ORDER BY ma.created_at DESC LIMIT 20`,
        [spaceId]
      ),
    ]);

    return res.json({
      space:          spaceRes.rows[0],
      members:        membersRes.rows,
      channels:       channelsRes.rows,
      recent_actions: recentActionsRes.rows,
    });
  } catch (err) {
    console.error('getSpaceOverview error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── UPDATE MEMBER ROLE ────────────────────────────────────────
const updateMemberRole = async (req, res) => {
  try {
    const { spaceId, userId } = req.params;
    const { role } = z.object({ role: z.enum(['admin', 'moderator', 'member']) }).parse(req.body);

    // Only owner can assign admin; admins can assign moderator/member
    const myRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!myRes.rows.length) return res.status(403).json({ error: 'Not a member' });
    const myRole = myRes.rows[0].role;

    if (myRole === 'moderator') return res.status(403).json({ error: 'Moderators cannot change roles' });
    if (role === 'admin' && myRole !== 'owner') return res.status(403).json({ error: 'Only owners can assign admins' });

    // Cannot change owner's role
    const targetRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, userId]
    );
    if (!targetRes.rows.length) return res.status(404).json({ error: 'Member not found' });
    if (targetRes.rows[0].role === 'owner') return res.status(403).json({ error: 'Cannot change owner role' });

    await db.query(
      'UPDATE space_members SET role = $1 WHERE space_id = $2 AND user_id = $3',
      [role, spaceId, userId]
    );

    // Log it
    await db.query(
      `INSERT INTO mod_actions (space_id, moderator_id, target_user_id, action, reason)
       VALUES ($1, $2, $3, 'warn', $4)`,
      [spaceId, req.user.id, userId, `Role changed to ${role}`]
    );

    return res.json({ updated: true, user_id: userId, new_role: role });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid role' });
    console.error('updateMemberRole error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ═══════════════════════════════════════════════════════════════
//  MODERATION ACTIONS
// ═══════════════════════════════════════════════════════════════

const modActionSchema = z.object({
  target_user_id:    z.string().uuid(),
  action:            z.enum(['warn', 'mute', 'kick', 'ban', 'unban']),
  reason:            z.string().max(500).optional(),
  duration_minutes:  z.number().int().positive().optional(), // for mute
});

// ── TAKE MOD ACTION ───────────────────────────────────────────
const takeModAction = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const body = modActionSchema.parse(req.body);

    // Verify moderator permissions
    const myRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!myRes.rows.length || !['owner', 'admin', 'moderator'].includes(myRes.rows[0].role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // Cannot moderate owner or someone of equal/higher role
    const targetRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, body.target_user_id]
    );
    if (!targetRes.rows.length) return res.status(404).json({ error: 'Target not in this space' });

    const roleHierarchy = { owner: 4, admin: 3, moderator: 2, member: 1 };
    const myLevel     = roleHierarchy[myRes.rows[0].role];
    const targetLevel = roleHierarchy[targetRes.rows[0].role];
    if (targetLevel >= myLevel) {
      return res.status(403).json({ error: 'Cannot moderate someone with equal or higher role' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      let expiresAt = null;

      switch (body.action) {
        case 'mute': {
          const mins = body.duration_minutes || 60;
          expiresAt  = new Date(Date.now() + mins * 60 * 1000).toISOString();
          await client.query(
            'UPDATE space_members SET muted_until = $1 WHERE space_id = $2 AND user_id = $3',
            [expiresAt, spaceId, body.target_user_id]
          );
          break;
        }
        case 'kick':
          await client.query(
            'DELETE FROM space_members WHERE space_id = $1 AND user_id = $2',
            [spaceId, body.target_user_id]
          );
          break;
        case 'ban':
          await client.query(
            'DELETE FROM space_members WHERE space_id = $1 AND user_id = $2',
            [spaceId, body.target_user_id]
          );
          // Also revoke all their invites in this space
          await client.query(
            'UPDATE invites SET is_revoked = TRUE WHERE space_id = $1 AND created_by = $2',
            [spaceId, body.target_user_id]
          );
          break;
        case 'unban':
          // No action needed on space_members — they were removed
          // Just log it so they can be re-invited
          break;
        case 'warn':
          // Warn is just a log entry — no DB change needed
          break;
      }

      // Log the action
      await client.query(
        `INSERT INTO mod_actions (space_id, moderator_id, target_user_id, action, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [spaceId, req.user.id, body.target_user_id, body.action, body.reason ?? null, expiresAt]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return res.json({
      success:  true,
      action:   body.action,
      user_id:  body.target_user_id,
      reason:   body.reason,
      expires_at: null,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.errors });
    console.error('takeModAction error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── DELETE MESSAGE (mod) ──────────────────────────────────────
const deleteMessageMod = async (req, res) => {
  try {
    const { spaceId, messageId } = req.params;
    const { reason } = req.body;

    const myRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!myRes.rows.length || !['owner', 'admin', 'moderator'].includes(myRes.rows[0].role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const msgRes = await db.query(
      `SELECT m.* FROM messages m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.id = $1 AND c.space_id = $2`,
      [messageId, spaceId]
    );
    if (!msgRes.rows.length) return res.status(404).json({ error: 'Message not found' });

    await db.query('UPDATE messages SET is_deleted = TRUE, content = NULL WHERE id = $1', [messageId]);

    await db.query(
      `INSERT INTO mod_actions (space_id, moderator_id, target_user_id, target_message_id, action, reason)
       VALUES ($1, $2, $3, $4, 'delete_message', $5)`,
      [spaceId, req.user.id, msgRes.rows[0].author_id, messageId, reason ?? null]
    );

    return res.json({ deleted: true, message_id: messageId });
  } catch (err) {
    console.error('deleteMessageMod error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET MOD LOG ───────────────────────────────────────────────
const getModLog = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const myRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!myRes.rows.length || !['owner', 'admin', 'moderator'].includes(myRes.rows[0].role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const logRes = await db.query(
      `SELECT ma.*,
              mod.handle AS moderator_handle, mod.display_name AS moderator_name,
              tgt.handle AS target_handle,    tgt.display_name AS target_name
       FROM mod_actions ma
       JOIN users mod ON mod.id = ma.moderator_id
       LEFT JOIN users tgt ON tgt.id = ma.target_user_id
       WHERE ma.space_id = $1
       ORDER BY ma.created_at DESC
       LIMIT $2 OFFSET $3`,
      [spaceId, parseInt(limit), parseInt(offset)]
    );

    const countRes = await db.query(
      'SELECT COUNT(*) FROM mod_actions WHERE space_id = $1', [spaceId]
    );

    return res.json({
      log:   logRes.rows,
      total: parseInt(countRes.rows[0].count),
    });
  } catch (err) {
    console.error('getModLog error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── UPDATE CHANNEL SETTINGS ───────────────────────────────────
const updateChannelSettings = async (req, res) => {
  try {
    const { channelId } = req.params;
    const body = z.object({
      slowmode_secs: z.number().int().min(0).max(21600).optional(),
      is_nsfw:       z.boolean().optional(),
      topic:         z.string().max(256).optional(),
    }).parse(req.body);

    const chanRes = await db.query(
      `SELECT c.*, sm.role FROM channels c
       JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2
       WHERE c.id = $1`,
      [channelId, req.user.id]
    );
    if (!chanRes.rows.length) return res.status(404).json({ error: 'Channel not found' });
    if (!['owner', 'admin', 'moderator'].includes(chanRes.rows[0].role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const fields = [], values = [];
    let idx = 1;
    if (body.slowmode_secs !== undefined) { fields.push(`slowmode_secs = $${idx++}`); values.push(body.slowmode_secs); }
    if (body.is_nsfw       !== undefined) { fields.push(`is_nsfw = $${idx++}`);       values.push(body.is_nsfw); }
    if (body.topic         !== undefined) { fields.push(`topic = $${idx++}`);         values.push(body.topic); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    values.push(channelId);
    const updated = await db.query(
      `UPDATE channels SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      values
    );

    return res.json({ channel: updated.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.errors });
    console.error('updateChannelSettings error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET BAN LIST ──────────────────────────────────────────────
const getBanList = async (req, res) => {
  try {
    const { spaceId } = req.params;

    const myRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!myRes.rows.length || !['owner', 'admin'].includes(myRes.rows[0].role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const bansRes = await db.query(
      `SELECT ma.target_user_id, ma.reason, ma.created_at,
              u.handle, u.display_name, u.avatar_url,
              mod.handle AS banned_by
       FROM mod_actions ma
       JOIN users u   ON u.id = ma.target_user_id
       JOIN users mod ON mod.id = ma.moderator_id
       WHERE ma.space_id = $1 AND ma.action = 'ban'
       ORDER BY ma.created_at DESC`,
      [spaceId]
    );

    return res.json({ bans: bansRes.rows });
  } catch (err) {
    console.error('getBanList error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  getSpaceOverview,
  updateMemberRole,
  takeModAction,
  deleteMessageMod,
  getModLog,
  updateChannelSettings,
  getBanList,
};
