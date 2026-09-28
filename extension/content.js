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

  const NON_LATIN = /[^\P{L}\p{Script=Latin}]/u;
  const RETRY_MS = 60000;
  const STABLE_MS = 500; // request only after the line list has stopped changing (one request per song)

  let settings = { tl: 'en', rom: true, trans: true, orig: false, translator: '', size: 1, float: true, lrclib: true }; // styles live in content.css
  const results = new Map();   // line text -> { r, t } for settings.tl
  const retryAt = new Map();   // line text -> timestamp after a failed request
  const inflight = new Set();
  const blocks = new Set();
  const marks = new WeakMap(); // h4 -> "gen\u0001text" it was annotated for (no attributes written to React nodes)
  let timer = 0, dead = false, lastSig = '', sigAt = 0, gen = 0; // gen changes when language/translator changes

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
    checkLrc(amazon.length > 0);
    if (!settings.rom && !settings.trans) return;
    const lrcMode = !amazon.length && !!lrc;
    const need = new Set();
    const texts = [];
    for (const el of lrcMode ? lrc.els : amazon) {
      const text = lineText(el);
      if (!text) continue;
      if (!/\p{L}/u.test(text)) { if (!ownBlock(el)) render(el, text, {}, ''); continue; } // e.g. "♪": size only
      texts.push(text);
      const mark = gen + '\u0001' + text;
      const block = ownBlock(el);
      const data = results.get(text);
      if (marks.get(el) === mark && block) continue;
      if (block && marks.get(el) !== mark) { blocks.delete(block); block.remove(); } // stale (text changed in place)
      if (data) render(el, text, data, mark);
      else if (!inflight.has(text) && !(retryAt.get(text) > Date.now())) need.add(text);
    }
    const sig = texts.join('\n');
    if (sig !== lastSig) { lastSig = sig; sigAt = Date.now(); }
    const wait = sigAt + STABLE_MS - Date.now();
    if (need.size && wait > 0) return schedule(wait);
    if (need.size) request([...new Set(texts)], lrcMode ? lrc.key : songKey(texts)); // the whole song, so Gemini gets full context
  }

  // done (popup "Translate this song" button) = force a fresh translation, then re-render every line and report back.
  function request(lines, key, done) {
    const { tl, translator } = settings;
    lines.forEach((l) => inflight.add(l));
    let resp;
    try {
      resp = chrome.runtime.sendMessage({ type: 'lyrics', key, lines, tl, force: !!done });
    } catch (e) { return shutdown(); } // extension was reloaded/removed
    resp.then((res) => {
      lines.forEach((l) => inflight.delete(l));
      if (done) done(res ? { ok: res.ok, gemini: res.gemini } : {});
      if (tl !== settings.tl || translator !== settings.translator) return schedule(0);
      if (done) gen++;
      const got = (res && res.results) || {};
      for (const l of lines) {
        if (got[l]) results.set(l, got[l]);
        else retryAt.set(l, Date.now() + RETRY_MS);
      }
      if (!res || !res.ok) setTimeout(() => schedule(0), RETRY_MS + 100);
      scan();
    }, () => {
      if (done) done({});
      lines.forEach((l) => { inflight.delete(l); retryAt.set(l, Date.now() + RETRY_MS); });
      if (!chrome.runtime || !chrome.runtime.id) shutdown();
    });
  }

  const romOf = (d, text) => (d && d.r && NON_LATIN.test(text) ? d.r : '');

  // The block is appended INSIDE the h4 after its text node, so it inherits color, alignment and the
  // active-line highlight (and can become the main line when originals are hidden). React nodes are never moved or removed; if React resets the h4's
  // textContent our block is wiped and the next scan re-adds it.
  function render(el, text, d, mark) {
    const old = ownBlock(el);
    if (old) { blocks.delete(old); old.remove(); }
    marks.set(el, mark);
    const block = document.createElement('div'); // stays empty (hidden) when there's nothing to add, so the line still gets the text size
    block.className = 'amlt';
    for (const [kind, value] of [['rom', romOf(d, text)], ['trans', d.t]]) {
      if (!value) continue;
      const line = document.createElement('div');
      line.className = 'amlt-' + kind;
      line.dir = 'auto';
      line.textContent = value;
      block.appendChild(line);
    }
    applyVisibility(block);
    blocks.add(block);
    el.appendChild(block);
  }

  // Only classes on OUR nodes change; content.css does the rest (incl. hiding the original when
  // .amlt-main is set and a translation is visible).
  function applyVisibility(block) {
    const rom = block.querySelector('.amlt-rom'), trans = block.querySelector('.amlt-trans');
    if (rom) rom.classList.toggle('amlt-off', !settings.rom);
    if (trans) trans.classList.toggle('amlt-off', !settings.trans);
    block.classList.toggle('amlt-main', !settings.orig);
  }

  // Text size: one CSS variable on <html> (not a React node); content.css scales every line that holds our block.
  const applySize = () => document.documentElement.style.setProperty('--amlt-scale', String(settings.size || 1));

  function refreshVisibility() {
    for (const b of blocks) (b.isConnected ? applyVisibility(b) : blocks.delete(b));
  }

  function clearAll() {
    gen++;
    for (const b of blocks) b.remove();
    blocks.clear();
    results.clear();
    retryAt.clear();
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
  window.addEventListener('message', (e) => { if (panel && e.source === panel.contentWindow && e.data === 'amlt-close') closePanel(); }); // Esc inside the panel

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
  function stageView() {
    const art = byTestid(STAGE_ART).find((e) => onScreen(e, 40)) || null;
    const box = [...document.querySelectorAll(STAGE_LYRICS)].find((e) => onScreen(e, 0)) || null;
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

  // Our own fixed-position element (a <body> child), NOT a child of Amazon's lyrics column: that column is React-managed
  // (it can be re-rendered or collapsed at any time, which would wipe foreign children), while a body child survives
  // re-renders and is simply placed over the empty spot. content.js keeps its box on Amazon's lyrics column (see placeLrc).
  function showLrc(p, data, st) {
    const synced = Array.isArray(data.synced) && data.synced.length > 0;
    const rows = synced ? data.synced : (data.plain || []).map((t) => [null, t]);
    if (!rows.length || !document.body) return;
    const root = document.createElement('div');
    root.className = 'amlt-stage' + (synced ? '' : ' amlt-stage-plain');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Lyrics from LRCLIB');
    const scroll = document.createElement('div');
    scroll.className = 'amlt-stage-scroll';
    const list = document.createElement('div');
    list.className = 'amlt-stage-list';
    const els = rows.map(([, text]) => {
      const line = document.createElement('div');
      line.className = 'amlt-stage-line';
      line.dir = 'auto';
      line.textContent = text || '\u266a';
      return line;
    });
    list.append(...els);
    scroll.append(list);
    const credit = document.createElement('div');
    credit.className = 'amlt-stage-credit';
    credit.textContent = synced ? 'Lyrics from LRCLIB' : 'Lyrics from LRCLIB \u00b7 not synced';
    credit.title = 'Amazon has no lyrics for this song. These come from lrclib.net.';
    root.append(scroll, credit);
    let userAt = 0;
    for (const ev of ['wheel', 'touchmove', 'pointerdown']) scroll.addEventListener(ev, () => { userAt = Date.now(); }, { passive: true });
    lrc = { id: p.id, key: p.key, root, scroll, list, els, synced, times: synced ? rows.map(([t]) => t) : [], active: -1, jumped: false, box: '', userAt: () => userAt };
    document.body.appendChild(root);
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
    let bottom = art ? art.bottom - 22 : box && box.height > 100 ? box.bottom : Math.round(H * 0.7);
    const room = right - (artRight + 48);
    const width = Math.min(room, Math.max(320, Math.round((right - artRight) * 0.684)));
    const left = right - width;
    const obstacles = [STAGE_TITLE, STAGE_SUBTITLE, MINI, STAGE_MINIMIZE, '.amlt-float'].flatMap((s) => [...document.querySelectorAll(s)]);
    for (const el of obstacles) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.right <= left || r.left >= right || r.bottom <= top || r.top >= bottom) continue;
      if (r.top > top + 120) bottom = Math.min(bottom, r.top - 12); // below the lyrics' start: end above it
    }
    return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(Math.min(bottom, H - 8) - top) };
  }
  function placeLrc(st) {
    if (!lrc || !st) return;
    const b = stageBox(st);
    const sig = [b.left, b.top, b.width, b.height].join();
    if (sig === lrc.box) return;
    lrc.box = sig;
    const ok = b.width >= 160 && b.height >= 120;
    Object.assign(lrc.root.style, { left: b.left + 'px', top: b.top + 'px', width: Math.max(0, b.width) + 'px', height: Math.max(0, b.height) + 'px' });
    lrc.root.classList.toggle('amlt-stage-off', !ok);
    // Synced: room above the first and below the last line, so the current line can sit in the middle like Amazon's.
    const pad = lrc.synced ? Math.round(b.height * 0.4) + 'px' : '';
    lrc.list.style.paddingTop = lrc.list.style.paddingBottom = pad;
  }
  // Hidden while something else of Amazon's (a menu, the queue) is drawn over the spot: the topmost page element at the
  // box's center must belong to the full view (or be one of its ancestors).
  function coveredLrc(st) {
    const r = lrc.root.getBoundingClientRect();
    if (!r.width || !r.height || !document.elementsFromPoint) return false;
    const top = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).find((e) => !lrc.root.contains(e));
    const anchorEl = st.box || st.art;
    const stageRoot = (anchorEl && anchorEl.closest('section[role="region"]')) || (st.art && st.box && common(st.art, st.box));
    return !!(top && stageRoot && !stageRoot.contains(top) && !top.contains(stageRoot));
  }
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
    if (Date.now() - lrc.userAt() > 4000) {
      lrc.scroll.scrollTo({ top: el.offsetTop - lrc.scroll.clientHeight / 2 + el.offsetHeight / 2, behavior: lrc.jumped ? 'smooth' : 'auto' });
      lrc.jumped = true;
    }
  }
  window.addEventListener('resize', () => { if (lrc) placeLrc(stageView()); });

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
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || dead) return;
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
    const amazon = els.length > 0;
    const fromLrc = !amazon && !!lrc && !dead;
    if (fromLrc) els = lrc.els;
    const texts = els.map(lineText).filter((t) => /\p{L}/u.test(t));
    const p = dead ? null : player();
    const now = p ? { title: p.title, artist: p.artist, lyrics: lyricsState(p, amazon, stageView()), lrc: lrcStatus() } : {};
    if (!texts.length) return send(msg.type === 'song' ? now : {});
    const lines = [...new Set(texts)];
    const key = fromLrc ? lrc.key : songKey(texts);
    if (msg.type === 'song') {
      return send({ ...now, key, lines, source: fromLrc ? 'lrclib' : 'amazon', lrc: fromLrc ? lrcStatus() : undefined, pending: lines.some((l) => inflight.has(l)), failed: lines.some((l) => retryAt.get(l) > Date.now()) });
    }
    if (msg.type === 'force') { request(lines, key, send); return true; }
  });

  chrome.storage.sync.get(settings).then((s) => {
    settings = s;
    applySize();
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'href', 'data-testid'] });
    schedule(0);
  });
})();
