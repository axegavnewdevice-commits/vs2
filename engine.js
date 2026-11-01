/**
 * Arabic Scrabble rules engine (server side, pure: no I/O).
 *
 * Everything here is a 1:1 port of the rules in index.html (tile table, board layout,
 * validatePlacement, scoreWord, submit/swap/pass/undo/surrender/end-game logic).
 * tests/parity.test.mjs runs the ORIGINAL functions from index.html side by side with this
 * file on thousands of random positions to prove the scoring and validation are identical.
 */
import { randomBytes, randomInt } from 'node:crypto';

export const ARABIC_TILES = [
  { letter: 'ا', value: 1, count: 10 },
  { letter: 'ل', value: 1, count: 6 },
  { letter: 'ي', value: 1, count: 5 },
  { letter: 'ة', value: 2, count: 3 },
  { letter: 'ب', value: 2, count: 4 },
  { letter: 'ت', value: 2, count: 4 },
  { letter: 'ر', value: 2, count: 4 },
  { letter: 'ص', value: 4, count: 2 },
  { letter: 'ن', value: 1, count: 4 },
  { letter: 'ئـ', value: 10, count: 2 },
  { letter: 'ؤ', value: 10, count: 2 },
  { letter: 'د', value: 2, count: 3 },
  { letter: 'ف', value: 3, count: 3 },
  { letter: 'ح', value: 1, count: 3 },
  { letter: 'س', value: 2, count: 3 },
  { letter: 'ع', value: 4, count: 3 },
  { letter: 'ج', value: 1, count: 3 },
  { letter: 'و', value: 1, count: 5 },
  { letter: 'ق', value: 3, count: 3 },
  { letter: 'غ', value: 8, count: 2 },
  { letter: 'خ', value: 1, count: 2 },
  { letter: 'ء', value: 8, count: 2 },
  { letter: 'ش', value: 3, count: 2 },
  { letter: 'م', value: 1, count: 4 },
  { letter: 'ز', value: 3, count: 2 },
  { letter: 'ك', value: 4, count: 3 },
  { letter: 'هـ', value: 1, count: 3 },
  { letter: 'ئ', value: 6, count: 2 },
  { letter: 'ط', value: 4, count: 2 },
  { letter: 'ض', value: 4, count: 1 },
  { letter: 'ذ', value: 3, count: 1 },
  { letter: 'ظ', value: 5, count: 1 },
  { letter: 'ث', value: 3, count: 1 },
  { letter: ' ', value: 2, count: 2, isBlank: true }, // blank tile (same table row as the original)
];

export const BOARD_LAYOUT = [
  [4, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 4],
  [0, 3, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 3, 0],
  [0, 0, 3, 0, 0, 0, 1, 0, 1, 0, 0, 0, 3, 0, 0],
  [1, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 1],
  [0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0],
  [0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0],
  [0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0],
  [4, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 1, 0, 0, 4],
  [0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0],
  [0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0],
  [0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0],
  [1, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 1],
  [0, 0, 3, 0, 0, 0, 1, 0, 1, 0, 0, 0, 3, 0, 0],
  [0, 3, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 3, 0],
  [4, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 4],
];

export const RACK_SIZE = 7;
export const INITIAL_TIME_MS = 25 * 60 * 1000;
export const SEEN_LIMIT = 60;
export const HISTORY_LIMIT = 400;

const PLAYABLE_LETTERS = new Set(ARABIC_TILES.filter((t) => !t.isBlank).map((t) => t.letter));
const other = (s) => (s === 1 ? 2 : 1);
const newTileId = () => 't' + randomBytes(6).toString('hex');
const emptyBoard = () => Array.from({ length: 15 }, () => Array(15).fill(null));
const clone = (v) => JSON.parse(JSON.stringify(v));

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
}

/* ------------------------------------------------------------------ */
/* Rules ported from index.html                                         */
/* ------------------------------------------------------------------ */

