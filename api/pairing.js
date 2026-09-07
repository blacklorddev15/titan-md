// TITAN ANIME MD — Neon pairing bridge (like the other projects).
//
// Flow:
//   GET  /api/pairing?stats=1        -> Neon-backed dashboard stats
//   POST /api/pairing { phone }      -> inserts a request into titan_pair_requests,
//                                        waits for the Titan bot (which polls the
//                                        same table) to write the pairing code back
//   Admin actions use X-Admin-Password and are validated against the
//   TITAN_ADMIN_PASSWORD environment variable.
'use strict';

const { Pool } = require('pg');

const cachedUrl = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || '';
const adminPassword = process.env.TITAN_ADMIN_PASSWORD || '';

function makePool() {
  const ssl = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(cachedUrl) ? false : { rejectUnauthorized: false };
  return new Pool({ connectionString: cachedUrl, connectionTimeoutMillis: 8000, max: 1, ssl });
}

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS titan_pair_requests (
      id         serial PRIMARY KEY,
      phone      text NOT NULL,
      status     text NOT NULL DEFAULT 'pending',
      code       text,
      error      text,
      sid        text,
      created_at timestamptz NOT NULL DEFAULT now(),
      claimed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS titan_heartbeat (
      id           int PRIMARY KEY,
      status       text NOT NULL,
      last_seen    timestamptz NOT NULL DEFAULT now(),
      premium_mode boolean NOT NULL DEFAULT false,
      extra        jsonb NOT NULL DEFAULT '{}'::jsonb
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS titan_sessions (
      numero text PRIMARY KEY,
      creds  jsonb NOT NULL,
      sid    text,
      updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS titan_settings (
      key   text PRIMARY KEY,
      value jsonb
  )`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAdmin(req) {
  return adminPassword && (req.headers['x-admin-password'] || '') === adminPassword;
}

module.exports = async (req, res) => {
  if (!cachedUrl) {
    return res.status(503).json({ status: 'offline', error: 'DATABASE_URL is not configured on this project.' });
  }
  const pool = makePool();
  try {
    await ensureTables(pool);

    // ── GET stats ─────────────────────────────────────────────
    if ((req.method || 'GET').toUpperCase() === 'GET') {
      const hb = await pool.query('SELECT status, last_seen, premium_mode FROM titan_heartbeat WHERE id = 1');
      const row = hb.rows[0];
      const fresh = row && row.last_seen && Date.now() - new Date(row.last_seen).getTime() < 45000;
      const sessions = await pool.query('SELECT count(*)::int AS c FROM titan_sessions');
      const settings = await pool.query(`SELECT value FROM titan_settings WHERE key = 'premium_mode'`);
      const premiumMode = settings.rows[0]
        ? Boolean(settings.rows[0].value)
        : row ? Boolean(row.premium_mode) : false;
      const uptimeSec = row && row.last_seen ? Math.max(0, Math.floor((Date.now() - new Date(row.last_seen).getTime()) / 1000)) : 0;
      return res.json({
        status: fresh ? 'online' : 'offline',
        uptime: fresh ? uptimeSec : 0,
        pairedCount: sessions.rows[0].c,
        activeSessions: sessions.rows[0].c,
        premiumMode,
        serverId: '',
        serverIp: '',
        serverPort: '',
        panelDomain: '',
      });
    }

    // ── POST ──────────────────────────────────────────────────
    const body = req.body || {};

    // admin: unlock console
    if (body.action === 'admin_login') {
      if (!adminPassword) {
        return res.status(503).json({ success: false, error: 'Admin password is not configured. Set TITAN_ADMIN_PASSWORD on this project.' });
      }
      if (String(body.password || '') !== adminPassword) {
        return res.status(401).json({ success: false, error: 'Incorrect admin password.' });
      }
      const s = await pool.query(`SELECT value FROM titan_settings WHERE key = 'premium_mode'`);
      const hb = await pool.query('SELECT premium_mode FROM titan_heartbeat WHERE id = 1');
      const premiumMode = s.rows[0] ? Boolean(s.rows[0].value) : hb.rows[0] ? Boolean(hb.rows[0].premium_mode) : false;
      return res.json({
        success: true,
        config: { panelDomain: '', serverIp: '', serverPort: '', serverId: '', premiumMode },
      });
    }

    // admin: gateway mode
    if (body.action === 'update_settings') {
      if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized.' });
      if (typeof body.premiumMode === 'boolean') {
        await pool.query(
          `INSERT INTO titan_settings (key, value) VALUES ('premium_mode', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [JSON.stringify(body.premiumMode)]
        );
      }
      return res.json({ success: true, config: { premiumMode: Boolean(body.premiumMode) } });
    }

    // admin: connection test (kept for compatibility)
    if (body.action === 'test_connection') {
      if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized.' });
      const hb = await pool.query('SELECT last_seen FROM titan_heartbeat WHERE id = 1');
      const online = !!hb.rows[0] && Date.now() - new Date(hb.rows[0].last_seen).getTime() < 45000;
      return res.json({ backendOnline: online, message: online ? 'Titan bot is online (Neon heartbeat fresh).' : 'Titan bot is offline (no recent Neon heartbeat).' });
    }

    // ── public: generate pairing code ─────────────────────────
    const phone = String(body.phone || '').replace(/\D/g, '');
    if (!phone || !/^\d{7,15}$/.test(phone)) {
      return res.status(200).json({ error: 'Enter a valid international WhatsApp number.' });
    }

    // quick-fail when the bot is not heartbeating
    const hb = await pool.query('SELECT last_seen FROM titan_heartbeat WHERE id = 1');
    const botFresh = !!hb.rows[0] && Date.now() - new Date(hb.rows[0].last_seen).getTime() < 45000;
    if (!botFresh) {
      return res.status(200).json({ error: 'Titan MD is currently offline. Start the bot, then try again.' });
    }

    const ins = await pool.query(
      `INSERT INTO titan_pair_requests (phone) VALUES ($1) RETURNING id, created_at`,
      [phone]
    );
    const requestId = ins.rows[0].id;

    // wait for the bot (which polls every ~5s) up to ~26s
    for (let i = 0; i < 26; i++) {
      await sleep(1000);
      const r = await pool.query(
        'SELECT status, code, error FROM titan_pair_requests WHERE id = $1',
        [requestId]
      );
      const row = r.rows[0];
      if (!row) return res.status(200).json({ error: 'Pairing request was lost. Try again.' });
      if (row.status === 'done') return res.json({ code: row.code });
      if (row.status === 'error') return res.status(200).json({ error: row.error || 'Pairing failed. Try again.' });
    }
    return res.status(200).json({ error: 'Timed out waiting for Titan MD. Please retry.' });
  } catch (e) {
    return res.status(500).json({ status: 'offline', error: e.message || 'Database error.' });
  } finally {
    pool.end().catch(() => {});
  }
};
