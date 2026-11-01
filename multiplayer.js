/*
 * Online multiplayer client (classic script, loaded after the game script in index.html).
 *
 * The server is the single source of truth: it holds both racks and the tile bag, validates and scores
 * every move with the original rules, and answers each request with the public state plus ONLY the
 * caller's own rack. Realtime Broadcast carries just a tiny "something changed" ping and the opponent's
 * tentative tiles; Presence carries online/offline. The original single-player game code is untouched
 * unless MP.active is true (a few one-line hooks in index.html call into window.MP).
 */
(() => {
  'use strict';
  const SESSION_KEY = 'arabicScrabble.mp.session.v1';
  const NAME_KEY = 'arabicScrabble.mp.name.v1';
  const GRACE_MS = 90 * 1000;   // how long a vanished opponent is shown as "reconnecting"
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const T = {
    title: 'اللعب عبر الإنترنت', yourName: 'اسمك', create: 'إنشاء غرفة', join: 'انضمام', code: 'رمز الغرفة', copy: 'نسخ الرمز', copied: 'تم نسخ الرمز',
    share: 'مشاركة', leave: 'مغادرة الغرفة', confirmLeave: 'تأكيد المغادرة', player: 'اللاعب', you: 'أنت', moves: 'سجل الحركات',
    waiting: 'بانتظار انضمام الخصم…', oppOn: 'الخصم متصل', oppOff: 'الخصم غير متصل', oppBack: 'عاد الخصم', oppGone: 'انقطع اتصال الخصم',
    oppRecon: 'الخصم غير متصل – بانتظار عودته', oppLong: 'الخصم غير متصل منذ فترة', reconnecting: 'جارٍ إعادة الاتصال…', offline: 'لا يوجد اتصال بالإنترنت',
    connecting: 'جارٍ الاتصال بالغرفة…', closed: 'تم إغلاق الغرفة', oppLeft: 'غادر الخصم الغرفة', joined: 'انضم الخصم – ابدؤوا اللعب!',
    undoAsk: 'يطلب الخصم إلغاء حركتك الأخيرة. هل توافق؟', yes: 'موافقة', no: 'رفض', undoSent: 'تم إرسال طلب إلغاء الحركة', undoDeclined: 'رفض الخصم إلغاء الحركة',
    paused: 'تم إيقاف اللعبة مؤقتاً', resumed: 'تم استئناف اللعبة', synced: 'تم تحديث اللعبة',
    pass: 'مرّر', swap: 'بدّل', undone: 'ألغى حركته', ended: 'انتهت اللعبة', surrender: 'استسلم', timeout: 'انتهى الوقت',
  };
  const ERR = {
    room_not_found: 'رمز الغرفة غير صحيح', room_expired: 'انتهت صلاحية الغرفة', room_closed: 'تم إغلاق الغرفة', room_full: 'الغرفة ممتلئة (لاعبان فقط)',
    invalid_code: 'أدخل رمزاً من 6 خانات', network: 'تعذر الاتصال بالخادم، حاول مجدداً', unauthorized: 'تعذر تسجيل الدخول', server_not_configured: 'الخادم غير مُهيّأ بعد',
    not_your_turn: 'ليس دورك', stale: 'تغيّرت اللعبة، تم تحديثها', paused: 'اللعبة متوقفة مؤقتاً', game_over: 'انتهت اللعبة', game_not_over: 'لا يمكن بدء لعبة جديدة قبل نهاية الحالية',
    bag_too_small: 'لا توجد قطع كافية في الكيس للتبديل', waiting_for_opponent: 'بانتظار انضمام الخصم', nothing_to_undo: 'لا توجد حركة لإلغائها', not_a_member: 'لا تملك مقعداً في هذه الغرفة',
    api_missing: 'ملفات الخادم (مجلد api) غير منشورة أو غير مفعّلة على Vercel', server_error: 'حدث خطأ في الخادم',
    supabase_lib: 'تعذر تحميل مكتبة Supabase من الإنترنت', anonymous_disabled: 'فعّل Anonymous sign-ins في إعدادات Supabase (Authentication)',
    supabase_unreachable: 'تعذر الوصول إلى Supabase: تحقق من SUPABASE_URL وأن المشروع غير متوقف', auth_failed: 'رفض Supabase تسجيل الدخول: تحقق من SUPABASE_ANON_KEY',
    db_not_ready: 'قاعدة البيانات غير جاهزة: شغّل ملف SQL في Supabase (SQL Editor)', database_error: 'خطأ في قاعدة البيانات',
    tile_not_in_rack: 'قطعة غير موجودة في رفّك', square_taken: 'المربع مشغول', blank_letter_required: 'اختر حرفاً للقطعة الفارغة',
  };
  const DB_MISSING = ['PGRST202', 'PGRST205', '42883', '42P01'];   // function / table not found: the SQL migration has not been run
  const errText = (e) => {
    const d = (e && e.data) || {};
    if (d.message) return d.message;
    if (d.error === 'database_error' && DB_MISSING.includes(d.code)) return ERR.db_not_ready;
    const base = ERR[d.error || (e && e.message)] || 'تعذر تنفيذ الطلب';
    return d.error === 'server_not_configured' && Array.isArray(d.missing) && d.missing.length ? `${base}: ${d.missing.join('، ')}` : base;
  };
  const fail = (code, detail, data = {}) => Object.assign(new Error(code), { data: { ...data, error: code }, detail, final: true });
  const diagOf = (e) => (e && (e.detail || (e.status ? 'HTTP ' + e.status : e.message))) || '';

  const MP = (window.MP = {
    active: false, seat: 0, code: null, status: 'idle', version: -1, view: null, names: { 1: 'Player 1', 2: 'Player 2' },
    busy: false, skew: 0, oppOnline: false, oppSeen: false, oppGoneAt: 0, connected: null, net: true, draft: null, seated: 1,
    lastEventNo: 0, resultGame: null, applying: false, lastDraftSig: '[]', timeoutKey: '',
  });

  /* ------------------------------------------------------------------ */
  /* Transports: Supabase (production) and a local simulator (dev/tests) */
  /* ------------------------------------------------------------------ */
  let transport = null, sub = null;

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error('script ' + src)); document.head.appendChild(s);
  });

  async function supabaseTransport(cfg) {
    if (!window.supabase) await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
    const sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'arabicScrabble.mp.auth' },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    const session = async () => {
      const { data } = await sb.auth.getSession();
      if (data && data.session) return data.session;
      const r = await sb.auth.signInAnonymously();            // anonymous user: a stable id per browser, survives refresh
      if (r.error) throw r.error;
      return r.data.session;
    };
    sb.auth.onAuthStateChange((_e, s) => { if (s) sb.realtime.setAuth(s.access_token); });
    return {
      name: 'supabase',
      token: async () => (await session()).access_token,
      async subscribe(code, seat, h) {
        const s = await session();
        await sb.realtime.setAuth(s.access_token);
        let closed = false;
        const ch = sb.channel('room:' + code, { config: { private: true, broadcast: { self: false }, presence: { key: String(seat) } } });
        ch.on('broadcast', { event: 'ping' }, (m) => h.onPing((m && m.payload) || {}))
          .on('broadcast', { event: 'draft' }, (m) => h.onDraft((m && m.payload) || {}))
          .on('presence', { event: 'sync' }, () => h.onPresence(new Set(Object.keys(ch.presenceState()).map(Number))))
          .subscribe(async (status) => {
            if (closed) return;
            if (status === 'SUBSCRIBED') { try { await ch.track({ seat, at: Date.now() }); } catch (_) {} h.onStatus(true); }
            else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') h.onStatus(false);
          });
        return {
          sendDraft: (payload) => { try { ch.send({ type: 'broadcast', event: 'draft', payload }); } catch (_) {} },
          close: () => { closed = true; try { sb.removeChannel(ch); } catch (_) {} },
        };
      },
    };
  }

  function devTransport() {
    const KEY = 'arabicScrabble.mp.devauth';
    const auth = async () => {
      let a = null; try { a = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) {}
      if (!a) { a = await (await fetch('/dev/auth', { method: 'POST' })).json(); localStorage.setItem(KEY, JSON.stringify(a)); }
      return a;
    };
    return {
      name: 'dev',
      token: async () => (await auth()).token,
      async subscribe(code, seat, h) {
        const a = await auth();
        const es = new EventSource(`/dev/events?code=${encodeURIComponent(code)}&token=${encodeURIComponent(a.token)}`);
        es.addEventListener('ping', (e) => h.onPing(JSON.parse(e.data)));
        es.addEventListener('draft', (e) => h.onDraft(JSON.parse(e.data)));
        es.addEventListener('presence', (e) => h.onPresence(new Set(JSON.parse(e.data).seats)));
        es.onopen = () => h.onStatus(true);
        es.onerror = () => h.onStatus(false);
        return {
          sendDraft: (payload) => { fetch('/dev/draft', { method: 'POST', body: JSON.stringify({ token: a.token, code, payload }) }).catch(() => {}); },
          close: () => es.close(),
        };
      },
    };
  }

  async function loadTransport() {
    if (transport) return transport;
    let res, text;
    try { res = await fetch('/api/config', { cache: 'no-store' }); text = await res.text(); }
    catch (e) { throw fail('network', 'GET /api/config failed: ' + (e && e.message || e)); }
    let cfg = null; try { cfg = JSON.parse(text); } catch (_) {}
    const type = (res.headers.get('content-type') || '?').split(';')[0];
    if (!cfg) throw fail(res.status === 404 ? 'api_missing' : 'server_error', `GET /api/config -> HTTP ${res.status} (${type}), not JSON`);
    if (!res.ok || cfg.error) throw fail(cfg.error || 'server_error', `GET /api/config -> HTTP ${res.status} ${cfg.error || ''}`, cfg);
    if (cfg.mode === 'dev') transport = devTransport();
    else { try { transport = await supabaseTransport(cfg); } catch (e) { throw fail('supabase_lib', 'supabase-js: ' + (e && e.message || e)); } }
    return transport;
  }

  /** Turns a supabase-js auth failure into something a person can act on. */
  function authFailure(e) {
    const msg = String((e && e.message) || e), code = e && (e.code || e.error_code), status = e && e.status;
    if (code === 'anonymous_provider_disabled' || /anonymous/i.test(msg)) return fail('anonymous_disabled', `auth: ${status || ''} ${msg}`);
    if (!status || /fetch|network|failed to/i.test(msg)) return fail('supabase_unreachable', `auth: ${msg}`);
    return fail('auth_failed', `auth: HTTP ${status} ${msg}`);
  }

  /** JSON call with the user's bearer token. Network failures and 5xx are retried (actions are idempotent via actionId). */
  async function api(method, path, body, retries = 0) {
    for (let i = 0; ; i++) {
      try {
        let token;
        try { token = await transport.token(); } catch (e) { throw authFailure(e); }
        const res = await fetch(path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        let data = null; try { data = await res.json(); } catch (_) {}
        if (!res.ok) {
          const d = data || { error: res.status === 404 ? 'api_missing' : 'server_error' };
          throw Object.assign(new Error(d.error || 'http_' + res.status), { status: res.status, data: d, detail: `${method} ${path.split('?')[0]} -> HTTP ${res.status} ${d.error || ''}${d.code ? ' (' + d.code + ')' : ''}` });
        }
        setNet(true);
        return data;
      } catch (e) {
        if (e.final) throw e;
        const retryable = !e.status || e.status >= 500;
        if (!e.status) setNet(false);
        if (!retryable) throw e;
        if (i >= retries) throw e.status ? e : fail('network', `${method} ${path.split('?')[0]} failed: ${e && e.message || e}`);
        await sleep(Math.min(5000, 700 * 2 ** i));
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Applying server state to the original game's globals                */
  /* ------------------------------------------------------------------ */
  const dummyRack = (seat, n) => Array.from({ length: 7 }, (_, i) => (i < n ? { id: `hidden-${seat}-${i}`, letter: '', value: 0, isBlank: false } : null));
  const ownRackArray = () => (MP.seat === 1 ? player1Rack : player2Rack);

  function restage(draft) {
    const rack = ownRackArray();
    draft.forEach((d) => {
      const idx = rack.findIndex((t) => t && t.id === d.id);
      if (idx < 0 || boardState[d.r][d.c]) return;
      const t = rack[idx];
      if (t.isBlank) t.letter = d.letter;
      rack[idx] = null; boardState[d.r][d.c] = t;
      placedTilesInTurn.push({ r: d.r, c: d.c, originalTile: t, tileId: d.id, originalRackIndex: idx });
    });
  }

  function apply(resp) {
    if (!resp) return;
    if (resp.unchanged) { MP.seated = resp.seated; if (resp.status !== MP.status) { MP.status = resp.status; } refresh(); return; }
    if (!resp.view || resp.version < MP.version) return;
    const v = resp.view, prev = MP.view;
    const sameTurn = !!prev && prev.game === v.game && prev.turnNo === v.turnNo;
    MP.applying = true;
    try {
      // keep the tiles I am arranging if only something unrelated (pause, presence ...) changed
      let draft = null;
      if (placedTilesInTurn.length && sameTurn && v.current === MP.seat && !v.ended) {
        draft = placedTilesInTurn.map((p) => ({ id: p.tileId, r: p.r, c: p.c, letter: p.originalTile.letter }));
      }
      try { hideBlankSelectionModal(); } catch (_) {}
      if (!sameTurn) { isSwappingMode = false; tilesToSwapIndices = []; MP.draft = null; }
      if (placedTilesInTurn.length) resetMove(true);

      MP.seat = resp.seat || MP.seat; MP.view = v; MP.version = resp.version; MP.status = resp.status; MP.names = resp.names || MP.names;
      MP.seated = resp.seated; MP.skew = resp.serverNow - Date.now();

      const board = Array.from({ length: 15 }, () => Array(15).fill(null));
      v.board.forEach((c) => { board[c.r][c.c] = { id: c.id, letter: c.letter, value: c.value, isBlank: c.isBlank }; });
      boardState = board;
      scores = { 1: v.scores[1], 2: v.scores[2] };
      currentPlayer = v.current; gameStarted = v.started; gamePaused = v.paused; gameEnded = v.ended; consecutiveScorelessTurns = v.scoreless;
      tileBag = Array.from({ length: v.bagCount }, (_, i) => ({ id: 'bag-' + i }));    // only the COUNT of the bag is known here
      const opp = MP.seat === 1 ? 2 : 1;
      const mine = (resp.rack || []).map((t) => (t ? { id: t.id, letter: t.letter, value: t.value, isBlank: t.isBlank } : null));
      const theirs = dummyRack(opp, v.rackCounts[opp]);                                  // face-down placeholders, no letters
      player1Rack = MP.seat === 1 ? mine : theirs; player2Rack = MP.seat === 1 ? theirs : mine;
      placedTilesInTurn = []; selectedRackTileId = null; draggedTileId = null; draggedTileOrigin = null;
      lastMoveData = v.lastMove ? { playerId: v.lastMove.seat, score: v.lastMove.score, boardPlacements: [], tilesDrawn: [] } : null;

      clockTick();
      if (draft) restage(draft);
      MP.lastDraftSig = JSON.stringify(placedTilesInTurn.map((p) => [p.r, p.c, p.tileId, p.originalTile.letter]));
      updateUI(true);
    } finally { MP.applying = false; }

    // one-off reactions to what just happened
    const ev = v.event;
    if (ev) {
      if (!prev) MP.lastEventNo = ev.no;
      else if (ev.no > MP.lastEventNo) {
        MP.lastEventNo = ev.no;
        if (ev.type === 'move' && Array.isArray(ev.cells) && window.animateFormedWords) window.animateFormedWords(ev.cells.map((w) => w.map(([r, c]) => ({ r, c }))));
        if (ev.type === 'undo_declined' && ev.seat !== MP.seat) toast(T.undoDeclined);
        if (ev.type === 'pause' && ev.seat !== MP.seat) toast(T.paused);
        if (ev.type === 'resume' && ev.seat !== MP.seat) toast(T.resumed);
        if (ev.type === 'undo_request' && ev.seat !== MP.seat) { /* the dialog below handles it */ }
        if (ev.type === 'new_game') closeResult();
      }
    }
    if (prev && prev.status !== 'playing' && resp.status === 'playing' && MP.seat === 1) toast(T.joined);
    if (resp.status === 'closed' && prev && !v.result?.left) toast(T.closed);
    if (resp.status === 'closed' && v.result && v.result.left && v.result.loser !== MP.seat) toast(T.oppLeft);
    const asked = v.undoRequest && v.lastMove && v.lastMove.seat === MP.seat && !v.ended;
    $('mp-undo-modal').classList.toggle('mp-open', !!asked);
    if (v.ended) {
      if (MP.resultGame !== v.game) { MP.resultGame = v.game; if (window.showGameResult) window.showGameResult({ reason: v.result && v.result.reason, loser: v.result && v.result.loser }); }
    } else if (MP.resultGame !== null) { MP.resultGame = null; closeResult(); }
    refresh();
  }
  const closeResult = () => { const b = $('result-close-btn'); if (b && !$('result-modal').classList.contains('hidden')) b.click(); };

  /* ---------------- clocks (display only; the server decides) ---------------- */
  function clockTick() {
    const v = MP.view; if (!v) return;
    const t = Date.now() + MP.skew;
    const running = v.started && !v.paused && !v.ended && v.turnStartedAt != null;
    const el = running ? Math.max(0, t - v.turnStartedAt) : 0;
    const rem = (s) => Math.max(0, Math.ceil((v.clocks[s] - (running && v.current === s ? el : 0)) / 1000));
    playerTimes = { 1: rem(1), 2: rem(2) };
    updateTimerDisplay();
    if (running && playerTimes[v.current] <= 0) {
      const key = v.game + ':' + v.turnNo;
      if (MP.timeoutKey !== key && !MP.busy) { MP.timeoutKey = key; setTimeout(() => send({ type: 'timeout' }, true).then((ok) => { if (!ok) MP.timeoutKey = ''; }), 500); }
    }
  }

  /* ---------------- sending actions ---------------- */
  const canAct = () => MP.active && MP.status === 'playing' && !!MP.view && currentPlayer === MP.seat && !gameEnded && !gamePaused && !MP.busy;

  async function send(action, silent) {
    if (MP.busy || !MP.view) return false;
    MP.busy = true; updateUI(false);
    const body = { code: MP.code, actionId: crypto.randomUUID(), game: MP.view.game, turnNo: MP.view.turnNo, ...action };
    try {
      const resp = await api('POST', '/api/action', body, 4);     // same actionId on every retry => never applied twice
      apply(resp);
      return true;
    } catch (e) {
      if (e.data && e.data.view) apply(e.data);                    // the server sends its current state with each refusal
      if (e.status === 410) { sessionLost(e); return false; }
      if (!silent) toast(errText(e));
      return false;
    } finally { MP.busy = false; updateUI(false); }
  }

  MP.canAct = canAct;
  MP.startClock = () => {};   // clocks tick from server timestamps (see clockTick)
  MP.submitMove = async () => {
    if (!canAct()) return;
    const check = validatePlacement();                              // instant local feedback; the server re-validates everything
    if (typeof check === 'string') { showStatus(check, true); toast(check); return; }
    if (placedTilesInTurn.some((p) => p.originalTile.isBlank && p.originalTile.letter === ' ')) return;
    await send({ type: 'move', placements: placedTilesInTurn.map((p) => ({ r: p.r, c: p.c, id: p.tileId, letter: p.originalTile.letter })) });
  };
  MP.swap = async () => {
    if (!canAct()) return;
    const rack = ownRackArray();
    const tileIds = tilesToSwapIndices.map((i) => rack[i] && rack[i].id).filter(Boolean);
    if (!tileIds.length) return;
    if (tileBag.length < 7) { toast(ERR.bag_too_small); return; }
    await send({ type: 'swap', tileIds });
  };
  MP.pass = async () => { if (canAct() && !placedTilesInTurn.length) await send({ type: 'pass' }); };
  MP.undo = async () => {
    if (!MP.view || !MP.view.lastMove || MP.busy || placedTilesInTurn.length) return;
    if (MP.view.lastMove.seat === MP.seat) await send({ type: 'undo' });
    else if (await send({ type: 'undo_request' })) toast(T.undoSent);
  };
  MP.togglePause = async () => { if (MP.active && MP.status === 'playing' && !gameEnded) await send({ type: gamePaused ? 'resume' : 'pause' }); };
  MP.surrender = async () => { if (MP.active && MP.status === 'playing' && !gameEnded) await send({ type: 'surrender' }); };
  MP.newGame = async () => {
    if (MP.status === 'closed') { clearSession(); location.reload(); return; }
    if (gameEnded) await send({ type: 'new_game' }); else toast(ERR.game_not_over);
  };

  /* ---------------- hooks called from the original code ---------------- */
  MP.afterUpdateUI = () => {
    if (!MP.active) return;
    const dis = (id, v) => { const b = $(id); if (b) b.disabled = v; };
    const live = MP.status === 'playing' && !!MP.view;
    if (!canAct()) ['submit-move', 'reset-move', 'swap-tiles', 'pass-turn'].forEach((id) => dis(id, true));
    if (!gameEnded && !(isSwappingMode && canAct())) { /* original rules already enabled/disabled the rest for a live turn */ }
    dis('undo-last-move', !(live && lastMoveData && !placedTilesInTurn.length && !gameEnded && !gamePaused && !MP.busy));
    dis('pause-game', !live || gameEnded || MP.busy);
    dis('surrender-game', !live || gameEnded || MP.busy);
    dis('new-game', !gameEnded || MP.busy);
    if (!MP.applying) scheduleDraft();
  };

  /* ---------------- opponent's tentative tiles ---------------- */
  const ALLOWED_LETTERS = () => new Set([' ', ...ARABIC_TILES.map((t) => t.letter)]);
  function scheduleDraft() {
    const sig = JSON.stringify(placedTilesInTurn.map((p) => [p.r, p.c, p.tileId, p.originalTile.letter]));
    if (sig === MP.lastDraftSig) return;
    MP.lastDraftSig = sig;
    clearTimeout(MP.draftTimer);
    MP.draftTimer = setTimeout(() => {
      if (!sub || !MP.view) return;
      sub.sendDraft({
        game: MP.view.game, turnNo: MP.view.turnNo,
        tiles: placedTilesInTurn.map((p) => ({ r: p.r, c: p.c, id: p.tileId, letter: p.originalTile.letter, value: p.originalTile.value, isBlank: !!p.originalTile.isBlank })),
      });
    }, 120);
  }
  function onDraft(p) {
    const v = MP.view;
    if (!v || !p || v.current === MP.seat || p.game !== v.game || p.turnNo !== v.turnNo || !Array.isArray(p.tiles)) return;   // only the player on turn can be arranging
    const letters = ALLOWED_LETTERS();
    const tiles = [];
    for (const t of p.tiles.slice(0, 7)) {
      if (!t || !Number.isInteger(t.r) || !Number.isInteger(t.c) || t.r < 0 || t.r > 14 || t.c < 0 || t.c > 14) continue;
      if (typeof t.id !== 'string' || !/^[\w-]{1,24}$/.test(t.id) || !letters.has(t.letter) || !Number.isInteger(t.value) || t.value < 0 || t.value > 10) continue;
      if (boardState[t.r][t.c]) continue;
      tiles.push({ r: t.r, c: t.c, id: t.id, letter: t.letter, value: t.value, isBlank: !!t.isBlank });
    }
    MP.draft = tiles.length ? tiles : null;
    renderBoard();                                                  // repaints; MP.paintDraft runs at the end of renderBoard
  }
  MP.paintDraft = () => {
    if (!MP.active || !MP.draft) return;
    const board = $('game-board');
    MP.draft.forEach((t) => {
      const sq = board.querySelector(`.square[data-r="${t.r}"][data-c="${t.c}"]`);
      if (!sq || sq.classList.contains('has-tile')) return;
      sq.classList.add('has-tile', 'mp-draft');
      sq.innerHTML = createTileHtml({ id: t.id, letter: t.letter, value: t.value, isBlank: t.isBlank });
    });
  };

  /* ------------------------------------------------------------------ */
  /* Connection: realtime subscription, presence, polling, recovery      */
  /* ------------------------------------------------------------------ */
  const setNet = (ok) => { if (MP.net !== ok) { MP.net = ok; refresh(); } };

  async function connect() {
    if (!MP.active || !MP.code || !MP.seat) return;
    if (sub) { sub.close(); sub = null; }
    try {
      sub = await transport.subscribe(MP.code, MP.seat, { onPing, onDraft, onPresence, onStatus });
    } catch (e) { MP.connected = false; refresh(); setTimeout(() => { if (!MP.connected) connect(); }, 4000); }
  }
  function onStatus(ok) {
    const was = MP.connected; MP.connected = ok;
    if (ok && was === false) resync();
    if (!ok) setTimeout(() => { if (MP.connected === false) connect(); }, 6000);   // supabase-js retries too; this is the safety net
    refresh();
  }
  function onPing(p) { if (p && Number(p.v) > MP.version) resync(); }
  function onPresence(set) {
    const opp = MP.seat === 1 ? 2 : 1, was = MP.oppOnline;
    MP.oppOnline = set.has(opp);
    if (MP.oppOnline) MP.oppSeen = true;
    if (!MP.oppOnline && was) MP.oppGoneAt = Date.now();
    if (MP.presenceSynced && was !== MP.oppOnline && MP.status === 'playing') toast(MP.oppOnline ? T.oppBack : T.oppGone);
    MP.presenceSynced = true;
    refresh();
    if (!MP.oppOnline) setTimeout(refresh, GRACE_MS + 500);
  }

  /** Fetches the authoritative state. A request that arrives while a fetch is running queues exactly one more, so no update is ever missed. */
  async function resync() {
    if (!MP.active || !MP.code) return;
    if (MP.syncing) { MP.syncAgain = true; return; }
    MP.syncing = true;
    try {
      do {
        MP.syncAgain = false;
        apply(await api('GET', `/api/rooms?code=${encodeURIComponent(MP.code)}&since=${MP.version}`));
      } while (MP.syncAgain);
    } catch (e) { if (e.status === 404 || e.status === 403 || e.status === 410) sessionLost(e); }
    finally { MP.syncing = false; }
  }
  function startBackgroundTimers() {
    if (MP.timersOn) return; MP.timersOn = true;
    setInterval(clockTick, 500);
    const poll = () => { resync(); setTimeout(poll, MP.connected !== true ? 3000 : MP.status === 'waiting' ? 4000 : 15000); };   // safety net: heals a missed ping; fast if realtime is down
    setTimeout(poll, 4000);
    window.addEventListener('online', () => { setNet(true); resync(); if (MP.connected === false) connect(); });
    window.addEventListener('offline', () => setNet(false));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { resync(); if (MP.connected === false) connect(); } });
  }

  /* ------------------------------------------------------------------ */
  /* Rooms                                                               */
  /* ------------------------------------------------------------------ */
  const saveSession = () => { try { localStorage.setItem(SESSION_KEY, JSON.stringify({ code: MP.code })); } catch (_) {} };
  const clearSession = () => { try { localStorage.removeItem(SESSION_KEY); } catch (_) {} };
  const readSession = () => { try { const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); return s && /^[A-Z0-9]{6}$/.test(s.code) ? s : null; } catch (_) { return null; } };

  function sessionLost(e) {
    clearSession();
    toast(ERR[e && (e.data && e.data.error || e.message)] || T.closed);
    setTimeout(() => location.reload(), 1800);                       // back to the normal game (and its "resume" prompt)
  }

  function enter(resp, opts = {}) {
    MP.active = true; MP.seat = resp.seat; MP.code = resp.code; MP.version = -1; MP.view = null; MP.lastEventNo = 0;
    document.body.classList.add('mp-online', 'mp-seat-' + resp.seat);
    saveSession();
    const rm = $('resume-modal'); if (rm) rm.classList.add('hidden');
    apply(resp);
    connect();
    startBackgroundTimers();
    if (resp.status === 'playing' && !opts.keepOpen) setTimeout(closeModal, 700);
    refresh();
  }

  async function createRoom() {
    await roomCall(() => api('POST', '/api/rooms', { op: 'create', name: nameValue() }));
  }
  async function joinRoom(code) {
    await roomCall(() => api('POST', '/api/rooms', { op: 'join', code, name: nameValue() }));
  }
  async function roomCall(fn) {
    setModalBusy(true); setModalError('');
    try { await loadTransport(); enter(await fn(), { keepOpen: false }); }
    catch (e) { console.error('[multiplayer]', e); setModalError(errText(e)); setDiag(diagOf(e)); }
    finally { setModalBusy(false); }
  }
  async function leaveRoom() {
    setModalBusy(true);
    try { await api('POST', '/api/rooms', { op: 'leave', code: MP.code }, 2); } catch (_) { /* leaving locally is enough */ }
    clearSession();
    location.reload();
  }

  async function resumeSavedSession(s) {
    MP.active = true; MP.code = s.code; MP.status = 'connecting';
    document.body.classList.add('mp-online');
    refresh(); updateUI(false);
    for (;;) {
      try {
        await loadTransport();
        const resp = await api('GET', `/api/rooms?code=${encodeURIComponent(s.code)}`);
        enter(resp, { keepOpen: true });
        return;
      } catch (e) {
        if (e.status === 404 || e.status === 403 || e.status === 410) { sessionLost(e); return; }
        await sleep(3000);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* UI                                                                  */
  /* ------------------------------------------------------------------ */
  let toastTimer = null;
  function toast(msg) {
    const el = $('mp-toast'); if (!el || !msg) return;
    el.textContent = msg; el.classList.add('mp-on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('mp-on'), 3200);
  }
  const nameValue = () => { const v = ($('mp-name').value || '').trim().slice(0, 14); try { localStorage.setItem(NAME_KEY, v); } catch (_) {} return v; };
  const setModalError = (m) => { const e = $('mp-error'); if (e) e.textContent = m || ''; if (!m) setDiag(''); };
  const setDiag = (m) => { const e = $('mp-diag'); if (e) e.textContent = m || ''; };
  const setModalBusy = (b) => { ['mp-create', 'mp-join', 'mp-leave', 'mp-copy'].forEach((id) => { const e = $(id); if (e) e.disabled = b; }); };
  const openModal = () => { $('mp-modal').classList.add('mp-open'); refresh(); };
  const closeModal = () => { $('mp-modal').classList.remove('mp-open'); };

  function buildUI() {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <button id="mp-chip" type="button" aria-live="polite"><span class="mp-dot"></span><span class="mp-chip-text"></span></button>
      <div id="mp-toast" role="status" aria-live="polite"></div>
      <div id="mp-undo-modal" role="dialog" aria-modal="true"><div id="mp-undo-card" class="mp-undo-card"></div></div>
      <div id="mp-modal" role="dialog" aria-modal="true" aria-labelledby="mp-title"><div id="mp-card">
        <h2><span id="mp-title">${T.title}</span><button id="mp-close" class="mp-x" type="button" aria-label="close">✕</button></h2>
        <div id="mp-lobby">
          <label for="mp-name">${T.yourName}</label>
          <input id="mp-name" type="text" maxlength="14" autocomplete="off" spellcheck="false" dir="auto">
          <div class="mp-row"><button id="mp-create" class="mp-btn" type="button">${T.create}</button></div>
          <h3>${T.code}</h3>
          <input id="mp-code" class="mp-code-input" type="text" maxlength="7" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="••••••" aria-label="${T.code}">
          <div class="mp-row"><button id="mp-join" class="mp-btn mp-alt" type="button">${T.join}</button></div>
        </div>
        <div id="mp-room" class="mp-hidden">
          <h3>${T.code}</h3>
          <div id="mp-code-show" class="mp-code-display" dir="ltr"></div>
          <div class="mp-row"><button id="mp-copy" class="mp-btn" type="button">${T.copy}</button><button id="mp-share" class="mp-btn mp-alt" type="button">${T.share}</button></div>
          <ul id="mp-players" class="mp-players"></ul>
          <p id="mp-status" class="mp-status"></p>
          <details><summary>${T.moves}</summary><ol id="mp-history" class="mp-history"></ol></details>
          <div class="mp-row"><button id="mp-leave" class="mp-btn mp-danger" type="button">${T.leave}</button></div>
        </div>
        <div id="mp-error" class="mp-error" role="alert"></div>
        <div id="mp-diag" class="mp-diag" dir="ltr"></div>
      </div></div>`;
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
    const card = $('mp-undo-card');
    card.style.cssText = 'width:min(100%,360px);padding:18px;border-radius:16px;background:#2b3220;color:#f1eed8;border:1px solid rgba(232,197,108,.5);direction:rtl;text-align:center;font-family:system-ui,sans-serif';
    card.innerHTML = `<p style="margin:0 0 12px;font-weight:700">${T.undoAsk}</p><div class="mp-row" id="mp-undo-row" style="display:flex;gap:8px"></div>`;
    const mk = (txt, accept, color) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.style.cssText = `flex:1;min-height:44px;border:0;border-radius:11px;font-weight:800;color:#fff;background:${color};cursor:pointer`; b.onclick = () => { $('mp-undo-modal').classList.remove('mp-open'); send({ type: 'undo_respond', accept }); }; return b; };
    $('mp-undo-row').append(mk(T.yes, true, '#5b7a2c'), mk(T.no, false, '#a33a2f'));

    try { $('mp-name').value = localStorage.getItem(NAME_KEY) || ''; } catch (_) {}
    $('mp-close').onclick = closeModal;
    $('mp-modal').addEventListener('click', (e) => { if (e.target.id === 'mp-modal') closeModal(); });
    $('mp-chip').onclick = openModal;
    $('mp-create').onclick = createRoom;
    $('mp-join').onclick = () => joinRoom($('mp-code').value);
    $('mp-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
    $('mp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom($('mp-code').value); });
    $('mp-copy').onclick = copyCode;
    $('mp-share').onclick = shareCode;
    let armed = null;
    $('mp-leave').onclick = () => {
      if (!armed) { $('mp-leave').textContent = T.confirmLeave; armed = setTimeout(() => { armed = null; $('mp-leave').textContent = T.leave; }, 4000); return; }
      clearTimeout(armed); leaveRoom();
    };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  }

  async function copyCode() {
    const code = MP.code; if (!code) return;
    try { await navigator.clipboard.writeText(code); }
    catch (_) { const t = document.createElement('textarea'); t.value = code; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch (__) {} t.remove(); }
    toast(T.copied);
  }
  function shareCode() {
    const url = location.origin + location.pathname + '?room=' + MP.code;
    const text = 'انضم إلى لعبة سكرابل عربية – رمز الغرفة: ' + MP.code;
    if (navigator.share) navigator.share({ title: 'Arabic Scrabble', text, url }).catch(() => {});
    else { try { navigator.clipboard.writeText(text + '\n' + url); toast(T.copied); } catch (_) {} }
  }

  /** Re-renders everything derived from MP state: chip, dialog, names. */
  function refresh() {
    const chip = $('mp-chip'); if (!chip) return;
    // ---- what to say about connection ----
    let state = 'wait', text = T.connecting;
    const myConn = !MP.net ? 'offline' : MP.connected === false ? 'reconnecting' : 'online';
    if (MP.active && MP.view) {
      if (myConn === 'offline') { state = 'bad'; text = T.offline; }
      else if (myConn === 'reconnecting') { state = 'wait'; text = T.reconnecting; }
      else if (MP.status === 'waiting') { state = 'wait'; text = T.waiting; }
      else if (MP.status === 'closed') { state = 'bad'; text = T.closed; }
      else if (MP.oppOnline) { state = 'ok'; text = T.oppOn; }
      else { state = Date.now() - MP.oppGoneAt < GRACE_MS && MP.oppSeen ? 'wait' : 'bad'; text = state === 'wait' ? T.oppRecon : (MP.oppSeen ? T.oppLong : T.oppOff); }
    } else if (MP.active) { state = myConn === 'offline' ? 'bad' : 'wait'; text = myConn === 'offline' ? T.offline : T.connecting; }
    chip.dataset.state = state;
    chip.querySelector('.mp-chip-text').textContent = text;
    chip.classList.toggle('mp-compact', state === 'ok' && MP.status === 'playing');   // healthy game: just the green dot
    chip.title = text;

    // ---- names on the rack cards (set through .value, never as HTML) ----
    if (MP.active) [1, 2].forEach((n) => { const i = $('player-' + n + '-name'); if (i && !i.matches(':focus')) i.value = MP.names[n] || 'Player ' + n; });

    // ---- dialog ----
    const inRoom = MP.active && MP.code && MP.seat;
    $('mp-lobby').classList.toggle('mp-hidden', !!inRoom);
    $('mp-room').classList.toggle('mp-hidden', !inRoom);
    if (!inRoom) return;
    $('mp-code-show').textContent = MP.code;
    const opp = MP.seat === 1 ? 2 : 1;
    const ul = $('mp-players'); ul.innerHTML = '';
    [1, 2].forEach((seat) => {
      const li = document.createElement('li');
      let on = '0';
      if (seat === MP.seat) on = myConn === 'online' ? '1' : myConn === 'reconnecting' ? 'w' : '0';
      else on = MP.seated < 2 ? 'w' : MP.oppOnline ? '1' : '0';
      li.dataset.on = on;
      li.innerHTML = '<span class="mp-dot"></span><span class="mp-pname"></span>';
      li.querySelector('.mp-pname').textContent = `${T.player} ${seat} – ${MP.names[seat] || ''}${seat === MP.seat ? ' (' + T.you + ')' : ''}`;
      ul.appendChild(li);
    });
    $('mp-status').textContent = MP.seated < 2 ? T.waiting : text;
    const hist = $('mp-history'); hist.innerHTML = '';
    ((MP.view && MP.view.history) || []).slice(-25).reverse().forEach((h) => {
      const li = document.createElement('li');
      const who = MP.names[h.seat] || '';
      li.textContent = h.type === 'move' ? `${who}: ${(h.words || []).join('، ')} (+${h.score})` : h.type === 'pass' ? `${who}: ${T.pass}` : h.type === 'swap' ? `${who}: ${T.swap} ${h.count}` : h.type === 'undo' ? `${who}: ${T.undone}` : T.ended;
      hist.appendChild(li);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  function boot() {
    buildUI();
    const btn = $('mp-online-button');
    if (btn) btn.addEventListener('click', openModal);

    // names: online they come from the room, and cannot be edited by double-tap
    const origName = window.playerName;
    window.playerName = (n) => (MP.active ? MP.names[n === 2 ? 2 : 1] : origName(n));
    const cont = $('player-racks-container');
    if (cont) ['pointerup', 'dblclick', 'keydown', 'contextmenu'].forEach((t) => cont.addEventListener(t, (e) => { if (MP.active && e.target.closest && e.target.closest('.player-name-input')) e.stopPropagation(); }, true));

    const link = new URLSearchParams(location.search).get('room');
    if (link) {
      history.replaceState(null, '', location.pathname);
      $('mp-code').value = link.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (!readSession()) openModal();
    }
    const s = readSession();
    if (s) resumeSavedSession(s);
    window.MP_READY = true;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();
