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

// Table creation used to run at the top of every request, in front of all routing — including the
// admin passcode check. A database that refuses connections therefore took the whole admin console
// down with it, and the console reported the passcode "not entering" when in fact no password was
// ever compared. It now runs once per process (retried on the next request if it failed) and never
// blocks a request.
let tablesPromise = null;

function ensureTablesOnce(pool) {
  if (!tablesPromise) {
    tablesPromise = ensureTables(pool).catch((error) => {
      tablesPromise = null;
      throw error;
    });
  }
  return tablesPromise;
}

// Turns a driver error into something the console can display without showing a bare driver dump.
function describeDbFailure(error) {
  const text = String((error && error.message) || 'Database error.');
  if (/quota|exceeded/i.test(text)) {
    return {
      code: 'database_quota_exceeded',
      error: `The database has hit its usage limit, so data actions are paused. Admin access is unaffected. (${text})`,
    };
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|terminat/i.test(text)) {
    return {
      code: 'database_unreachable',
      error: `The database cannot be reached right now, so data actions are paused. Admin access is unaffected. (${text})`,
    };
  }
  return { code: 'database_error', error: text };
}

// ── Vercel project access ─────────────────────────────────────────────────────
// The one action that rescues a deployment whose database has run out of quota is pointing it at a
// different Postgres, and that has to be possible from this console rather than the Vercel
// dashboard. It needs a token plus the project it belongs to; both are read from the environment.
function vercelCreds() {
  return {
    token: String(process.env.VERCEL_API_TOKEN || '').trim(),
    project: String(process.env.PROJECT_ID || process.env.VERCEL_PROJECT_ID || '').trim(),
    team: String(process.env.TEAM_ID || process.env.VERCEL_ORG_ID || process.env.VERCEL_TEAM_ID || '').trim(),
  };
}

// Names only what is actually absent, so the console never asks for something already configured.
function missingVercelCreds(creds) {
  return [
    !creds.token && 'VERCEL_API_TOKEN',
    !creds.project && 'PROJECT_ID',
  ].filter(Boolean);
}

/**
 * Starts a fresh production build from the Git source.
 *
 * Deliberately NOT a redeploy-by-deploymentId: that inherits the previous build's settings,
 * environment variables included, so a changed DATABASE_URL would not take effect and the button
 * would look like it worked when it had not. That was measured on the sibling skylar-pairing
 * deployment, not assumed.
 */
