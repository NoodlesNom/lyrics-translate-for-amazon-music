// Content script: annotates Amazon Music lyric lines with romanization and translation.
(() => {
  'use strict';

  // ===================== AMAZON MUSIC SELECTORS — edit here after a live check =====================
  // The web player is React Native Web: generated css-*/r-* classes are NOT stable, so only
  // testids / roles / aria attributes are used. A lyric line is an <h4> whose direct text node is the lyric.
  const LINE_SELECTOR = '[data-testid="Stage_OverlaysContainer"] [aria-hidden="true"] h4[role="heading"][aria-hidden="true"]';
  // Fallback if the testid changes: same h4 inside any aria-hidden (scroller) ancestor.
  const FALLBACK_SELECTOR = '[aria-hidden="true"] h4[role="heading"][aria-hidden="true"][dir="auto"]';
  const MIN_ROWS = 3; // a line counts only if its list (h4 > row > list) holds at least this many lines
  // Now Playing title; the artist is assumed to be the next text element (not verified).
  const TITLE_SELECTOR = 'h4[data-testid="WidgetHeader_Primary_Related_playlists"]';
  // --- Mini-player (verified live 2026-09-28). Control testids are comma lists, e.g. "IconButton,MiniPlayer_Pause".
  const MINI = '[data-testid*="MiniPlayer_"]';
  const MINI_TITLE = 'a[data-testid="MiniPlayer_Title"]';        // aria-label = title, href /tracks/<ASIN>?do=play
  const MINI_ARTIST = 'a[href^="/artists/"]';                    // in the title's cluster, aria-label = artist(s) ("A, B & C")
  const MINI_SLIDER = '[data-testid*="MiniPlayer_ProgressSlider"] [role="slider"]'; // aria-label "Playback 1:23 of 3:45"
  // Amazon's lyrics indicator: a badge next to the mini-player title. No badge = Amazon has no lyrics for the song.
  const LYRICS_BADGE = '[data-testid="Badge"][aria-label="Lyrics available"]';
  const CLUSTER_UP = 4; // levels walked up from the title to the cluster that holds the title, artist and badge slots
  // --- Full view ("stage", verified live 2026-09-28): an in-page overlay (not the Fullscreen API), opened from the
  // mini-player's "Enter Full Screen" button. Amazon's lyrics only ever show here, in Stage_OverlaysContainer, right of
  // the art; for songs without lyrics that container is empty and collapsed to 0 px width. The mini-player title may be
  // gone while it's open; its transport buttons keep their MiniPlayer_* testids.
  const STAGE_ART = 'Stage_TileImage';                           // div[data-testid="Imagery,Stage_TileImage"][role=img]
  const STAGE_TITLE = '[data-testid="Stage_Title"]';             // a: text/aria-label = title (href may hold /tracks/<ASIN>)
  const STAGE_SUBTITLE = '[data-testid="Stage_Subtitle"]';       // artist(s)
  const STAGE_LYRICS = '[data-testid="Stage_OverlaysContainer"]'; // Amazon's lyrics column (empty = no lyrics)
  const STAGE_MINIMIZE = '[aria-label="Minimize"][data-testid*="OpenMiniPlayerIconButton"]';
  const ANY_SLIDER = '[role="slider"][aria-label]';              // fallback clock: a slider labelled "Playback 1:23 of 3:45"
  // ================================================================================================

  const NON_LATIN = /[^\P{L}\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u; // letters only (as in background.js)
  const RETRY_MS = 60000;
  const STABLE_MS = 500; // request only after the line list has stopped changing (one request per song)

  let settings = { tl: 'en', rom: true, trans: true, orig: false, translator: '', size: 1, float: true, lrclib: true }; // styles live in content.css
  const results = new Map();   // line text -> { r, t } for settings.tl
  const retryAt = new Map();   // line text -> timestamp after a failed request
  const inflight = new Set();
  const blocks = new Set();
  const marks = new WeakMap(); // h4 -> "gen\u0001text" it was annotated for (no attributes written to React nodes)
  let timer = 0, dead = false, lastSig = '', sigAt = 0, gen = 0; // gen changes when language/translator/song changes
  let currentSongKey = '';

  const isOurs = (n) => {
    const el = n.nodeType === 1 ? n : n.parentElement;
    return !!(el && el.closest('.amlt, .amlt-float, .amlt-panel, .amlt-stage'));
  };
  // Our own inserts/removals are ignored, so annotating never re-triggers a scan.
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (isOurs(m.target)) continue;
      const nodes = [...m.addedNodes, ...m.removedNodes];
      if (m.type === 'characterData' || !nodes.length || !nodes.every(isOurs)) return schedule();
    }
  });

  // Debounced, but a page that never stops changing (clocks, sliders) can't postpone a scan by more than MAX_WAIT.
  const MAX_WAIT = 1000;
  let firstAsk = 0;
  function schedule(delay = 250) {
    const now = Date.now();
    if (!timer) firstAsk = now;
    else if (now + delay - firstAsk > MAX_WAIT) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; scan(); }, delay);
  }

  function findLines() {
    let els = [...document.querySelectorAll(LINE_SELECTOR)];
    if (!els.length) els = [...document.querySelectorAll(FALLBACK_SELECTOR)];
    const listOf = (el) => el.parentElement && el.parentElement.parentElement;
    const count = new Map();
    for (const el of els) count.set(listOf(el), (count.get(listOf(el)) || 0) + 1);
    return els.filter((el) => listOf(el) && count.get(listOf(el)) >= MIN_ROWS);
  }

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // Lyric text = the h4's direct text nodes only (never our inserted block).
  const lineText = (el) => clean([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(''));
  const ownBlock = (el) => el.querySelector(':scope > .amlt');

  function songKey(texts) {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    if (md && md.title) return 'ms:' + md.title + '|' + (md.artist || '');
    const title = document.querySelector(TITLE_SELECTOR);
    if (title && clean(title.textContent)) {
      const artist = title.nextElementSibling || (title.parentElement && title.parentElement.nextElementSibling);
      return 'dom:' + clean(title.textContent) + '|' + clean(artist && artist.textContent).slice(0, 80);
    }
    const p = player();
    if (p) return p.key;
    let h = 2166136261; // FNV-1a over the lyric set
    for (const c of texts.join('\n')) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); }
    return 'h:' + (h >>> 0).toString(36);
  }

  function scan() {
    floating();
    if (dead) return;
    const amazon = findLines();
    // Full lyrics view: our own list from the TrackLyricsPage response, at full size.
    // Amazon's lyric scroller is never moved, including before that response and when it is empty.
    // Rows are hidden only once those lines exist. Lyric-less songs use LRCLIB only.
    const azOn = syncAmazonStage(amazon);
    const playingNow = player();
    const answered = playingNow && captureFor(playingNow.asin);
    checkLrc(azOn || amazon.length > 0 || !!(answered && answered.lines.length));
    if (!settings.rom && !settings.trans) return;
    const lrcMode = !azOn && !amazon.length && !!lrc;
    const hosts = azOn ? az.els : lrcMode ? lrc.els : amazon;
    const rows = [];
    const texts = [];
    for (const el of hosts) {
      const text = lineText(el);
      if (!text) continue;
      rows.push({ el, text });
      if (/\p{L}/u.test(text)) texts.push(text);
    }
    const sig = texts.join('\n');
    if (sig !== lastSig) { lastSig = sig; sigAt = Date.now(); }
    const key = lrcMode ? lrc.key : songKey(texts);
    // A reload often has lyrics before the media-session title. The saved key is that title, so a
    // playlist heading or a hash would miss the cache and translate the song again. Wait for it.
    if (!lrcMode && (key.startsWith('dom:') || key.startsWith('h:'))) {
      if (!fallbackAt) fallbackAt = Date.now();
      if (Date.now() - fallbackAt < 4000) return schedule(250);
    } else fallbackAt = 0;
    // Results and request state are keyed by line text, so none of it may cross a song boundary.
    // Keep the state when the same song is rescanned; storage is intentionally untouched.
    resetSongState(key);
    const need = new Set();
    const painted = [];
    for (const { el, text } of rows) {
      if (!/\p{L}/u.test(text)) { if (!ownBlock(el)) render(el, text, {}, ''); continue; } // e.g. "♪": size only
      const mark = gen + '\u0001' + text;
      const block = ownBlock(el);
      const data = results.get(text);
      // A mark match used to skip the line forever. A Gemini reply that replaces a painted Google
      // translation must still redraw, without touching lines Gemini has not changed.
      const again = repaint.has(text);
      if (marks.get(el) === mark && block && !again) continue;
      if (block && marks.get(el) !== mark) { blocks.delete(block); block.remove(); } // stale (text changed in place)
      if (data) { render(el, text, data, mark); if (again) painted.push(text); }
      else if (!inflight.has(text) && !(retryAt.get(text) > Date.now())) need.add(text);
    }
    painted.forEach((t) => repaint.delete(t));
    if (seenKey && key !== seenKey) seenKey = ''; // leaving and coming back counts as another play
    warmCache(key);
    // The full-view sweep is still collecting lines. Don't translate a partial list: one new line
    // would send the whole song again and wipe the "from cache" time.
    if (azOn && az && !az.done) return;
    if (key && warmReady !== key) return; // storage check first, so a saved song is not sent again
    const wait = sigAt + STABLE_MS - Date.now();
    // Google-only cache (Gemini selected, no g[tl] yet): the lines are already painted, so `need` is
    // empty and a plain cache hit would only touch() the LRU. Ask Gemini once the line list is stable.
    const upgrade = !!(key && gemTried !== key && texts.some((t) => googleOnly.has(t)));
    if ((need.size || upgrade) && wait > 0) return schedule(wait);
    if (need.size) request([...new Set(texts)], key, null, lrcMode ? lrc.roman : null); // the whole song, so Gemini gets full context
    else if (upgrade) request([...new Set(texts)], key, null, lrcMode ? lrc.roman : null, true);
    else if (texts.length) touchSeen(key);
  }

  function resetSongState(key) {
    if (!key || key === currentSongKey) return;
    currentSongKey = key;
    gen++;
    for (const b of blocks) b.remove();
    blocks.clear();
    results.clear();
    retryAt.clear();
    inflight.clear();
    warmed = '';
    warmReady = '';
    fromStore = false;
    seenKey = '';
    googleOnly = new Set();
    gemTried = '';
    repaint.clear();
  }

  // Paint translations already stored for this track, so a return visit doesn't wait on Gemini.
  // googleOnly: lines whose cached translation is Google's (t[tl]) while Gemini is selected and this
  // line has no g[tl] yet. mostly-Latin lines are not Gemini's job (background.js). A full Gemini
  // cache hit leaves this empty, so those replays still never call the translator.
  let warmed = '', warmReady = '', fromStore = false, gemTried = '';
  let googleOnly = new Set();
  const repaint = new Set(); // line texts whose on-screen translation must be redrawn
  const latinLine = (l) => !NON_LATIN.test(l);
  function warmCache(key) {
    if (!key || warmed === key || dead) return;
    warmed = key;
    warmReady = '';
    fromStore = false;
    let got;
    try { got = chrome.storage.local.get(['song:' + key, 'geminiKey']); } catch (e) { warmReady = key; return; }
    got.then((all) => {
      if (dead || warmed !== key) return;
      warmReady = key;
      googleOnly = new Set();
      const entry = all['song:' + key];
      if (!entry || !entry.lines) { schedule(0); return; }
      const tl = settings.tl;
      const gemOn = !!all.geminiKey && settings.translator !== 'google' && !(entry.noGemini && entry.noGemini[tl]);
      const mostly = !!(entry.mostly && entry.mostly[tl]);
      for (const line of Object.keys(entry.lines)) {
        const c = entry.lines[line] || {};
        const fromGem = gemOn && c.g && tl in c.g;
        const t = fromGem ? c.g[tl] : (c.t && tl in c.t ? c.t[tl] : undefined);
        if (t === undefined) continue;
        // A line already painted this session is still a cache hit. Skipping it used to leave
        // fromStore false, so a return to this song never said "from cache".
        fromStore = true;
        // Gemini was selected but this line was stored by Google (no g[tl]). Show t now, and let
        // scan() ask Gemini. Lines already in the target language on a mostly-Latin song stay put.
        if (gemOn && !fromGem && !(mostly && latinLine(line))) googleOnly.add(line);
        if (results.has(line)) continue;
        const d = { r: c.r || '', t };
        if (c.o) d.o = c.o, d.og = c.og || '';
        results.set(line, d);
      }
      schedule(0);
    }, () => { if (warmed === key) { warmReady = key; schedule(0); } });
  }

  // A cache hit that already has this translator's text never calls it, so tell the background this
  // track was played again. A Google-only hit while Gemini is selected is not one of these: scan()
  // sends a lyrics request instead (see googleOnly).
  let seenKey = '', fallbackAt = 0;
  function touchSeen(key) {
    if (!key || seenKey === key || dead) return;
    seenKey = key;
    try { chrome.runtime.sendMessage({ type: 'seen', key }); } catch (e) { /* reloaded */ }
  }

  // done (popup "Translate this song" button) = force a fresh translation, then re-render every line and report back.
  // roman = { lang, lines } for romanized LRCLIB lyrics (see background.js detectRoman).
  // keep = the song is already painted from the Google cache. Do not clear that text or mark the lines
  // in flight (the popup would say "Translating…" and a failure used to schedule a blank retry).
  // When Gemini answers, its text replaces the painted line; if it does not, the Google text stays.
  function request(lines, key, done, roman, keep) {
    if (!keep) fromStore = false;
    // persist() sets idx and entry.ts to the same time. touch() right after that would make
    // idx > entry.ts, and the popup would say "from cache" for a translation that just happened.
    if (key) { seenKey = key; gemTried = key; }
    const { tl, translator } = settings;
    if (!keep) lines.forEach((l) => inflight.add(l));
    let resp;
    try {
      resp = chrome.runtime.sendMessage({ type: 'lyrics', key, lines, tl, force: !!done, roman: roman || undefined });
    } catch (e) { return shutdown(); } // extension was reloaded/removed
    resp.then((res) => {
      const sameSong = currentSongKey === key;
      // A song change clears inflight. Do not let an old response delete a new request
      // for the same line or put the old song's result back into the shared map.
      if (sameSong && !keep) lines.forEach((l) => inflight.delete(l));
      if (done) done(res ? { ok: res.ok, gemini: res.gemini } : {});
      if (!sameSong) return;
      if (res && res.roman && lrc && lrc.key === key && lrc.roman) romanVerdict(res.roman);
      if (tl !== settings.tl || translator !== settings.translator) return schedule(0);
      if (done) gen++;
      const got = (res && res.results) || {};
      let replaced = false;
      for (const l of lines) {
        if (!got[l]) {
          // A kept Google line stays on screen. Only lines with nothing to show are retried.
          if (!keep || !results.has(l)) retryAt.set(l, Date.now() + RETRY_MS);
          continue;
        }
        const prev = results.get(l);
        results.set(l, got[l]);
        if (prev && !sameResult(prev, got[l])) { repaint.add(l); replaced = true; }
      }
      if (replaced) fromStore = false; // a new Gemini translation, not the cached Google one
      if (!keep && (!res || !res.ok)) setTimeout(() => schedule(0), RETRY_MS + 100);
      scan();
    }, () => {
      const sameSong = currentSongKey === key;
      if (done) done({});
      // keep: the Google translation is already visible. Leave it; the next load can try Gemini again.
      if (sameSong && !keep) lines.forEach((l) => { inflight.delete(l); retryAt.set(l, Date.now() + RETRY_MS); });
      if (!chrome.runtime || !chrome.runtime.id) shutdown();
    });
  }

  function sameResult(a, b) {
    return (a.t || '') === (b.t || '') && (a.r || '') === (b.r || '') && (a.o || '') === (b.o || '') && (a.og || '') === (b.og || '');
  }

  const flat = (s) => s.normalize('NFD').replace(/[\p{M}\p{P}\s]+/gu, '').toLowerCase();
  const romOf = (d, text) => (d && d.r && NON_LATIN.test(text) ? d.r : '');

  // Romanized LRCLIB lyrics (v1.3.6): the answer names the final language ('' = Gemini says the lines aren't a
  // romanization after all: they become ordinary lines) and where the original-script line comes from.
  function romanVerdict(v) {
    const was = lrc.verdict ? lrc.verdict.lang : lrc.roman.lang;
    lrc.verdict = v;
    if (!!was === !!v.lang) return;
    for (const el of lrc.els) {
      el.classList.toggle('amlt-roman', !!v.lang && lrc.roman.lines.includes(lineText(el)));
      marks.delete(el); // re-rendered by the next scan
    }
  }

  // The block is appended INSIDE the lyric element after its text node (an Amazon h4, or one of our .amlt-stage-line
  // rows), so it inherits color, alignment and the
  // active-line highlight (and can become the main line when originals are hidden). React nodes are never moved or removed; if React resets the h4's
  // textContent our block is wiped and the next scan re-adds it.
  // A romanized LRCLIB line (.amlt-roman, v1.3.6) gets a block of its own: the line's text IS the romanization, so it goes in
  // the romanization slot, the translation is the main line, and the "Original lyrics" slot holds the original-script guess
  // (Gemini, or hiragana for Japanese) if there is one, never the romaji again. See applyVisibility.
  function render(el, text, d, mark) {
    const old = ownBlock(el);
    if (old) { blocks.delete(old); old.remove(); }
    marks.set(el, mark);
    const block = document.createElement('div'); // stays empty (hidden) when there's nothing to add, so the line still gets the text size
    const roman = el.classList.contains('amlt-roman') && /\p{L}/u.test(text);
    block.className = roman ? 'amlt amlt-rblock' : 'amlt';
    // never the same text twice: a "translation" or guess that is just the romanization again is left out
    const other = (v) => (v && flat(v) !== flat(text) ? v : '');
    const parts = roman ? [['orig', other(d.o)], ['rom', text], ['trans', other(d.t)]] : [['rom', romOf(d, text)], ['trans', d.t]];
    for (const [kind, value] of parts) {
      if (!value) continue;
      const line = document.createElement('div');
      line.className = 'amlt-' + kind;
      line.dir = 'auto';
      line.textContent = value;
      if (kind === 'orig') {
        line.classList.add('amlt-guess');
        line.title = d.og === 'gemini' ? 'Original script guessed by Gemini from the romanized lyrics' : 'Hiragana guessed from the romanized lyrics (no kanji)';
      }
      block.appendChild(line);
    }
    applyVisibility(block);
    blocks.add(block);
    el.appendChild(block);
  }

  // Only classes on OUR nodes change; content.css does the rest (incl. hiding the original when
  // .amlt-main is set and a translation is visible).
  // Romanized lines (.amlt-rblock): the main (big) line is the original-script guess when "Original lyrics" is on and there
  // is one, else the translation, else the romanization itself (it's the only text left, so it shows even with the
  // Romanization toggle off); the romanization shows below the main line when its toggle is on.
  function applyVisibility(block) {
    const rom = block.querySelector('.amlt-rom'), trans = block.querySelector('.amlt-trans');
    if (block.classList.contains('amlt-rblock')) {
      const orig = block.querySelector('.amlt-orig');
      const main = orig && settings.orig ? orig : trans && settings.trans ? trans : rom;
      for (const el of [orig, rom, trans]) if (el) el.classList.toggle('amlt-big', el === main);
      if (orig) orig.classList.toggle('amlt-off', orig !== main);
      if (trans) trans.classList.toggle('amlt-off', !settings.trans);
      if (rom) rom.classList.toggle('amlt-off', rom !== main && !settings.rom);
      return;
    }
    if (rom) rom.classList.toggle('amlt-off', !settings.rom);
    if (trans) trans.classList.toggle('amlt-off', !settings.trans);
    block.classList.toggle('amlt-main', !settings.orig);
  }

  // Text size: one CSS variable on <html> (not a React node). content.css scales Amazon lines
  // that hold an .amlt block, and the full-view list (.amlt-stage-line) directly — that list is
  // our own nodes, so it must not wait for a block before the popup size does anything.
  function applySize() {
    const scale = String(settings.size || 1);
    document.documentElement.style.setProperty('--amlt-scale', scale);
    document.querySelectorAll('.amlt-stage').forEach((el) => el.style.setProperty('--amlt-scale', scale));
  }

  function refreshVisibility() {
    for (const b of blocks) (b.isConnected ? applyVisibility(b) : blocks.delete(b));
  }

  function clearAll() {
    gen++;
    for (const b of blocks) b.remove();
    blocks.clear();
    results.clear();
    retryAt.clear();
    warmed = '';
    warmReady = '';
    seenKey = '';
    fromStore = false;
    googleOnly = new Set();
    gemTried = '';
    repaint.clear();
  }

  // Floating button (top-right) toggles an in-page panel that shows popup.html in an iframe.
  let floatBtn = null, panel = null;
  function floating() {
    if (floatBtn && !floatBtn.isConnected) floatBtn = null;
    if (!settings.float || dead) { if (floatBtn) floatBtn.remove(); floatBtn = null; return closePanel(); }
    if (floatBtn || !document.body) return;
    floatBtn = document.createElement('button');
    floatBtn.className = 'amlt-float';
    floatBtn.title = floatBtn.ariaLabel = 'Lyrics Translate';
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/icon48.png');
    img.alt = '';
    floatBtn.append(img);
    floatBtn.addEventListener('click', () => (panel ? closePanel() : openPanel()));
    document.body.appendChild(floatBtn);
    gDot();
    uMark();
  }
  // Unpacked copies only: a small ! on the floating button when GitHub has a newer release (same check as the popup).
  function uMark() {
    if (!floatBtn || dead) return;
    let resp;
    try { resp = chrome.runtime.sendMessage({ type: 'update' }); } catch (e) { return; }
    resp.then((u) => {
      if (!floatBtn) return;
      let mark = floatBtn.querySelector('.amlt-umark');
      if (!u || !u.newer) { if (mark) mark.remove(); return; }
      if (!mark) { mark = document.createElement('span'); mark.className = 'amlt-umark'; mark.textContent = '!'; floatBtn.append(mark); }
    }, () => {});
  }
  // Gemini status dot in the button's corner (v1.3.6): same colors and meaning as the popup's indicator (the background
  // works it out), only while Gemini is the selected translator; the tooltip names the state. Refreshed on status changes.
  let gSeq = 0;
  function gDot() {
    if (!floatBtn || dead) return;
    const seq = ++gSeq;
    let resp;
    try { resp = chrome.runtime.sendMessage({ type: 'gstate' }); } catch (e) { return; }
    resp.then((g) => {
      if (seq !== gSeq || !floatBtn) return;
      let dot = floatBtn.querySelector('.amlt-gdot');
      if (!g || !g.show) { if (dot) dot.remove(); floatBtn.title = 'Lyrics Translate'; return; }
      if (!dot) { dot = document.createElement('span'); dot.className = 'amlt-gdot'; floatBtn.append(dot); }
      dot.dataset.state = g.state;
      floatBtn.title = 'Lyrics Translate \u00b7 ' + g.label;
    }, () => {});
  }
  function openPanel() {
    panel = document.createElement('iframe');
    panel.className = 'amlt-panel';
    panel.src = chrome.runtime.getURL('popup.html');
    document.body.appendChild(panel);
  }
  function closePanel() { if (panel) panel.remove(); panel = null; }
  // Clicks inside the iframe don't reach this document, so any click here outside the button closes the panel.
  document.addEventListener('click', (e) => { if (panel && !(floatBtn && floatBtn.contains(e.target))) closePanel(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); }, true);
  // From the panel: Esc pressed inside it, or its content height (the panel fits it; CSS caps it to the window).
  window.addEventListener('message', (e) => {
    if (!panel || e.source !== panel.contentWindow) return;
    if (e.data === 'amlt-close') closePanel();
    else if (e.data && e.data.amlt === 'height' && Number.isFinite(e.data.h)) panel.style.height = Math.min(Math.max(Math.round(e.data.h), 120), 800) + 'px';
  });

  function scrollerOf(h4) {
    for (let n = h4.parentElement, i = 0; n && n !== document.body && i < 6; n = n.parentElement, i++) {
      if (n.matches(STAGE_LYRICS)) return null;
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'scroll' || oy === 'auto') return n;
    }
    return null;
  }

  // ===================== LRCLIB fallback: synced lyrics when Amazon has none =====================
  // A song counts as lyric-less when (1) a title is shown (mini-player, or the full view's Stage_Title while that's
  // open), (2) Amazon shows no lyric lines, the full view's lyrics column (if open) is empty, and no "Lyrics available"
  // badge sits next to the title, (3) for SETTLE_MS after that started (badges and lyrics can render late). The lookup and
  // its cache live in background.js. The result is shown ONLY in the full view, in the spot where Amazon's own lyrics
  // appear (right of the art), styled like them; on the normal page nothing is shown (the popup says where to look).
  const SETTLE_MS = 1800;
  const LRC_RETRY_MS = 60000, LRC_TRIES = 3, LRC_LEAD = 0.15;
  let lrc = null;             // shown lyrics: { id, key, root, scroll, list, els, times, active, synced }
  let seen = { sig: '', since: 0 }, lrcId = '', lrcTimer = 0, lrcTick = 0, lastMini = null;
  const lrcMemo = new Map();  // song id -> { state: pending|found|none|error, data, retryAt, tries }

  const testids = (el) => (el.getAttribute('data-testid') || '').split(',').map((t) => t.trim());
  const byTestid = (id) => [...document.querySelectorAll(`[data-testid*="${id}"]`)].filter((e) => testids(e).includes(id));
  const visible = (el) => el.getClientRects().length > 0;
  const firstVisible = (sel) => { const all = [...document.querySelectorAll(sel)]; return all.find(visible) || null; };
  const miniTitle = () => { const all = [...document.querySelectorAll(MINI_TITLE)]; return all.find(visible) || all[0] || null; };
  const playButton = () => [...document.querySelectorAll(MINI)].find((e) => testids(e).some((t) => t === 'MiniPlayer_Pause' || t === 'MiniPlayer_Play'));
  const asinOf = (a) => (/\/tracks\/([A-Za-z0-9]+)/.exec((a && a.getAttribute('href')) || '') || [])[1] || '';
  // The title's cluster: the nearest ancestor (a few levels up) that also holds the artist, and so the badge slot.
  function clusterOf(title, artistSel) {
    let n = title.parentElement;
    for (let i = 0; n && n !== document.body && i < CLUSTER_UP; i++, n = n.parentElement) if (n.querySelector(artistSel)) return n;
    return (title.parentElement && title.parentElement.parentElement) || title.parentElement;
  }

  // The playing song: from the mini-player title when there is one, else from the full view's Stage_Title/Stage_Subtitle.
  // A Stage_Title without a /tracks/ link keeps the last mini-player ASIN (and artist) when the title is the same, so
  // opening the full view doesn't turn the song into a "new" one.
  function player() {
    const t = miniTitle();
    const title = t && clean(t.getAttribute('aria-label') || t.textContent);
    if (title) {
      const cluster = clusterOf(t, MINI_ARTIST);
      const a = cluster && cluster.querySelector(MINI_ARTIST);
      const artist = a ? clean(a.getAttribute('aria-label') || a.textContent) : '';
      const asin = asinOf(t);
      lastMini = { title, artist, asin };
      return song(title, artist, asin, !!(cluster && cluster.querySelector(LYRICS_BADGE)));
    }
    const s = firstVisible(STAGE_TITLE);
    const stitle = s && clean(s.getAttribute('aria-label') || s.textContent);
    if (!stitle) return null;
    const sub = firstVisible(STAGE_SUBTITLE);
    const links = sub ? [...sub.querySelectorAll(MINI_ARTIST)] : [];
    let artist = links.length ? links.map((l) => clean(l.getAttribute('aria-label') || l.textContent)).filter(Boolean).join(', ') : clean(sub && sub.textContent);
    let asin = asinOf(s);
    if (lastMini && lastMini.title === stitle && (!asin || asin === lastMini.asin)) { asin = asin || lastMini.asin; artist = lastMini.artist || artist; }
    const cluster = clusterOf(s, STAGE_SUBTITLE);
    return song(stitle, artist, asin, !!(cluster && cluster.querySelector(LYRICS_BADGE)));
  }
  function song(title, artist, asin, badge) {
    const key = asin ? 'asin:' + asin : 'bar:' + title + '|' + artist;
    return { id: key, key, title, artist, asin, badge };
  }

  // The full view, or null when it's closed: the art, Amazon's lyrics column and whether that column holds anything.
  // "Open" = the art (or, without art, the lyrics column) is really on screen: inside the viewport, and not hidden or
  // faded out by an ancestor (so a full view left mounted off-screen or mid-close doesn't count).
  function onScreen(el, minSize) {
    const r = el.getBoundingClientRect();
    if (r.width < minSize || r.height < 40 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1) return false;
    }
    return true;
  }
  // Minimized, occluded (another app covering the window), or a hidden tab. The viewport is then
  // 0 and getBoundingClientRect is empty, so onScreen() fails. Focus alone is not this: the toolbar
  // popup blurs the page while the column still has a real box.
  function viewBlind() {
    return document.hidden || document.visibilityState === 'hidden' || innerWidth < 2 || innerHeight < 2;
  }
  function stageView() {
    const arts = byTestid(STAGE_ART);
    const boxes = [...document.querySelectorAll(STAGE_LYRICS)];
    let art = arts.find((e) => onScreen(e, 40)) || null;
    let box = boxes.find((e) => onScreen(e, 0)) || null;
    if (!art && !box) {
      const mounted = boxes.find((e) => e.querySelector('h4'));
      const r = mounted && mounted.getBoundingClientRect();
      const noBox = !r || r.width < 1 || r.height < 1;
      // Rows are still in the DOM. Don't drop the sweep just because the window is covered,
      // minimized, or unfocused and the viewport check can no longer see the column.
      if (mounted && (viewBlind() || (!document.hasFocus() && noBox))) {
        art = arts[0] || null;
        box = mounted;
      }
    }
    if (!art && !box) return null;
    const filled = !!box && (!!box.querySelector('h4') || (box.children.length > 0 && box.getBoundingClientRect().width > 40));
    return { art, box, filled };
  }

  // amazon = Amazon has lyrics (badge, lines on screen, or a filled lyrics column) | checking = none of that yet, within
  // the settle window | none = Amazon has no lyrics | '' = no song title anywhere.
  function lyricsState(p, amazonHasLines, st) {
    if (!p) return '';
    const sig = p.badge || amazonHasLines || (st && st.filled) ? '' : p.id; // the settle window restarts whenever this changes
    if (sig !== seen.sig) seen = { sig, since: Date.now() };
    if (!sig) return 'amazon';
    const wait = seen.since + SETTLE_MS - Date.now();
    if (wait > 0) { clearTimeout(lrcTimer); lrcTimer = setTimeout(() => schedule(0), wait + 20); return 'checking'; }
    return 'none';
  }

  // Clock: a reachable <audio>/<video> (exact), else the player's progress slider (MiniPlayer_ProgressSlider, or any
  // slider labelled "Playback 1:23 of 3:45"): m:ss or h:mm:ss, plus aria-valuenow/valuemax when they fit the duration.
  const TIMES = /\d{1,2}(?::\d{2}){1,2}/g;
  const PLAYBACK = /playback .* of /i;
  const secs = (s) => s.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  const attrNum = (el, a) => { const v = el.getAttribute(a); return v === null || v === '' || isNaN(v) ? null : Number(v); };
  function playing() {
    const b = playButton(), label = b && (b.getAttribute('aria-label') || '').trim();
    if (label && /^(pause|play)\b/i.test(label)) return /^pause/i.test(label);
    const ps = navigator.mediaSession && navigator.mediaSession.playbackState;
    return ps === 'playing' || ps === 'paused' ? ps === 'playing' : null;
  }
  function slider() {
    let all = [...document.querySelectorAll(MINI_SLIDER)];
    if (!all.length) all = [...document.querySelectorAll(ANY_SLIDER)].filter((e) => PLAYBACK.test(e.getAttribute('aria-label')));
    return all.find(visible) || all[0] || null;
  }
  function readClock() {
    const media = [...document.querySelectorAll('audio, video')].find((m) => m.duration > 0 && isFinite(m.duration));
    if (media) return { pos: media.currentTime, dur: media.duration, playing: !media.paused, exact: true };
    const sl = slider();
    if (!sl) return null;
    const t = (sl.getAttribute('aria-label') || '').match(TIMES) || [];
    let pos = t.length ? secs(t[0]) : null, dur = t.length > 1 ? secs(t[1]) : null;
    const now = attrNum(sl, 'aria-valuenow'), min = attrNum(sl, 'aria-valuemin') || 0, max = attrNum(sl, 'aria-valuemax');
    if (now !== null && max > min) {
      const span = max - min;
      const unit = dur ? (Math.abs(span - dur) <= 2 ? 1 : Math.abs(span / 1000 - dur) <= 2 ? 1000 : 0) : span > 36000 ? 1000 : span > 1 && span !== 100 ? 1 : 0;
      if (unit) { pos = (now - min) / unit; if (!dur) dur = span / unit; }
    }
    if (pos === null) return dur ? { pos: null, dur } : null;
    return { pos, dur, playing: playing() };
  }
  // Sub-second position from a clock that only changes once a second: re-anchor on every change, extrapolate while
  // playing (at most ~1.25 s past the last change, so a stalled or paused clock freezes the highlight), jump on seek.
  let anchor = null;
  function position(c) {
    if (c.exact) return c.pos;
    const now = performance.now();
    if (!anchor || c.pos !== anchor.raw) {
      const predicted = anchor ? anchor.pos + (now - anchor.t) / 1000 : 0;
      const rolled = anchor && Math.abs(c.pos - predicted) < 1.5 && c.pos > anchor.raw; // ordinary tick while playing
      anchor = { raw: c.pos, pos: c.pos + (!rolled && Number.isInteger(c.pos) ? 0.5 : 0), t: now };
    }
    const playing = c.playing === null || c.playing === undefined ? now - anchor.t < 1500 : c.playing;
    return playing ? anchor.pos + Math.min((now - anchor.t) / 1000, 1.25) : anchor.pos;
  }

  // Looks the song up as soon as it counts as lyric-less (also with the full view closed, so the popup can say lyrics
  // are ready); shows them only while the full view is open. Stage closed, song change or Amazon lines = removed.
  function checkLrc(amazonHasLines) {
    const p = dead ? null : player();
    const st = dead ? null : stageView();
    const state = lyricsState(p, amazonHasLines, st);
    const id = settings.lrclib && state === 'none' ? p.id : '';
    lrcId = id;
    if (!id || !st || (lrc && lrc.id !== id)) hideLrc();
    if (!id) return;
    const m = lrcMemo.get(id);
    if (!m || (m.state === 'error' && m.retryAt <= Date.now() && m.tries < LRC_TRIES)) return lookupLrc(p, m);
    if (!st) return;
    if (lrc) return placeLrc(st);
    if (m.state === 'found') showLrc(p, m.data, st);
  }

  function lookupLrc(p, prev) {
    const c = readClock();
    const duration = c && c.dur;
    if (!(duration > 0)) { clearTimeout(lrcTimer); lrcTimer = setTimeout(() => schedule(0), 1000); return; } // never look up without it
    const m = { state: 'pending', tries: ((prev && prev.tries) || 0) + 1 };
    lrcMemo.set(p.id, m);
    let resp;
    try {
      resp = chrome.runtime.sendMessage({ type: 'lrclib', key: p.key, title: p.title, artist: p.artist, duration });
    } catch (e) { return shutdown(); }
    resp.then((res) => {
      if (res && res.status === 'found') Object.assign(m, { state: 'found', data: res });
      else if (res && res.status === 'none') m.state = 'none';
      else Object.assign(m, { state: 'error', retryAt: Date.now() + Math.max(LRC_RETRY_MS, (res && res.retryMs) || 0) });
      if (m.state === 'error' && m.tries < LRC_TRIES) setTimeout(() => schedule(0), m.retryAt - Date.now() + 50);
      schedule(0);
    }, () => {
      Object.assign(m, { state: 'error', retryAt: Date.now() + LRC_RETRY_MS });
      if (!chrome.runtime || !chrome.runtime.id) shutdown();
    });
  }

  // Shared full-view lyric list (.amlt-stage): LRCLIB when Amazon has no lyrics, and Amazon's own lines when it does.
  // A fixed <body> child, never inside Amazon's column (React re-renders would wipe it, and their scroller must not move it).
  function createStage({ aria, credit, creditTitle, plain, pad, specs }) {
    const root = document.createElement('div');
    root.className = 'amlt-stage' + (plain ? ' amlt-stage-plain' : '');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', aria);
    const scroll = document.createElement('div');
    scroll.className = 'amlt-stage-scroll';
    const list = document.createElement('div');
    list.className = 'amlt-stage-list';
    const els = specs.map((spec) => {
      const line = document.createElement('div');
      line.className = 'amlt-stage-line' + (spec.roman ? ' amlt-roman' : '');
      line.dir = 'auto';
      line.textContent = spec.text || '\u266a';
      return line;
    });
    list.append(...els);
    scroll.append(list);
    if (credit) {
      const creditEl = document.createElement('div');
      creditEl.className = 'amlt-stage-credit';
      creditEl.textContent = credit;
      if (creditTitle) creditEl.title = creditTitle;
      root.append(scroll, creditEl);
    } else root.append(scroll);
    let userAt = 0;
    for (const ev of ['wheel', 'touchmove', 'pointerdown']) scroll.addEventListener(ev, () => { userAt = Date.now(); }, { passive: true });
    applySize();
    return { root, scroll, list, els, pad: !!pad, box: '', active: -1, jumped: false, userAt: () => userAt };
  }
  // Centers one of OUR lines. Does not read or write Amazon's scrollTop. Skipped for a few seconds after the user
  // wheels or drags this scroller (same pause the LRCLIB list uses).
  function scrollStageLine(stage, el) {
    if (!stage || !el || Date.now() - stage.userAt() <= 4000) return;
    stage.scroll.scrollTo({ top: el.offsetTop - stage.scroll.clientHeight / 2 + el.offsetHeight / 2, behavior: stage.jumped ? 'smooth' : 'auto' });
    stage.jumped = true;
  }
  function lyricCover(st, sc) {
    const usable = (el) => {
      if (!el || !el.isConnected) return null;
      if (el.style && el.style.display === 'none') return null;
      const r = el.getBoundingClientRect();
      if (r.width < 160 || r.height < 120 || r.bottom <= r.top) return null;
      return r;
    };
    const col = usable(st && st.box);
    const scr = usable(sc);
    if (scr && col) {
      const overlapW = Math.min(scr.right, col.right) - Math.max(scr.left, col.left);
      const overlap = overlapW > Math.min(scr.width, col.width) * 0.5;
      if (!overlap) return scr;
      // A wide parent testid would paint across the art. Keep the scroller's left/right (where
      // the lines actually are) but take whichever bottom is lower so we match the column.
      if (col.width > scr.width + 80) {
        const top = Math.min(scr.top, col.top);
        const bottom = Math.max(scr.bottom, col.bottom);
        return { left: scr.left, top, width: scr.width, height: bottom - top };
      }
      const left = Math.min(scr.left, col.left);
      const top = Math.min(scr.top, col.top);
      const right = Math.max(scr.right, col.right);
      const bottom = Math.max(scr.bottom, col.bottom);
      return { left, top, width: right - left, height: bottom - top };
    }
    return scr || col;
  }
  function placeStage(stage, st) {
    if (!stage || !st) return;
    let b = null;
    if (stage === az) {
      const live = lyricCover(st, azSc);
      if (live && live.width >= 160 && live.height >= 120) {
        b = { left: Math.round(live.left), top: Math.round(live.top), width: Math.round(live.width), height: Math.round(live.height) };
        stage.cover = b;
      } else if (stage.cover) b = stage.cover; // scroller display:none collapses the column for a moment
    }
    if (!b) b = stageBox(st);
    const sig = [b.left, b.top, b.width, b.height].join();
    if (sig === stage.box) return;
    stage.box = sig;
    const ok = b.width >= 160 && b.height >= 120;
    Object.assign(stage.root.style, { left: b.left + 'px', top: b.top + 'px', width: Math.max(0, b.width) + 'px', height: Math.max(0, b.height) + 'px' });
    stage.root.classList.toggle('amlt-stage-off', !ok);
    const pad = stage.pad ? Math.round(b.height * 0.4) + 'px' : '';
    stage.list.style.paddingTop = stage.list.style.paddingBottom = pad;
  }

  // Amazon lines in the full lyrics view: the page hook posts the TrackLyricsPage lines (text plus
  // startTimeMillis / endTimeMillis). When that view is open and the response has lines for the playing
  // track, draw them all at once in the same .amlt-stage list LRCLIB uses and hide Amazon's rows immediately.
  // Nothing is scrolled on Amazon's scroller, and nothing is fetched from here. No lines (or the view is
  // closed, or the song is only playing) means this overlay never starts; lyric-less songs stay on LRCLIB.
  // The current line comes from those timestamps and position(), not from a white h4. A response with no
  // timestamps falls back to the clock. Only OUR scroller moves.
  let az = null, azSc = null, azTimer = 0;
  const azCaptured = new Map(); // track id -> { ids, lines: [{text, start, end}] }
  function sameCaptured(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i].text !== b[i].text || a[i].start !== b[i].start || a[i].end !== b[i].end) return false;
    return true;
  }
  function rememberLyrics(ids, lines) {
    const prev = azCaptured.get(ids[0]);
    if (prev && sameCaptured(prev.lines, lines) && ids.every((id) => prev.ids.includes(id))) return false;
    const rec = { ids: ids.slice(), lines: lines };
    for (const id of ids) azCaptured.set(id, rec);
    while (azCaptured.size > 8) azCaptured.delete(azCaptured.keys().next().value);
    return true;
  }
  function captureFor(asin) {
    if (!asin) return null;
    return azCaptured.get(asin) || null;
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    try { if (location.origin && event.origin !== location.origin) return; } catch (e) { return; }
    const data = event.data;
    if (!data || data.source !== 'amlt-page' || data.type !== 'lyrics' || !Array.isArray(data.lines)) return;
    const ids = [];
    const raw = Array.isArray(data.ids) ? data.ids : [data.trackId];
    for (const id of raw) if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
    if (!ids.length) return;
    const lines = [];
    for (const line of data.lines) {
      if (!line || typeof line !== 'object') continue;
      const start = typeof line.start === 'number' && isFinite(line.start) ? line.start : null;
      const end = typeof line.end === 'number' && isFinite(line.end) ? line.end : null;
      const text = typeof line.text === 'string' ? line.text : '';
      if (!text.trim() && start == null && end == null) continue;
      lines.push({ text: clean(text), start, end });
    }
    if (rememberLyrics(ids, lines) && !dead) schedule(0);
  });
  let pulledId = null;
  function pullLyrics(asin) {
    const id = asin || '';
    if (pulledId === id) return;
    pulledId = id;
    try { window.postMessage({ source: 'amlt-ext', type: 'pull' }, location.origin || '*'); } catch (e) {}
  }
  function concealScroller(sc) {
    if (sc && sc.style.display !== 'none') sc.style.setProperty('display', 'none', 'important');
  }
  function lyricsScroller(lines) {
    const shown = lines.filter((el) => el.getClientRects().length);
    const pool = shown.length ? shown : lines;
    for (const el of pool) {
      const sc = scrollerOf(el);
      if (sc) return sc;
    }
    return null;
  }
  // Which song the full-view list belongs to. Still used after the harvest code was removed:
  // a track change drops that list. Without this, scan() throws once TrackLyricsPage lines
  // exist and never reaches translation or the overlay.
  function playingTrack() {
    const p = dead ? null : player();
    if (!p || !p.title) return '';
    return p.id + '\u0001' + p.title;
  }
  function columnHeads(st) {
    const box = st && st.box;
    if (!box) return [];
    return [...box.querySelectorAll('h4[role="heading"]')];
  }
  // The lyrics column, not the now-playing stage by itself. A collapsed 0-wide placeholder is not open.
  // Rows we hid stay in the DOM, so a connected h4 still counts after display:none.
  function lyricsOpen(st) {
    if (!st || !st.box) return false;
    if (columnHeads(st).length) return true;
    // Rows we hid are still in the column. If that node is gone, the lyrics view closed
    // (x-ray or minimize) even when the column's box is still wide.
    if (az && azSc && azSc.isConnected && st.box.contains(azSc)) return true;
    if (az) return false;
    const r = st.box.getBoundingClientRect();
    return r.width >= 160 && r.height >= 120;
  }
  function stageLines(texts) {
    return texts.map((text) => {
      const line = document.createElement('div');
      line.className = 'amlt-stage-line';
      line.dir = 'auto';
      line.textContent = text || '\u266a';
      return line;
    });
  }
  function hideAmazonRows(st) {
    const heads = columnHeads(st);
    const sc = lyricsScroller(heads);
    if (sc) { azSc = sc; concealScroller(sc); return; }
    const list = heads[0] && heads[0].parentElement && heads[0].parentElement.parentElement;
    if (list && list !== document.body) { azSc = list; concealScroller(list); }
  }
  function watchAzHide(sc) {
    if (!az || !sc) return;
    if (az.mo) az.mo.disconnect();
    az.mo = new MutationObserver(() => { if (az && azSc && azSc.isConnected) concealScroller(azSc); });
    az.mo.observe(sc, { attributes: true, attributeFilter: ['style'] });
  }
  function dropAmazonStage(restore) {
    clearInterval(azTimer);
    azTimer = 0;
    if (az) {
      if (az.mo) az.mo.disconnect();
      for (const el of az.els) { const b = ownBlock(el); if (b) blocks.delete(b); }
      az.root.remove();
      az = null;
    }
    if (restore && azSc && azSc.isConnected) {
      azSc.style.removeProperty('display');
      azSc.style.removeProperty('opacity');
    }
    if (restore) azSc = null;
  }
  function hideAmazonStage() { dropAmazonStage(true); }
  function applyActive(i) {
    if (!az || i < 0 || i === az.active) return;
    if (az.els[az.active]) az.els[az.active].classList.remove('amlt-stage-on');
    az.active = i;
    const el = az.els[i];
    if (!el) return;
    el.classList.add('amlt-stage-on');
    scrollStageLine(az, el);
  }
  // Gap between lines: nothing is current, so nothing stays lit and we do not scroll.
  function clearActive() {
    if (!az || az.active < 0) return;
    if (az.els[az.active]) az.els[az.active].classList.remove('amlt-stage-on');
    az.active = -1;
  }
  // No timestamps on the response. Equal slices of the playback duration (the clock fallback).
  function indexFromClock() {
    if (!az) return -1;
    const n = az.els.length;
    if (!n) return -1;
    const c = readClock();
    if (!c || c.pos == null) return -1;
    const pos = position(c);
    if (!(c.dur > 0)) return -1;
    let i = Math.floor(Math.min(1, Math.max(0, pos / c.dur)) * n);
    if (i >= n) i = n - 1;
    return Math.max(0, i);
  }
  // Response times are milliseconds. position() is seconds. A line with no start is not chosen here.
  // If none of the lines have a start, or the playhead is outside every timed span while some line
  // has no start, the clock fallback is used. A gap between timed lines highlights nothing.
  function indexFromTimes() {
    if (!az || !az.els.length) return -1;
    const times = az.times || [];
    const ends = az.ends || [];
    let any = false;
    for (let i = 0; i < times.length; i++) if (times[i] != null) { any = true; break; }
    if (!any) return indexFromClock();
    const c = readClock();
    if (!c || c.pos == null) return -1;
    const pos = position(c) * 1000;
    let hit = -1;
    let missing = false;
    for (let i = 0; i < az.els.length; i++) {
      const start = times[i];
      if (start == null) { missing = true; continue; }
      let end = ends[i];
      if (end == null) {
        end = Infinity;
        for (let j = i + 1; j < times.length; j++) if (times[j] != null) { end = times[j]; break; }
      }
      if (pos >= start && pos < end) hit = i;
    }
    if (hit >= 0) return hit;
    if (missing) return indexFromClock();
    return -1;
  }
  function markAmazon() {
    if (!az) return;
    const i = indexFromTimes();
    if (i >= 0) applyActive(i);
    else clearActive();
  }
  function showAmazonLines(pack, st, track) {
    const texts = pack.lines.map((line) => line.text);
    const sig = texts.join('\n');
    if (!az || !az.root.isConnected) {
      az = createStage({ aria: 'Lyrics', credit: '', plain: false, pad: true, specs: texts.map((text) => ({ text, roman: false })) });
      az.sig = sig;
      az.texts = texts.slice();
      az.times = pack.lines.map((line) => line.start);
      az.ends = pack.lines.map((line) => line.end);
      az.track = track;
      az.done = true;
      anchor = null;
      placeStage(az, st);
      document.body.appendChild(az.root);
      if (!azTimer) azTimer = setInterval(tickAmazon, 200);
    } else if (az.sig !== sig) {
      for (const el of az.els) { const b = ownBlock(el); if (b) blocks.delete(b); marks.delete(el); }
      const els = stageLines(texts);
      az.list.replaceChildren(...els);
      az.els = els;
      az.sig = sig;
      az.texts = texts.slice();
      az.times = pack.lines.map((line) => line.start);
      az.ends = pack.lines.map((line) => line.end);
      az.track = track;
      az.active = -1;
      az.jumped = false;
      az.done = true;
    } else az.track = track;
    // Measure the column, then hide Amazon's rows in this same turn (no scroll, no partial list).
    placeStage(az, st);
    hideAmazonRows(st);
    if (azSc) watchAzHide(azSc);
    az.root.classList.toggle('amlt-stage-covered', coveredStage(az, st));
    markAmazon();
  }
  function tickAmazon() {
    if (!az || dead) return;
    const st = stageView();
    const track = playingTrack();
    const p = player();
    const pack = p && captureFor(p.asin);
    if (!st || !lyricsOpen(st) || !pack || !pack.lines.length || (track && az.track && track !== az.track)) {
      hideAmazonStage();
      return schedule(0);
    }
    hideAmazonRows(st);
    placeStage(az, st);
    az.root.classList.toggle('amlt-stage-covered', coveredStage(az, st));
    markAmazon();
  }
  function syncAmazonStage() {
    const st = stageView();
    if (!st || !lyricsOpen(st)) { hideAmazonStage(); return false; }
    const p = dead ? null : player();
    if (!p || !p.asin) { pullLyrics(''); return false; }
    const pack = captureFor(p.asin);
    if (!pack) { pullLyrics(p.asin); if (az) hideAmazonStage(); return false; }
    // TrackLyricsPage answered with nothing. Do not start the overlay and do not scroll.
    if (!pack.lines.length) { hideAmazonStage(); return false; }
    const track = playingTrack();
    if (az && track && az.track && track !== az.track) hideAmazonStage();
    showAmazonLines(pack, st, track);
    return true;
  }

  // Our own fixed-position element (a <body> child), NOT a child of Amazon's lyrics column: that column is React-managed
  // (it can be re-rendered or collapsed at any time, which would wipe foreign children), while a body child survives
  // re-renders and is simply placed over the empty spot. content.js keeps its box on Amazon's lyrics column (see placeStage).
  function showLrc(p, data, st) {
    const synced = Array.isArray(data.synced) && data.synced.length > 0;
    const rows = synced ? data.synced : (data.plain || []).map((t) => [null, t]);
    if (!rows.length || !document.body) return;
    const roman = data.roman ? { lang: data.roman, lines: data.romanLines || [] } : null;
    const stage = createStage({
      aria: 'Lyrics from LRCLIB',
      credit: synced ? 'Lyrics from LRCLIB' : 'Lyrics from LRCLIB \u00b7 not synced',
      creditTitle: 'Amazon has no lyrics for this song. These come from lrclib.net.',
      plain: !synced,
      pad: synced,
      specs: rows.map(([, text]) => ({ text, roman: !!(roman && roman.lines.includes(text)) })),
    });
    lrc = { id: p.id, key: p.key, synced, roman, verdict: null, times: synced ? rows.map(([t]) => t) : [], ...stage };
    document.body.appendChild(lrc.root);
    placeLrc(st);
    anchor = null;
    tickLrc();
    lrcTick = setInterval(tickLrc, 200);
    schedule(0); // translate/romanize the new lines
  }

  function hideLrc() {
    clearInterval(lrcTick);
    lrcTick = 0;
    if (!lrc) return;
    for (const el of lrc.els) { const b = ownBlock(el); if (b) blocks.delete(b); }
    lrc.root.remove();
    lrc = null;
    anchor = null;
  }

  // The box of Amazon's lyrics column (measured live at 1600x820: x 857-1516, y 120-566, art x 52-552, y 88-588):
  // right edge and top from Amazon's (possibly empty, 0-wide) Stage_OverlaysContainer, bottom a bit above the art's
  // bottom, width ~68% of the space right of the art, never over the art; then pulled up above anything of the full
  // view (title, artist, transport, slider) that would sit under it.
  function stageBox(st) {
    const W = innerWidth, H = innerHeight;
    const art = st.art && st.art.getBoundingClientRect();
    const box = st.box && st.box.getBoundingClientRect();
    const col = st.box && st.box.parentElement && st.box.parentElement.getBoundingClientRect();
    const artRight = art ? art.right : col && col.width > 0 ? col.left : Math.round(W * 0.35);
    const right = box && box.right > artRight + 160 && box.right <= W ? box.right
      : col && col.right > artRight + 160 && col.right <= W ? col.right - 32 : W - 84;
    const top = box && box.top >= 0 && box.top < H / 2 ? box.top : art ? art.top + 32 : Math.round(H * 0.15);
    // Prefer the lyrics column's own bottom when it is actually open (a real width). art.bottom
  // stops our list short of Amazon's, so their rows show underneath and fewer of our lines fit.
  // The empty 0-wide placeholder (LRCLIB) keeps the art-based bottom the spot was measured with.
  let bottom = box && box.width >= 160 && box.height > 160 ? box.bottom : art ? art.bottom - 22 : Math.round(H * 0.7);
    const room = right - (artRight + 48);
    const width = box && box.width >= 160 ? box.width : Math.min(room, Math.max(320, Math.round((right - artRight) * 0.684)));
    const left = box && box.width >= 160 ? box.left : right - width;
    const obstacles = [STAGE_TITLE, STAGE_SUBTITLE, MINI, STAGE_MINIMIZE, '.amlt-float'].flatMap((s) => [...document.querySelectorAll(s)]);
    for (const el of obstacles) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.right <= left || r.left >= right || r.bottom <= top || r.top >= bottom) continue;
      if (r.top > top + 120) bottom = Math.min(bottom, r.top - 12); // below the lyrics' start: end above it
    }
    return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(Math.min(bottom, H - 8) - top) };
  }
  function placeLrc(st) { placeStage(lrc, st); }
  // Hidden while something else of Amazon's (a menu, the queue) is drawn over the spot: the topmost page element at the
  // box's center must belong to the full view (or be one of its ancestors).
  // Our popup must not count. The in-page panel sits above the lyrics (higher z-index, on the right) so it is the
  // element at the center the whole time it is open, and visibility:hidden on .amlt-stage-covered cleared every lyric
  // until the panel closed. The toolbar popup steals document focus the same way: don't treat a blur as a cover.
  function coveredStage(stage, st) {
    const r = stage.root.getBoundingClientRect();
    if (!r.width || !r.height || !document.elementsFromPoint || !document.hasFocus()) return false;
    const top = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).find((e) => {
      if (stage.root.contains(e)) return false;
      if (e.closest && e.closest('.amlt-panel, .amlt-float, .amlt')) return false;
      return true;
    });
    const anchorEl = st.box || st.art;
    const stageRoot = (anchorEl && anchorEl.closest('section[role="region"]')) || (st.art && st.box && common(st.art, st.box));
    return !!(top && stageRoot && !stageRoot.contains(top) && !top.contains(stageRoot));
  }
  function coveredLrc(st) { return coveredStage(lrc, st); }
  function common(a, b) { for (let n = a; n; n = n.parentElement) if (n.contains(b)) return n; return null; }

  // Every 200 ms while shown: still valid (full view open, same song, Amazon still without lines)? Placement, cover
  // check, and for synced lyrics the current line (scrolled to the middle of our own scroll box unless the user just scrolled).
  function tickLrc() {
    if (!lrc || dead) return;
    const st = stageView(), p = player();
    if (!lrc.root.isConnected || !st || st.filled || !p || p.id !== lrc.id || findLines().length) { hideLrc(); return schedule(0); }
    placeLrc(st);
    lrc.root.classList.toggle('amlt-stage-covered', coveredLrc(st));
    if (!lrc.synced) return;
    const c = readClock();
    if (!c || c.pos === null) return;
    const pos = position(c) + LRC_LEAD;
    let lo = 0, hi = lrc.times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lrc.times[mid] <= pos) lo = mid + 1; else hi = mid; }
    const i = lo - 1;
    if (i === lrc.active) return;
    if (lrc.els[lrc.active]) lrc.els[lrc.active].classList.remove('amlt-stage-on');
    lrc.active = i;
    const el = lrc.els[i];
    if (!el) return;
    el.classList.add('amlt-stage-on');
    scrollStageLine(lrc, el);
  }
  window.addEventListener('resize', () => { const st = stageView(); if (lrc) placeStage(lrc, st); if (az) placeStage(az, st); });

  // For the popup's "This song" notice: synced | unsynced (shown in the full view, or found and the full view is open) |
  // synced-closed | unsynced-closed (found, full view closed) | pending (looking it up) | none (Amazon has no lyrics and
  // LRCLIB has no close match) | error | '' (Amazon has lyrics, or off).
  function lrcStatus() {
    if (dead || !settings.lrclib) return '';
    if (lrc) return lrc.synced ? 'synced' : 'unsynced';
    const m = lrcId && lrcMemo.get(lrcId);
    if (!m) return lrcId ? 'pending' : '';
    if (m.state === 'found') return (m.data.synced && m.data.synced.length ? 'synced' : 'unsynced') + (stageView() ? '' : '-closed');
    return m.state === 'none' ? 'none' : m.state === 'error' ? 'error' : 'pending';
  }

  function shutdown() {
    dead = true;
    observer.disconnect();
    clearTimeout(timer);
    hideLrc();
    hideAmazonStage();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (dead) return;
    if (area === 'local' ? changes.geminiStatus || changes.geminiKey : area === 'sync' && changes.translator) gDot();
    if (area === 'local' && changes.upd) uMark();
    if (area !== 'sync') return;
    const prev = settings.tl + '|' + settings.translator;
    for (const k of Object.keys(settings)) if (changes[k]) settings[k] = changes[k].newValue;
    applySize();
    refreshVisibility();
    floating();
    if (changes.lrclib) schedule(0); // on: look for the current song; off: our lyrics are removed by checkLrc
    // Only a new language/translator, or turning rom/trans on, can need new results; display-only changes
    // (size, original, floating button) never rescan, so they never message the background.
    if (settings.tl + '|' + settings.translator !== prev) clearAll();
    if (settings.tl + '|' + settings.translator !== prev || changes.rom || changes.trans) schedule(0);
  });

  // Popup: the current song (its button and "This song" line), and force a fresh translation.
  // title/artist/lyrics come from the mini-player (or the full view's title) whenever a song is playing, even with the
  // full view closed. Songs shown from LRCLIB (Amazon has no lyrics) work the same way, keyed by the track.
  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    let els = dead ? [] : findLines();
    const amazon = els.length > 0 || !!(az && az.root && az.root.isConnected);
    const fromLrc = !amazon && !!lrc && !dead;
    if (!dead && az && az.root.isConnected && az.els.length) els = az.els;
    else if (fromLrc) els = lrc.els;
    const texts = els.map(lineText).filter((t) => /\p{L}/u.test(t));
    const p = dead ? null : player();
    const now = p ? { title: p.title, artist: p.artist, lyrics: lyricsState(p, amazon, stageView()), lrc: lrcStatus() } : {};
    if (!texts.length) return send(msg.type === 'song' ? now : {});
    const lines = [...new Set(texts)];
    const key = fromLrc ? lrc.key : songKey(texts);
    if (msg.type === 'song') {
      // roman (v1.3.6): romanized LRCLIB lyrics: { lang, guess } (guess: 'gemini' | 'local' | '' = none; undefined = not known yet)
      const roman = fromLrc && lrc.roman ? (lrc.verdict ? { lang: lrc.verdict.lang, guess: lrc.verdict.guess } : { lang: lrc.roman.lang }) : undefined;
      return send({ ...now, key, lines, source: fromLrc ? 'lrclib' : 'amazon', lrc: fromLrc ? lrcStatus() : undefined, roman, pending: lines.some((l) => inflight.has(l)), failed: lines.some((l) => retryAt.get(l) > Date.now()), cached: fromStore && lines.every((l) => results.has(l)) });
    }
    if (msg.type === 'force') { request(lines, key, send, fromLrc ? lrc.roman : null); return true; }
  });

  chrome.storage.sync.get(settings).then((s) => {
    settings = s;
    applySize();
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'href', 'data-testid'] });
    schedule(0);
  });
})();
