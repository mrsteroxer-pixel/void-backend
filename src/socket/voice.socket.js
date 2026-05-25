// src/socket/voice.socket.js
// VOID Voice — WebRTC Signaling Server
//
// How it works:
//   1. User joins a voice channel → server tracks them in the room
//   2. Server tells existing peers a new user arrived
//   3. Peers exchange SDP offers/answers + ICE candidates via this server
//   4. Once connected, audio flows peer-to-peer (server not in the media path)
//   5. Server handles mute/deafen state, screen share flags, and disconnects

const db = require('../config/db');

// voiceRooms: Map<channelId, Map<userId, { socketId, handle, muted, deafened, screen_sharing }>>
const voiceRooms = new Map();

const registerVoiceHandlers = (io, socket) => {
  const userId = socket.user.id;
  const handle = socket.user.handle;

  // ── JOIN VOICE CHANNEL ───────────────────────────────────────
  socket.on('voice:join', async ({ channel_id }) => {
    try {
      // Verify access + channel is voice type
      const chanRes = await db.query(
        `SELECT c.id, c.type, c.name FROM channels c
         JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2
         WHERE c.id = $1 AND c.type = 'voice'`,
        [channel_id, userId]
      );
      if (!chanRes.rows.length) {
        return socket.emit('voice:error', { message: 'Voice channel not found or access denied' });
      }

      // Leave any existing voice channel first
      for (const [cid, room] of voiceRooms.entries()) {
        if (room.has(userId)) {
          await leaveVoice(io, socket, cid, userId);
        }
      }

      // Add to voice room
      if (!voiceRooms.has(channel_id)) voiceRooms.set(channel_id, new Map());
      const room = voiceRooms.get(channel_id);

      room.set(userId, {
        socket_id:     socket.id,
        handle,
        muted:         false,
        deafened:      false,
        screen_sharing: false,
        joined_at:     new Date(),
      });

      socket.join(`voice:${channel_id}`);
      socket.voiceChannel = channel_id;

      // Tell the new user who's already in the room
      const existingPeers = [...room.entries()]
        .filter(([uid]) => uid !== userId)
        .map(([uid, peer]) => ({ user_id: uid, ...peer }));

      socket.emit('voice:joined', {
        channel_id,
        channel_name: chanRes.rows[0].name,
        peers: existingPeers,
      });

      // Tell everyone else in the room that a new peer arrived
      socket.to(`voice:${channel_id}`).emit('voice:peer_joined', {
        user_id:  userId,
        handle,
        muted:    false,
        deafened: false,
      });

      // Broadcast updated participant list to the whole space
      broadcastVoiceState(io, channel_id);

      console.log(`[voice] ${handle} joined channel ${channel_id} (${room.size} in room)`);

    } catch (err) {
      console.error('voice:join error:', err);
      socket.emit('voice:error', { message: 'Failed to join voice channel' });
    }
  });

  // ── LEAVE VOICE CHANNEL ──────────────────────────────────────
  socket.on('voice:leave', async ({ channel_id }) => {
    await leaveVoice(io, socket, channel_id, userId);
  });

  // ── WebRTC SIGNALING ─────────────────────────────────────────
  // These events relay WebRTC handshake data between two peers.
  // The server never inspects the SDP/ICE payloads.

  // Offer: initiating peer → target peer
  socket.on('voice:offer', ({ target_user_id, sdp }) => {
    const room = voiceRooms.get(socket.voiceChannel);
    if (!room || !room.has(target_user_id)) return;

    const targetSocket = room.get(target_user_id).socket_id;
    io.to(targetSocket).emit('voice:offer', {
      from_user_id: userId,
      from_handle:  handle,
      sdp,
    });
  });

  // Answer: target peer → initiating peer
  socket.on('voice:answer', ({ target_user_id, sdp }) => {
    const room = voiceRooms.get(socket.voiceChannel);
    if (!room || !room.has(target_user_id)) return;

    const targetSocket = room.get(target_user_id).socket_id;
    io.to(targetSocket).emit('voice:answer', {
      from_user_id: userId,
      sdp,
    });
  });

  // ICE candidate exchange
  socket.on('voice:ice_candidate', ({ target_user_id, candidate }) => {
    const room = voiceRooms.get(socket.voiceChannel);
    if (!room || !room.has(target_user_id)) return;

    const targetSocket = room.get(target_user_id).socket_id;
    io.to(targetSocket).emit('voice:ice_candidate', {
      from_user_id: userId,
      candidate,
    });
  });

  // ── MUTE / DEAFEN ────────────────────────────────────────────
  socket.on('voice:mute', ({ muted }) => {
    const room = voiceRooms.get(socket.voiceChannel);
    if (!room || !room.has(userId)) return;

    room.get(userId).muted = !!muted;

    io.to(`voice:${socket.voiceChannel}`).emit('voice:state_update', {
      user_id: userId,
      muted:   !!muted,
    });

    broadcastVoiceState(io, socket.voiceChannel);
  });

  socket.on('voice:deafen', ({ deafened }) => {
    const room = voiceRooms.get(socket.voiceChannel);
    if (!room || !room.has(userId)) return;

    const peer = room.get(userId);
    peer.deafened = !!deafened;
    // Deafening also mutes
    if (deafened) peer.muted = true;

    io.to(`voice:${socket.voiceChannel}`).emit('voice:state_update', {
      user_id:  userId,
      muted:    peer.muted,
      deafened: peer.deafened,
    });

    broadcastVoiceState(io, socket.voiceChannel);
  });

  // ── SCREEN SHARE ─────────────────────────────────────────────
  // Free on VOID — no Nitro equivalent needed
  socket.on('voice:screen_share', ({ sharing }) => {
    const room = voiceRooms.get(socket.voiceChannel);
    if (!room || !room.has(userId)) return;

    room.get(userId).screen_sharing = !!sharing;

    io.to(`voice:${socket.voiceChannel}`).emit('voice:screen_share', {
      user_id: userId,
      handle,
      sharing: !!sharing,
    });

    broadcastVoiceState(io, socket.voiceChannel);
  });

  // ── SPEAKING INDICATOR (VAD — voice activity detection) ──────
  socket.on('voice:speaking', ({ speaking }) => {
    if (!socket.voiceChannel) return;
    socket.to(`voice:${socket.voiceChannel}`).emit('voice:speaking', {
      user_id: userId,
      speaking: !!speaking,
    });
  });

  // ── GET VOICE CHANNEL STATE ──────────────────────────────────
  socket.on('voice:state', ({ channel_id }) => {
    const room = voiceRooms.get(channel_id);
    socket.emit('voice:state', {
      channel_id,
      participants: room
        ? [...room.entries()].map(([uid, peer]) => ({ user_id: uid, ...peer }))
        : [],
    });
  });

  // ── DISCONNECT ───────────────────────────────────────────────
  socket.on('disconnect', async () => {
    if (socket.voiceChannel) {
      await leaveVoice(io, socket, socket.voiceChannel, userId);
    }
  });
};