async function startProductionBuild(creds) {
  const teamQ = creds.team ? `?teamId=${encodeURIComponent(creds.team)}` : '';
  const auth = { Authorization: `Bearer ${creds.token}` };

  const projRes = await fetch(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(creds.project)}${teamQ}`,
    { headers: auth }
  );
  const proj = await projRes.json();
  if (!projRes.ok) {
    return { success: false, message: 'Vercel: ' + ((proj.error && proj.error.message) || projRes.status) };
  }

  const link = proj.link || {};
  if (!link.repoId) {
    return {
      success: false,
      message: 'This project has no Git repository linked, so a rebuild that picks up new '
             + 'environment variables cannot be started from here.',
    };
  }

  const createRes = await fetch(`https://api.vercel.com/v13/deployments${teamQ}`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
    body: JSON.stringify({
      name: proj.name || link.repo,
      project: creds.project,
      target: 'production',
      gitSource: {
        type: link.type || 'github',
        repoId: link.repoId,
        ref: link.productionBranch || 'main',
      },
    }),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    return { success: false, message: 'Vercel: ' + ((created.error && created.error.message) || createRes.status) };
  }
  return {
    success: true,
    message: 'Rebuild started — the site stays up while it builds, and the new database is used once it finishes.',
    url: created.url ? `https://${created.url}` : '',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Trimmed and case-insensitive. This password is typed by hand, and on a phone the first
// letter gets capitalised — that should not read the same as a wrong password.
function samePassword(supplied) {
  const want = String(adminPassword || '').trim().toLowerCase();
  const got = String(supplied || '').trim().toLowerCase();
  return Boolean(want) && got === want;
}

function isAdmin(req) {
  return samePassword(req.headers['x-admin-password'] || '');
}

module.exports = async (req, res) => {
  if (!cachedUrl) {
    return res.status(503).json({ status: 'offline', error: 'DATABASE_URL is not configured on this project.' });
  }
  const pool = makePool();
  try {
    // Never fatal: a database outage must not stop the admin console from opening.
    try {
      await ensureTablesOnce(pool);
    } catch (error) {
      console.warn('[ensureTables] skipped:', error.message);
    }

    // ── GET stats ─────────────────────────────────────────────
    if ((req.method || 'GET').toUpperCase() === 'GET') {
      let hb;
      try {
        hb = await pool.query('SELECT status, last_seen, premium_mode FROM titan_heartbeat WHERE id = 1');
      } catch (error) {
        // Answer 200 with the truth rather than a 500, so the portal still renders and can say
        // which part is down instead of showing an error page.
        const failure = describeDbFailure(error);
        return res.status(200).json({
          status: 'offline',
          database: 'unavailable',
          code: failure.code,
          error: failure.error,
          uptime: 0,
          pairedCount: null,
          activeSessions: null,
          premiumMode: false,
          serverId: '', serverIp: '', serverPort: '', panelDomain: '',
        });
      }
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
      if (!samePassword(body.password)) {
        return res.status(401).json({ success: false, error: 'Incorrect admin password.' });
      }
      // Unlocking the console is a passcode check, so it must not depend on the database. The only
      // thing read here decides which mode button looks active — useful, never essential.
      let premiumMode = false;
      let database = 'ok';
      try {
        const s = await pool.query(`SELECT value FROM titan_settings WHERE key = 'premium_mode'`);
        const hb = await pool.query('SELECT premium_mode FROM titan_heartbeat WHERE id = 1');
        premiumMode = s.rows[0] ? Boolean(s.rows[0].value) : hb.rows[0] ? Boolean(hb.rows[0].premium_mode) : false;
      } catch (error) {
        database = 'unavailable';
        console.warn('[admin_login] gateway mode unavailable:', error.message);
      }
      return res.json({
        success: true,
        database,
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

    // ── admin: which database this deployment is running on ───
    // Host and database name only. The password is not needed to identify a database, and this
    // response is rendered in a browser.
    if (body.action === 'db_current') {
      if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized.' });
      const raw = String(process.env.DATABASE_URL || '');
      let host = '';
      let name = '';
      try {
        const parsed = new URL(raw);
        host = parsed.host;
        name = parsed.pathname.replace(/^\//, '');
      } catch { /* missing or malformed */ }
      const creds = vercelCreds();
      return res.json({
        success: true,
        host,
        database: name,
        urlMasked: raw.replace(/^(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/i, '$1\u2022\u2022\u2022\u2022@'),
        canManage: Boolean(creds.token && creds.project),
        missing: missingVercelCreds(creds),
      });
    }

    // Opens a candidate connection string and closes it again, so a new database can be checked
    // before the site is pointed at it. Read-only: one SELECT 1, nothing is written.
    if (body.action === 'db_test') {
      if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized.' });
      const target = String(body.url || '').trim();
      if (!/^postgres(ql)?:\/\//i.test(target)) {
        return res.json({ success: false, message: 'That does not look like a PostgreSQL connection string.' });
      }
      const probe = new Pool({
        connectionString: target.split('?')[0],
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 8000,
        max: 1,
      });
      try {
        await probe.query('SELECT 1');
        return res.json({ success: true, message: 'Connection OK — the database answered.' });
      } catch (error) {
        return res.json({ success: false, message: 'Could not connect: ' + (error.message || 'unknown error') });
      } finally {
        await probe.end().catch(() => {});
      }
    }

    // Writes DATABASE_URL onto the Vercel project and starts a build. Those two steps together are
    // what actually moves the deployment onto a different database.
    if (body.action === 'db_set') {
      if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized.' });
      const target = String(body.url || '').trim();
      if (!/^postgres(ql)?:\/\//i.test(target)) {
        return res.json({ success: false, message: 'That does not look like a PostgreSQL connection string.' });
      }
      const creds = vercelCreds();
      const missing = missingVercelCreds(creds);
      if (missing.length) {
        return res.json({
          success: false,
          message: `Saving the database needs ${missing.join(' and ')} set on this deployment.`,
        });
      }
      const teamQ = creds.team ? `&teamId=${encodeURIComponent(creds.team)}` : '';
      const envRes = await fetch(
        `https://api.vercel.com/v10/projects/${encodeURIComponent(creds.project)}/env?upsert=true${teamQ}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'DATABASE_URL', value: target, type: 'encrypted', target: ['production'] }),
        }
      );
      const envBody = await envRes.json().catch(() => ({}));
      if (!envRes.ok) {
        return res.json({
          success: false,
          message: 'Vercel rejected the environment change: '
                 + ((envBody.error && envBody.error.message) || envRes.status),
        });
      }
      const build = await startProductionBuild(creds);
      return res.json(Object.assign({ databaseSaved: true }, build));
    }

    // Rebuild from Git so an environment change takes effect — Vercel only applies environment
    // variables on a new build, so this is the step that makes the value above real.
    if (body.action === 'redeploy') {
      if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized.' });
      const creds = vercelCreds();
      const missing = missingVercelCreds(creds);
      if (missing.length) {
        return res.json({
          success: false,
          message: `Redeploy needs ${missing.join(' and ')} set on this deployment.`,
        });
      }
      return res.json(await startProductionBuild(creds));
    }

    // admin: list stored sessions
    if (body.action === 'list_sessions') {
      if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized.' });
      const rows = await pool.query(
        `SELECT numero, sid, updated_at FROM titan_sessions ORDER BY updated_at DESC LIMIT 200`
      );
      const counts = await pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE updated_at < now() - interval '30 days')::int AS older_30d
           FROM titan_sessions`
      );
      return res.json({
        success: true,
        sessions: rows.rows,
        total: counts.rows[0].total,
        inactive30d: counts.rows[0].older_30d,
      });
    }

    // admin: remove ONE stored session by number.
    //
    // titan_sessions is keyed by numero, so that is the identifier rather than a synthetic
    // id. As with clear_sessions this only clears the database row (and the WhatsApp
    // credentials stored on it); revoking the link itself is the bot's job with /delpair.
    if (body.action === 'delete_session') {
      if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized.' });
      const numero = String(body.numero == null ? '' : body.numero).trim().slice(0, 40);
      if (!numero) return res.status(400).json({ success: false, error: 'Missing session number.' });
      const r = await pool.query(
        'DELETE FROM titan_sessions WHERE numero = $1 RETURNING numero', [numero]
      );
      if (!r.rows.length) return res.status(404).json({ success: false, error: 'No such session.' });
      return res.json({ success: true, deleted: r.rows[0].numero });
    }

    // admin: remove sessions the bot has not touched for N days.
    //
    // titan_sessions has no status column: the bot writes updated_at when it connects or
    // disconnects a number, not continuously, so a long-lived session can look old. That
    // makes an age rule the only option — and a risky one — so the threshold is explicit,
    // defaults high, and a dry run reports the count before anything is removed.
    if (body.action === 'clear_sessions') {
      if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'Unauthorized.' });
      // days=0 means "every session, regardless of age". It has to be asked for
      // explicitly -- it is never what an empty or malformed field falls back to -- and
      // the count is still reported first so the button confirms before deleting.
      const raw = body.days;
      const parsed = (raw === undefined || raw === null || raw === '') ? 30 : Number(raw);
      const days = Math.min(3650, Math.max(0, Number.isFinite(parsed) ? parsed : 30));
      const all = days === 0;

      if (body.dryRun) {
        const r = all
          ? await pool.query(`SELECT count(*)::int AS n FROM titan_sessions`)
          : await pool.query(
              `SELECT count(*)::int AS n FROM titan_sessions
                WHERE updated_at < now() - make_interval(days => $1::int)`,
              [days]
            );
        return res.json({ success: true, dryRun: true, days, all, wouldClear: r.rows[0].n });
      }

      const r = all
        ? await pool.query(`DELETE FROM titan_sessions RETURNING numero`)
        : await pool.query(
            `DELETE FROM titan_sessions
              WHERE updated_at < now() - make_interval(days => $1::int)
              RETURNING numero`,
            [days]
          );
      return res.json({ success: true, days, all, cleared: r.rows.length });
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
    const failure = describeDbFailure(e);
    // 503 when the database is the problem (data actions are paused), 500 for anything unexpected.
    const status = failure.code === 'database_error' ? 500 : 503;
    return res.status(status).json({
      status: 'offline',
      success: false,
      code: failure.code,
      error: failure.error,
    });
  } finally {
    pool.end().catch(() => {});
  }
};
