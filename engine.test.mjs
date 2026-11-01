import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, act, publicView, rackView, settle, ARABIC_TILES, INITIAL_TIME_MS } from '../lib/engine.js';

let n = 0;
const id = () => 'action-' + String(++n).padStart(8, '0');
const T0 = 1_800_000_000_000;
const tile = (letter, value, isBlank = false, tid) => ({ id: tid || 'x' + (++n), letter, value, isBlank });
const A = (G, type, extra = {}) => ({ type, actionId: id(), game: G.game, turnNo: G.turnNo, ...extra });

/** Game with a known rack for seat 1 (and a known 2nd rack) so that scores are predictable. */
function rigged() {
  const G = createGame();
  G.racks[1] = [tile('ب', 2), tile('ت', 2), tile('ا', 1), tile('ل', 1), tile('م', 1), tile('ن', 1), tile('ر', 2)];
  G.racks[2] = [tile('س', 2), tile('ك', 4), tile('ا', 1), tile('و', 1), tile('ح', 1), tile('د', 2), tile('ف', 3)];
  return G;
}
const place = (G, seat, cells) => cells.map(([r, c, i]) => ({ r, c, id: G.racks[seat][i].id }));
const totalTiles = (G) => G.bag.length + G.racks[1].filter(Boolean).length + G.racks[2].filter(Boolean).length + G.board.flat().filter(Boolean).length;

test('new game: 102 tiles, 7 per rack, unique ids, same distribution as the original table', () => {
  const G = createGame();
  assert.equal(totalTiles(G), 102);
  assert.equal(G.racks[1].length, 7); assert.equal(G.racks[2].length, 7); assert.equal(G.bag.length, 88);
  const all = [...G.bag, ...G.racks[1], ...G.racks[2]];
  assert.equal(new Set(all.map((t) => t.id)).size, 102);
  for (const row of ARABIC_TILES) assert.equal(all.filter((t) => t.letter === row.letter).length, row.count, row.letter);
});

test('PRIVACY: public view never contains bag or rack tile ids, letters-by-slot or the seen list', () => {
  const G = createGame();
  const json = JSON.stringify(publicView(G));
  [...G.bag, ...G.racks[1], ...G.racks[2]].forEach((t) => assert.ok(!json.includes(t.id), 'leaked tile id ' + t.id));
  assert.ok(!('bag' in publicView(G)) && !('racks' in publicView(G)) && !('seen' in publicView(G)));
  assert.equal(publicView(G).bagCount, 88);
  assert.deepEqual(publicView(G).rackCounts, { 1: 7, 2: 7 });
  // each seat only ever receives its own rack
  assert.deepEqual(rackView(G, 1).map((t) => t.id), G.racks[1].map((t) => t.id));
  assert.deepEqual(rackView(G, 2).map((t) => t.id), G.racks[2].map((t) => t.id));
});

test('only the active player can move; opponent tiles cannot be played; replays and stale moves are rejected', () => {
  const G = rigged();
  const p = place(G, 1, [[7, 7, 0], [7, 8, 1]]);
  assert.equal(act(G, 2, A(G, 'move', { placements: place(G, 2, [[7, 7, 0], [7, 8, 2]]) }), T0).error, 'not_your_turn');
  // seat 1 tries to play one of seat 2's tiles
  assert.equal(act(G, 1, A(G, 'move', { placements: [{ r: 7, c: 7, id: G.racks[2][0].id }, { r: 7, c: 8, id: G.racks[1][1].id }] }), T0).error, 'tile_not_in_rack');
  assert.equal(act(G, 1, { ...A(G, 'move', { placements: p }), turnNo: 99 }, T0).error, 'stale');
  assert.equal(act(G, 1, { ...A(G, 'move', { placements: p }), game: 7 }, T0).error, 'stale');
  const move = A(G, 'move', { placements: p });
  const ok = act(G, 1, move, T0);
  assert.ok(!ok.error);
  assert.equal(G.scores[1], (2 + 2) * 2); // star square = double word
  assert.equal(G.current, 2);
  const before = JSON.stringify(G);
  const dup = act(G, 1, move, T0 + 5);                       // network retry with the same actionId
  assert.ok(dup.duplicate); assert.equal(JSON.stringify(G), before, 'duplicate must not change anything');
  // replaying the same placements as a NEW action is stale (turnNo moved on) and, by turn, not theirs anyway
  assert.equal(act(G, 1, { ...A(G, 'move', { placements: p }), turnNo: 0 }, T0).error, 'stale');
});

