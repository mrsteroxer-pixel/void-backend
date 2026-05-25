// src/controllers/auth.controller.js
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { z } = require('zod');
const db = require('../config/db');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');

const SALT_ROUNDS = 12;

// ── Validation schemas ──────────────────────────────────────────
const registerSchema = z.object({
  handle:       z.string().min(2).max(32).regex(/^[a-z0-9._-]+$/, 'Handle can only contain lowercase letters, numbers, dots, underscores, hyphens'),
  display_name: z.string().min(1).max(64),
  email:        z.string().email(),
  password:     z.string().min(8).max(128),
  invite_code:  z.string().min(1, 'An invite code is required to join VOID'),
});

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

// ── Helpers ─────────────────────────────────────────────────────
const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const setRefreshCookie = (res, token) => {
  res.cookie('void_refresh', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
  });
};

// ── REGISTER ────────────────────────────────────────────────────
const register = async (req, res) => {
  try {
    const body = registerSchema.parse(req.body);

    // 1. Validate invite code
    const inviteRes = await db.query(
      `SELECT i.*, s.name AS space_name
       FROM invites i
       JOIN spaces s ON s.id = i.space_id
       WHERE i.code = $1
         AND i.is_revoked = FALSE
         AND (i.expires_at IS NULL OR i.expires_at > NOW())
         AND (i.max_uses IS NULL OR i.use_count < i.max_uses)`,
      [body.invite_code]
    );

    if (inviteRes.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired invite code' });
    }
    const invite = inviteRes.rows[0];

    // 2. Check handle + email uniqueness
    const existsRes = await db.query(
      'SELECT id FROM users WHERE handle = $1 OR email = $2',
      [body.handle, body.email]
    );
    if (existsRes.rows.length > 0) {
      return res.status(409).json({ error: 'Handle or email already taken' });
    }

    // 3. Hash password
    const password_hash = await bcrypt.hash(body.password, SALT_ROUNDS);

    // 4. Create user + join space in a transaction
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const userRes = await client.query(
        `INSERT INTO users (handle, display_name, email, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, handle, display_name, email, created_at`,
        [body.handle, body.display_name, body.email, password_hash]
      );
      const user = userRes.rows[0];

      // Add to space with the role specified by invite
      await client.query(
        `INSERT INTO space_members (space_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [invite.space_id, user.id, invite.grant_role]
      );

      // Increment invite use count
      await client.query(
        'UPDATE invites SET use_count = use_count + 1 WHERE id = $1',
        [invite.id]
      );

      await client.query('COMMIT');

      // 5. Issue tokens
      const payload = { id: user.id, handle: user.handle, email: user.email };
      const accessToken  = signAccessToken(payload);
      const refreshToken = signRefreshToken(payload);

      // 6. Store hashed refresh token
      await db.query(
        `INSERT INTO sessions (user_id, refresh_token, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')`,
        [user.id, hashToken(refreshToken), req.ip, req.headers['user-agent']]
      );

      setRefreshCookie(res, refreshToken);

      return res.status(201).json({
        message: `Welcome to VOID. You've joined ${invite.space_name}.`,
        access_token: accessToken,
        user: {
          id:           user.id,
          handle:       user.handle,
          display_name: user.display_name,
          email:        user.email,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: err.errors });
    }
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── LOGIN ───────────────────────────────────────────────────────
const login = async (req, res) => {
  try {
    const body = loginSchema.parse(req.body);

    const userRes = await db.query(
      'SELECT * FROM users WHERE email = $1 AND is_banned = FALSE',
      [body.email]
    );

    if (userRes.rows.length === 0) {
      // Generic message to prevent user enumeration
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = userRes.rows[0];
    const match = await bcrypt.compare(body.password, user.password_hash);

    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last seen
    await db.query('UPDATE users SET last_seen_at = NOW(), status = $1 WHERE id = $2', ['online', user.id]);

    const payload = { id: user.id, handle: user.handle, email: user.email };
    const accessToken  = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    await db.query(
      `INSERT INTO sessions (user_id, refresh_token, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')`,
      [user.id, hashToken(refreshToken), req.ip, req.headers['user-agent']]
    );

    setRefreshCookie(res, refreshToken);

    return res.json({
      access_token: accessToken,
      user: {
        id:             user.id,
        handle:         user.handle,
        display_name:   user.display_name,
        email:          user.email,
        avatar_url:     user.avatar_url,
        status:         user.status,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: err.errors });
    }
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── REFRESH TOKEN ───────────────────────────────────────────────
const refresh = async (req, res) => {
  try {
    const token = req.cookies?.void_refresh;
    if (!token) return res.status(401).json({ error: 'No refresh token' });

    const payload = verifyRefreshToken(token);
    const hashed  = hashToken(token);

    // Verify token exists in DB and isn't expired
    const sessionRes = await db.query(
      `SELECT * FROM sessions
       WHERE user_id = $1 AND refresh_token = $2 AND expires_at > NOW()`,
      [payload.id, hashed]
    );

    if (sessionRes.rows.length === 0) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    // Rotate refresh token (one-time use)
    const newRefresh = signRefreshToken({ id: payload.id, handle: payload.handle, email: payload.email });
    const newAccess  = signAccessToken({ id: payload.id, handle: payload.handle, email: payload.email });

    await db.query(
      `UPDATE sessions SET refresh_token = $1, expires_at = NOW() + INTERVAL '30 days'
       WHERE user_id = $2 AND refresh_token = $3`,
      [hashToken(newRefresh), payload.id, hashed]
    );

    setRefreshCookie(res, newRefresh);
    return res.json({ access_token: newAccess });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
};

// ── LOGOUT ──────────────────────────────────────────────────────
const logout = async (req, res) => {
  try {
    const token = req.cookies?.void_refresh;
    if (token) {
      await db.query(
        'DELETE FROM sessions WHERE refresh_token = $1',
        [hashToken(token)]
      );
    }

    // Set user offline
    if (req.user?.id) {
      await db.query('UPDATE users SET status = $1 WHERE id = $2', ['offline', req.user.id]);
    }

    res.clearCookie('void_refresh');
    return res.json({ message: 'Logged out' });
  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ── ME ──────────────────────────────────────────────────────────
const me = async (req, res) => {
  try {
    const userRes = await db.query(
      `SELECT id, handle, display_name, email, avatar_url, avatar_animated,
              bio, status, status_text, is_verified, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user: userRes.rows[0] });
  } catch (err) {
    console.error('Me error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { register, login, refresh, logout, me };