/** Port of scoreWord(). */
export function scoreWord(wordTiles, placedCoords) {
  let score = 0;
  let wordMultiplier = 1;
  for (const { r, c, tile } of wordTiles) {
    let letterScore = tile.value;
    const isNewTile = placedCoords.includes(`${r},${c}`);
    if (isNewTile) {
      const multiplier = BOARD_LAYOUT[r][c];
      if (multiplier === 1) letterScore = tile.value * 2;
      else if (multiplier === 2) letterScore = tile.value * 3;
      if (multiplier === 3 || multiplier === 5) wordMultiplier *= 2;
      else if (multiplier === 4) wordMultiplier *= 3;
    }
    score += letterScore;
  }
  return score * wordMultiplier;
}

/**
 * Port of validatePlacement(). `boardState` must already contain the placed tiles
 * (exactly like the original, where staged tiles live in boardState) and `placed` is
 * the list of {r, c}. Returns { words } or an (Arabic) error string.
 */
export function validatePlacement(boardState, placed) {
  const placedCoords = placed.map((p) => `${p.r},${p.c}`);
  if (placed.length === 0) return 'الرجاء وضع قطعة واحدة على الأقل.';

  const allTilesEmpty = boardState.flat().filter((t) => t !== null).length === placed.length;
  if (allTilesEmpty) {
    if (!placed.some((p) => p.r === 7 && p.c === 7)) return 'في الحركة الأولى، يجب وضع قطعة على المربع النجمي (7, 7).';
  }

  const rows = new Set(placed.map((p) => p.r));
  const cols = new Set(placed.map((p) => p.c));
  let direction = null;

  if (rows.size === 1 && cols.size >= 1) {
    direction = 'horizontal';
    const row = placed[0].r;
    const sortedCols = placed.map((p) => p.c).sort((a, b) => a - b);
    for (let c = sortedCols[0]; c <= sortedCols[sortedCols.length - 1]; c++) {
      if (boardState[row][c] === null) return 'يجب أن تكون القطع الجديدة متصلة ببعضها البعض دون فجوات.';
    }
  } else if (cols.size === 1 && rows.size >= 1) {
    direction = 'vertical';
    const col = placed[0].c;
    const sortedRows = placed.map((p) => p.r).sort((a, b) => a - b);
    for (let r = sortedRows[0]; r <= sortedRows[sortedRows.length - 1]; r++) {
      if (boardState[r][col] === null) return 'يجب أن تكون القطع الجديدة متصلة ببعضها البعض دون فجوات.';
    }
  } else {
    return 'يجب أن تشكل القطع حركة واحدة مستقيمة (أفقية أو عمودية).';
  }

  if (!allTilesEmpty) {
    let connectedToOld = false;
    for (const p of placed) {
      if (
        (p.r > 0 && boardState[p.r - 1][p.c] && !placedCoords.includes(`${p.r - 1},${p.c}`)) ||
        (p.r < 14 && boardState[p.r + 1][p.c] && !placedCoords.includes(`${p.r + 1},${p.c}`)) ||
        (p.c > 0 && boardState[p.r][p.c - 1] && !placedCoords.includes(`${p.r},${p.c - 1}`)) ||
        (p.c < 14 && boardState[p.r][p.c + 1] && !placedCoords.includes(`${p.r},${p.c + 1}`))
      ) {
        connectedToOld = true;
        break;
      }
    }
    if (!connectedToOld) {
      const primaryTiles =
        direction === 'horizontal'
          ? placed.map((p) => {
              let s = p.c; while (s > 0 && boardState[p.r][s - 1]) s--;
              let e = p.c; while (e < 14 && boardState[p.r][e + 1]) e++;
              return e - s;
            })
          : placed.map((p) => {
              let s = p.r; while (s > 0 && boardState[s - 1][p.c]) s--;
              let e = p.r; while (e < 14 && boardState[e + 1][p.c]) e++;
              return e - s;
            });
      const formsNewWordWithOldTiles = primaryTiles.some((length) => length > placed.length - 1);
      if (!formsNewWordWithOldTiles && !connectedToOld) return 'يجب أن تلامس الحركة الجديدة قطعة موجودة بالفعل على اللوح.';
    }
  }

  const words = [];
  const wordKeySet = new Set();
  const getWordTiles = (startR, startC, endR, endC, isHorizontal) => {
    const word = [];
    if (isHorizontal) for (let c = startC; c <= endC; c++) word.push({ r: startR, c, tile: boardState[startR][c] });
    else for (let r = startR; r <= endR; r++) word.push({ r, c: startC, tile: boardState[r][startC] });
    return word;
  };

  const startR = placed.map((p) => p.r).sort((a, b) => a - b)[0];
  const endR = placed.map((p) => p.r).sort((a, b) => a - b)[placed.length - 1];
  const startC = placed.map((p) => p.c).sort((a, b) => a - b)[0];
  const endC = placed.map((p) => p.c).sort((a, b) => a - b)[placed.length - 1];

  if (direction === 'horizontal') {
    const row = startR;
    let ws = startC; while (ws > 0 && boardState[row][ws - 1]) ws--;
    let we = endC; while (we < 14 && boardState[row][we + 1]) we++;
    const primary = getWordTiles(row, ws, row, we, true);
    if (primary.length > 1) { wordKeySet.add(`${row},${ws}-${row},${we}`); words.push(primary); }
    placed.forEach((p) => {
      let cs = p.r; while (cs > 0 && boardState[cs - 1][p.c]) cs--;
      let ce = p.r; while (ce < 14 && boardState[ce + 1][p.c]) ce++;
      if (ce - cs >= 1) {
        const cross = getWordTiles(cs, p.c, ce, p.c, false);
        const key = `${cs},${p.c}-${ce},${p.c}`;
        if (!wordKeySet.has(key)) { wordKeySet.add(key); words.push(cross); }
      }
    });
  } else if (direction === 'vertical') {
    const col = startC;
    let ws = startR; while (ws > 0 && boardState[ws - 1][col]) ws--;
    let we = endR; while (we < 14 && boardState[we + 1][col]) we++;
    const primary = getWordTiles(ws, col, we, col, false);
    if (primary.length > 1) { wordKeySet.add(`${ws},${col}-${we},${col}`); words.push(primary); }
    placed.forEach((p) => {
      let cs = p.c; while (cs > 0 && boardState[p.r][cs - 1]) cs--;
      let ce = p.c; while (ce < 14 && boardState[p.r][ce + 1]) ce++;
      if (ce - cs >= 1) {
        const cross = getWordTiles(p.r, cs, p.r, ce, true);
        const key = `${p.r},${cs}-${p.r},${ce}`;
        if (!wordKeySet.has(key)) { wordKeySet.add(key); words.push(cross); }
      }
    });
  }

  if (words.length === 0 && placed.length > 0) return 'يجب أن تشكل القطع كلمة واحدة على الأقل (من قطعتين أو أكثر).';
  return { words };
}