test('malformed or malicious move payloads are rejected without touching state', () => {
  const G = rigged();
  const snap = JSON.stringify(G);
  const bad = [
    undefined, null, [], 'x', [{}], [{ r: -1, c: 7, id: G.racks[1][0].id }], [{ r: 7, c: 15, id: G.racks[1][0].id }],
    [{ r: 7.5, c: 7, id: G.racks[1][0].id }], [{ r: '7', c: 7, id: G.racks[1][0].id }], [{ r: 7, c: 7, id: 5 }],
    [{ r: 7, c: 7, id: G.racks[1][0].id }, { r: 7, c: 7, id: G.racks[1][1].id }],            // same square twice
    [{ r: 7, c: 7, id: G.racks[1][0].id }, { r: 7, c: 8, id: G.racks[1][0].id }],            // same tile twice
    Array.from({ length: 8 }, (_, i) => ({ r: 7, c: i, id: 'x' + i })),                      // 8 tiles
    [{ r: 7, c: 7, id: '__proto__' }],
  ];
  for (const placements of bad) {
    const out = act(G, 1, A(G, 'move', { placements }), T0);
    assert.ok(out.error, 'accepted: ' + JSON.stringify(placements));
  }
  assert.equal(JSON.stringify(G), snap);
  assert.equal(act(G, 1, { type: 'move', placements: [], actionId: 'short' }, T0).error, 'bad_action_id');
  assert.equal(act(G, 1, { type: 'hack', actionId: id() }, T0).error, 'bad_action');
  assert.equal(act(G, 3, A(G, 'pass'), T0).error, 'bad_seat');
  // a score can never be supplied by the client
  const p = place(G, 1, [[7, 7, 0], [7, 8, 1]]);
  act(G, 1, A(G, 'move', { placements: p, score: 9999, scores: { 1: 9999 } }), T0);
  assert.equal(G.scores[1], 8);
});

test('first move rules, illegal placements and rack/bag bookkeeping', () => {
  const G = rigged();
  assert.equal(act(G, 1, A(G, 'move', { placements: place(G, 1, [[3, 3, 0], [3, 4, 1]]) }), T0).error, 'invalid_placement'); // misses the star
  assert.equal(act(G, 1, A(G, 'move', { placements: place(G, 1, [[7, 7, 0], [8, 8, 1]]) }), T0).error, 'invalid_placement'); // diagonal
  const res = act(G, 1, A(G, 'move', { placements: place(G, 1, [[7, 7, 0], [7, 8, 1], [7, 9, 2]]) }), T0);
  assert.ok(!res.error);
  assert.equal(G.racks[1].filter(Boolean).length, 7, 'rack refilled');
  assert.equal(G.bag.length, 88 - 3);
  assert.equal(totalTiles(G), 102);
  assert.equal(G.rackRev[1], 1); assert.equal(G.rackRev[2], 0);
  assert.equal(act(G, 1, A(G, 'pass'), T0).error, 'not_your_turn');
});

test('blank tile: letter is mandatory and valid; it scores exactly as the original code does (table value 2)', () => {
  const G = rigged();
  G.racks[1][1] = tile('', 2, true); G.racks[1][1].letter = ' ';
  const p = place(G, 1, [[7, 7, 0], [7, 8, 1]]);
  assert.equal(act(G, 1, A(G, 'move', { placements: p }), T0).error, 'blank_letter_required');
  assert.equal(act(G, 1, A(G, 'move', { placements: [p[0], { ...p[1], letter: 'Z' }] }), T0).error, 'blank_letter_required');
  assert.equal(act(G, 1, A(G, 'move', { placements: [p[0], { ...p[1], letter: ' ' }] }), T0).error, 'blank_letter_required');
  assert.ok(!act(G, 1, A(G, 'move', { placements: [p[0], { ...p[1], letter: 'ن' }] }), T0).error);
  assert.equal(G.board[7][8].letter, 'ن');
  assert.equal(G.scores[1], (2 + 2) * 2);
});

