// Titan Anime MD - pairing bridge (restored from live deployment, pinned upstream)
// NOTE: the original /api/pairing function code was lost with the deleted titan-md repo.
// This proxy forwards to the still-running original deployment so pairing keeps working.
// Replace with the real function source when you have it, and delete the UPSTREAM pin.
const UPSTREAM = 'https://titan-md-repo-7uj9yjd3w-frozenlord254-2896s-projects.vercel.app';

module.exports = async (req, res) => {
  const url = new URL(UPSTREAM + '/api/pairing');
  const q = req.query || {};
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v !== undefined) url.searchParams.append(k, v);
  }
  const method = (req.method || 'GET').toUpperCase();
  const headers = { Accept: 'application/json', 'User-Agent': 'titan-md-proxy' };
  const admin = req.headers['x-admin-password'];
  if (admin) headers['X-Admin-Password'] = admin;
  let body;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    body = JSON.stringify(req.body ?? {});
  }
  try {
    const upstream = await fetch(url, { method, headers, body, cache: 'no-store' });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    res.status(502).json({ status: 'offline', error: 'Titan MD pairing bridge unreachable' });
  }
};
