// src/controllers/monetization.controller.js
const { z }   = require('zod');
const db      = require('../config/db');

const PLATFORM_FEE = parseFloat(process.env.VOID_PLATFORM_FEE_PERCENT || 5) / 100;

// ── Validation ────────────────────────────────────────────────
const tierSchema = z.object({
  name:        z.string().min(1).max(64),
  description: z.string().max(512).optional(),
  price_cents: z.number().int().min(100),   // minimum $1.00
  currency:    z.string().length(3).default('USD'),
  perks:       z.array(z.string()).optional(),
});

// ═══════════════════════════════════════════════════════════════
//  CREATOR TIERS
// ═══════════════════════════════════════════════════════════════

// ── LIST TIERS ────────────────────────────────────────────────
const listTiers = async (req, res) => {
  try {
    const { spaceId } = req.params;

    const memberRes = await db.query(
      'SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!memberRes.rows.length) return res.status(403).json({ error: 'Not a member' });

    const tiersRes = await db.query(
      `SELECT t.*,
         (SELECT COUNT(*) FROM subscriptions s WHERE s.tier_id = t.id AND s.status = 'active') AS subscriber_count
       FROM creator_tiers t
       WHERE t.space_id = $1 AND t.is_active = TRUE
       ORDER BY t.position ASC, t.price_cents ASC`,
      [spaceId]
    );

    return res.json({ tiers: tiersRes.rows });
  } catch (err) {
    console.error('listTiers error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── CREATE TIER ───────────────────────────────────────────────
const createTier = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const body = tierSchema.parse(req.body);

    const memberRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!memberRes.rows.length || !['owner', 'admin'].includes(memberRes.rows[0].role)) {
      return res.status(403).json({ error: 'Only admins can create tiers' });
    }

    const posRes = await db.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM creator_tiers WHERE space_id = $1',
      [spaceId]
    );

    const tierRes = await db.query(
      `INSERT INTO creator_tiers (space_id, name, description, price_cents, currency, perks, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [spaceId, body.name, body.description ?? null,
       body.price_cents, body.currency,
       body.perks ? JSON.stringify(body.perks) : null,
       posRes.rows[0].next]
    );

    return res.status(201).json({ tier: tierRes.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.errors });
    console.error('createTier error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── UPDATE TIER ───────────────────────────────────────────────
const updateTier = async (req, res) => {
  try {
    const { tierId } = req.params;
    const body = tierSchema.partial().parse(req.body);

    const tierRes = await db.query(
      `SELECT t.*, sm.role FROM creator_tiers t
       JOIN space_members sm ON sm.space_id = t.space_id AND sm.user_id = $2
       WHERE t.id = $1`,
      [tierId, req.user.id]
    );
    if (!tierRes.rows.length) return res.status(404).json({ error: 'Tier not found' });
    if (!['owner', 'admin'].includes(tierRes.rows[0].role)) return res.status(403).json({ error: 'Insufficient permissions' });

    const fields = [];
    const values = [];
    let idx = 1;

    if (body.name        !== undefined) { fields.push(`name = $${idx++}`);        values.push(body.name); }
    if (body.description !== undefined) { fields.push(`description = $${idx++}`); values.push(body.description); }
    if (body.price_cents !== undefined) { fields.push(`price_cents = $${idx++}`); values.push(body.price_cents); }
    if (body.perks       !== undefined) { fields.push(`perks = $${idx++}`);       values.push(JSON.stringify(body.perks)); }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    values.push(tierId);
    const updated = await db.query(
      `UPDATE creator_tiers SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      values
    );

    return res.json({ tier: updated.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.errors });
    console.error('updateTier error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── DELETE TIER ───────────────────────────────────────────────
const deleteTier = async (req, res) => {
  try {
    const { tierId } = req.params;

    const tierRes = await db.query(
      `SELECT t.*, sm.role FROM creator_tiers t
       JOIN space_members sm ON sm.space_id = t.space_id AND sm.user_id = $2
       WHERE t.id = $1`,
      [tierId, req.user.id]
    );
    if (!tierRes.rows.length) return res.status(404).json({ error: 'Tier not found' });
    if (!['owner', 'admin'].includes(tierRes.rows[0].role)) return res.status(403).json({ error: 'Insufficient permissions' });

    // Soft delete — keep for historical subscription records
    await db.query('UPDATE creator_tiers SET is_active = FALSE WHERE id = $1', [tierId]);
    return res.json({ deleted: true, id: tierId });
  } catch (err) {
    console.error('deleteTier error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ═══════════════════════════════════════════════════════════════
//  SUBSCRIPTIONS
// ═══════════════════════════════════════════════════════════════

// ── SUBSCRIBE TO A TIER ───────────────────────────────────────
// In production this would create a Stripe checkout session.
// For now it creates the subscription record directly (dev/test mode).
const subscribe = async (req, res) => {
  try {
    const { tierId } = req.params;

    const tierRes = await db.query(
      'SELECT * FROM creator_tiers WHERE id = $1 AND is_active = TRUE',
      [tierId]
    );
    if (!tierRes.rows.length) return res.status(404).json({ error: 'Tier not found or inactive' });
    const tier = tierRes.rows[0];

    // Check not already subscribed
    const existingRes = await db.query(
      `SELECT * FROM subscriptions WHERE tier_id = $1 AND subscriber_id = $2`,
      [tierId, req.user.id]
    );

    if (existingRes.rows.length) {
      const sub = existingRes.rows[0];
      if (sub.status === 'active') return res.status(409).json({ error: 'Already subscribed to this tier' });

      // Reactivate cancelled subscription
      const updated = await db.query(
        `UPDATE subscriptions SET status = 'active',
           current_period_start = NOW(),
           current_period_end = NOW() + INTERVAL '30 days',
           cancelled_at = NULL
         WHERE id = $1 RETURNING *`,
        [sub.id]
      );
      return res.json({ subscription: updated.rows[0], reactivated: true });
    }

    // Create subscription
    const subRes = await db.query(
      `INSERT INTO subscriptions (tier_id, subscriber_id, status, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '30 days') RETURNING *`,
      [tierId, req.user.id]
    );

    // Award creator points to the space owner (5% fee means creator gets 95%)
    const creatorRevenue = Math.floor(tier.price_cents * (1 - PLATFORM_FEE));
    const points = Math.floor(creatorRevenue / 10); // 1 point per 10 cents

    const spaceRes = await db.query('SELECT owner_id FROM spaces WHERE id = $1', [tier.space_id]);
    if (spaceRes.rows.length) {
      const ownerId = spaceRes.rows[0].owner_id;
      await db.query(
        `INSERT INTO creator_points (user_id, balance, total_earned)
         VALUES ($1, $2, $2)
         ON CONFLICT (user_id) DO UPDATE SET
           balance = creator_points.balance + $2,
           total_earned = creator_points.total_earned + $2,
           updated_at = NOW()`,
        [ownerId, points]
      );
      await db.query(
        `INSERT INTO creator_points_log (user_id, delta, reason)
         VALUES ($1, $2, $3)`,
        [ownerId, points, `Subscription: ${tier.name} (${tier.price_cents / 100} ${tier.currency})`]
      );
    }

    return res.status(201).json({
      subscription: subRes.rows[0],
      message: `Subscribed to ${tier.name}`,
      // In production: return { checkout_url } from Stripe here
    });
  } catch (err) {
    console.error('subscribe error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── CANCEL SUBSCRIPTION ───────────────────────────────────────
const cancelSubscription = async (req, res) => {
  try {
    const { tierId } = req.params;

    const subRes = await db.query(
      `UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW()
       WHERE tier_id = $1 AND subscriber_id = $2 AND status = 'active'
       RETURNING *`,
      [tierId, req.user.id]
    );

    if (!subRes.rows.length) return res.status(404).json({ error: 'Active subscription not found' });

    return res.json({
      message: 'Subscription cancelled. Access continues until end of billing period.',
      subscription: subRes.rows[0],
    });
  } catch (err) {
    console.error('cancelSubscription error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── MY SUBSCRIPTIONS ──────────────────────────────────────────
const mySubscriptions = async (req, res) => {
  try {
    const subsRes = await db.query(
      `SELECT s.*, t.name AS tier_name, t.price_cents, t.currency,
              sp.id AS space_id, sp.name AS space_name, sp.icon_url
       FROM subscriptions s
       JOIN creator_tiers t ON t.id = s.tier_id
       JOIN spaces sp ON sp.id = t.space_id
       WHERE s.subscriber_id = $1
       ORDER BY s.created_at DESC`,
      [req.user.id]
    );

    return res.json({ subscriptions: subsRes.rows });
  } catch (err) {
    console.error('mySubscriptions error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── CHECK ACCESS TO GATED CHANNEL ─────────────────────────────
const checkGatedAccess = async (req, res) => {
  try {
    const { channelId } = req.params;

    const chanRes = await db.query(
      'SELECT * FROM channels WHERE id = $1',
      [channelId]
    );
    if (!chanRes.rows.length) return res.status(404).json({ error: 'Channel not found' });
    const channel = chanRes.rows[0];

    // Not gated — everyone has access
    if (!channel.is_gated || !channel.required_tier_id) {
      return res.json({ access: true, reason: 'open' });
    }

    // Check if user has active subscription to required tier
    const subRes = await db.query(
      `SELECT 1 FROM subscriptions
       WHERE tier_id = $1 AND subscriber_id = $2
         AND status = 'active'
         AND current_period_end > NOW()`,
      [channel.required_tier_id, req.user.id]
    );

    // Also grant access to space admins/owners
    const memberRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [channel.space_id, req.user.id]
    );
    const isAdmin = memberRes.rows.length && ['owner', 'admin'].includes(memberRes.rows[0].role);

    const hasAccess = subRes.rows.length > 0 || isAdmin;

    return res.json({
      access: hasAccess,
      reason: hasAccess ? (isAdmin ? 'admin' : 'subscribed') : 'subscription_required',
      required_tier_id: channel.required_tier_id,
    });
  } catch (err) {
    console.error('checkGatedAccess error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ═══════════════════════════════════════════════════════════════
//  CREATOR POINTS & PAYOUTS
// ═══════════════════════════════════════════════════════════════

// ── GET MY CREATOR POINTS ─────────────────────────────────────
const getMyPoints = async (req, res) => {
  try {
    const pointsRes = await db.query(
      'SELECT * FROM creator_points WHERE user_id = $1',
      [req.user.id]
    );

    const logRes = await db.query(
      `SELECT * FROM creator_points_log WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );

    return res.json({
      points: pointsRes.rows[0] ?? { balance: 0, total_earned: 0 },
      log: logRes.rows,
    });
  } catch (err) {
    console.error('getMyPoints error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── REDEEM POINTS ─────────────────────────────────────────────
const redeemPoints = async (req, res) => {
  try {
    const redeemSchema = z.object({
      amount: z.number().int().positive(),
      reward: z.enum(['storage', 'custom_domain', 'voice_priority']),
    });
    const { amount, reward } = redeemSchema.parse(req.body);

    const pointsRes = await db.query(
      'SELECT balance FROM creator_points WHERE user_id = $1',
      [req.user.id]
    );
    const balance = pointsRes.rows[0]?.balance ?? 0;

    if (balance < amount) {
      return res.status(400).json({ error: `Insufficient points. Have ${balance}, need ${amount}` });
    }

    await db.query(
      `UPDATE creator_points SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2`,
      [amount, req.user.id]
    );
    await db.query(
      `INSERT INTO creator_points_log (user_id, delta, reason) VALUES ($1, $2, $3)`,
      [req.user.id, -amount, `Redeemed: ${reward}`]
    );

    return res.json({
      message: `Redeemed ${amount} points for ${reward}`,
      new_balance: balance - amount,
      reward,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.errors });
    console.error('redeemPoints error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET SPACE REVENUE SUMMARY ─────────────────────────────────
const getRevenueSummary = async (req, res) => {
  try {
    const { spaceId } = req.params;

    const memberRes = await db.query(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, req.user.id]
    );
    if (!memberRes.rows.length || !['owner', 'admin'].includes(memberRes.rows[0].role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // Active subscribers per tier
    const tiersRes = await db.query(
      `SELECT t.id, t.name, t.price_cents, t.currency,
              COUNT(s.id) FILTER (WHERE s.status = 'active') AS active_subscribers,
              COUNT(s.id) FILTER (WHERE s.status = 'active') * t.price_cents AS gross_revenue_cents
       FROM creator_tiers t
       LEFT JOIN subscriptions s ON s.tier_id = t.id
       WHERE t.space_id = $1
       GROUP BY t.id
       ORDER BY t.price_cents DESC`,
      [spaceId]
    );

    const totalGross = tiersRes.rows.reduce((sum, t) => sum + parseInt(t.gross_revenue_cents || 0), 0);
    const platformFee = Math.floor(totalGross * PLATFORM_FEE);
    const creatorNet  = totalGross - platformFee;

    // Payout history
    const payoutsRes = await db.query(
      `SELECT * FROM payouts WHERE space_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [spaceId]
    );

    return res.json({
      tiers: tiersRes.rows,
      summary: {
        gross_revenue_cents: totalGross,
        platform_fee_cents:  platformFee,
        creator_net_cents:   creatorNet,
        platform_fee_pct:    PLATFORM_FEE * 100,
      },
      payouts: payoutsRes.rows,
    });
  } catch (err) {
    console.error('getRevenueSummary error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  listTiers, createTier, updateTier, deleteTier,
  subscribe, cancelSubscription, mySubscriptions,
  checkGatedAccess,
  getMyPoints, redeemPoints,
  getRevenueSummary,
};
