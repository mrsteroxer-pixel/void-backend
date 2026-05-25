// src/controllers/ai.controller.js
const { z }        = require('zod');
const db           = require('../config/db');
const aiService    = require('../services/ai.service');

const AI_USER_ID = process.env.AI_USER_ID || '00000000-0000-0000-0000-000000000001';

// ── CHANNEL SUMMARY ────────────────────────────────────────────
// Generates a "what you missed" summary for a channel
const summariseChannel = async (req, res) => {
  try {
    const { channelId } = req.params;
    const { since } = req.query;  // ISO timestamp — summarise since this time

    // Verify access
    const chanRes = await db.query(
      `SELECT c.id, c.name FROM channels c
       JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2
       WHERE c.id = $1`,
      [channelId, req.user.id]
    );
    if (!chanRes.rows.length) return res.status(403).json({ error: 'Access denied' });
    const channel = chanRes.rows[0];

    // Fetch recent messages (up to 80, since timestamp if provided)
    const sinceClause = since ? `AND m.created_at > $3` : '';
    const params = since ? [channelId, 80, since] : [channelId, 80];

    const msgsRes = await db.query(
      `SELECT m.content, m.created_at, u.handle
       FROM messages m
       LEFT JOIN users u ON u.id = m.author_id
       WHERE m.channel_id = $1
         AND m.is_deleted = FALSE
         AND m.type = 'text'
         AND m.author_id != ${'$' + (since ? 4 : 3)}
         ${sinceClause}
       ORDER BY m.created_at DESC
       LIMIT $2`,
      since ? [...params, AI_USER_ID] : [...params, AI_USER_ID]
    );

    if (msgsRes.rows.length < 3) {
      return res.json({ summary: 'not enough messages to summarise yet.', message_count: msgsRes.rows.length });
    }

    const summary = await aiService.summariseMessages(
      msgsRes.rows.reverse(),
      { channel_name: channel.name }
    );

    // Store summary in DB
    const summaryRes = await db.query(
      `INSERT INTO ai_summaries (channel_id, user_id, summary_text)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [channelId, req.user.id, summary]
    );

    // Post summary as an AI message in the channel (visible to requester only via socket)
    const msgRes = await db.query(
      `INSERT INTO messages (channel_id, author_id, content, type)
       VALUES ($1, $2, $3, 'ai') RETURNING id, created_at`,
      [channelId, AI_USER_ID, summary]
    );

    return res.json({
      summary,
      summary_id:    summaryRes.rows[0].id,
      message_id:    msgRes.rows[0].id,
      message_count: msgsRes.rows.length,
      channel_name:  channel.name,
    });
  } catch (err) {
    console.error('summariseChannel error:', err);
    return res.status(500).json({ error: 'AI summary failed' });
  }
};

// ── DRAFT ASSIST ───────────────────────────────────────────────
const draftMessage = async (req, res) => {
  try {
    const { prompt, channel_id } = z.object({
      prompt:     z.string().min(1).max(500),
      channel_id: z.string().uuid().optional(),
    }).parse(req.body);

    let channelName = null;
    if (channel_id) {
      const chanRes = await db.query(
        `SELECT c.name FROM channels c
         JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2
         WHERE c.id = $1`,
        [channel_id, req.user.id]
      );
      if (chanRes.rows.length) channelName = chanRes.rows[0].name;
    }

    const draft = await aiService.draftAssist(prompt, { channel_name: channelName });
    return res.json({ draft });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.errors });
    console.error('draftMessage error:', err);
    return res.status(500).json({ error: 'AI draft failed' });
  }
};

// ── SMART REPLIES ──────────────────────────────────────────────
const smartReplies = async (req, res) => {
  try {
    const { channelId } = req.params;

    const access = await db.query(
      `SELECT c.id FROM channels c
       JOIN space_members sm ON sm.space_id = c.space_id AND sm.user_id = $2
       WHERE c.id = $1`,
      [channelId, req.user.id]
    );
    if (!access.rows.length) return res.status(403).json({ error: 'Access denied' });

    const msgsRes = await db.query(
      `SELECT m.content, u.handle FROM messages m
       LEFT JOIN users u ON u.id = m.author_id
       WHERE m.channel_id = $1 AND m.is_deleted = FALSE AND m.type = 'text'
       ORDER BY m.created_at DESC LIMIT 5`,
      [channelId]
    );

    if (!msgsRes.rows.length) return res.json({ suggestions: [] });

    const suggestions = await aiService.suggestReplies(msgsRes.rows.reverse());
    return res.json({ suggestions });
  } catch (err) {
    console.error('smartReplies error:', err);
    return res.status(500).json({ error: 'AI suggestions failed' });
  }
};

// ── MODERATE MESSAGE (internal — called on message send) ────────
const moderateMessage = async (content) => {
  try {
    if (!content || content.length < 5) return null;
    const result = await aiService.moderateContent(content);
    return result;
  } catch {
    return null;  // Fail open — don't block messages if moderation fails
  }
};

// ── MODERATION ENDPOINT (manual check) ────────────────────────
const checkModeration = async (req, res) => {
  try {
    const { content } = z.object({ content: z.string().min(1).max(4000) }).parse(req.body);
    const result = await aiService.moderateContent(content);
    return res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed' });
    console.error('checkModeration error:', err);
    return res.status(500).json({ error: 'Moderation check failed' });
  }
};

// ── GET MY SUMMARIES ───────────────────────────────────────────
const getMySummaries = async (req, res) => {
  try {
    const summariesRes = await db.query(
      `SELECT s.*, c.name AS channel_name
       FROM ai_summaries s
       LEFT JOIN channels c ON c.id = s.channel_id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC
       LIMIT 20`,
      [req.user.id]
    );
    return res.json({ summaries: summariesRes.rows });
  } catch (err) {
    console.error('getMySummaries error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  summariseChannel,
  draftMessage,
  smartReplies,
  checkModeration,
  getMySummaries,
  moderateMessage,
};