/** Port of calculateScore(): all words + the 50-point bingo for seven tiles. */
export function scoreMove(boardState, placed) {
  const result = validatePlacement(boardState, placed);
  if (typeof result === 'string') return 0;
  const coords = placed.map((p) => `${p.r},${p.c}`);
  let total = 0;
  result.words.forEach((w) => { total += scoreWord(w, coords); });
  if (placed.length === 7) total += 50;
  return total;
}

/* ------------------------------------------------------------------ */
/* Game state                                                          */
/* ------------------------------------------------------------------ */

export function createGame(game = 1) {
  const bag = [];
  ARABIC_TILES.forEach((t) => {
    for (let i = 0; i < t.count; i++) bag.push({ id: newTileId(), letter: t.letter, value: t.value, isBlank: t.isBlank || false });
  });
  shuffle(bag);
  const racks = { 1: bag.splice(0, RACK_SIZE), 2: bag.splice(0, RACK_SIZE) };
  return {
    game, board: emptyBoard(), bag, racks,
    scores: { 1: 0, 2: 0 }, current: 1, turnNo: 0,
    started: false, paused: false, ended: false,
    clocks: { 1: INITIAL_TIME_MS, 2: INITIAL_TIME_MS }, turnStartedAt: null,
    scoreless: 0, lastMove: null, undoRequest: null, result: null,
    history: [], rackRev: { 1: 0, 2: 0 }, event: null, eventNo: 0, seen: [],
  };
}

