// src/controllers/invite.controller.js
const { z } = require('zod');
const db = require('../config/db');

// Expiry durations mapped to PostgreSQL intervals
const EXPIRY_MAP = {
  '1h':    { interval: '1 hour',   label: '1 hour'   },
  '24h':   { interval: '24 hours', label: '24 hours' },
  '7d':    { interval: '7 days',   label: '7 days'   },
  '30d':   { interval: '30 days',  label: '30 days'  },
  'never': { interval: null,       label: 'Never'    },
};

const createInviteSchema = z.object({
  space_id:   z.string().uuid(),
  expiry:     z.enum(['1h', '24h', '7d', '30d', 'never']).default('7d'),
  max_uses:   z.number().int().positive().nullable().optional(),
  grant_role: z.enum(['member', 'moderator', 'admin']).default('member'),
});

// ── CREATE INVITE ───────────────────────────────────────────────
const createInvite = async (req, res) => {
  try {
    const body = createInviteSchema.parse(req.body);

    // Check user is admin/owner of the space
    const memberRes = await db.query(
      `SELECT role FROM space_members
       WHERE space_id = $1 AND user_id = $2`,
      [body.space_id, req.user.id]
    );

    if (memberRes.rows.length === 0) {
      return res.status(403).json({ error: 'You are not a member of this space' });
    }

    const role = memberRes.rows[0].role;
    if (!['owner', 'admin', 'moderator'].includes(role)) {
      return res.status(403).json({ error: 'You do not have permission to create invites' });
    }

    // Calculate expiry timestamp
    const expiryConfig = EXPIRY_MAP[body.expiry];
    const expiresAt = expiryConfig.interval
      ? `NOW() + INTERVAL '${expiryConfig.interval}'`
      : 'NULL';

    const inviteRes = await db.query(
      `INSERT INTO invites (space_id, created_by, expiry, expires_at, max_uses, grant_role)
       VALUES ($1, $2, $3, ${expiresAt}, $4, $5)
       RETURNING id, code, space_id, expiry, expires_at, max_uses, use_count, grant_role, created_at`,
      [body.space_id, req.user.id, body.expiry, body.max_uses ?? null, body.grant_role]
    );

    const invite = inviteRes.rows[0];

    return res.status(201).json({
      invite: {
        ...invite,
        url: `${process.env.INVITE_BASE_URL}/${invite.code}`,
        expires_label: expiryConfig.label,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: err.errors });
    }
    console.error('Create invite error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── VALIDATE INVITE (public — used on signup page) ──────────────
const validateInvite = async (req, res) => {
  try {
    const { code } = req.params;

    const inviteRes = await db.query(
      `SELECT i.id, i.code, i.expiry, i.expires_at, i.max_uses, i.use_count,
              i.grant_role, i.is_revoked,
              s.id AS space_id, s.name AS space_name, s.description AS space_description,
              s.icon_url, s.member_count
       FROM invites i
       JOIN spaces s ON s.id = i.space_id
       WHERE i.code = $1`,
      [code]
    );

    if (inviteRes.rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    const invite = inviteRes.rows[0];

    if (invite.is_revoked) {
      return res.status(410).json({ error: 'This invite has been revoked' });
    }

    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This invite has expired' });
    }

    if (invite.max_uses && invite.use_count >= invite.max_uses) {
      return res.status(410).json({ error: 'This invite has reached its maximum uses' });
    }

    return res.json({
      valid: true,
      space: {
        id:           invite.space_id,
        name:         invite.space_name,
        description:  invite.space_description,
        icon_url:     invite.icon_url,
        member_count: invite.member_count,
      },
      invite: {
        code:        invite.code,
        grant_role:  invite.grant_role,
        expires_at:  invite.expires_at,
        uses_left:   invite.max_uses ? invite.max_uses - invite.use_count : null,
      },
    });
  } catch (err) {
    console.error('Validate invite error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── LIST INVITES FOR A SPACE ─────────────────────────────────────
const listInvites = async (req, res) => {
  try {
    const { spaceId } = req.params;

    // Must be admin/owner
    const memberRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );

    if (!memberRes.rows.length || !['owner', 'admin'].includes(memberRes.rows[0].role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const invitesRes = await db.query(
      `SELECT i.id, i.code, i.expiry, i.expires_at, i.max_uses, i.use_count,
              i.grant_role, i.is_revoked, i.created_at,
              u.handle AS created_by_handle
       FROM invites i
       JOIN users u ON u.id = i.created_by
       WHERE i.space_id = $1
       ORDER BY i.created_at DESC`,
      [spaceId]
    );

    return res.json({
      invites: invitesRes.rows.map(inv => ({
        ...inv,
        url: `${process.env.INVITE_BASE_URL}/${inv.code}`,
        is_active: !inv.is_revoked &&
                   (!inv.expires_at || new Date(inv.expires_at) > new Date()) &&
                   (!inv.max_uses || inv.use_count < inv.max_uses),
      })),
    });
  } catch (err) {
    console.error('List invites error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── REVOKE INVITE ───────────────────────────────────────────────
const revokeInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;

    // Get invite and verify ownership
    const inviteRes = await db.query(
      `SELECT i.*, sm.role
       FROM invites i
       JOIN space_members sm ON sm.space_id = i.space_id AND sm.user_id = $2
       WHERE i.id = $1`,
      [inviteId, req.user.id]
    );

    if (!inviteRes.rows.length) {
      return res.status(404).json({ error: 'Invite not found or no permission' });
    }

    const { role } = inviteRes.rows[0];
    if (!['owner', 'admin', 'moderator'].includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    await db.query(
      'UPDATE invites SET is_revoked = TRUE WHERE id = $1',
      [inviteId]
    );

    return res.json({ message: 'Invite revoked' });
  } catch (err) {
    console.error('Revoke invite error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { createInvite, validateInvite, listInvites, revokeInvite };
