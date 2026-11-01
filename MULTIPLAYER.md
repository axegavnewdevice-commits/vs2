# Online multiplayer (2 players, private rooms)

Two people open the site, one taps the globe button → **Create room**, shares the 6-character code, the other taps
the globe → enters the code → **Join**. Same board, same clocks, each sees only their own rack.

## How it works

```
Browser A ──HTTPS──┐                          ┌── Supabase Postgres (rooms, players, SECRETS: bag+racks)
Browser B ──HTTPS──┼─► Vercel /api functions ─┤        (only the service_role key can touch it)
   ▲   ▲           │   (rules engine = the    └── Supabase Realtime REST: "room changed, version N"
   │   └───────────┘    original scoring)
   └── Supabase Realtime (private channel room:CODE): ping · opponent's tentative tiles · presence
```

* **The server is the referee.** `lib/engine.js` is a 1:1 port of the original tile table, board layout,
  `validatePlacement`, `scoreWord`, bingo bonus, swap / pass / undo / surrender / end-of-game maths and clocks.
  Clients only *request* actions; the server checks turn, tile ownership, square emptiness, blank letters and the
  original placement rules, scores the move itself, draws tiles from the hidden bag and saves everything in one
  transaction (optimistic version lock). A client can never send a score.
* **Privacy.** Racks and bag live in `room_secrets` (RLS on, no policy, no grant → unreachable from any browser).
  Every response contains the public state plus **only the caller's own rack**. The opponent's rack is 7 blank
  face-down placeholders and the bag is just a number.
* **Realtime** (Broadcast + Presence) is only a nudge: broadcasts carry "version N exists" and the opponent's
  tentative tiles; the client then fetches authoritative state over HTTPS. Because Supabase lets members also send
  broadcasts, a forged message can therefore never change anybody's game.
* **Recovery.** Seat = anonymous Supabase user id stored in the browser, so a refresh puts you straight back into
  the same seat, rack and board. After a network drop the client retries with the *same* `actionId` (never applied
  twice), re-syncs on `online` / tab-visible / realtime-reconnect, and polls every 15 s (3 s if realtime is down).
* **Anti-cheat / integrity.** Wrong turn, stale `game`/`turnNo` (replayed old moves), duplicate `actionId`, foreign
  or invented tile ids, occupied squares, malformed payloads, a third player, expired or closed rooms → all rejected
  server-side. Tests prove each one.

## Rules of play online (decisions worth knowing)

| Topic | Behaviour |
| --- | --- |
| Challenge / undo | There is no dictionary (same as the original). The player who just moved can take their move back; the opponent can *ask*, and the mover gets an Accept / Decline dialog. |
| Surrender / Leave | Surrender uses the original scoring. **Leaving a running game = surrender**, and closes the room. |
| New game | Only after a game ended (either player can start it): fresh bag and racks, Player 1 starts, as in the original. |
| Clocks | 25:00 each, first move is free, pause stops both — as in the original, but timed by the server. A clock that hits 0 ends the game (any client reports it, the server verifies). |
| Pause | Either player can pause/resume. |
| Opponent drops | Chip shows "opponent offline – waiting for return" for 90 s, then "offline for a while". The seat is held for the room's lifetime, the clock keeps running. |
| Room lifetime | Unjoined: 1 h. Playing: 6 h since the last move. Expired rooms are refused everywhere and deleted by a daily Vercel cron + lazily on room creation. |
| Names | Entered in the room dialog (max 14 chars); shown on both screens. |

## One-time setup

### 1. Supabase
1. Create a project at <https://supabase.com>.
2. **Authentication → Sign In / Providers → enable "Allow anonymous sign-ins".** (Players get an invisible, stable
   id; no email or password.)
3. **SQL Editor → New query →** paste `supabase/migrations/20261031000000_online_multiplayer.sql` → **Run**.
   (Or `supabase db push`.) It is safe to re-run.
4. **Realtime → Settings →** turn **"Allow public access" OFF** (so only the private, RLS-protected channels work).
5. **Project Settings → API:** copy the *Project URL*, the *anon / publishable* key and the *service_role / secret* key.

### 2. GitHub + Vercel
1. Push this folder to GitHub (`.env*` files are already git-ignored).
2. Vercel → *Add New Project* → import the repo. Framework preset **Other**; no build command; output = root.
3. **Settings → Environment Variables** (Production + Preview), see `.env.example`:

   | Name | Value | Visible to browser? |
   | --- | --- | --- |
   | `SUPABASE_URL` | Project URL | yes (public) |
   | `SUPABASE_ANON_KEY` | anon / publishable key | yes (public by design; RLS protects data) |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role / secret key | **NO — server only** |
   | `CRON_SECRET` | long random string (`openssl rand -hex 32`) | no |

4. Deploy. The browser gets only the URL and anon key, from `/api/config`. The service-role key is never in any
   client file.

### 3. First-run smoke test (please do this once — see "Not verified here")
1. Open the site in two different browsers/devices. In A: globe → *Create room*. In B: globe → enter code → *Join*.
2. A places two tiles → B must see them dashed in the same squares → A taps ✓ → both boards/scores match.
3. Refresh A mid-game → same rack and board. Turn off B's Wi-Fi for a few seconds → A sees "opponent offline";
   turn it on → B catches up.
4. A third browser entering the code must see "room full".

## Troubleshooting: "Create room" shows an error

The dialog now shows the reason, plus a small grey technical line under it. What it means:

