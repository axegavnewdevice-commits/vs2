/** Route logic shared by the Vercel functions (api/*.js) and the local dev server. Storage is injected. */
import { HttpError } from './service.js';

const ALLOWED_ACTION_FIELDS = ['placements', 'tileIds', 'accept', 'type', 'actionId', 'game', 'turnNo'];

export function buildRoutes({ backend, service }) {
  /** Wraps a handler: method check, bearer-token auth, JSON errors, no caching. */
  const handler = ({ methods, auth = true }, fn) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!methods.includes(req.method)) throw new HttpError(405, 'method_not_allowed');
      let user = null;
      if (auth) {
        const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        user = m ? await backend.verifyToken(m[1]) : null;
        if (!user) throw new HttpError(401, 'unauthorized');
      }
      const out = await fn({ req, user, body: req.body && typeof req.body === 'object' ? req.body : {}, query: req.query || {} });
      res.status(200).json(out);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.code, ...e.extra });
      console.error(e);
      res.status(500).json({ error: 'server_error' });
    }
  };

  return {
    config: handler({ methods: ['GET'], auth: false }, async () => backend.publicConfig()),

    // POST {op:'create'|'join'|'leave', ...}   GET ?code=ABC234[&since=N]
    rooms: handler({ methods: ['GET', 'POST'] }, async ({ req, user, body, query }) => {
      if (req.method === 'GET') return service.getState({ userId: user.id, code: query.code, since: query.since });
      switch (body.op) {
        case 'create': return service.createRoom({ userId: user.id, name: body.name });
        case 'join': return service.joinRoom({ userId: user.id, code: body.code, name: body.name });
        case 'leave': return service.leave({ userId: user.id, code: body.code });
        default: throw new HttpError(400, 'bad_op');
      }
    }),

    // POST {code, type, actionId, game, turnNo, ...payload}
    action: handler({ methods: ['POST'] }, async ({ user, body }) => {
      const action = {};
      for (const k of ALLOWED_ACTION_FIELDS) if (k in body) action[k] = body[k]; // nothing else (e.g. a "score") is forwarded
      return service.act({ userId: user.id, code: body.code, action });
    }),

    // Vercel Cron sends "Authorization: Bearer $CRON_SECRET"
    cleanup: handler({ methods: ['GET'], auth: false }, async ({ req }) => {
      const secret = process.env.CRON_SECRET;
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, 'unauthorized');
      return { deleted: await service.cleanup() };
    }),
  };
}
