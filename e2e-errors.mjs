/** Every way "Create room" can fail must say WHY (not one generic message). */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }
import { startDevServer } from '../dev/dev-server.mjs';

const srv = await startDevServer({ port: 8793 });
const browser = await chromium.launch();
const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const fakeSupabase = (authError) => ({ status: 200, contentType: 'text/javascript', body: `window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),signInAnonymously:async()=>({error:${JSON.stringify(authError)}}),onAuthStateChange(){}},realtime:{setAuth(){}}})};` });
const SUPA_CFG = json(200, { mode: 'supabase', url: 'https://x.supabase.co', anonKey: 'k' });

const cases = [
  ['API files not deployed (HTML 404)', async (p) => p.route('**/api/config', (r) => r.fulfill({ status: 404, contentType: 'text/html', body: '<h1>The page could not be found</h1>' })), /api/, /HTTP 404.*not JSON/],
  ['env vars missing', async (p) => p.route('**/api/config', (r) => r.fulfill(json(500, { error: 'server_not_configured', missing: ['SUPABASE_SERVICE_ROLE_KEY'] }))), /SUPABASE_SERVICE_ROLE_KEY/, /server_not_configured/],
  ['function crashed (HTML 500)', async (p) => p.route('**/api/config', (r) => r.fulfill({ status: 500, contentType: 'text/plain', body: 'A server error has occurred' })), /خطأ في الخادم/, /HTTP 500/],
  ['server unreachable', async (p) => p.route('**/api/config', (r) => r.abort()), /الاتصال بالخادم/, /\/api\/config failed/],
  ['supabase-js cannot be downloaded', async (p) => { await p.route('**/api/config', (r) => r.fulfill(SUPA_CFG)); await p.route(/jsdelivr/, (r) => r.abort()); }, /مكتبة Supabase/, /supabase-js/],
  ['anonymous sign-ins disabled', async (p) => { await p.route('**/api/config', (r) => r.fulfill(SUPA_CFG)); await p.route(/jsdelivr/, (r) => r.fulfill(fakeSupabase({ message: 'Anonymous sign-ins are disabled', status: 422, code: 'anonymous_provider_disabled' }))); }, /Anonymous sign-ins/, /auth: 422/],
  ['supabase URL wrong / project paused', async (p) => { await p.route('**/api/config', (r) => r.fulfill(SUPA_CFG)); await p.route(/jsdelivr/, (r) => r.fulfill(fakeSupabase({ message: 'fetch failed', status: 0 }))); }, /SUPABASE_URL/, /auth: fetch failed/],
  ['wrong anon key', async (p) => { await p.route('**/api/config', (r) => r.fulfill(SUPA_CFG)); await p.route(/jsdelivr/, (r) => r.fulfill(fakeSupabase({ message: 'Invalid API key', status: 401 }))); }, /SUPABASE_ANON_KEY/, /auth: HTTP 401/],
  ['SQL migration not run', async (p) => p.route('**/api/rooms', (r) => r.fulfill(json(500, { error: 'database_error', code: 'PGRST202' }))), /ملف SQL/, /database_error \(PGRST202\)/],
];

for (const [name, setup, msgRe, diagRe] of cases) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await ctx.route(/cdn\.tailwindcss|gstatic|googleapis/, (r) => r.abort());
  await setup(page);
  await page.goto(srv.url + '/index.html');
  await page.waitForFunction(() => window.MP_READY === true);
  await page.evaluate(() => document.getElementById('welcome-splash')?.remove());
  await page.locator('#mp-online-button').evaluate((el) => el.click());
  await page.locator('#mp-create').evaluate((el) => el.click());
  await page.waitForFunction(() => document.getElementById('mp-error').textContent.length > 0, null, { timeout: 8000 });
  const msg = await page.locator('#mp-error').innerText(), diag = await page.locator('#mp-diag').innerText();
  assert.match(msg, msgRe, `${name}: message was "${msg}"`);
  assert.match(diag, diagRe, `${name}: diagnostic was "${diag}"`);
  assert.equal(await page.locator('#mp-create').isDisabled(), false, 'dialog must stay usable for a retry');
  console.log(`  ✓ ${name}\n      → ${msg}   [${diag}]`);
  await ctx.close();
}
await browser.close(); srv.closeAll();
console.log('\nERROR-DIAGNOSTICS E2E PASSED'); process.exit(0);
