/**
 * Room + game service. All business logic of the online mode lives here; it talks to storage and
 * realtime only through the small `backend` interface, so the exact same code runs
 *   - in production on Vercel with lib/backend-supabase.js, and
 *   - in tests / local dev with dev/backend-memory.js.
 *
 * backend interface:
 *   createRoom({code,userId,name,publicState,state,ttl})   -> {ok,room_id} | {error:'code_taken'}
 *   joinRoom({code,userId,name,ttl})                         -> {ok,seat,rejoined} | {error:'not_found'|'closed'|'expired'|'full'}
 *   loadRoom(code)                                           -> {room:{id,code,status,version,expires_at},players:[{seat,user_id,name}],state} | null
 *   commitRoom({roomId,expectedVersion,status,publicState,state,ttl}) -> {ok,version} | {error:'conflict'}
 *   cleanupExpired()                                         -> number
 *   broadcast(code,event,payload)                            -> void
 */
import { randomInt, randomUUID } from 'node:crypto';
import { createGame, act as engineAct, publicView, rackView } from './engine.js';

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: easy to read out loud
export const WAITING_TTL = '1 hour';   // a room nobody joined
export const ACTIVE_TTL = '6 hours';   // refreshed on every move
export const generateCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
export const normalizeCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const STATE_ERRORS = new Set([
  'stale', 'not_your_turn', 'paused', 'game_over', 'game_not_over', 'nothing_to_undo', 'no_request',
  'not_your_move', 'own_move', 'no_timeout', 'not_expired', 'bag_too_small', 'waiting_for_opponent',
]);

export function cleanName(name, seat) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f<>&"`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  return s || `Player ${seat}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createService(backend, { now = () => Date.now() } = {}) {
  const seatOf = (loaded, userId) => {
    const p = loaded.players.find((x) => x.user_id === userId);
    return p ? p.seat : 0;
  };
  const expired = (loaded) => Date.parse(loaded.room.expires_at) <= now();

  async function ping(code, loaded, G) {
    try {
      await Promise.race([
        backend.broadcast(code, 'ping', { v: loaded.room.version, game: G.game, turnNo: G.turnNo, status: loaded.room.status }),
        sleep(1500),
      ]);
    } catch (e) {
      console.warn('broadcast failed (clients will catch up by polling):', e && e.message);
    }
  }

  function respond(loaded, G, seat, extra = {}) {
    const names = { 1: 'Player 1', 2: 'Player 2' };
    loaded.players.forEach((p) => { if (p.name) names[p.seat] = p.name; });
    return {
      code: loaded.room.code, seat, status: loaded.room.status, version: loaded.room.version,
      serverNow: now(), names, seated: loaded.players.length,
      view: publicView(G), rack: rackView(G, seat), ...extra,
    };
  }

  /* ---------------- room lifecycle ---------------- */

  async function createRoom({ userId, name }) {
    try { await backend.cleanupExpired(); } catch (_) { /* best effort */ }
    for (let i = 0; i < 8; i++) {
      const code = generateCode();
      const G = createGame();
      const r = await backend.createRoom({ code, userId, name: cleanName(name, 1), publicState: publicView(G), state: G, ttl: WAITING_TTL });
      if (r && r.ok) {
        const loaded = await backend.loadRoom(code);
        return respond(loaded, loaded.state, 1);
      }
      if (!r || r.error !== 'code_taken') throw new HttpError(500, 'create_failed');
    }
    throw new HttpError(503, 'create_failed');
  }

  async function joinRoom({ userId, code, name }) {
    code = normalizeCode(code);
    if (code.length !== 6) throw new HttpError(400, 'invalid_code');
    const r = await backend.joinRoom({ code, userId, name: cleanName(name, 2), ttl: ACTIVE_TTL });
    if (!r || !r.ok) {
      const map = { not_found: [404, 'room_not_found'], expired: [410, 'room_expired'], closed: [410, 'room_closed'], full: [409, 'room_full'] };
      const [status, c] = map[r && r.error] || [500, 'join_failed'];
      throw new HttpError(status, c);
    }
    const loaded = await backend.loadRoom(code);
    if (!r.rejoined) await ping(code, loaded, loaded.state);
    return respond(loaded, loaded.state, r.seat);
  }

  async function getState({ userId, code, since }) {
    code = normalizeCode(code);
    const loaded = code.length === 6 ? await backend.loadRoom(code) : null;
    if (!loaded) throw new HttpError(404, 'room_not_found');
    const seat = seatOf(loaded, userId);
    if (!seat) throw new HttpError(403, 'not_a_member');
    if (expired(loaded)) throw new HttpError(410, 'room_expired');
    if (since !== undefined && Number(since) === loaded.room.version) {
      return { unchanged: true, version: loaded.room.version, status: loaded.room.status, seated: loaded.players.length, serverNow: now() };
    }
    return respond(loaded, loaded.state, seat);
  }

  /* ---------------- actions ---------------- */

  /**
   * Loads, validates, applies one engine action and commits it with optimistic locking.
   * Retries when another request changed the room in between (version conflict).
   */
  async function mutate({ userId, code, action, closeRoom = false }) {
    code = normalizeCode(code);
    if (code.length !== 6) throw new HttpError(400, 'invalid_code');
    for (let attempt = 0; attempt < 5; attempt++) {
      const loaded = await backend.loadRoom(code);
      if (!loaded) throw new HttpError(404, 'room_not_found');
      const seat = seatOf(loaded, userId);
      if (!seat) throw new HttpError(403, 'not_a_member');
      if (expired(loaded)) throw new HttpError(410, 'room_expired');
      if (loaded.room.status === 'closed') throw new HttpError(410, 'room_closed');
      const G = loaded.state;

      if (loaded.room.status === 'waiting') {
        if (action.type === 'leave') {
          const c = await backend.commitRoom({ roomId: loaded.room.id, expectedVersion: loaded.room.version, status: 'closed', publicState: publicView(G), state: G, ttl: '10 minutes' });
          if (c.error === 'conflict') continue;
          loaded.room.version = c.version; loaded.room.status = 'closed';
          return respond(loaded, G, seat, { left: true });
        }
        throw new HttpError(409, 'waiting_for_opponent', { ...respond(loaded, G, seat) });
      }

      const at = now();
      const out = engineAct(G, seat, action, at);

      if (out.duplicate) return respond(loaded, G, seat, { duplicate: true });

      if (out.error && !out.settled) {
        const status = STATE_ERRORS.has(out.error) ? 409 : 422;
        throw new HttpError(status, out.error, { message: out.message, ...respond(loaded, G, seat) });
      }

      const next = out.G;
      const status = closeRoom ? 'closed' : 'playing';
      const c = await backend.commitRoom({
        roomId: loaded.room.id, expectedVersion: loaded.room.version, status,
        publicState: publicView(next), state: next, ttl: closeRoom ? '10 minutes' : ACTIVE_TTL,
      });
      if (c.error === 'conflict') continue; // someone else changed the room: reload and re-validate
      loaded.room.version = c.version;
      loaded.room.status = status;
      loaded.state = next;
      await ping(code, loaded, next);
      if (out.settled) throw new HttpError(409, 'game_over', { ...respond(loaded, next, seat) });
      return respond(loaded, next, seat);
    }
    throw new HttpError(503, 'busy');
  }

  const act = ({ userId, code, action }) => mutate({ userId, code, action });
  const leave = ({ userId, code }) => mutate({ userId, code, action: { type: 'leave', actionId: randomUUID() }, closeRoom: true });

  return { createRoom, joinRoom, getState, act, leave, cleanup: () => backend.cleanupExpired() };
}