| Message in the dialog | Cause | Fix |
| --- | --- | --- |
| الخادم... غير منشورة (مجلد api) / `HTTP 404 … not JSON` | The `api/` folder is not deployed as functions (wrong repo/branch/root directory, or the site is hosted somewhere other than Vercel) | Make sure `api/`, `lib/` and `package.json` are in the repo root that Vercel builds. Open `https://YOUR-SITE/api/config` in a browser: it must show JSON |
| الخادم غير مُهيّأ بعد: NAME | Environment variable `NAME` is missing in Vercel | Add it (Settings → Environment Variables), then **redeploy** (variables only apply to new deployments) |
| حدث خطأ في الخادم / `HTTP 500 … not JSON` | The function crashed (see Vercel → Deployments → Functions → Logs) | Usually a missing/typo'd variable or dependency install failure |
| فعّل Anonymous sign-ins | Supabase → Authentication → Sign In / Providers → *Allow anonymous sign-ins* is off | Turn it on |
| تعذر الوصول إلى Supabase | `SUPABASE_URL` is wrong (must be `https://<ref>.supabase.co`, no trailing path) or the free project is paused | Fix the URL / restore the project |
| رفض Supabase تسجيل الدخول | `SUPABASE_ANON_KEY` is wrong | Copy it again from Project Settings → API |
| قاعدة البيانات غير جاهزة | The SQL migration was not run | Run `supabase/migrations/…sql` in the SQL Editor |

If you use Supabase's newer *publishable / secret* keys and something fails, use the **Legacy API keys** tab
(`anon` / `service_role`) instead. After redeploying, close and reopen the app (or reload twice): the offline cache
may serve the previous version once.

## Develop and test locally (no Supabase needed)

```bash
npm install
npm test                # engine + original-parity + service tests (node:test)
node tests/e2e.mjs      # two real browser sessions + a third intruder (needs Playwright + Chromium)
node tests/e2e-local.mjs# the original single-player game still works
node tests/e2e-errors.mjs# every failure mode shows a specific message
npm run dev             # http://localhost:8787 — full game with in-memory rooms and simulated realtime
```

## What was and was not verified

**Verified by automated tests in the build environment**
* `tests/parity.test.mjs` — the server rules vs the **original code from `tests/fixtures/original-index.html`**
  executed side by side on **60 088 random positions** (10 274 legal, 49 814 illegal, 5 736 multi-word, 241 bingos):
  identical validity, error text, word lists and scores. Tile table (102 tiles) and board layout identical.
* `tests/engine.test.mjs` — turn enforcement, replay/stale/duplicate rejection, malformed payloads, privacy of the
  public view, clocks/pause/timeouts, swap, undo (+ approval flow), surrender, end-of-game maths, and 150 random
  complete games checking tile conservation after every step. Mutation checks confirmed the tests fail when the
  turn check, replay check, rack-ownership check or privacy filter is removed.
* `tests/service.test.mjs` — create/join/room-full/expired/closed, 8 simultaneous joiners (exactly one wins),
  concurrent actions with version conflicts, leave, cleanup, name sanitising, per-player response privacy.
* `tests/e2e.mjs` — two isolated Chromium sessions through the real UI: create/join, third player refused, only
  own rack in the DOM and JS state, wrong-turn blocked, live tentative tiles, synced move/score/bag, undo request,
  pass, pause, **refresh keeps the game**, offline→reconnect catch-up, surrender → result on both → new game,
  leave. Includes a regression test for a lost-update race that was found and fixed during testing.
* `tests/e2e-local.mjs` — the original hot-seat game, scoring and save/resume prompt still behave as before.

**Not verified here (the build sandbox has no internet, so nothing was run against real Supabase or Vercel)**
* The SQL migration and RLS policies were reviewed by hand but **never executed on Postgres**.
* The Supabase-specific client/server code — anonymous sign-in, private-channel authorisation on
  `realtime.messages`, the Realtime REST broadcast, Presence, `supabase-js@2` from jsDelivr — was written to
  the documented APIs but **not run**. The tests use an in-memory backend with the same interface and a simulated
  realtime layer.
* If realtime is misconfigured the game still works (polling every 3 s) but the opponent shows as "offline" and
  tentative tiles will not appear; re-check steps 2 and 4 above and the policies in the SQL file.
* No load testing; there is no per-IP rate limiting on `/api/*` (consider Vercel Firewall rate limits).
* Losing the browser's storage (private window closed, "clear site data") loses the anonymous identity, and with it
  the seat; there is no recovery link.

## Findings in the original game (left untouched in single-player)

1. **Undo loses tiles.** `lastMoveData.tilesDrawn` is the same array that the refill loop then empties, so the
   original undo cannot return drawn tiles to the bag, and the restored tiles are pushed past the 7th rack slot
   where they are invisible (demonstrated by `tests/parity.test.mjs`). The **online** undo is implemented
   correctly (exact tiles back, bag restored). To fix single-player too, change `tilesDrawn: newTiles` to
   `tilesDrawn: [...newTiles]` in `submitMove`.
2. **Blank tile value.** The tile table gives the blank `value: 2` although the tile shows 0 and the end-game
   deduction counts 0; scoring uses the table value, so a freshly drawn blank scores 2. The server reproduces this
   exactly (scoring is unchanged, as requested). If you intended 0, set the blank's `value` to `0` in both
   `ARABIC_TILES` (index.html) and `lib/engine.js`.

## File map (new / changed)

```
index.html            original game + ~20 one-line hooks (all inert unless online) + toolbar button
multiplayer.js/.css   client: rooms, sync, presence, recovery, UI
api/*.js              Vercel functions: config, rooms, action, cleanup (cron)
lib/engine.js         server rules engine (port of the original)
lib/service.js        room lifecycle + action pipeline      lib/routes.js  shared route logic
lib/backend-supabase.js  Postgres RPC + Realtime REST        supabase/migrations/*.sql  schema + RLS
dev/                  in-memory backend + local dev server (tests only)
tests/                see above        sw.js: never caches /api; vercel.json: cron + no-store
```
