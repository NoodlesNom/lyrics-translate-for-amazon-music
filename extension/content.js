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
    return !!(el && el.closest('.amlt, .amlt-float, .amlt-panel, .amlt-lrc'));
  };
  // Our own inserts/removals are ignored, so annotating never re-triggers a scan.
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (isOurs(m.target)) continue;
      const nodes = [...m.addedNodes, ...m.removedNodes];
      if (m.type === 'characterData' || !nodes.length || !nodes.every(isOurs)) return schedule();
    }
  });

  function schedule(delay = 250) {
    clearTimeout(timer);
    timer = setTimeout(scan, delay);
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
  // Amazon marks songs that have lyrics with a "Lyrics available" badge next to the mini-player title. A song counts as
  // lyric-less only when the mini-player shows a title, Amazon's lyrics view shows no lines, and no such badge has
  // appeared in the title's cluster for SETTLE_MS (badges can render after the title). Title, artist, track ASIN and
  // the clock come from the mini-player. The lookup and its cache live in background.js; this part shows the result
  // in a small panel above the mini-player and highlights the line being sung.
  const SETTLE_MS = 1800;
  const LRC_RETRY_MS = 60000, LRC_TRIES = 3, LRC_LEAD = 0.15;
  let lrc = null;             // the panel: { id, key, panel, body, els, times, active, synced }
  let seen = { sig: '', since: 0 }, lrcId = '', lrcTimer = 0, lrcTick = 0, lrcHidden = '', lrcMin = false;
  const lrcMemo = new Map();  // song id -> { state: pending|found|none|error, data, retryAt, tries }

  const testids = (el) => (el.getAttribute('data-testid') || '').split(',').map((t) => t.trim());
  const visible = (el) => el.getClientRects().length > 0;
  const miniTitle = () => { const all = [...document.querySelectorAll(MINI_TITLE)]; return all.find(visible) || all[0] || null; };
  const playButton = () => [...document.querySelectorAll(MINI)].find((e) => testids(e).some((t) => t === 'MiniPlayer_Pause' || t === 'MiniPlayer_Play'));
  // The title's cluster: the nearest ancestor (a few levels up) that also holds the artist link, and so the badge slot.
  function clusterOf(title) {
    let n = title.parentElement;
    for (let i = 0; n && n !== document.body && i < CLUSTER_UP; i++, n = n.parentElement) if (n.querySelector(MINI_ARTIST)) return n;
    return (title.parentElement && title.parentElement.parentElement) || title.parentElement;
  }

  // The playing song as the mini-player shows it, or null when there's no mini-player title.
  function player() {
    const t = miniTitle();
    const title = t && clean(t.getAttribute('aria-label') || t.textContent);
    if (!title) return null;
    const cluster = clusterOf(t);
    const a = cluster && cluster.querySelector(MINI_ARTIST);
    const artist = a ? clean(a.getAttribute('aria-label') || a.textContent) : '';
    const asin = (/\/tracks\/([A-Za-z0-9]+)/.exec(t.getAttribute('href') || '') || [])[1] || '';
    const key = asin ? 'asin:' + asin : 'bar:' + title + '|' + artist;
    return { id: key, key, title, artist, asin, badge: !!(cluster && cluster.querySelector(LYRICS_BADGE)) };
  }

  // amazon = Amazon has lyrics (badge, or its lyrics view shows lines) | checking = no badge yet, within the settle
  // window after a title change | none = Amazon has no lyrics | '' = no mini-player title.
  function lyricsState(p, amazonHasLines) {
    if (!p) return '';
    const sig = p.badge || amazonHasLines ? '' : p.id; // the settle window restarts whenever this changes
    if (sig !== seen.sig) seen = { sig, since: Date.now() };
    if (!sig) return 'amazon';
    const wait = seen.since + SETTLE_MS - Date.now();
    if (wait > 0) { clearTimeout(lrcTimer); lrcTimer = setTimeout(() => schedule(0), wait + 20); return 'checking'; }
    return 'none';
  }

  // Clock: a reachable <audio>/<video> (exact), else the mini-player slider: its aria-label "Playback 1:23 of 3:45"
  // (m:ss or h:mm:ss, any language) and aria-valuenow/valuemax when they are present and fit the duration.
  const TIMES = /\d{1,2}(?::\d{2}){1,2}/g;
  const secs = (s) => s.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  const attrNum = (el, a) => { const v = el.getAttribute(a); return v === null || v === '' || isNaN(v) ? null : Number(v); };
  function playing() {
    const b = playButton(), label = b && (b.getAttribute('aria-label') || '').trim();
    if (label && /^(pause|play)\b/i.test(label)) return /^pause/i.test(label);
    const ps = navigator.mediaSession && navigator.mediaSession.playbackState;
    return ps === 'playing' || ps === 'paused' ? ps === 'playing' : null;
  }
  function readClock() {
    const media = [...document.querySelectorAll('audio, video')].find((m) => m.duration > 0 && isFinite(m.duration));
    if (media) return { pos: media.currentTime, dur: media.duration, playing: !media.paused, exact: true };
    const sl = [...document.querySelectorAll(MINI_SLIDER)].find(visible) || document.querySelector(MINI_SLIDER);
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

  function checkLrc(amazonHasLines) {
    const p = dead ? null : player();
    const state = lyricsState(p, amazonHasLines);
    const id = settings.lrclib && state === 'none' ? p.id : '';
    lrcId = id;
    if (!id || (lrc && lrc.id !== id)) hideLrc();
    if (!id) return;
    if (lrc) return placeLrc();
    const m = lrcMemo.get(id);
    if (!m || (m.state === 'error' && m.retryAt <= Date.now() && m.tries < LRC_TRIES)) return lookupLrc(p, m);
    if (m.state === 'found' && lrcHidden !== id) showLrc(p, m.data);
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

  function showLrc(p, data) {
    const synced = Array.isArray(data.synced) && data.synced.length > 0;
    const rows = synced ? data.synced : (data.plain || []).map((t) => [null, t]);
    if (!rows.length) return;
    const panel = document.createElement('div');
    panel.className = 'amlt-lrc' + (synced ? '' : ' amlt-lrc-plain') + (lrcMin ? ' amlt-lrc-min' : '');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Lyrics from LRCLIB');
    const head = document.createElement('div');
    head.className = 'amlt-lrc-head';
    const title = document.createElement('span');
    title.className = 'amlt-lrc-title';
    title.textContent = 'Lyrics';
    const src = document.createElement('span');
    src.className = 'amlt-lrc-src';
    src.textContent = synced ? 'from LRCLIB' : 'from LRCLIB · not synced';
    src.title = 'Amazon has no lyrics for this song. These come from lrclib.net.';
    const btn = (act, label, text) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'amlt-lrc-btn';
      b.dataset.act = act;
      b.title = b.ariaLabel = label;
      b.textContent = text;
      return b;
    };
    head.append(title, src, btn('min', 'Minimize', '\u2013'), btn('close', 'Hide for this song', '\u00d7'));
    const body = document.createElement('div');
    body.className = 'amlt-lrc-body';
    const els = rows.map(([, text]) => {
      const line = document.createElement('div');
      line.className = 'amlt-lrc-line';
      line.dir = 'auto';
      line.textContent = text || '\u266a';
      return line;
    });
    body.append(...els);
    panel.append(head, body);
    head.addEventListener('click', (e) => {
      const act = e.target && e.target.dataset && e.target.dataset.act;
      if (act === 'min') { lrcMin = !lrcMin; panel.classList.toggle('amlt-lrc-min', lrcMin); }
      if (act === 'close') { lrcHidden = lrc.id; hideLrc(); }
    });
    let userAt = 0;
    for (const ev of ['wheel', 'touchmove', 'pointerdown']) body.addEventListener(ev, () => { userAt = Date.now(); }, { passive: true });
    lrc = { id: p.id, key: p.key, panel, body, els, synced, times: synced ? rows.map(([t]) => t) : [], active: -1, userAt: () => userAt };
    document.body.appendChild(panel);
    placeLrc();
    anchor = null;
    if (synced) { tickLrc(); lrcTick = setInterval(tickLrc, 200); }
    schedule(0); // translate/romanize the new lines
  }

  function hideLrc() {
    clearInterval(lrcTick);
    lrcTick = 0;
    if (!lrc) return;
    for (const el of lrc.els) { const b = ownBlock(el); if (b) blocks.delete(b); }
    lrc.panel.remove();
    lrc = null;
    anchor = null;
  }

  // Sits above the mini-player (its whole bar: the smallest box holding its title and Play/Pause button), right edge.
  function miniTop() {
    const t = miniTitle(), b = playButton();
    let root = t && b ? t.parentElement : null;
    while (root && !root.contains(b)) root = root.parentElement;
    const r = root && root.getBoundingClientRect();
    if (r && r.height > 0 && r.height <= innerHeight * 0.4) return r.top;
    let top = Infinity; // no compact bar: the highest mini-player part in the lower half of the window
    for (const el of [t, ...document.querySelectorAll(MINI)]) {
      const q = el && el.getBoundingClientRect();
      if (q && q.height > 0 && q.top > innerHeight / 2) top = Math.min(top, q.top);
    }
    return top === Infinity ? innerHeight - 90 : top;
  }
  function placeLrc() {
    if (!lrc) return;
    const bottom = Math.max(12, Math.round(innerHeight - miniTop() + 12));
    lrc.panel.style.bottom = bottom + 'px';
    lrc.panel.style.maxHeight = Math.max(160, Math.min(Math.round(innerHeight * 0.6), innerHeight - bottom - 140)) + 'px';
  }

  function tickLrc() {
    if (!lrc || !lrc.synced || dead) return;
    const c = readClock();
    if (!c || c.pos === null) return;
    const pos = position(c) + LRC_LEAD;
    let lo = 0, hi = lrc.times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lrc.times[mid] <= pos) lo = mid + 1; else hi = mid; }
    const i = lo - 1;
    if (i === lrc.active) return;
    if (lrc.els[lrc.active]) lrc.els[lrc.active].classList.remove('amlt-lrc-on');
    lrc.active = i;
    const el = lrc.els[i];
    if (!el) return;
    el.classList.add('amlt-lrc-on');
    if (Date.now() - lrc.userAt() > 4000 && !lrc.panel.classList.contains('amlt-lrc-min')) {
      lrc.body.scrollTo({ top: el.offsetTop - lrc.body.clientHeight / 2 + el.offsetHeight / 2, behavior: 'smooth' });
    }
  }
  window.addEventListener('resize', () => placeLrc());

  // For the popup's "This song" notice: synced | unsynced (panel shown) | hidden-synced | hidden-unsynced (closed with ×) |
  // pending (looking it up) | none (Amazon has no lyrics and LRCLIB has no close match) | '' (Amazon has lyrics, or off).
  function lrcStatus() {
    if (dead || !settings.lrclib) return '';
    if (lrc) return lrc.synced ? 'synced' : 'unsynced';
    const m = lrcId && lrcMemo.get(lrcId);
    if (!m) return lrcId ? 'pending' : '';
    if (m.state === 'found') return 'hidden-' + (m.data.synced && m.data.synced.length ? 'synced' : 'unsynced');
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
    if (changes.lrclib) schedule(0); // on: look for the current song; off: the panel is removed by checkLrc
    // Only a new language/translator, or turning rom/trans on, can need new results; display-only changes
    // (size, original, floating button) never rescan, so they never message the background.
    if (settings.tl + '|' + settings.translator !== prev) clearAll();
    if (settings.tl + '|' + settings.translator !== prev || changes.rom || changes.trans) schedule(0);
  });

  // Popup: the current song (its button and "This song" line), and force a fresh translation.
  // title/artist/lyrics come from the mini-player whenever a song is playing, even with Amazon's lyrics view closed.
  // Songs shown from LRCLIB (Amazon has no lyrics) work the same way, keyed by the mini-player's track.
  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    let els = dead ? [] : findLines();
    const amazon = els.length > 0;
    const fromLrc = !amazon && !!lrc && !dead;
    if (fromLrc) els = lrc.els;
    const texts = els.map(lineText).filter((t) => /\p{L}/u.test(t));
    const p = dead ? null : player();
    const now = p ? { title: p.title, artist: p.artist, lyrics: lyricsState(p, amazon), lrc: lrcStatus() } : {};
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
