// src/controllers/message.controller.js
const { z } = require('zod');
const db = require('../config/db');

const sendSchema = z.object({
  content: z.string().min(1).max(4000),
  thread_id: z.string().uuid().optional(),
});

const editSchema = z.object({
  content: z.string().min(1).max(4000),
});

// ── GET MESSAGES (paginated) ─────────────────────────────────────
const getMessages = async (req, res) => {
  try {
    const { channelId } = req.params;
    const { before, limit = 50 } = req.query;
    const cap = Math.min(parseInt(limit), 100);

    // Verify user is a member of the space this channel belongs to
    const accessRes = await db.query(
      `SELECT c.id FROM channels c
       JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2
       WHERE c.id = $1`,
      [channelId, req.user.id]
    );
    if (!accessRes.rows.length) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const params = [channelId, cap];
    const beforeClause = before
      ? `AND m.created_at < (SELECT created_at FROM messages WHERE id = $3)`
      : '';
    if (before) params.push(before);

    const msgsRes = await db.query(
      `SELECT
          m.id, m.content, m.type, m.thread_id, m.is_pinned,
          m.is_deleted, m.edited_at, m.created_at,
          u.id AS author_id, u.handle, u.display_name, u.avatar_url, u.avatar_animated,
          (SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.id) AS reply_count,
          (
            SELECT json_agg(json_build_object('emoji', r.emoji, 'count', r.cnt))
            FROM (
              SELECT emoji, COUNT(*) AS cnt
              FROM reactions WHERE message_id = m.id
              GROUP BY emoji
            ) r
          ) AS reactions
       FROM messages m
       LEFT JOIN users u ON u.id = m.author_id
       WHERE m.channel_id = $1
         AND m.thread_id IS NULL
         ${beforeClause}
       ORDER BY m.created_at DESC
       LIMIT $2`,
      params
    );

    return res.json({
      messages: msgsRes.rows.reverse(),
      has_more: msgsRes.rows.length === cap,
    });
  } catch (err) {
    console.error('Get messages error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET THREAD REPLIES ───────────────────────────────────────────
const getThread = async (req, res) => {
  try {
    const { messageId } = req.params;

    // Verify access
    const accessRes = await db.query(
      `SELECT m.id FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2
       WHERE m.id = $1`,
      [messageId, req.user.id]
    );
    if (!accessRes.rows.length) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const repliesRes = await db.query(
      `SELECT m.id, m.content, m.type, m.edited_at, m.created_at,
              u.id AS author_id, u.handle, u.display_name, u.avatar_url
       FROM messages m
       LEFT JOIN users u ON u.id = m.author_id
       WHERE m.thread_id = $1 AND m.is_deleted = FALSE
       ORDER BY m.created_at ASC`,
      [messageId]
    );

    return res.json({ replies: repliesRes.rows });
  } catch (err) {
    console.error('Get thread error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── EDIT MESSAGE ─────────────────────────────────────────────────
const editMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { content } = editSchema.parse(req.body);

    const msgRes = await db.query(
      'SELECT * FROM messages WHERE id = $1 AND is_deleted = FALSE',
      [messageId]
    );
    if (!msgRes.rows.length) return res.status(404).json({ error: 'Message not found' });

    const msg = msgRes.rows[0];
    if (msg.author_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit your own messages' });
    }

    const updated = await db.query(
      `UPDATE messages SET content = $1, edited_at = NOW()
       WHERE id = $2 RETURNING id, content, edited_at`,
      [content, messageId]
    );

    return res.json({ message: updated.rows[0] });
  } catch (err) {
    console.error('Edit message error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── DELETE MESSAGE ───────────────────────────────────────────────
const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;

    const msgRes = await db.query(
      `SELECT m.*, sm.role
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2
       WHERE m.id = $1`,
      [messageId, req.user.id]
    );
    if (!msgRes.rows.length) return res.status(404).json({ error: 'Message not found' });

    const msg = msgRes.rows[0];
    const canDelete = msg.author_id === req.user.id ||
                      ['owner', 'admin', 'moderator'].includes(msg.role);

    if (!canDelete) return res.status(403).json({ error: 'Cannot delete this message' });

    await db.query(
      'UPDATE messages SET is_deleted = TRUE, content = NULL WHERE id = $1',
      [messageId]
    );

    return res.json({ deleted: true, id: messageId });
  } catch (err) {
    console.error('Delete message error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── PIN MESSAGE ──────────────────────────────────────────────────
const pinMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { pinned } = req.body;

    // Must be mod+
    const msgRes = await db.query(
      `SELECT m.channel_id, sm.role FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2
       WHERE m.id = $1`,
      [messageId, req.user.id]
    );
    if (!msgRes.rows.length) return res.status(404).json({ error: 'Message not found' });
    if (!['owner', 'admin', 'moderator'].includes(msgRes.rows[0].role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    await db.query('UPDATE messages SET is_pinned = $1 WHERE id = $2', [!!pinned, messageId]);
    return res.json({ pinned: !!pinned, id: messageId });
  } catch (err) {
    console.error('Pin message error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── TOGGLE REACTION ──────────────────────────────────────────────
const toggleReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji) return res.status(400).json({ error: 'Emoji required' });

    // Check if reaction exists
    const existing = await db.query(
      'SELECT 1 FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, req.user.id, emoji]
    );

    if (existing.rows.length) {
      await db.query(
        'DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
        [messageId, req.user.id, emoji]
      );
      return res.json({ action: 'removed', emoji });
    } else {
      await db.query(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
        [messageId, req.user.id, emoji]
      );
      return res.json({ action: 'added', emoji });
    }
  } catch (err) {
    console.error('Reaction error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { getMessages, getThread, editMessage, deleteMessage, pinMessage, toggleReaction };
