// src/controllers/dm.controller.js
const { z } = require('zod');
const db = require('../config/db');

const sendSchema = z.object({
  content_encrypted: z.string().min(1),  // AES-GCM ciphertext (base64)
  content_iv:        z.string().min(1),  // IV (base64)
});

// ── GET OR CREATE DM THREAD (1:1) ────────────────────────────────
const getOrCreateThread = async (req, res) => {
  try {
    const { userId } = req.params;  // the other user
    const meId = req.user.id;

    if (userId === meId) {
      return res.status(400).json({ error: 'Cannot DM yourself' });
    }

    // Check other user exists
    const otherRes = await db.query(
      'SELECT id, handle, display_name, avatar_url, status FROM users WHERE id = $1',
      [userId]
    );
    if (!otherRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const other = otherRes.rows[0];

    // Find existing 1:1 thread between these two users
    const existingRes = await db.query(
      `SELECT dt.id FROM dm_threads dt
       JOIN dm_participants dp1 ON dp1.thread_id = dt.id AND dp1.user_id = $1
       JOIN dm_participants dp2 ON dp2.thread_id = dt.id AND dp2.user_id = $2
       WHERE dt.is_group = FALSE`,
      [meId, userId]
    );

    let threadId;
    if (existingRes.rows.length) {
      threadId = existingRes.rows[0].id;
    } else {
      // Create new thread
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const threadRes = await client.query(
          'INSERT INTO dm_threads (is_group) VALUES (FALSE) RETURNING id'
        );
        threadId = threadRes.rows[0].id;

        await client.query(
          'INSERT INTO dm_participants (thread_id, user_id) VALUES ($1, $2), ($1, $3)',
          [threadId, meId, userId]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    return res.json({
      thread_id: threadId,
      participant: other,
    });
  } catch (err) {
    console.error('Get/create DM thread error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── LIST MY DM THREADS ───────────────────────────────────────────
const listThreads = async (req, res) => {
  try {
    const meId = req.user.id;

    const threadsRes = await db.query(
      `SELECT
          dt.id AS thread_id,
          dt.is_group,
          dt.name AS group_name,
          dp_me.last_read_at,
          dp_me.is_muted,
          -- Last message preview (metadata only, not content — E2E)
          (SELECT created_at FROM dm_messages
           WHERE thread_id = dt.id AND is_deleted = FALSE
           ORDER BY created_at DESC LIMIT 1) AS last_message_at,
          -- Unread count
          (SELECT COUNT(*) FROM dm_messages
           WHERE thread_id = dt.id
             AND is_deleted = FALSE
             AND created_at > COALESCE(dp_me.last_read_at, '1970-01-01')
          ) AS unread_count,
          -- Other participants (for 1:1, just the other user)
          (SELECT json_agg(json_build_object(
            'id', u.id,
            'handle', u.handle,
            'display_name', u.display_name,
            'avatar_url', u.avatar_url,
            'status', u.status
          ))
          FROM dm_participants dp2
          JOIN users u ON u.id = dp2.user_id
          WHERE dp2.thread_id = dt.id AND dp2.user_id != $1
          ) AS participants
       FROM dm_threads dt
       JOIN dm_participants dp_me ON dp_me.thread_id = dt.id AND dp_me.user_id = $1
       ORDER BY last_message_at DESC NULLS LAST`,
      [meId]
    );

    return res.json({ threads: threadsRes.rows });
  } catch (err) {
    console.error('List threads error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET MESSAGES IN A THREAD (paginated) ─────────────────────────
// Note: content is returned as-is (still encrypted) — only the
// recipient's browser can decrypt it with their private key.
const getMessages = async (req, res) => {
  try {
    const { threadId } = req.params;
    const { before, limit = 50 } = req.query;
    const cap = Math.min(parseInt(limit), 100);

    // Verify participant
    const partRes = await db.query(
      'SELECT 1 FROM dm_participants WHERE thread_id = $1 AND user_id = $2',
      [threadId, req.user.id]
    );
    if (!partRes.rows.length) return res.status(403).json({ error: 'Access denied' });

    const params = [threadId, cap];
    const beforeClause = before
      ? `AND m.created_at < (SELECT created_at FROM dm_messages WHERE id = $3)`
      : '';
    if (before) params.push(before);

    const msgsRes = await db.query(
      `SELECT
          m.id, m.thread_id, m.content_encrypted, m.content_iv,
          m.is_deleted, m.created_at,
          u.id AS author_id, u.handle, u.display_name, u.avatar_url
       FROM dm_messages m
       JOIN users u ON u.id = m.author_id
       WHERE m.thread_id = $1
         ${beforeClause}
       ORDER BY m.created_at DESC
       LIMIT $2`,
      params
    );

    // Mark thread as read
    await db.query(
      'UPDATE dm_participants SET last_read_at = NOW() WHERE thread_id = $1 AND user_id = $2',
      [threadId, req.user.id]
    );

    return res.json({
      messages: msgsRes.rows.reverse(),
      has_more: msgsRes.rows.length === cap,
    });
  } catch (err) {
    console.error('Get DM messages error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── DELETE DM MESSAGE ────────────────────────────────────────────
const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;

    const msgRes = await db.query(
      `SELECT m.* FROM dm_messages m
       WHERE m.id = $1 AND m.author_id = $2`,
      [messageId, req.user.id]
    );
    if (!msgRes.rows.length) {
      return res.status(404).json({ error: 'Message not found or not yours' });
    }

    await db.query(
      'UPDATE dm_messages SET is_deleted = TRUE, content_encrypted = NULL, content_iv = NULL WHERE id = $1',
      [messageId]
    );

    return res.json({ deleted: true, id: messageId });
  } catch (err) {
    console.error('Delete DM error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── CREATE GROUP DM ──────────────────────────────────────────────
const createGroupDM = async (req, res) => {
  try {
    const { name, user_ids } = req.body;

    if (!Array.isArray(user_ids) || user_ids.length < 2 || user_ids.length > 9) {
      return res.status(400).json({ error: 'Group DMs require 2–9 other members' });
    }

    const allIds = [...new Set([req.user.id, ...user_ids])];

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const threadRes = await client.query(
        'INSERT INTO dm_threads (is_group, name) VALUES (TRUE, $1) RETURNING id',
        [name ?? null]
      );
      const threadId = threadRes.rows[0].id;

      for (const uid of allIds) {
        await client.query(
          'INSERT INTO dm_participants (thread_id, user_id) VALUES ($1, $2)',
          [threadId, uid]
        );
      }

      await client.query('COMMIT');
      return res.status(201).json({ thread_id: threadId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Create group DM error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { getOrCreateThread, listThreads, getMessages, deleteMessage, createGroupDM };
