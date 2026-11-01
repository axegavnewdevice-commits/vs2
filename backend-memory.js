/** In-memory backend with the same semantics as the SQL functions. For tests and `npm run dev` only. */
import { randomUUID } from 'node:crypto';

const ttlMs = (t) => ({ '1 hour': 3600e3, '6 hours': 6 * 3600e3, '10 minutes': 600e3 }[t] ?? 3600e3);

export function createMemoryBackend({ now = () => Date.now() } = {}) {
  const rooms = new Map(); // code -> { room, players, state, public }
  const tokens = new Map();
  const listeners = new Set(); // (code, event, payload) => void
  const clone = (v) => JSON.parse(JSON.stringify(v)); // like a DB round trip: no shared references

  return {
    rooms, listeners,
    publicConfig: () => ({ mode: 'dev' }),
    issueToken() { const id = randomUUID(); const token = 'dev.' + id; tokens.set(token, id); return { token, id }; },
    async verifyToken(token) { return tokens.has(token) ? { id: tokens.get(token) } : null; },
    async createRoom({ code, userId, name, publicState, state, ttl }) {
      for (const [c, r] of rooms) if (r.room.created_by === userId && r.room.status === 'waiting') rooms.delete(c);
      if (rooms.has(code)) return { error: 'code_taken' };
      rooms.set(code, {
        room: { id: randomUUID(), code, status: 'waiting', version: 0, created_by: userId, expires_at: new Date(now() + ttlMs(ttl)).toISOString() },
        players: [{ seat: 1, user_id: userId, name }], state: clone(state), public: clone(publicState),
      });
      return { ok: true, room_id: rooms.get(code).room.id };
    },
    async joinRoom({ code, userId, name, ttl }) {
      const r = rooms.get(code);
      if (!r) return { error: 'not_found' };
      if (r.room.status === 'closed') return { error: 'closed' };
      if (Date.parse(r.room.expires_at) <= now()) return { error: 'expired' };
      const mine = r.players.find((p) => p.user_id === userId);
      if (mine) return { ok: true, room_id: r.room.id, seat: mine.seat, rejoined: true };
      if (r.players.length >= 2) return { error: 'full' };
      r.players.push({ seat: 2, user_id: userId, name });
      Object.assign(r.room, { status: 'playing', version: r.room.version + 1, expires_at: new Date(now() + ttlMs(ttl)).toISOString() });
      return { ok: true, room_id: r.room.id, seat: 2, rejoined: false };
    },
    async loadRoom(code) {
      const r = rooms.get(code);
      return r ? clone({ room: r.room, players: r.players, state: r.state }) : null;
    },
    async commitRoom({ roomId, expectedVersion, status, publicState, state, ttl }) {
      const r = [...rooms.values()].find((x) => x.room.id === roomId);
      if (!r || r.room.version !== expectedVersion) return { error: 'conflict' };
      Object.assign(r.room, { version: r.room.version + 1, status, expires_at: new Date(now() + ttlMs(ttl)).toISOString() });
      r.state = clone(state); r.public = clone(publicState);
      return { ok: true, version: r.room.version };
    },
    async cleanupExpired() {
      let n = 0;
      for (const [c, r] of rooms) if (Date.parse(r.room.expires_at) < now()) { rooms.delete(c); n++; }
      return n;
    },
    async broadcast(code, event, payload) { listeners.forEach((l) => l(code, event, payload)); },
  };
}
