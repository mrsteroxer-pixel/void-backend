// src/socket/dm.socket.js
const db = require('../config/db');

const registerDMHandlers = (io, socket) => {
  const userId = socket.user.id;
  const handle = socket.user.handle;

  // Auto-join all DM thread rooms on connect
  const joinDMRooms = async () => {
    const threadsRes = await db.query(
      'SELECT thread_id FROM dm_participants WHERE user_id = $1',
      [userId]
    );
    for (const row of threadsRes.rows) {
      socket.join(`dm:${row.thread_id}`);
    }
  };
  joinDMRooms().catch(console.error);

  // ── SEND DM ─────────────────────────────────────────────────
  // Content is already AES-GCM encrypted by the client before sending.
  // The server stores and forwards ciphertext — it cannot read messages.
  socket.on('dm:send', async ({ thread_id, content_encrypted, content_iv }) => {
    try {
      if (!content_encrypted || !content_iv) {
        return socket.emit('error', { message: 'Encrypted content required' });
      }

      // Verify sender is a participant
      const partRes = await db.query(
        'SELECT 1 FROM dm_participants WHERE thread_id = $1 AND user_id = $2',
        [thread_id, userId]
      );
      if (!partRes.rows.length) {
        return socket.emit('error', { message: 'Access denied' });
      }

      // Store encrypted message
      const msgRes = await db.query(
        `INSERT INTO dm_messages (thread_id, author_id, content_encrypted, content_iv)
         VALUES ($1, $2, $3, $4)
         RETURNING id, thread_id, content_encrypted, content_iv, created_at`,
        [thread_id, userId, content_encrypted, content_iv]
      );
      const message = msgRes.rows[0];

      // Get author info
      const userRes = await db.query(
        'SELECT handle, display_name, avatar_url FROM users WHERE id = $1',
        [userId]
      );

      const fullMsg = {
        ...message,
        author: {
          id:           userId,
          handle:       userRes.rows[0]?.handle,
          display_name: userRes.rows[0]?.display_name,
          avatar_url:   userRes.rows[0]?.avatar_url,
        },
      };

      // Broadcast to all participants in this DM thread
      io.to(`dm:${thread_id}`).emit('dm:message', fullMsg);

      // Send push notification data (no content — E2E) to offline participants
      const participantsRes = await db.query(
        'SELECT user_id FROM dm_participants WHERE thread_id = $1 AND user_id != $2',
        [thread_id, userId]
      );

      for (const p of participantsRes.rows) {
        io.to(`user:${p.user_id}`).emit('dm:notification', {
          thread_id,
          from_handle: handle,
          // No content exposed in notification — privacy-first
          timestamp: message.created_at,
        });
      }

    } catch (err) {
      console.error('dm:send error:', err);
      socket.emit('error', { message: 'Failed to send DM' });
    }
  });

  // ── DELETE DM ────────────────────────────────────────────────
  socket.on('dm:delete', async ({ message_id }) => {
    try {
      const msgRes = await db.query(
        'SELECT * FROM dm_messages WHERE id = $1 AND author_id = $2',
        [message_id, userId]
      );
      if (!msgRes.rows.length) return;

      await db.query(
        'UPDATE dm_messages SET is_deleted = TRUE, content_encrypted = NULL, content_iv = NULL WHERE id = $1',
        [message_id]
      );

      io.to(`dm:${msgRes.rows[0].thread_id}`).emit('dm:deleted', {
        id: message_id,
        thread_id: msgRes.rows[0].thread_id,
      });
    } catch (err) {
      socket.emit('error', { message: 'Failed to delete DM' });
    }
  });

  // ── TYPING IN DM ─────────────────────────────────────────────
  socket.on('dm:typing:start', ({ thread_id }) => {
    socket.to(`dm:${thread_id}`).emit('dm:typing:start', { user_id: userId, handle, thread_id });
  });

  socket.on('dm:typing:stop', ({ thread_id }) => {
    socket.to(`dm:${thread_id}`).emit('dm:typing:stop', { user_id: userId, thread_id });
  });

  // ── MARK DM AS READ ──────────────────────────────────────────
  socket.on('dm:read', async ({ thread_id }) => {
    try {
      await db.query(
        'UPDATE dm_participants SET last_read_at = NOW() WHERE thread_id = $1 AND user_id = $2',
        [thread_id, userId]
      );
      socket.emit('dm:read:ack', { thread_id });
    } catch (err) {
      console.error('dm:read error:', err);
    }
  });
};

module.exports = { registerDMHandlers };
