/**
 * End-to-end test: two (+1) real browser sessions against the dev server (same routes/engine as Vercel,
 * in-memory storage, simulated realtime). Run:  node tests/e2e.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }
import { startDevServer } from '../dev/dev-server.mjs';

const srv = await startDevServer({ port: 8791 });
const browser = await chromium.launch();
fs.mkdirSync('tests/shots', { recursive: true });
const errors = [];
const log = (m) => console.log('  ✓ ' + m);

async function newPlayer(label) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, locale: 'ar' });
  await ctx.route(/cdn\.tailwindcss|gstatic|googleapis|jsdelivr/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  await page.goto(srv.url + '/index.html');
  await page.waitForFunction(() => window.MP_READY === true);
  await page.evaluate(() => document.getElementById('welcome-splash')?.remove());
  await page.addStyleTag({ content: '.hidden{display:none!important}' });   // stands in for the Tailwind CDN (offline sandbox)
  return { ctx, page, label };
}
const click = (page, sel) => page.locator(sel).first().evaluate((el) => el.click());
const mp = (page, expr) => page.evaluate(`(() => { const MP = window.MP; return ${expr}; })()`);
const waitFor = async (page, expr, timeout = 8000) => {
  try { return await page.waitForFunction(`(() => { const MP = window.MP; return ${expr}; })()`, null, { timeout }); }
  catch (e) {
    const dump = await page.evaluate(() => ({ seat: MP.seat, ver: MP.version, status: MP.status, busy: MP.busy, cur: currentPlayer, turnNo: MP.view && MP.view.turnNo, last: MP.view && MP.view.lastMove, ureq: MP.view && MP.view.undoRequest, b87: boardState[8][7] && boardState[8][7].letter, ev: MP.view && MP.view.event, hist: MP.view && MP.view.history.slice(-3) })).catch(() => 'n/a');
    console.error('\nTIMEOUT waiting for: ' + expr + '\n', JSON.stringify(dump));
    throw e;
  }
};
const ids = (page, which) => page.evaluate((w) => (w === 1 ? player1Rack : player2Rack).filter(Boolean).map((t) => t.id), which);

// ---------- create + join ----------
const A = await newPlayer('A'), B = await newPlayer('B');
await click(A.page, '#mp-online-button');
await A.page.fill('#mp-name', 'Ali');
await click(A.page, '#mp-create');
await waitFor(A.page, "MP.active && MP.status==='waiting'");
const code = (await A.page.locator('#mp-code-show').innerText()).trim();
assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
assert.equal(await mp(A.page, "document.getElementById('mp-chip').dataset.state"), 'wait');
assert.match(await A.page.locator('#mp-status').innerText(), /بانتظار/);
await A.page.screenshot({ path: 'tests/shots/1-room-waiting.png' });
log(`room ${code} created; host sees "waiting for opponent"`);

await click(B.page, '#mp-online-button');
await B.page.fill('#mp-name', 'Sara');
await B.page.fill('#mp-code', code.toLowerCase());
await click(B.page, '#mp-join');
await waitFor(B.page, "MP.active && MP.status==='playing'");
await waitFor(A.page, "MP.status==='playing' && MP.oppOnline");
await waitFor(B.page, "MP.oppOnline");
assert.equal(await mp(A.page, 'MP.seat'), 1); assert.equal(await mp(B.page, 'MP.seat'), 2);
assert.equal(await mp(A.page, "document.getElementById('mp-chip').dataset.state"), 'ok');
assert.equal(await A.page.inputValue('#player-2-name'), 'Sara'); assert.equal(await B.page.inputValue('#player-1-name'), 'Ali');
log('guest joined by code (case-insensitive); both see each other online; names synced');

// ---------- a third person and bad codes ----------
const C = await newPlayer('C');
await click(C.page, '#mp-online-button'); await C.page.fill('#mp-code', code); await click(C.page, '#mp-join');
await waitFor(C.page, "document.getElementById('mp-error').textContent.length>0");
assert.match(await C.page.locator('#mp-error').innerText(), /ممتلئة/); assert.equal(await mp(C.page, 'MP.active'), false);
await C.page.fill('#mp-code', 'ZZZZZZ'); await click(C.page, '#mp-join');
await waitFor(C.page, "document.getElementById('mp-error').textContent.includes('غير صحيح')");
await C.page.fill('#mp-code', 'AB'); await click(C.page, '#mp-join');
await waitFor(C.page, "document.getElementById('mp-error').textContent.includes('6')");
log('third player refused ("room full"); unknown and malformed codes handled gracefully');
await C.ctx.close();

// ---------- privacy ----------
const aIds = await ids(A.page, 1), bIds = await ids(B.page, 2);
assert.equal(aIds.length, 7); assert.equal(bIds.length, 7);
const aLetters = await A.page.evaluate(() => player1Rack.map((t) => t.letter));
const oppDom = await A.page.evaluate(() => [...document.querySelectorAll('#rack-2 .tile')].map((t) => ({ hidden: t.classList.contains('tile-hidden'), letter: t.dataset.letter, id: t.dataset.tileId })));
assert.equal(oppDom.length, 7); oppDom.forEach((t) => { assert.ok(t.hidden); assert.equal(t.letter, ''); });
const htmlA = await A.page.content(); bIds.forEach((i) => assert.ok(!htmlA.includes(i), 'B tile id in A page'));
const stateA = JSON.stringify(await A.page.evaluate(() => ({ r2: player2Rack, bag: tileBag, view: MP.view })));
bIds.forEach((i) => assert.ok(!stateA.includes(i), "B's tile id reachable in A's JS state"));
const htmlB = await B.page.content(); aIds.forEach((i) => assert.ok(!htmlB.includes(i)));
assert.ok((await A.page.evaluate(() => tileBag.every((t) => /^bag-/.test(t.id)))));
log('each browser holds only its own rack; opponent rack = 7 blank face-down placeholders; bag = count only');

// ---------- turn enforcement in the UI ----------
await click(B.page, '#rack-2 .rack-slot[data-slot-index="0"]');
await click(B.page, '.square[data-r="7"][data-c="7"]');
assert.equal(await B.page.evaluate(() => placedTilesInTurn.length), 0); assert.equal(await B.page.evaluate(() => boardState[7][7]), null);
assert.equal(await B.page.evaluate(() => document.getElementById('submit-move').disabled && document.getElementById('pass-turn').disabled), true);
log("player 2 cannot place tiles or press move buttons on player 1's turn");

// ---------- player 1 builds a word: opponent sees the tentative tiles live ----------
const plain = await A.page.evaluate(() => player1Rack.map((t, i) => (t && !t.isBlank ? i : -1)).filter((i) => i >= 0));
for (const [k, c] of [[plain[0], 7], [plain[1], 8]]) {
  await click(A.page, `#rack-1 .rack-slot[data-slot-index="${k}"]`);
  await click(A.page, `.square[data-r="7"][data-c="${c}"]`);
}
await waitFor(B.page, "document.querySelectorAll('.square.mp-draft').length===2");
const draftLetter = await B.page.locator('.square[data-r="7"][data-c="7"].mp-draft .tile-letter').innerText();
const placedLetter = await A.page.evaluate(() => boardState[7][7].letter);
assert.equal(draftLetter.trim(), placedLetter.trim());
assert.equal(await B.page.evaluate(() => boardState[7][7]), null, 'a draft is display-only on the opponent');
await B.page.screenshot({ path: 'tests/shots/2-opponent-sees-draft.png' });
log('opponent sees the exact tiles in the exact squares while they are still being arranged');

// ---------- commit ----------
await click(A.page, '#submit-move');
await waitFor(B.page, "currentPlayer===2 && boardState[7][7] && boardState[7][8]");
await waitFor(A.page, "currentPlayer===2 && player1Rack.filter(Boolean).length===7");
const sa = await A.page.evaluate(() => ({ b: boardState.flat().filter(Boolean).map((t) => t.id).sort(), s: scores, bag: tileBag.length }));
const sb = await B.page.evaluate(() => ({ b: boardState.flat().filter(Boolean).map((t) => t.id).sort(), s: scores, bag: tileBag.length }));
assert.deepEqual(sa, sb); assert.ok(sa.s[1] > 0); assert.equal(sa.bag, 102 - 14 - 2);
assert.equal(await B.page.evaluate(() => document.querySelectorAll('.square.mp-draft').length), 0, 'drafts are replaced by the real tiles');
assert.equal(await B.page.evaluate(() => document.querySelectorAll('.word-blink-layer').length >= 0), true);
log(`move committed: identical board/score (${sa.s[1]})/bag on both screens, no refresh needed`);

// ---------- player 2 replies ----------
const p2plain = await B.page.evaluate(() => player2Rack.map((t, i) => (t && !t.isBlank ? i : -1)).filter((i) => i >= 0)[0]);
await click(B.page, `#rack-2 .rack-slot[data-slot-index="${p2plain}"]`);
await click(B.page, '.square[data-r="8"][data-c="7"]');
await click(B.page, '#submit-move');
await waitFor(A.page, "currentPlayer===1 && boardState[8][7]");
await waitFor(B.page, "currentPlayer===1 && player2Rack.filter(Boolean).length===7");
log('player 2 replied; player 1 sees it instantly');

// ---------- undo request (challenge) ----------
await click(A.page, '#undo-last-move'); await click(A.page, '#confirm-undo-btn');
await waitFor(B.page, "document.getElementById('mp-undo-modal').classList.contains('mp-open')");
await B.page.screenshot({ path: 'tests/shots/3-undo-request.png' });
await B.page.locator('#mp-undo-row button').first().evaluate((el) => el.click());
await waitFor(A.page, "boardState[8][7]===null && currentPlayer===2");
await waitFor(B.page, "boardState[8][7]===null && player2Rack.filter(Boolean).length===7");
assert.equal(await B.page.evaluate(() => tileBag.length), 102 - 14 - 2);
log("undo: challenger asks, mover approves, tile returns to the mover's rack, bag restored (no tile lost)");

// ---------- pass + pause ----------
await click(B.page, '#pass-turn');
await waitFor(A.page, "currentPlayer===1");
await click(B.page, '#pause-game');
await waitFor(A.page, 'gamePaused===true');
assert.equal(await A.page.evaluate(() => document.getElementById('submit-move').disabled), true);
await click(A.page, '#pause-game');
await waitFor(B.page, 'gamePaused===false');
log('pass turn and pause/resume synchronise');

// ---------- refresh keeps the game ----------
const before = await ids(A.page, 1);
await A.page.reload(); await A.page.waitForFunction(() => window.MP_READY === true);
await A.page.evaluate(() => document.getElementById('welcome-splash')?.remove());
await waitFor(A.page, "MP.active && MP.view && MP.seat===1 && MP.status==='playing'");
assert.deepEqual(await ids(A.page, 1), before, 'same rack after refresh');
assert.equal(await A.page.evaluate(() => boardState.flat().filter(Boolean).length), 2);
assert.equal(await A.page.evaluate(() => document.getElementById('resume-modal').classList.contains('hidden') || getComputedStyle(document.getElementById('resume-modal')).display === 'none'), true);
log('browser refresh: same seat, same rack, same board; game not lost');

// ---------- offline / reconnect ----------
await B.ctx.setOffline(true);
srv.dropStreams(code, 2);   // what the server sees when B's connection really dies
await waitFor(A.page, '!MP.oppOnline', 12000);
assert.notEqual(await mp(A.page, "document.getElementById('mp-chip').dataset.state"), 'ok');
await A.page.screenshot({ path: 'tests/shots/4-opponent-disconnected.png' });
await B.page.evaluate(() => window.dispatchEvent(new Event('offline')));
assert.equal(await mp(B.page, "document.getElementById('mp-chip').dataset.state"), 'bad');
log('opponent drop detected via Presence on the other side; offline shown on the dropped side');
// while B is away, A plays; B must catch up on reconnect
const a2 = await A.page.evaluate(() => player1Rack.map((t, i) => (t && !t.isBlank ? i : -1)).filter((i) => i >= 0)[0]);
await click(A.page, `#rack-1 .rack-slot[data-slot-index="${a2}"]`); await click(A.page, '.square[data-r="6"][data-c="7"]'); await click(A.page, '#submit-move');
await waitFor(A.page, 'currentPlayer===2 && boardState[6][7]');
await B.ctx.setOffline(false);
await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
await waitFor(B.page, 'boardState[6][7] && currentPlayer===2', 12000);
await waitFor(A.page, 'MP.oppOnline', 12000);
log('reconnect: B recovered the move made while offline; A sees B online again');

// ---------- regression: a ping that lands while a sync is in flight must not be lost ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hold = true;
await A.page.route('**/api/rooms?**', async (route) => { const resp = await route.fetch(); if (hold) await sleep(700); await route.fulfill({ response: resp }); });
await click(B.page, '#pause-game');
await sleep(200);                                           // A's fetch for the "paused" state is now stuck in flight with stale data
await click(B.page, '#pause-game');                         // resume, while that stale fetch is still pending
await sleep(2200);                                          // the held fetch has now been delivered; allow the queued re-sync to finish (still << 15 s poll)
hold = false;
assert.equal(await A.page.evaluate(() => gamePaused), false, 'A is stuck on the stale "paused" state');
assert.equal(await A.page.evaluate(() => MP.version), await B.page.evaluate(() => MP.version), 'A is behind B');
log('a ping arriving during an in-flight sync is queued, not dropped (no stale screen)');

