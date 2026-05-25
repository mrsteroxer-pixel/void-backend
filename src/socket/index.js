// src/socket/index.js
const { verifyAccessToken } = require('../utils/jwt');
const { registerDMHandlers }    = require('./dm.socket');
const { registerVoiceHandlers } = require('./voice.socket');
const { moderateMessage }       = require('../controllers/ai.controller');
const db = require('../config/db');

const AI_USER_ID  = process.env.AI_USER_ID || '00000000-0000-0000-0000-000000000001';
const onlineUsers = new Map();

const registerSocketHandlers = (io) => {

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token ||
                    socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) return next(new Error('Authentication required'));
      const payload = verifyAccessToken(token);
      socket.user = payload;
      next();
    } catch { next(new Error('Invalid token')); }
  });

  io.on('connection', async (socket) => {
    const userId = socket.user.id;
    const handle = socket.user.handle;

    console.log(`[socket] connected: ${handle} (${socket.id})`);

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);

    socket.join(`user:${userId}`);
    await db.query('UPDATE users SET status = $1, last_seen_at = NOW() WHERE id = $2', ['online', userId]);

    const spacesRes = await db.query('SELECT space_id FROM space_members WHERE user_id = $1', [userId]);
    for (const row of spacesRes.rows) socket.join(`space:${row.space_id}`);
    for (const row of spacesRes.rows) {
      socket.to(`space:${row.space_id}`).emit('presence:update', { user_id: userId, handle, status: 'online' });
    }

    registerDMHandlers(io, socket);
    registerVoiceHandlers(io, socket);

    socket.on('channel:join', async ({ channel_id }) => {
      try {
        const access = await db.query(
          `SELECT c.id FROM channels c JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2 WHERE c.id = $1`,
          [channel_id, userId]
        );
        if (!access.rows.length) return socket.emit('error', { message: 'Access denied' });
        socket.join(`channel:${channel_id}`);
        socket.emit('channel:joined', { channel_id });
      } catch { socket.emit('error', { message: 'Could not join channel' }); }
    });

    socket.on('channel:leave', ({ channel_id }) => socket.leave(`channel:${channel_id}`));

    socket.on('message:send', async ({ channel_id, content, thread_id }) => {
      try {
        if (!content?.trim() || content.length > 4000) return socket.emit('error', { message: 'Invalid message' });

        const access = await db.query(
          `SELECT c.id, c.slowmode_secs FROM channels c JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2 WHERE c.id = $1`,
          [channel_id, userId]
        );
        if (!access.rows.length) return socket.emit('error', { message: 'Access denied' });

        const slowmode = access.rows[0].slowmode_secs;
        if (slowmode > 0) {
          const lastMsg = await db.query(
            `SELECT created_at FROM messages WHERE channel_id = $1 AND author_id = $2 ORDER BY created_at DESC LIMIT 1`,
            [channel_id, userId]
          );
          if (lastMsg.rows.length) {
            const elapsed = (Date.now() - new Date(lastMsg.rows[0].created_at)) / 1000;
            if (elapsed < slowmode) return socket.emit('error', { message: `Slowmode: wait ${Math.ceil(slowmode - elapsed)}s`, code: 'SLOWMODE' });
          }
        }

        // ── AI Moderation (async — don't block send) ───────────
        moderateMessage(content.trim()).then(async (modResult) => {
          if (modResult?.flagged && modResult.severity === 'high') {
            // Notify mods in the space
            const chanRes = await db.query('SELECT space_id FROM channels WHERE id = $1', [channel_id]);
            if (chanRes.rows.length) {
              io.to(`space:${chanRes.rows[0].space_id}`).emit('mod:alert', {
                channel_id,
                user_id: userId,
                handle,
                reason:   modResult.reason,
                severity: modResult.severity,
              });
            }
          }
        }).catch(() => {});

        // Save + broadcast message
        const msgRes = await db.query(
          `INSERT INTO messages (channel_id, author_id, content, thread_id) VALUES ($1, $2, $3, $4)
           RETURNING id, channel_id, content, thread_id, type, is_pinned, created_at`,
          [channel_id, userId, content.trim(), thread_id ?? null]
        );
        const message = msgRes.rows[0];
        const userRes = await db.query('SELECT display_name, avatar_url, avatar_animated FROM users WHERE id = $1', [userId]);

        io.to(`channel:${channel_id}`).emit('message:new', {
          ...message,
          author: { id: userId, handle, display_name: userRes.rows[0]?.display_name, avatar_url: userRes.rows[0]?.avatar_url, avatar_animated: userRes.rows[0]?.avatar_animated },
          reactions: [], reply_count: 0,
        });
      } catch (err) { console.error('message:send error:', err); socket.emit('error', { message: 'Failed to send message' }); }
    });

    socket.on('message:edit', async ({ message_id, content }) => {
      try {
        if (!content?.trim()) return;
        const msgRes = await db.query('SELECT * FROM messages WHERE id = $1 AND is_deleted = FALSE', [message_id]);
        if (!msgRes.rows.length || msgRes.rows[0].author_id !== userId) return socket.emit('error', { message: 'Cannot edit' });
        const updated = await db.query('UPDATE messages SET content = $1, edited_at = NOW() WHERE id = $2 RETURNING id, channel_id, content, edited_at', [content.trim(), message_id]);
        io.to(`channel:${updated.rows[0].channel_id}`).emit('message:edited', updated.rows[0]);
      } catch { socket.emit('error', { message: 'Failed to edit' }); }
    });

    socket.on('message:delete', async ({ message_id }) => {
      try {
        const msgRes = await db.query(
          `SELECT m.*, sm.role FROM messages m JOIN channels c ON c.id = m.channel_id JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2 WHERE m.id = $1`,
          [message_id, userId]
        );
        if (!msgRes.rows.length) return;
        const msg = msgRes.rows[0];
        if (msg.author_id !== userId && !['owner','admin','moderator'].includes(msg.role)) return;
        await db.query('UPDATE messages SET is_deleted = TRUE, content = NULL WHERE id = $1', [message_id]);
        io.to(`channel:${msg.channel_id}`).emit('message:deleted', { id: message_id, channel_id: msg.channel_id });
      } catch { socket.emit('error', { message: 'Failed to delete' }); }
    });

    socket.on('message:react', async ({ message_id, emoji }) => {
      try {
        if (!emoji) return;
        const existing = await db.query('SELECT 1 FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [message_id, userId, emoji]);
        let action;
        if (existing.rows.length) { await db.query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [message_id, userId, emoji]); action = 'removed'; }
        else { await db.query('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)', [message_id, userId, emoji]); action = 'added'; }
        const countsRes = await db.query('SELECT emoji, COUNT(*) AS count FROM reactions WHERE message_id = $1 GROUP BY emoji', [message_id]);
        const chanRes = await db.query('SELECT channel_id FROM messages WHERE id = $1', [message_id]);
        if (!chanRes.rows.length) return;
        io.to(`channel:${chanRes.rows[0].channel_id}`).emit('message:reaction', { message_id, user_id: userId, emoji, action, counts: countsRes.rows });
      } catch { socket.emit('error', { message: 'Failed to react' }); }
    });

    socket.on('typing:start', ({ channel_id }) => socket.to(`channel:${channel_id}`).emit('typing:start', { user_id: userId, handle, channel_id }));
    socket.on('typing:stop',  ({ channel_id }) => socket.to(`channel:${channel_id}`).emit('typing:stop',  { user_id: userId, channel_id }));

    socket.on('presence:set', async ({ status, status_text }) => {
      if (!['online','idle','dnd','offline'].includes(status)) return;
      await db.query('UPDATE users SET status = $1, status_text = $2 WHERE id = $3', [status, status_text ?? null, userId]);
      for (const row of spacesRes.rows) io.to(`space:${row.space_id}`).emit('presence:update', { user_id: userId, handle, status, status_text });
    });

    // ── AI commands via socket ─────────────────────────────────
    socket.on('ai:summarise', async ({ channel_id }) => {
      try {
        const access = await db.query(
          `SELECT c.id, c.name FROM channels c JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2 WHERE c.id = $1`,
          [channel_id, userId]
        );
        if (!access.rows.length) return;

        const msgsRes = await db.query(
          `SELECT m.content, m.created_at, u.handle FROM messages m LEFT JOIN users u ON u.id = m.author_id
           WHERE m.channel_id = $1 AND m.is_deleted = FALSE AND m.type = 'text' AND m.author_id != $2
           ORDER BY m.created_at DESC LIMIT 60`,
          [channel_id, AI_USER_ID]
        );
        if (msgsRes.rows.length < 3) {
          return socket.emit('ai:summary', { channel_id, summary: 'not enough messages to summarise yet.' });
        }

        const { summariseMessages } = require('../services/ai.service');
        const summary = await summariseMessages(msgsRes.rows.reverse(), { channel_name: access.rows[0].name });

        socket.emit('ai:summary', { channel_id, summary });
      } catch (err) {
        console.error('ai:summarise socket error:', err);
        socket.emit('ai:summary', { channel_id, summary: 'summary unavailable right now.' });
      }
    });

    socket.on('disconnect', async () => {
      console.log(`[socket] disconnected: ${handle} (${socket.id})`);
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          await db.query('UPDATE users SET status = $1, last_seen_at = NOW() WHERE id = $2', ['offline', userId]);
          for (const row of spacesRes.rows) io.to(`space:${row.space_id}`).emit('presence:update', { user_id: userId, handle, status: 'offline' });
        }
      }
    });
  });
};

module.exports = { registerSocketHandlers };