test('swap: needs 7+ tiles in the bag, keeps tile count, passes the turn, clears undo', () => {
  const G = rigged();
  const ids = [G.racks[1][0].id, G.racks[1][1].id];
  const out = act(G, 1, A(G, 'swap', { tileIds: ids }), T0);
  assert.ok(!out.error);
  assert.equal(totalTiles(G), 102); assert.equal(G.bag.length, 88);
  assert.equal(G.current, 2); assert.equal(G.scoreless, 1); assert.ok(G.started);
  assert.ok(!G.racks[1].some((t) => t && ids.includes(t.id)), 'swapped tiles are gone from the rack');
  const G2 = rigged(); G2.bag.length = 6;
  assert.equal(act(G2, 1, A(G2, 'swap', { tileIds: [G2.racks[1][0].id] }), T0).error, 'bag_too_small');
  assert.equal(act(G, 2, A(G, 'swap', { tileIds: [] }), T0).error, 'bad_swap');
  assert.equal(act(G, 2, A(G, 'swap', { tileIds: [G.racks[1][0] ? G.racks[1][0].id : 'zzzzzzzz'] }), T0).error, 'tile_not_in_rack');
});

test('six scoreless turns end the game (only once the game has started, as in the original)', () => {
  const G = rigged();
  for (let i = 0; i < 8; i++) { act(G, G.current, A(G, 'pass'), T0 + i); }
  assert.ok(!G.ended, 'passes before any move/swap never end the game in the original either');
  const H = rigged();
  act(H, 1, A(H, 'swap', { tileIds: [H.racks[1][0].id] }), T0); // starts the game, scoreless = 1
  for (let i = 0; i < 4; i++) act(H, H.current, A(H, 'pass'), T0 + i);
  assert.ok(!H.ended && H.scoreless === 5);
  act(H, H.current, A(H, 'pass'), T0 + 9);
  assert.ok(H.ended); assert.equal(H.result.reason, 'passes');
});

test('undo: only the mover, restores score/rack/bag exactly (original bug fixed), request/approve flow', () => {
  const G = rigged();
  const rackBefore = G.racks[1].map((t) => t.id).sort();
  const bagBefore = G.bag.map((t) => t.id);
  act(G, 1, A(G, 'move', { placements: place(G, 1, [[7, 7, 0], [7, 8, 1]]) }), T0);
  assert.equal(act(G, 2, A(G, 'undo'), T0).error, 'not_your_move');
  assert.equal(act(G, 1, A(G, 'undo_request'), T0).error, 'own_move');
  // opponent asks, mover declines
  assert.ok(!act(G, 2, A(G, 'undo_request'), T0).error);
  assert.deepEqual(publicView(G).undoRequest.by, 2);
  assert.equal(act(G, 2, A(G, 'undo_respond', { accept: true }), T0).error, 'not_your_move');
  assert.ok(!act(G, 1, A(G, 'undo_respond', { accept: false }), T0).error);
  assert.equal(G.undoRequest, null); assert.equal(G.scores[1], 8);
  // ask again, mover accepts
  act(G, 2, A(G, 'undo_request'), T0);
  assert.ok(!act(G, 1, A(G, 'undo_respond', { accept: true }), T0).error);
  assert.equal(G.scores[1], 0); assert.equal(G.current, 1);
  assert.equal(G.board.flat().filter(Boolean).length, 0);
  assert.deepEqual(G.racks[1].filter(Boolean).map((t) => t.id).sort(), rackBefore, 'same seven tiles back');
  assert.equal(G.racks[1].length, 7);
  assert.deepEqual(G.bag.map((t) => t.id), bagBefore, 'drawn tiles went back to the front of the bag, in order');
  assert.equal(totalTiles(G), 102);
  assert.equal(act(G, 1, A(G, 'undo'), T0).error, 'nothing_to_undo');
  // a pass makes the previous move un-undoable
  act(G, 1, A(G, 'move', { placements: place(G, 1, [[7, 7, 0], [7, 8, 1]]) }), T0);
  act(G, 2, A(G, 'pass'), T0);
  assert.equal(act(G, 1, A(G, 'undo'), T0).error, 'nothing_to_undo');
});