// ── Helper: leave a voice room ───────────────────────────────────
const leaveVoice = async (io, socket, channel_id, userId) => {
  const room = voiceRooms.get(channel_id);
  if (!room) return;

  room.delete(userId);
  socket.leave(`voice:${channel_id}`);
  socket.voiceChannel = null;

  // Clean up empty rooms
  if (room.size === 0) voiceRooms.delete(channel_id);

  // Notify remaining peers
  io.to(`voice:${channel_id}`).emit('voice:peer_left', { user_id: userId });

  // Update voice state for the space
  broadcastVoiceState(io, channel_id);

  console.log(`[voice] ${socket.user?.handle} left channel ${channel_id}`);
};

// ── Helper: broadcast participant list to the space ──────────────
const broadcastVoiceState = async (io, channel_id) => {
  try {
    // Get space_id for this channel
    const chanRes = await require('../config/db').query(
      'SELECT space_id FROM channels WHERE id = $1', [channel_id]
    );
    if (!chanRes.rows.length) return;

    const room = voiceRooms.get(channel_id);
    const participants = room
      ? [...room.entries()].map(([uid, peer]) => ({
          user_id:       uid,
          handle:        peer.handle,
          muted:         peer.muted,
          deafened:      peer.deafened,
          screen_sharing: peer.screen_sharing,
        }))
      : [];

    io.to(`space:${chanRes.rows[0].space_id}`).emit('voice:participants', {
      channel_id,
      participants,
    });
  } catch (err) {
    console.error('broadcastVoiceState error:', err);
  }
};

// ── REST helper: get all active voice rooms ──────────────────────
const getVoiceRooms = () => {
  const result = {};
  for (const [channelId, room] of voiceRooms.entries()) {
    result[channelId] = [...room.entries()].map(([uid, peer]) => ({
      user_id: uid, ...peer,
    }));
  }
  return result;
};

module.exports = { registerVoiceHandlers, getVoiceRooms };
