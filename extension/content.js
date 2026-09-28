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
  // ================================================================================================

  const NON_LATIN = /[^\P{L}\p{Script=Latin}]/u;
  const RETRY_MS = 60000;
  const STABLE_MS = 500; // request only after the line list has stopped changing (one request per song)

  let settings = { tl: 'en', rom: true, trans: true, orig: false, translator: '', size: 1, float: true }; // styles live in content.css
  const results = new Map();   // line text -> { r, t } for settings.tl
  const retryAt = new Map();   // line text -> timestamp after a failed request
  const inflight = new Set();
  const blocks = new Set();
  const marks = new WeakMap(); // h4 -> "gen\u0001text" it was annotated for (no attributes written to React nodes)
  let timer = 0, dead = false, lastSig = '', sigAt = 0, gen = 0; // gen changes when language/translator changes

  const isOurs = (n) => {
    const el = n.nodeType === 1 ? n : n.parentElement;
    return !!(el && el.closest('.amlt, .amlt-float, .amlt-panel'));
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
    let h = 2166136261; // FNV-1a over the lyric set
    for (const c of texts.join('\n')) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); }
    return 'h:' + (h >>> 0).toString(36);
  }

  function scan() {
    floating();
    if (dead || (!settings.rom && !settings.trans)) return;
    const need = new Set();
    const texts = [];
    for (const el of findLines()) {
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
    if (need.size) request([...new Set(texts)], songKey(texts)); // the whole song, so Gemini gets full context
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

  function shutdown() {
    dead = true;
    observer.disconnect();
    clearTimeout(timer);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || dead) return;
    const prev = settings.tl + '|' + settings.translator;
    for (const k of Object.keys(settings)) if (changes[k]) settings[k] = changes[k].newValue;
    applySize();
    refreshVisibility();
    floating();
    // Only a new language/translator, or turning rom/trans on, can need new results; display-only changes
    // (size, original, floating button) never rescan, so they never message the background.
    if (settings.tl + '|' + settings.translator !== prev) clearAll();
    if (settings.tl + '|' + settings.translator !== prev || changes.rom || changes.trans) schedule(0);
  });

  // Popup: the current song (its button and "This song" line), and force a fresh translation.
  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    const texts = dead ? [] : findLines().map(lineText).filter((t) => /\p{L}/u.test(t));
    if (!texts.length) return send({});
    const lines = [...new Set(texts)];
    if (msg.type === 'song') {
      return send({ key: songKey(texts), lines, pending: lines.some((l) => inflight.has(l)), failed: lines.some((l) => retryAt.get(l) > Date.now()) });
    }
    if (msg.type === 'force') { request([...new Set(texts)], songKey(texts), send); return true; }
  });

  chrome.storage.sync.get(settings).then((s) => {
    settings = s;
    applySize();
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    schedule(0);
  });
})();