test('clocks: first move is free, then the active clock runs; pause freezes; timeout only when really expired', () => {
  const G = rigged();
  act(G, 1, A(G, 'move', { placements: place(G, 1, [[7, 7, 0], [7, 8, 1]]) }), T0 + 40_000);
  assert.equal(G.clocks[1], INITIAL_TIME_MS, 'the very first move costs no time (original behaviour)');
  assert.equal(G.turnStartedAt, T0 + 40_000);
  act(G, 2, A(G, 'pass'), T0 + 70_000);
  assert.equal(G.clocks[2], INITIAL_TIME_MS - 30_000);
  assert.equal(G.clocks[1], INITIAL_TIME_MS);
  act(G, 1, A(G, 'pause'), T0 + 100_000);
  assert.ok(G.paused && G.turnStartedAt === null);
  assert.equal(G.clocks[1], INITIAL_TIME_MS - 30_000);
  assert.equal(act(G, 1, A(G, 'pass'), T0 + 101_000).error, 'paused');
  act(G, 2, A(G, 'resume'), T0 + 500_000); // a long pause costs nothing
  assert.equal(G.clocks[1], INITIAL_TIME_MS - 30_000);
  assert.equal(act(G, 2, A(G, 'timeout'), T0 + 501_000).error, 'not_expired');
  // let seat 1's clock run out
  const late = T0 + 500_000 + INITIAL_TIME_MS + 5_000;
  const out = act(G, 2, A(G, 'timeout'), late);
  assert.equal(out.error, 'game_over'); assert.ok(out.settled);   // already settled by the clock check
  assert.ok(G.ended); assert.equal(G.result.reason, 'time_expired'); assert.equal(G.clocks[1], 0);
});

test('a move that arrives after the clock ran out is refused and the game ends on time', () => {
  const G = rigged();
  act(G, 1, A(G, 'swap', { tileIds: [G.racks[1][0].id] }), T0);
  act(G, 2, A(G, 'pass'), T0 + 1000);
  // seat 1 now has 25 minutes; they answer after 26
  const r = act(G, 1, A(G, 'pass'), T0 + 1000 + INITIAL_TIME_MS + 60_000);
  assert.equal(r.error, 'game_over'); assert.ok(r.settled);
  assert.ok(G.ended); assert.equal(G.result.reason, 'time_expired');
});

test('surrender and leaving: original surrender scoring; new game only after the end', () => {
  const G = rigged();
  assert.equal(act(G, 1, A(G, 'new_game'), T0).error, 'game_not_over');
  G.scores = { 1: 30, 2: 10 };
  act(G, 2, A(G, 'surrender'), T0);                                 // seat 2 surrenders (does not need to be their turn)
  const left = G.racks[2].reduce((s, t) => s + (t ? t.value : 0), 0);
  assert.equal(G.scores[2], 0); assert.equal(G.scores[1], 30 + left);
  assert.equal(G.result.reason, 'surrender'); assert.equal(G.result.loser, 2); assert.equal(G.result.winner, 1);
  assert.equal(act(G, 1, A(G, 'pass'), T0).error, 'game_over');
  const next = act(G, 1, A(G, 'new_game'), T0);
  assert.ok(!next.error);
  assert.equal(next.G.game, 2); assert.equal(next.G.scores[1], 0); assert.equal(next.G.current, 1);
  assert.equal(totalTiles(next.G), 102); assert.deepEqual(next.rackChanged, [1, 2]);
  assert.ok(next.G.rackRev[1] > 0 && next.G.rackRev[2] > 0, 'both clients must refetch their new rack');
  // an old-game move can never be replayed into the new game
  assert.equal(act(next.G, 1, { type: 'pass', actionId: id(), game: 1, turnNo: 0 }, T0).error, 'stale');
});

