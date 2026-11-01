import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../dev/backend-memory.js';
import { createService, HttpError } from '../lib/service.js';

let n = 0;
const aid = () => 'action-' + String(++n).padStart(8, '0');
function setup() {
  let t = 1_800_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const backend = createMemoryBackend({ now: clock.now });
  const service = createService(backend, { now: clock.now });
  const user = () => backend.issueToken().id;
  const pings = []; backend.listeners.add((code, ev, p) => pings.push({ code, ev, p }));
  return { backend, service, clock, user, pings };
}
const rejects = async (p, status, code) => {
  await assert.rejects(p, (e) => e instanceof HttpError && e.status === status && e.code === code, `expected ${status} ${code}`);
};
const firstMove = (res) => ({ type: 'move', actionId: aid(), game: res.view.game, turnNo: res.view.turnNo,
  placements: [{ r: 7, c: 7, id: res.rack[0].id, letter: 'ا' }, { r: 7, c: 8, id: res.rack[1].id, letter: 'ا' }] });

test('create -> join -> both see the same public state but only their own rack', async () => {
  const { service, user, pings } = setup();
  const [a, b] = [user(), user()];
  const created = await service.createRoom({ userId: a, name: 'Ali' });
  assert.match(created.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(created.seat, 1); assert.equal(created.status, 'waiting'); assert.equal(created.seated, 1);
  const joined = await service.joinRoom({ userId: b, code: created.code.toLowerCase() + ' ', name: 'Sara' });
  assert.equal(joined.seat, 2); assert.equal(joined.status, 'playing'); assert.equal(joined.names[1], 'Ali'); assert.equal(joined.names[2], 'Sara');
  assert.ok(pings.some((p) => p.ev === 'ping'), 'opponent is pinged when the second player joins');
  const sa = await service.getState({ userId: a, code: created.code });
  assert.deepEqual(sa.view, joined.view);
  const ids = (r) => r.rack.filter(Boolean).map((t) => t.id);
  assert.equal(ids(sa).length, 7); assert.equal(ids(joined).length, 7);
  assert.ok(!ids(sa).some((i) => ids(joined).includes(i)), 'racks differ');
  const blob = JSON.stringify(sa);
  ids(joined).forEach((i) => assert.ok(!blob.includes(i), "player 2's tile id leaked into player 1's response"));
  assert.ok(!blob.includes('"bag"'));
});

test('room is full for a third person; outsiders cannot read or act; invalid/expired codes fail gracefully', async () => {
  const { service, user, clock } = setup();
  const [a, b, c] = [user(), user(), user()];
  const { code } = await service.createRoom({ userId: a });
  await service.joinRoom({ userId: b, code });
  await rejects(service.joinRoom({ userId: c, code }), 409, 'room_full');
  await rejects(service.getState({ userId: c, code }), 403, 'not_a_member');
  await rejects(service.act({ userId: c, code, action: { type: 'pass', actionId: aid(), game: 1, turnNo: 0 } }), 403, 'not_a_member');
  await rejects(service.joinRoom({ userId: c, code: 'ZZZZZZ' }), 404, 'room_not_found');
  await rejects(service.joinRoom({ userId: c, code: 'ab' }), 400, 'invalid_code');
  const again = await service.joinRoom({ userId: b, code });   // refresh / reconnect of a seated player
  assert.equal(again.seat, 2);
  clock.advance(7 * 3600e3);
  await rejects(service.getState({ userId: a, code }), 410, 'room_expired');
  await rejects(service.joinRoom({ userId: c, code }), 410, 'room_expired');
});

test('simultaneous joins: exactly one of many wins the seat', async () => {
  const { service, user } = setup();
  const { code } = await service.createRoom({ userId: user() });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.joinRoom({ userId: user(), code })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'room_full').length, 7);
});

