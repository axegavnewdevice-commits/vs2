/** Production backend: Supabase Postgres (service_role, server-side only) + Realtime Broadcast REST API. */
import { createClient } from '@supabase/supabase-js';
import { HttpError } from './service.js';

let admin = null;
function env() {
  const vars = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  const missing = Object.keys(vars).filter((k) => !vars[k]);
  // names only, never values: tells the person which Vercel variable to add
  if (missing.length) throw new HttpError(500, 'server_not_configured', { missing });
  return { url: vars.SUPABASE_URL.trim().replace(/\/+$/, ''), serviceKey: vars.SUPABASE_SERVICE_ROLE_KEY.trim(), anonKey: vars.SUPABASE_ANON_KEY.trim() };
}
function db() {
  if (!admin) {
    const { url, serviceKey } = env();
    admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return admin;
}
async function rpc(fn, args) {
  const { data, error } = await db().rpc(fn, args);
  if (error) { console.error(`rpc ${fn} failed:`, error.code, error.message); throw new HttpError(500, 'database_error', { code: error.code || null }); }
  return data;
}

export const supabaseBackend = {
  publicConfig() {
    const { url, anonKey } = env();
    return { mode: 'supabase', url, anonKey }; // the anon key is public by design; RLS protects the data
  },
  async verifyToken(token) {
    const { data, error } = await db().auth.getUser(token);
    return error || !data || !data.user ? null : { id: data.user.id };
  },
  createRoom: ({ code, userId, name, publicState, state, ttl }) =>
    rpc('create_room', { p_code: code, p_user: userId, p_name: name, p_public: publicState, p_state: state, p_ttl: ttl }),
  joinRoom: ({ code, userId, name, ttl }) => rpc('join_room', { p_code: code, p_user: userId, p_name: name, p_ttl: ttl }),
  loadRoom: (code) => rpc('load_room', { p_code: code }),
  commitRoom: ({ roomId, expectedVersion, status, publicState, state, ttl }) =>
    rpc('commit_room', { p_room_id: roomId, p_expected_version: expectedVersion, p_status: status, p_public: publicState, p_state: state, p_ttl: ttl }),
  cleanupExpired: () => rpc('cleanup_expired_rooms', {}),
  async broadcast(code, event, payload) {
    const { url, serviceKey } = env();
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        apikey: serviceKey, 'Content-Type': 'application/json',
        // legacy service_role keys are JWTs and go in Authorization; the newer sb_secret_ keys are not JWTs and must only be sent as apikey
        ...(serviceKey.startsWith('eyJ') ? { Authorization: `Bearer ${serviceKey}` } : {}),
      },
      body: JSON.stringify({ messages: [{ topic: `room:${code}`, event, payload, private: true }] }),
    });
    if (!res.ok) throw new Error(`broadcast HTTP ${res.status}`);
  },
};
