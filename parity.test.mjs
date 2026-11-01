/**
 * Proves the server engine scores and validates exactly like the ORIGINAL game code.
 * The original <script> is pulled out of index.html (or tests/fixtures/original-index.html if
 * present) and executed in a sandbox with a fake DOM. No game rule is re-implemented here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARABIC_TILES, BOARD_LAYOUT, validatePlacement, scoreMove } from '../lib/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'original-index.html');
const html = fs.readFileSync(fs.existsSync(fixture) ? fixture : path.join(here, '..', 'index.html'), 'utf8');

function loadOriginal() {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const code = blocks.find((b) => b.includes('const ARABIC_TILES') && b.includes('const validatePlacement'));
  assert.ok(code, 'original game script not found in index.html');
  const fake = new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : fake),
    apply: () => fake, set: () => true, has: () => true,
  });
  const sandbox = {
    console: { log() {}, error() {}, warn() {} }, crypto: globalThis.crypto, Math, JSON, Set, Array, Object, Number, String, parseInt, parseFloat,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    window: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => fake, querySelector: () => fake, querySelectorAll: () => [], createElement: () => fake, addEventListener() {} },
    playerName: (n) => 'P' + n, playerFor: (n) => 'P' + n,
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx);
  return ctx;
}

// small deterministic PRNG so failures are reproducible
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

test('tile table and board layout are identical to the original', () => {
  const ctx = loadOriginal();
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(ARABIC_TILES)', ctx)), JSON.parse(JSON.stringify(ARABIC_TILES)));
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(BOARD_LAYOUT)', ctx)), BOARD_LAYOUT);
  const total = ARABIC_TILES.reduce((s, t) => s + t.count, 0);
  assert.equal(total, 102);
});

test('validatePlacement + score: 60 000+ random positions match the original exactly', () => {
  const ctx = loadOriginal();
  const letters = ARABIC_TILES.filter((t) => !t.isBlank);
  const R = rng(20261031);
  let compared = 0, valid = 0, invalid = 0, withCross = 0, bingos = 0;

  for (let game = 0; game < 400; game++) {
    const board = Array.from({ length: 15 }, () => Array(15).fill(null));
    const mk = () => {
      const base = R() < 0.04 ? { letter: ' ', value: 2, isBlank: true } : letters[Math.floor(R() * letters.length)];
      const tile = { id: 't' + Math.floor(R() * 1e9), letter: base.letter === ' ' ? letters[Math.floor(R() * letters.length)].letter : base.letter, value: base.value, isBlank: !!base.isBlank };
      return tile;
    };
    for (let attempt = 0; attempt < 160; attempt++) {
      // build a random candidate move (mostly straight lines, sometimes scattered)
      const n = 1 + Math.floor(R() * 7);
      const horiz = R() < 0.5;
      const placed = [];
      const scatter = R() < 0.12;
      let r0 = Math.floor(R() * 15), c0 = Math.floor(R() * 15);
      if (game % 3 === 0 && attempt === 0) { r0 = 7; c0 = 7 - Math.floor(R() * 4); }
      for (let i = 0; i < n; i++) {
        let r = horiz ? r0 : r0 + i, c = horiz ? c0 + i : c0;
        if (scatter) { r = Math.floor(R() * 15); c = Math.floor(R() * 15); }
        if (R() < 0.08) { if (horiz) c += 1; else r += 1; } // gaps
        if (r > 14 || c > 14 || r < 0 || c < 0) continue;
        if (board[r][c] || placed.some((p) => p.r === r && p.c === c)) continue;
        placed.push({ r, c });
      }
      if (placed.length === 0) continue;
      const work = board.map((row) => row.slice());
      placed.forEach((p) => { work[p.r][p.c] = mk(); });

      // --- original ---
      ctx.__board = work;
      ctx.__placed = placed.map((p) => ({ r: p.r, c: p.c }));
      vm.runInContext('boardState = __board; placedTilesInTurn = __placed;', ctx);
      const o = vm.runInContext('validatePlacement()', ctx);
      const oScore = vm.runInContext('calculateScore()', ctx);
      // --- port ---
      const p = validatePlacement(work, placed);
      const pScore = scoreMove(work, placed);

      compared++;
      if (typeof o === 'string') {
        assert.equal(typeof p, 'string', `game ${game} attempt ${attempt}: original rejected, port accepted`);
        assert.equal(p, o, 'error text differs');
        invalid++;
      } else {
        assert.equal(typeof p, 'object', `game ${game} attempt ${attempt}: original accepted, port rejected (${p})`);
        assert.equal(p.words.length, o.words.length);
        p.words.forEach((w, i) => assert.equal(JSON.stringify(w.map(({ r, c }) => [r, c])), JSON.stringify(o.words[i].map(({ r, c }) => [r, c]))));
        valid++;
        if (o.words.length > 1) withCross++;
        if (placed.length === 7) bingos++;
        // commit to the shared board so later attempts see richer positions
        placed.forEach((q) => { board[q.r][q.c] = work[q.r][q.c]; });
      }
      assert.equal(pScore, oScore, `game ${game} attempt ${attempt}: score ${pScore} != original ${oScore}`);
    }
  }
  assert.ok(compared > 30000, `only ${compared} comparisons`);
  assert.ok(valid > 1500 && invalid > 1500 && withCross > 200, `coverage too thin: valid=${valid} invalid=${invalid} cross=${withCross}`);
  console.log(`      compared=${compared} valid=${valid} invalid=${invalid} multiWord=${withCross} bingo=${bingos}`);
});

test('ORIGINAL BEHAVIOUR NOTE: blank tile scores its table value (2) although it displays 0', () => {
  const ctx = loadOriginal();
  const board = Array.from({ length: 15 }, () => Array(15).fill(null));
  board[7][7] = { id: 'a', letter: 'ب', value: 2, isBlank: false };
  board[7][8] = { id: 'b', letter: 'ت', value: 2, isBlank: true }; // blank straight from the bag: value 2
  ctx.__board = board; ctx.__placed = [{ r: 7, c: 7 }, { r: 7, c: 8 }];
  vm.runInContext('boardState = __board; placedTilesInTurn = __placed;', ctx);
  const original = vm.runInContext('calculateScore()', ctx);
  assert.equal(original, (2 + 2) * 2); // star = double word, blank counted as 2
  assert.equal(scoreMove(board, ctx.__placed), original); // the port preserves it exactly
});

test('ORIGINAL BUG (documented): undo cannot return drawn tiles because lastMoveData.tilesDrawn is emptied by the refill loop', () => {
  const ctx = loadOriginal();
  vm.runInContext(`
    initializeTileBag(); initializeRacks();
    boardState = Array(15).fill(0).map(() => Array(15).fill(null));
    placedTilesInTurn = []; scores = {1:0,2:0}; currentPlayer = 1; gamePaused = false; gameEnded = false;
    const rack = player1Rack;
    [[7,7,0],[7,8,1]].forEach(([r,c,i]) => placeTileFromRack(rack[i].id, r, c, i));
    // keep any blank out of this demo
  `, ctx);
  const hasBlank = vm.runInContext('placedTilesInTurn.some(p => p.originalTile.isBlank)', ctx);
  if (hasBlank) return; // extremely unlikely draw; the demonstration needs plain letters
  vm.runInContext('submitMove();', ctx);
  const bagAfterMove = vm.runInContext('tileBag.length', ctx);
  assert.equal(bagAfterMove, 102 - 14 - 2);
  assert.equal(vm.runInContext('lastMoveData.tilesDrawn.length', ctx), 0, 'tilesDrawn was emptied by the refill loop');
  vm.runInContext('undoLastMove();', ctx);
  assert.equal(vm.runInContext('tileBag.length', ctx), bagAfterMove, 'bag NOT restored by the original undo');
  assert.ok(vm.runInContext('player1Rack.length', ctx) > 7, 'rack overflowed: returned tiles are pushed past slot 7 and become invisible');
});