test('rack-empty ending applies the original unused-tile deduction and minutes bonus', () => {
  const G = rigged();
  G.bag = []; G.racks[1] = [tile('ب', 2), tile('ت', 2), null, null, null, null, null];
  G.racks[2] = [tile('غ', 8), tile('ء', 8), tile('ا', 1), null, null, null, null];
  G.scores = { 1: 20, 2: 20 };
  const out = act(G, 1, A(G, 'move', { placements: [{ r: 7, c: 7, id: G.racks[1][0].id }, { r: 7, c: 8, id: G.racks[1][1].id }] }), T0);
  assert.ok(!out.error);
  assert.ok(G.ended); assert.equal(G.result.reason, 'rack_empty');
  assert.equal(G.result.deduction[2], 17);
  // seat1: 20 + 8 + 25 minutes; seat2: 20 - 17 + 25 minutes
  assert.equal(G.scores[1], 20 + 8 + 25); assert.equal(G.scores[2], 20 - 17 + 25);
  assert.equal(G.result.winner, 1);
});

test('FUZZ: 150 random complete games keep every invariant (tile conservation, no leaks, no crashes)', () => {
  let games = 0, moves = 0, ended = 0;
  const rnd = () => Math.random();
  for (let g = 0; g < 150; g++) {
    let G = createGame();
    let now = T0;
    for (let step = 0; step < 400 && !G.ended; step++) {
      now += 5_000 + Math.floor(rnd() * 20_000);
      const seat = G.current;
      const rack = G.racks[seat];
      // try a handful of random placements; fall back to swap/pass
      let done = false;
      for (let attempt = 0; attempt < 25 && !done; attempt++) {
        const k = 1 + Math.floor(rnd() * 4);
        const horiz = rnd() < 0.5;
        const r0 = G.board.flat().some(Boolean) ? Math.floor(rnd() * 15) : 7;
        const c0 = G.board.flat().some(Boolean) ? Math.floor(rnd() * 12) : 5 + Math.floor(rnd() * 3);
        const tiles = rack.filter(Boolean).sort(() => rnd() - 0.5).slice(0, k);
        const placements = tiles.map((t, i) => ({ r: horiz ? r0 : r0 + i, c: horiz ? c0 + i : c0, id: t.id, letter: 'ا' })).filter((p) => p.r < 15 && p.c < 15);
        if (!placements.length) continue;
        const out = act(G, seat, { type: 'move', actionId: id(), game: G.game, turnNo: G.turnNo, placements }, now);
        if (!out.error) { done = true; moves++; G = out.G; }
      }
      if (!done) {
        const r = rnd();
        let out;
        if (r < 0.35 && G.bag.length >= 7 && rack.some(Boolean)) out = act(G, seat, { type: 'swap', actionId: id(), game: G.game, turnNo: G.turnNo, tileIds: [rack.find(Boolean).id] }, now);
        else out = act(G, seat, { type: 'pass', actionId: id(), game: G.game, turnNo: G.turnNo }, now);
        if (!out.error) G = out.G;
      }
      if (rnd() < 0.05 && G.lastMove && !G.ended) { const o = act(G, G.lastMove.seat, { type: 'undo', actionId: id(), game: G.game, turnNo: G.turnNo }, now); if (!o.error) G = o.G; }
      // invariants after every step
      assert.equal(totalTiles(G), 102, `tile conservation broken (game ${g}, step ${step})`);
      const ids = [...G.bag, ...G.racks[1].filter(Boolean), ...G.racks[2].filter(Boolean), ...G.board.flat().filter(Boolean)].map((t) => t.id);
      assert.equal(new Set(ids).size, ids.length, 'duplicate tile id');
      assert.ok(G.racks[1].length <= 7 && G.racks[2].length <= 7, 'rack overflow');
      assert.ok(G.scores[1] >= 0 && G.scores[2] >= 0);
      const pub = JSON.stringify(publicView(G));
      [...G.racks[1], ...G.racks[2], ...G.bag].filter(Boolean).forEach((t) => { if (!G.board.flat().some((b) => b && b.id === t.id)) assert.ok(!pub.includes(t.id), 'public view leaked ' + t.id); });
    }
    games++; if (G.ended) ended++;
  }
  console.log(`      games=${games} accepted moves=${moves} finished games=${ended}`);
  assert.ok(moves > 500);
});