const running = (G) => G.started && !G.paused && !G.ended && G.turnStartedAt != null;
export const remainingMs = (G, seat, now) =>
  seat === G.current && running(G) ? G.clocks[seat] - Math.max(0, now - G.turnStartedAt) : G.clocks[seat];

function checkpoint(G, now) {
  if (running(G)) {
    G.clocks[G.current] = Math.max(0, G.clocks[G.current] - Math.max(0, now - G.turnStartedAt));
    G.turnStartedAt = now;
  }
}

function switchTurn(G, now) {
  G.current = other(G.current);
  G.turnStartedAt = G.started && !G.paused && !G.ended ? now : null;
}

/** Appends to the public move history and bumps the event counters (`entry.cells` is for animation only). */
function record(G, entry, now) {
  G.turnNo += 1;
  G.eventNo += 1;
  G.event = { no: G.eventNo, ...entry };
  const { cells, wordText, ...plain } = entry;
  G.history.push({ n: G.eventNo, t: now, ...plain, ...(wordText ? { words: wordText } : {}) });
  if (G.history.length > HISTORY_LIMIT) G.history.splice(0, G.history.length - HISTORY_LIMIT);
}

function endGame(G, reason, now, extra = {}) {
  if (G.ended) return;
  checkpoint(G, now);
  G.turnStartedAt = null;
  G.started = false;
  G.ended = true;
  G.undoRequest = null;
  const deduction = { 1: 0, 2: 0 }, bonus = { 1: 0, 2: 0 };
  [1, 2].forEach((p) => {
    const value = G.racks[p].reduce((sum, t) => (t ? sum + (t.isBlank ? 0 : t.value) : sum), 0);
    deduction[p] = value;
    G.scores[p] -= value;
  });
  [1, 2].forEach((p) => {
    const minutes = Math.floor(Math.ceil(G.clocks[p] / 1000) / 60);
    bonus[p] = minutes;
    G.scores[p] += minutes;
  });
  G.scores[1] = Math.max(0, G.scores[1]);
  G.scores[2] = Math.max(0, G.scores[2]);
  const winner = G.scores[1] > G.scores[2] ? 1 : G.scores[2] > G.scores[1] ? 2 : 0;
  G.result = { reason, winner, deduction, bonus, ...extra };
  record(G, { type: 'end', seat: G.current, reason }, now);
}

/** Port of checkGameEndConditions(). */
function checkEnd(G, now) {
  if (G.ended || !G.started) return false;
  const noTiles = (rack) => rack.every((t) => !t);
  if (G.bag.length === 0 && (noTiles(G.racks[1]) || noTiles(G.racks[2]))) { endGame(G, 'rack_empty', now); return true; }
  if (G.scoreless >= 6) { endGame(G, 'passes', now); return true; }
  return false;
}

