/**
 * Local development / test server (NOT used on Vercel).
 *   node dev/dev-server.mjs            -> http://localhost:8787
 * Serves the static site and the exact same route code as /api/*, backed by memory instead of Supabase.
 * Realtime is simulated with Server-Sent Events: private "room:<CODE>" topics, membership checks,
 * ping/draft broadcast and presence - mirroring what Supabase Realtime does in production.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryBackend } from './backend-memory.js';
import { createService } from '../lib/service.js';
import { buildRoutes } from '../lib/routes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export function startDevServer({ port = 8787, clockOffset = 0 } = {}) {
  const now = () => Date.now() + clockOffset.valueOf();
  const backend = createMemoryBackend({ now });
  const service = createService(backend, { now });
  const routes = buildRoutes({ backend, service });

  // ---- simulated realtime ----
  const subs = new Map(); // code -> Set<{res, seat, userId}>
  const presence = (code) => [...(subs.get(code) || [])].map((s) => s.seat);
  const emit = (code, event, payload, exceptRes) => (subs.get(code) || new Set()).forEach((s) => {
    if (s.res !== exceptRes) s.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  });
  backend.listeners.add((code, event, payload) => emit(code, event, payload));

  const wrap = (req, res) => {
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    return res;
  };
  const readBody = (req) => new Promise((resolve) => {
    let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/api/config') return routes.config(req, wrap(req, res));
      if (url.pathname === '/api/rooms' || url.pathname === '/api/action') {
        req.query = Object.fromEntries(url.searchParams);
        if (req.method === 'POST') req.body = await readBody(req);
        return (url.pathname === '/api/rooms' ? routes.rooms : routes.action)(req, wrap(req, res));
      }
      if (url.pathname === '/dev/auth' && req.method === 'POST') return wrap(req, res).json(backend.issueToken());
      if (url.pathname === '/dev/now') return wrap(req, res).json({ now: now() });
      if (url.pathname === '/dev/events') { // SSE: only seated members may listen (like the realtime.messages RLS policy)
        const code = url.searchParams.get('code'); const token = url.searchParams.get('token');
        const user = await backend.verifyToken(token || '');
        const room = await backend.loadRoom(code || '');
        const member = user && room && room.players.find((p) => p.user_id === user.id);
        if (!member) { res.statusCode = 403; return res.end('forbidden'); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const sub = { res, seat: member.seat, userId: user.id };
        if (!subs.has(code)) subs.set(code, new Set());
        subs.get(code).add(sub);
        res.write(': open\n\n');
        emit(code, 'presence', { seats: presence(code) });
        req.on('close', () => { subs.get(code).delete(sub); emit(code, 'presence', { seats: presence(code) }); });
        return;
      }
      if (url.pathname === '/dev/draft' && req.method === 'POST') {
        const body = await readBody(req);
        const user = await backend.verifyToken(body.token || '');
        const room = await backend.loadRoom(body.code || '');
        if (user && room && room.players.some((p) => p.user_id === user.id)) {
          const mine = [...(subs.get(body.code) || [])].find((s) => s.userId === user.id);
          emit(body.code, 'draft', body.payload, mine && mine.res);
        }
        return wrap(req, res).json({ ok: true });
      }
      // static files
      let p = decodeURIComponent(url.pathname); if (p.endsWith('/')) p += 'index.html';
      const file = path.join(root, p);
      if (!file.startsWith(root) || /\/(dev|tests|supabase|lib|node_modules)\//.test(p) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(file).pipe(res);
    } catch (e) { console.error(e); res.statusCode = 500; res.end('error'); }
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, backend, service, port, url: `http://localhost:${port}`, dropStreams: (code, seat) => { [...(subs.get(code) || [])].filter((x) => x.seat === seat).forEach((x) => x.res.destroy()); }, closeAll: () => { subs.forEach((set) => set.forEach((s) => s.res.end())); server.close(); } })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDevServer({ port: Number(process.env.PORT) || 8787 }).then((s) => console.log('Dev server (in-memory, no Supabase):', s.url));
}
