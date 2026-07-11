// ===========================================================================
// Personal CORS proxy for the viewer's live leaderboard/ghost fetch, as a
// Cloudflare Worker — the hosted-site equivalent of serve.py's /vd route.
//
// Why it exists: VelociDrone's `getFlight` response carries no
// Access-Control-Allow-Origin header, so a browser on GitHub Pages can never
// read it directly. And its request holds your account email AES-encrypted
// with a *public* key, so routing through a third-party CORS proxy would
// expose it. This worker is the fix you own: browser -> your worker ->
// VelociDrone, nobody else in the path.
//
// Deploy (once, free tier is plenty):
//   1. https://dash.cloudflare.com -> Workers & Pages -> Create -> Worker
//   2. Replace the starter code with this file, hit Deploy
//   3. Copy the worker URL (https://<name>.<account>.workers.dev) into the
//      viewer's "proxy URL" field (shown under Human lines when the viewer
//      isn't running on localhost)
// ===========================================================================

const UPSTREAM = 'https://www.velocidrone.com/api/';
// same allowlist as serve.py
const ALLOWED = ['leaderboard/', 'get_official_tracks', 'download-file'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const path = new URL(req.url).pathname.replace(/^\/+/, '');
    if (!ALLOWED.some(p => path.startsWith(p))) {
      return new Response('endpoint not allowed', { status: 403, headers: CORS });
    }
    const upstream = await fetch(UPSTREAM + path, {
      method: req.method,
      headers: {
        'Content-Type': req.headers.get('Content-Type') || 'application/x-www-form-urlencoded',
        'User-Agent': 'vd-track-viewer',
      },
      body: req.method === 'POST' ? await req.arrayBuffer() : undefined,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': 'text/plain' },
    });
  },
};