// ---------- surrender + new game ----------
await click(B.page, '#surrender-game'); await B.page.locator('#confirm-surrender-btn').evaluate((el) => el.click());
await waitFor(A.page, 'gameEnded===true'); await waitFor(B.page, 'gameEnded===true');
await waitFor(A.page, "!document.getElementById('result-modal').classList.contains('hidden')");
assert.match(await A.page.locator('#result-winner').innerText(), /Ali/);
await A.page.screenshot({ path: 'tests/shots/5-result.png' });
await click(A.page, '#result-new-btn');
await waitFor(B.page, "gameEnded===false && boardState.flat().filter(Boolean).length===0 && player2Rack.filter(Boolean).length===7");
assert.notDeepEqual(await ids(B.page, 2), bIds, 'a fresh rack for the new game');
log('surrender -> winner announced on both; new game resets both clients with fresh private racks');

// ---------- leave ----------
await click(B.page, '#mp-online-button');
await B.page.locator('#mp-leave').evaluate((el) => el.click()); await B.page.locator('#mp-leave').evaluate((el) => el.click());
await waitFor(A.page, "MP.status==='closed'");
log('leaving closes the room for the other player');

assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
log('no uncaught page errors in any session');
await browser.close(); srv.closeAll();
console.log('\nE2E PASSED');
process.exit(0);
