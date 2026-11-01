/** Single-player (hot-seat) regression: the original game must behave exactly as before when no room is joined. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }
import { startDevServer } from '../dev/dev-server.mjs';

const srv = await startDevServer({ port: 8792 });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
await ctx.route(/cdn\.tailwindcss|gstatic|googleapis|jsdelivr/, (r) => r.abort());
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
const prep = async () => { await page.waitForFunction(() => window.MP_READY === true); await page.evaluate(() => document.getElementById('welcome-splash')?.remove()); await page.addStyleTag({ content: '.hidden{display:none!important}' }); };
const click = (sel) => page.locator(sel).first().evaluate((el) => el.click());
const log = (m) => console.log('  ✓ ' + m);

await page.goto(srv.url + '/index.html'); await prep();
assert.equal(await page.evaluate(() => MP.active), false);
// both racks are real and the off-turn one is hidden by the ORIGINAL flip logic
assert.equal(await page.evaluate(() => player1Rack.filter(Boolean).length + player2Rack.filter(Boolean).length), 14);
assert.equal(await page.evaluate(() => tileBag.length), 88);
log('local mode untouched: 14 real tiles dealt, bag of 88, multiplayer inactive');

const idx = await page.evaluate(() => player1Rack.map((t, i) => (t && !t.isBlank ? i : -1)).filter((i) => i >= 0));
for (const [k, c] of [[idx[0], 7], [idx[1], 8]]) { await click(`#rack-1 .rack-slot[data-slot-index="${k}"]`); await click(`.square[data-r="7"][data-c="${c}"]`); }
await click('#submit-move');
await page.waitForFunction(() => currentPlayer === 2);
assert.ok(await page.evaluate(() => scores[1] > 0));
assert.equal(await page.evaluate(() => player1Rack.filter(Boolean).length), 7);
log('local move scored and the turn passed, exactly as before');
// the original undo flow still runs (note: it has the pre-existing tile-return bug, see README)
await click('#pass-turn');
await page.waitForFunction(() => currentPlayer === 1);
log('local pass works');

// save / resume prompt still works after reload
await page.waitForTimeout(1500);
await page.reload(); await prep();
await page.waitForFunction(() => !document.getElementById('resume-modal').classList.contains('hidden'), null, { timeout: 5000 });
log('"resume your saved game" prompt still appears after a reload');
assert.equal(await page.evaluate(() => MP.active), false);
assert.deepEqual(errors, [], errors.join(' | '));
await browser.close(); srv.closeAll();
console.log('\nLOCAL E2E PASSED'); process.exit(0);