test('moves: waiting room refuses play; wrong player refused; legal move syncs; replay is idempotent', async () => {
  const { service, user, pings } = setup();
  const [a, b] = [user(), user()];
  const c0 = await service.createRoom({ userId: a });
  await rejects(service.act({ userId: a, code: c0.code, action: firstMove(c0) }), 409, 'waiting_for_opponent');
  const j = await service.joinRoom({ userId: b, code: c0.code });
  const sa = await service.getState({ userId: a, code: c0.code });
  await assert.rejects(service.act({ userId: b, code: c0.code, action: { type: 'pass', actionId: aid(), game: 1, turnNo: 0 } }), (e) => Boolean(e.code === 'not_your_turn' && e.status === 409 && e.extra.view && e.extra.rack));
  const mv = firstMove(sa);
  const ok = await service.act({ userId: a, code: c0.code, action: mv });
  assert.equal(ok.view.board.length, 2); assert.equal(ok.view.current, 2); assert.ok(ok.view.scores[1] > 0);
  assert.equal(ok.rack.filter(Boolean).length, 7);
  assert.ok(pings.at(-1).p.v >= ok.version);
  const sb = await service.getState({ userId: b, code: c0.code });
  assert.deepEqual(sb.view.board, ok.view.board); assert.equal(sb.view.scores[1], ok.view.scores[1]);
  const dup = await service.act({ userId: a, code: c0.code, action: mv });     // same actionId, e.g. retry after a dropped response
  assert.ok(dup.duplicate); assert.equal(dup.view.scores[1], ok.view.scores[1]);
  await rejects(service.act({ userId: a, code: c0.code, action: { ...mv, actionId: aid() } }), 409, 'stale');   // replayed old move
  // a forged score field is never forwarded by the API layer, and the engine ignores it anyway
  assert.equal(sb.view.history.at(-1).type, 'move');
});

test('polling: unchanged version returns a tiny response', async () => {
  const { service, user } = setup();
  const a = user(); const r = await service.createRoom({ userId: a });
  const same = await service.getState({ userId: a, code: r.code, since: r.version });
  assert.equal(same.unchanged, true); assert.ok(!same.view && !same.rack);
});

test('concurrent actions from both players never corrupt state (optimistic locking + retry)', async () => {
  const { service, user } = setup();
  const [a, b] = [user(), user()];
  const c0 = await service.createRoom({ userId: a });
  await service.joinRoom({ userId: b, code: c0.code });
  const sa = await service.getState({ userId: a, code: c0.code });
  const mv = firstMove(sa);
  // player 1 moves while player 2 hammers pause/resume and a bogus pass at the same instant
  const jobs = [
    service.act({ userId: a, code: c0.code, action: mv }),
    ...Array.from({ length: 6 }, (_, i) => service.act({ userId: b, code: c0.code, action: { type: i % 2 ? 'resume' : 'pause', actionId: aid() } })),
    service.act({ userId: b, code: c0.code, action: { type: 'pass', actionId: aid(), game: 1, turnNo: 0 } }),
  ];
  const res = await Promise.allSettled(jobs);
  assert.equal(res[0].status, 'fulfilled', 'the legal move must succeed');
  const final = await service.getState({ userId: a, code: c0.code });
  const total = final.view.board.length + final.view.bagCount + final.view.rackCounts[1] + final.view.rackCounts[2];
  assert.equal(total, 102, 'no tile created or lost');
  assert.equal(final.view.board.length, 2);
});

test('leave: waiting room closes; leaving a running game forfeits; closed rooms cannot be used', async () => {
  const { service, user, pings } = setup();
  const [a, b, c] = [user(), user(), user()];
  const w = await service.createRoom({ userId: a });
  const l = await service.leave({ userId: a, code: w.code });
  assert.equal(l.status, 'closed');
  await rejects(service.joinRoom({ userId: b, code: w.code }), 410, 'room_closed');
  const g = await service.createRoom({ userId: a });
  await service.joinRoom({ userId: b, code: g.code });
  const out = await service.leave({ userId: b, code: g.code });
  assert.equal(out.status, 'closed'); assert.equal(out.view.ended, true); assert.equal(out.view.result.loser, 2);
  const seen = await service.getState({ userId: a, code: g.code });   // the opponent can still read the result
  assert.equal(seen.status, 'closed'); assert.equal(seen.view.result.winner, 1);
  await rejects(service.act({ userId: a, code: g.code, action: { type: 'pass', actionId: aid(), game: 1, turnNo: 0 } }), 410, 'room_closed');
  assert.ok(pings.length >= 2);
});

test('creating a new room discards your abandoned waiting room; cleanup removes expired rooms', async () => {
  const { service, user, backend, clock } = setup();
  const a = user();
  const r1 = await service.createRoom({ userId: a });
  const r2 = await service.createRoom({ userId: a });
  assert.ok(!backend.rooms.has(r1.code) && backend.rooms.has(r2.code));
  clock.advance(2 * 3600e3);
  assert.equal(await service.cleanup(), 1);
  assert.equal(backend.rooms.size, 0);
});

test('names are sanitised', async () => {
  const { service, user } = setup();
  const r = await service.createRoom({ userId: user(), name: '  <b>Evil</b>\n"name"  that is far too long ' });
  assert.ok(r.names[1].length <= 14 && !/[<>"&]/.test(r.names[1]));
});