/** Ends the game when the running clock has reached zero (what the original's 1s ticker does). */
export function settle(G, now) {
  if (running(G) && remainingMs(G, G.current, now) <= 0) {
    G.clocks[G.current] = 0;
    G.turnStartedAt = now;
    endGame(G, 'time_expired', now);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

const err = (code) => ({ error: code });
const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

function actMove(G, seat, a, now) {
  const list = a.placements;
  if (!Array.isArray(list) || list.length < 1 || list.length > RACK_SIZE) return err('bad_move');
  const rack = G.racks[seat];
  const seenCells = new Set(), seenIds = new Set();
  const staged = [];
  for (const p of list) {
    if (!p || !isInt(p.r, 0, 14) || !isInt(p.c, 0, 14) || typeof p.id !== 'string') return err('bad_move');
    const key = `${p.r},${p.c}`;
    if (seenCells.has(key) || seenIds.has(p.id)) return err('bad_move');
    seenCells.add(key); seenIds.add(p.id);
    if (G.board[p.r][p.c] !== null) return err('square_taken');
    const idx = rack.findIndex((t) => t && t.id === p.id);
    if (idx === -1) return err('tile_not_in_rack');
    if (rack[idx].isBlank && !PLAYABLE_LETTERS.has(p.letter)) return err('blank_letter_required');
    staged.push({ r: p.r, c: p.c, idx, letter: p.letter });
  }

  const work = clone(G.board);
  staged.forEach((s) => {
    const t = { ...rack[s.idx] };
    if (t.isBlank) t.letter = s.letter;
    work[s.r][s.c] = t;
  });
  const placed = staged.map((s) => ({ r: s.r, c: s.c }));
  const validation = validatePlacement(work, placed);
  if (typeof validation === 'string') return { error: 'invalid_placement', message: validation };

  const score = scoreMove(work, placed);
  const wordText = validation.words.map((w) => w.map(({ tile }) => tile.letter).join(''));
  const wordCells = validation.words.map((w) => w.map(({ r, c }) => [r, c]));

  // --- from here the move is legal: mutate ---
  checkpoint(G, now);
  if (!G.started) G.started = true;
  G.scoreless = 0;
  G.undoRequest = null;
  const placements = staged.map((s) => ({ r: s.r, c: s.c, tile: work[s.r][s.c] }));
  staged.forEach((s) => { G.board[s.r][s.c] = work[s.r][s.c]; rack[s.idx] = null; });

  const summary = { type: 'move', seat, score, wordText, cells: wordCells, count: staged.length };
  const rackEmpty = rack.every((t) => !t);
  if (rackEmpty && G.bag.length === 0) {
    G.lastMove = { seat, score, placements, drawn: [], turnNo: G.turnNo + 1 };
    G.scores[seat] += score;
    G.rackRev[seat] += 1;
    record(G, summary, now);
    endGame(G, 'rack_empty', now);
    return { G, rackChanged: [seat] };
  }

  const drawn = G.bag.splice(0, staged.length);
  G.lastMove = { seat, score, placements, drawn: drawn.map((t) => ({ ...t })), turnNo: G.turnNo + 1 };
  G.scores[seat] += score;
  const refill = drawn.slice();
  rack.forEach((t, i) => { if (t === null && refill.length) rack[i] = refill.shift(); });
  G.rackRev[seat] += 1;
  record(G, summary, now);

  if (G.bag.length === 0 && rack.every((t) => !t)) { endGame(G, 'rack_empty', now); return { G, rackChanged: [seat] }; }
  switchTurn(G, now);
  checkEnd(G, now);
  return { G, rackChanged: [seat] };
}

function actSwap(G, seat, a, now) {
  const ids = a.tileIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > RACK_SIZE || new Set(ids).size !== ids.length) return err('bad_swap');
  if (G.bag.length < 7) return err('bag_too_small');
  const rack = G.racks[seat];
  const indices = [];
  for (const id of ids) {
    const i = typeof id === 'string' ? rack.findIndex((t) => t && t.id === id) : -1;
    if (i === -1) return err('tile_not_in_rack');
    indices.push(i);
  }
  checkpoint(G, now);
  indices.sort((x, y) => y - x);
  const swapped = [];
  for (const i of indices) {
    const t = rack[i];
    if (t.isBlank) { t.letter = ' '; t.value = 0; } // same as the original swap code
    swapped.push(t);
    rack[i] = null;
  }
  const newTiles = G.bag.splice(0, indices.length);
  G.bag.push(...swapped);
  shuffle(G.bag);
  rack.forEach((t, i) => { if (t === null && newTiles.length) rack[i] = newTiles.shift(); });
  G.rackRev[seat] += 1;
  G.lastMove = null;
  G.undoRequest = null;
  G.scoreless += 1;
  if (!G.started) G.started = true;
  record(G, { type: 'swap', seat, count: indices.length }, now);
  switchTurn(G, now);
  checkEnd(G, now);
  return { G, rackChanged: [seat] };
}

function actPass(G, seat, a, now) {
  checkpoint(G, now);
  G.scoreless += 1;
  G.lastMove = null;
  G.undoRequest = null;
  record(G, { type: 'pass', seat }, now);
  switchTurn(G, now);
  checkEnd(G, now);
  return { G, rackChanged: [] };
}

function performUndo(G, now) {
  const { seat, score, placements, drawn } = G.lastMove;
  const rack = G.racks[seat];
  checkpoint(G, now);
  G.scores[seat] = Math.max(0, G.scores[seat] - score);
  placements.forEach(({ r, c, tile }) => {
    if (G.board[r][c] && G.board[r][c].id === tile.id) G.board[r][c] = null;
  });
  // Take the freshly drawn tiles back out of the rack and return them to the front of the bag.
  drawn.forEach((d) => {
    const i = rack.findIndex((t) => t && t.id === d.id);
    if (i !== -1) rack[i] = null;
  });
  G.bag.unshift(...drawn);
  placements.forEach(({ tile }) => {
    const restored = { ...tile };
    if (restored.isBlank) restored.letter = ' '; // the player chooses the blank's letter again
    const i = rack.findIndex((t) => t === null);
    if (i !== -1) rack[i] = restored; else rack.push(restored);
  });
  G.rackRev[seat] += 1;
  G.current = seat;
  G.lastMove = null;
  G.undoRequest = null;
  G.scoreless = 0;
  G.turnStartedAt = G.started && !G.paused && !G.ended ? now : null;
  record(G, { type: 'undo', seat, score }, now);
}

function actUndo(G, seat, a, now) {
  if (!G.lastMove) return err('nothing_to_undo');
  if (G.lastMove.seat !== seat) return err('not_your_move');
  performUndo(G, now);
  return { G, rackChanged: [seat] };
}

function actUndoRequest(G, seat, a, now) {
  if (!G.lastMove) return err('nothing_to_undo');
  if (G.lastMove.seat === seat) return err('own_move');
  G.undoRequest = { by: seat, turnNo: G.turnNo };
  G.eventNo += 1;
  G.event = { no: G.eventNo, type: 'undo_request', seat };
  return { G, rackChanged: [] };
}

function actUndoRespond(G, seat, a, now) {
  if (!G.lastMove || !G.undoRequest) return err('no_request');
  if (G.lastMove.seat !== seat) return err('not_your_move');
  if (a.accept === true) { performUndo(G, now); return { G, rackChanged: [seat] }; }
  G.undoRequest = null;
  G.eventNo += 1;
  G.event = { no: G.eventNo, type: 'undo_declined', seat };
  return { G, rackChanged: [] };
}

function actPause(G, seat, a, now, pause) {
  if (G.paused === pause) return { G, rackChanged: [] };
  checkpoint(G, now);
  G.paused = pause;
  G.turnStartedAt = !pause && G.started && !G.ended ? now : null;
  G.eventNo += 1;
  G.event = { no: G.eventNo, type: pause ? 'pause' : 'resume', seat };
  return { G, rackChanged: [] };
}

function actSurrender(G, seat, a, now, extra = {}) {
  const loser = seat, winner = other(seat);
  const remaining = G.racks[loser].reduce((s, t) => (t ? s + (t.isBlank ? 0 : t.value || 0) : s), 0);
  G.scores[loser] = 0;
  G.scores[winner] = (G.scores[winner] || 0) + remaining;
  checkpoint(G, now);
  G.turnStartedAt = null;
  G.started = false;
  G.ended = true;
  G.paused = false;
  G.undoRequest = null;
  G.result = { reason: 'surrender', loser, winner, ...extra };
  record(G, { type: 'end', seat: loser, reason: 'surrender' }, now);
  return { G, rackChanged: [] };
}

function actTimeout(G, seat, a, now) {
  if (!running(G)) return err('no_timeout');
  if (remainingMs(G, G.current, now) > 1500) return err('not_expired'); // 1.5 s tolerance for clock skew
  G.clocks[G.current] = 0;
  endGame(G, 'time_expired', now);
  return { G, rackChanged: [] };
}

function actNewGame(G, seat, a, now) {
  if (!G.ended) return err('game_not_over');
  const next = createGame(G.game + 1);
  next.rackRev = { 1: G.rackRev[1] + 1, 2: G.rackRev[2] + 1 };
  next.eventNo = G.eventNo + 1;
  next.event = { no: next.eventNo, type: 'new_game', seat };
  next.turnNo = 0;
  next.seen = G.seen;
  return { G: next, rackChanged: [1, 2] };
}

const NEEDS_TURNNO = new Set(['move', 'swap', 'pass', 'undo', 'undo_request', 'undo_respond']);

/**
 * Applies one action by `seat`. Returns { G, rackChanged } or { error, message? }.
 * `a.game` / `a.turnNo` guard against replayed or stale requests; `a.actionId` makes retries idempotent.
 * On `error`, G may only have been touched by the clock-expiry settle (see `settled`).
 */
export function act(G, seat, a, now = Date.now()) {
  if (seat !== 1 && seat !== 2) return err('bad_seat');
  if (!a || typeof a.type !== 'string') return err('bad_action');
  if (typeof a.actionId !== 'string' || a.actionId.length < 8 || a.actionId.length > 64) return err('bad_action_id');
  if (G.seen.includes(a.actionId)) return { G, rackChanged: [], duplicate: true };

  // The original ticker ends the game the moment the running clock hits zero.
  if (G.started && settle(G, now) && a.type !== 'new_game') {
    G.seen.push(a.actionId);
    return { G, rackChanged: [], settled: true, error: 'game_over' };
  }

  if (NEEDS_TURNNO.has(a.type) && (a.game !== G.game || a.turnNo !== G.turnNo)) return err('stale');

  let out;
  switch (a.type) {
    case 'move': case 'swap': case 'pass': {
      if (G.ended) return err('game_over');
      if (G.paused) return err('paused');
      if (G.current !== seat) return err('not_your_turn');
      out = a.type === 'move' ? actMove(G, seat, a, now) : a.type === 'swap' ? actSwap(G, seat, a, now) : actPass(G, seat, a, now);
      break;
    }
    case 'undo': case 'undo_request': case 'undo_respond': {
      if (G.ended) return err('game_over');
      if (G.paused) return err('paused');
      out = a.type === 'undo' ? actUndo(G, seat, a, now) : a.type === 'undo_request' ? actUndoRequest(G, seat, a, now) : actUndoRespond(G, seat, a, now);
      break;
    }
    case 'pause': case 'resume':
      if (G.ended) return err('game_over');
      out = actPause(G, seat, a, now, a.type === 'pause');
      break;
    case 'surrender':
      if (G.ended) return err('game_over');
      out = actSurrender(G, seat, a, now);
      break;
    case 'leave':
      out = G.ended ? { G, rackChanged: [] } : actSurrender(G, seat, a, now, { left: true });
      break;
    case 'timeout': out = actTimeout(G, seat, a, now); break;
    case 'new_game': out = actNewGame(G, seat, a, now); break;
    default: return err('bad_action');
  }
  if (out.error) return out;
  out.G.seen.push(a.actionId);
  if (out.G.seen.length > SEEN_LIMIT) out.G.seen.splice(0, out.G.seen.length - SEEN_LIMIT);
  return out;
}

/* ------------------------------------------------------------------ */
/* Views: what each client may see                                      */
/* ------------------------------------------------------------------ */

/** Everything both players may see. Never includes the bag contents or any rack. */
export function publicView(G) {
  const board = [];
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
    const t = G.board[r][c];
    if (t) board.push({ r, c, id: t.id, letter: t.letter, value: t.value, isBlank: !!t.isBlank });
  }
  const ev = G.event ? { ...G.event } : null;
  return {
    game: G.game, turnNo: G.turnNo, current: G.current, scores: G.scores,
    clocks: G.clocks, turnStartedAt: G.turnStartedAt,
    started: G.started, paused: G.paused, ended: G.ended, result: G.result,
    board, bagCount: G.bag.length,
    rackCounts: { 1: G.racks[1].filter(Boolean).length, 2: G.racks[2].filter(Boolean).length },
    scoreless: G.scoreless,
    lastMove: G.lastMove ? { seat: G.lastMove.seat, score: G.lastMove.score } : null,
    undoRequest: G.undoRequest, history: G.history, rackRev: G.rackRev, event: ev,
  };
}

/** The viewer's own rack only (7 slots, null for empty). */
export function rackView(G, seat) {
  const rack = G.racks[seat].slice(0, RACK_SIZE);
  while (rack.length < RACK_SIZE) rack.push(null);
  return rack;
}
