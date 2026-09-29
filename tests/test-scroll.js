// v1.3.5: Amazon's full-view lyrics scroller vs. the taller rows the extension makes. mock.html?amz=scroll reproduces
// Amazon's scrolling as measured live: after a SEEK no line is white for a moment, then Amazon jumps to index * 53 px (its
// own row height, ignoring the extension's taller rows) and repeats that 400 ms later; ordinary line changes are
// smooth-centered correctly; wheel/touch input pauses Amazon's auto-scroll for 3 s. The extension must bring the white
// line back to the middle quickly, without fighting Amazon (bounded scroll writes, no jitter), must pause after user
// wheel input, and must not touch its own LRCLIB lyrics. Translate and LRCLIB are MOCKED; every lyric line is invented.
const { chromium } = require('playwright');
const fs = require('fs');
const EXT = require('path').resolve(__dirname, '..', 'extension');
const results = [];
const check = (name, cond, info = '') => { results.push([cond ? 'PASS' : 'FAIL', name, info]); console.log(cond ? 'PASS' : 'FAIL', name, info); };

// Synthetic Google answer: every line gets a translation and a romanization, so every row grows.
function onGoogle(route) {
  const q = new URLSearchParams(route.request().postData() || '').get('q');
  const ls = q.split('\n|\n');
  route.fulfill({ contentType: 'application/json', body: JSON.stringify([[[ls.map((l, i) => 'Invented test translation ' + (i + 1)).join('\n|\n'), q, null, null],
    [null, null, null, ls.map((l, i) => 'invented romaji ' + (i + 1)).join(' | ')]], null, 'ja']) });
}
// LRCLIB (mocked): 30 invented synced lines for "Glass Harbor (Test)" (song 9, no Amazon lyrics).
const WORDS = ['紙の月が川に浮かぶ', 'Tin roofs are drumming softly', 'ランプの下で待っている', 'We count the boats at nine'];
const SYNCED = Array.from({ length: 30 }, (_, i) => `[00:${String(2 + i * 3).padStart(2, '0')}.00]${WORDS[i % 4]} ${i + 1}`).map((l) => l.replace(/\[00:(\d{2,3})/, (m, s) => `[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`)).join('\n');
function onLrclib(route) {
  const u = new URL(route.request().url());
  if (u.pathname === '/api/get' && u.searchParams.get('track_name') === 'Glass Harbor (Test)') {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 1, name: 'Glass Harbor (Test)', trackName: 'Glass Harbor (Test)', artistName: 'Mock Singer',
      albumName: 'Mock Album', duration: 200, instrumental: false, plainLyrics: SYNCED.replace(/\[[^\]]*\]/g, ''), syncedLyrics: SYNCED }) });
  }
  route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":404}' });
}

const SC = '[data-testid="Stage_OverlaysContainer"] .r-150rngu';
const ROWS = 'div[style*="padding-top: 191px"] > div';
// Where the current (white) line's row sits in Amazon's scroller.
const where = (page) => page.evaluate(({ SC, ROWS }) => {
  const sc = document.querySelector(SC);
  if (!sc) return null;
  const rows = [...document.querySelectorAll(ROWS)];
  const i = rows.findIndex((r) => r.querySelector('h4').style.color === 'rgb(255, 255, 255)');
  const H = sc.clientHeight, b = sc.getBoundingClientRect();
  if (i < 0) return { i, H, top: sc.scrollTop };
  const a = rows[i].getBoundingClientRect(), top = a.top - b.top, bottom = a.bottom - b.top;
  return { i, H, scrollTop: Math.round(sc.scrollTop), rowTop: Math.round(top), rowBottom: Math.round(bottom), rowH: Math.round(a.height),
    visible: top >= -1 && bottom <= H + 1, off: Math.round(((top + bottom) / 2 - H / 2) / H * 100) / 100 };
}, { SC, ROWS });
const good = (w) => !!w && w.i >= 0 && w.visible && Math.abs(w.off) <= 0.25;
// Seek to line i (line i plays from 0:02 + 4 s * i) and time (rAF) how long until line i is white, fully visible and within
// a quarter of the height from the middle.
const seekAndTime = (page, i, timeout = 3000) => page.evaluate(({ i, timeout, SC, ROWS }) => new Promise((res) => {
  const t0 = performance.now();
  window.__seekAt = t0;
  mockPlayer.seek(2 + 4 * i + 1);
  const sc = document.querySelector(SC);
  (function f() {
    const r = document.querySelectorAll(ROWS)[i];
    const a = r.getBoundingClientRect(), b = sc.getBoundingClientRect(), H = sc.clientHeight, top = a.top - b.top, bottom = a.bottom - b.top;
    if (r.querySelector('h4').style.color === 'rgb(255, 255, 255)' && top >= -1 && bottom <= H + 1 && Math.abs((top + bottom) / 2 - H / 2) <= H / 4) return res(Math.round(performance.now() - t0));
    if (performance.now() - t0 > timeout) return res(-1);
    requestAnimationFrame(f);
  })();
}), { i, timeout, SC, ROWS });
// Scroll activity since t (performance.now() in the page): scroll events grouped into bursts (gaps < 60 ms); a burst that
// starts within 50 ms after one of Amazon's own writes is Amazon's, every other burst is the extension's.
const activity = (page, since) => page.evaluate((since) => {
  const log = amz.log.filter((e) => e.t >= since), writes = amz.writes.filter((w) => w.t >= since - 60);
  const bursts = [];
  for (const e of log) { const b = bursts[bursts.length - 1]; if (b && e.t - b.end < 60) { b.end = e.t; b.n++; b.last = e.top; } else bursts.push({ start: e.t, end: e.t, n: 1, last: e.top }); }
  const byAmazon = (b) => writes.some((w) => b.start - w.t >= 0 && b.start - w.t <= 50);
  return { events: log.length, amazonWrites: writes.filter((w) => w.t >= since).length, amazonBursts: bursts.filter(byAmazon).length, extBursts: bursts.filter((b) => !byAmazon(b)).length };
}, since);
const now = (page) => page.evaluate(() => performance.now());
const lastJump = (page) => page.evaluate(() => { const w = amz.writes.filter((x) => !x.smooth && x.t >= window.__seekAt); return w[0] || null; });

(async () => {
  const manifest = JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8'));
  check('manifest 1.3.5: no new permissions (storage + the same four hosts)', manifest.version === '1.3.5' && JSON.stringify(manifest.permissions) === '["storage"]'
    && JSON.stringify(manifest.host_permissions) === JSON.stringify(['https://clients5.google.com/*', 'https://translate.googleapis.com/*', 'https://generativelanguage.googleapis.com/*', 'https://lrclib.net/*']));
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: { width: 1600, height: 820 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route(/api\.github\.com/, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ tag_name: 'v' + manifest.version, html_url: 'https://github.com/NoodlesNom/lyrics-translate-for-amazon-music/releases/latest' }) }));
  await ctx.route(/clients5\.google\.com|translate\.googleapis\.com/, onGoogle);
  await ctx.route(/lrclib\.net/, onLrclib);
  await ctx.route('https://music.amazon.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(__dirname + '/mock.html') }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const setSettings = (s) => sw.evaluate((s) => chrome.storage.sync.set(s), s);
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // ---------- 1. Extra large text (145 %) ----------
  await setSettings({ size: 1.45 });
  await page.goto('https://music.amazon.com/?song=17&amz=scroll&start=0');
  await page.waitForFunction(() => document.querySelectorAll('.amlt-trans').length >= 40, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  let w = await where(page);
  check('145 %: rows annotated and taller than Amazon thinks (53 px)', w && w.rowH > 80, JSON.stringify(w));
  let t = await seekAndTime(page, 30);
  let jump = await lastJump(page);
  check('145 %: the mock reproduces the bug: Amazon\'s own jump leaves the line far below the visible area', jump && jump.rowTop > jump.height + 500, JSON.stringify(jump));
  check('145 %: seek to line 31 of 40 → white line fully visible and centered within 500 ms', t >= 0 && t <= 500, `ms=${t}`);
  let since = await now(page) - t - 5;
  await page.waitForTimeout(1500);
  w = await where(page);
  let act = await activity(page, since);
  check('145 %: Amazon jumps back to its wrong spot 400 ms later → re-corrected, still centered at 1.5 s', good(w) && w.i === 30 && act.amazonWrites >= 2, JSON.stringify({ w, act }));
  check('145 %: bounded corrections for the seek (≤ 4 extension scrolls, no jitter)', act.extBursts >= 1 && act.extBursts <= 4, JSON.stringify(act));
  await page.evaluate(() => mockPlayer.pause());
  await page.waitForTimeout(300);
  since = await now(page);
  await page.waitForTimeout(2000);
  act = await activity(page, since);
  check('145 %: paused, nothing changing → zero scroll events in 2 s (no correction loop)', act.events === 0, JSON.stringify(act));
  await page.evaluate(() => mockPlayer.play());
  t = await seekAndTime(page, 8);
  check('145 %: seek back to line 9 → centered within 500 ms', t >= 0 && t <= 500, `ms=${t}`);
  t = await seekAndTime(page, 39);
  check('145 %: seek to the last line → fully visible and centered within 500 ms', t >= 0 && t <= 500, `ms=${t}`);

  // ---------- 2. Default text size (100 %) ----------
  await setSettings({ size: 1 });
  await page.waitForTimeout(800);
  t = await seekAndTime(page, 25);
  jump = await lastJump(page);
  check('100 %: Amazon alone leaves the line below the visible area (bug reproduced)', jump && jump.rowTop > jump.height, JSON.stringify(jump));
  check('100 %: seek to line 26 → centered within 500 ms', t >= 0 && t <= 500, `ms=${t}`);
  await page.waitForTimeout(1200);
  check('100 %: still centered after Amazon\'s second jump', good(await where(page)), JSON.stringify(await where(page)));
  t = await seekAndTime(page, 14);
  check('100 %: seek back to line 15 → centered within 500 ms', t >= 0 && t <= 500, `ms=${t}`);
  // Steady playback: Amazon's ordinary (correct) smooth scrolls; the extension must not add any.
  await page.waitForTimeout(1500);
  since = await now(page);
  const samples = [];
  for (let k = 0; k < 18; k++) { await page.waitForTimeout(500); samples.push(await where(page)); }
  act = await activity(page, since);
  const lines = new Set(samples.map((s) => s.i));
  check('100 %: steady playback over 3 line changes → line always visible, extension adds no scrolls', lines.size >= 3 && samples.every((s) => s.i < 0 || s.visible) && act.extBursts === 0 && act.amazonBursts >= 2, JSON.stringify({ lines: [...lines], act }));

  // ---------- 3. User wheel pauses auto-centering ----------
  const box = await page.locator(SC).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(400);
  const userTop = (await where(page)).scrollTop;
  const wheelAt = Date.now();
  await page.evaluate(() => { window.__seekAt = performance.now(); mockPlayer.seek(2 + 4 * 33 + 1); }); // Amazon (paused itself) only moves the highlight
  await page.waitForTimeout(1500);
  w = await where(page);
  check('wheel: during the 3 s after user wheel input nothing re-centers (scroll stays where the user put it)', w.i === 33 && Math.abs(w.scrollTop - userTop) <= 1 && !w.visible, JSON.stringify({ userTop, w }));
  await page.waitForTimeout(Math.max(0, 3000 - (Date.now() - wheelAt)) + 900);
  w = await where(page);
  check('wheel: ~3 s later the (new) white line is centered again', good(w) && w.i >= 33, JSON.stringify(w));

  // ---------- 4. Toggles and sizes change row heights ----------
  await setSettings({ size: 1.45 });
  await page.waitForTimeout(900);
  check('size 100 % → 145 % while playing: rows grow, current line re-centered', good(await where(page)), JSON.stringify(await where(page)));
  await setSettings({ trans: false });
  await page.waitForTimeout(900);
  check('translation off: rows shrink, current line re-centered', good(await where(page)), JSON.stringify(await where(page)));
  t = await seekAndTime(page, 36);
  check('translation off: seek to line 37 → centered within 500 ms', t >= 0 && t <= 500, `ms=${t}`);
  await setSettings({ trans: true, orig: true, rom: false });
  await page.waitForTimeout(900);
  t = await seekAndTime(page, 20);
  check('original shown + romanization off: seek to line 21 → centered within 500 ms', t >= 0 && t <= 500, `ms=${t}`);
  await setSettings({ orig: false, rom: true, size: 1 });
  await page.waitForTimeout(600);

  // ---------- 5. No white line right after a seek → the extension waits ----------
  since = await now(page);
  const gap = await page.evaluate(({ SC }) => new Promise((res) => {
    const sc = document.querySelector(SC), top0 = sc.scrollTop;
    mockPlayer.seek(2 + 4 * 3 + 1);
    // Amazon clears the highlight at once (seek seen within 50 ms) and sets the new one 150 ms after that.
    setTimeout(() => res({ white: [...sc.querySelectorAll('h4')].filter((h) => h.style.color === 'rgb(255, 255, 255)').map((h) => h.textContent.slice(0, 12)), active: amz.active, moved: sc.scrollTop !== top0 }), 140);
  }), { SC });
  check('right after a seek, while no line is white, the extension doesn\'t scroll', gap.white.length === 0 && !gap.moved, JSON.stringify(gap));
  await page.waitForTimeout(1200);
  check('…and centers once the white line appears', good(await where(page)), JSON.stringify(await where(page)));

  // ---------- 6. LRCLIB lyrics (our own full-view lyrics) unaffected ----------
  await page.goto('https://music.amazon.com/?song=9&amz=scroll&start=0&stagehref=tracks');
  await page.waitForSelector('.amlt-stage', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.amlt-stage .amlt-trans').length >= 30, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate(() => mockPlayer.seek(2 + 3 * 24 + 0.2)); // line 25 of 30 (3 s per line)
  await page.waitForTimeout(1500);
  const lrcState = () => page.evaluate(() => {
    const sc = document.querySelector('.amlt-stage-scroll'), on = document.querySelector('.amlt-stage-on');
    const a = on && on.getBoundingClientRect(), b = sc.getBoundingClientRect();
    return { on: document.querySelectorAll('.amlt-stage-on').length, idx: [...document.querySelectorAll('.amlt-stage-line')].indexOf(on), amazonScroller: !!document.querySelector('[data-testid="Stage_OverlaysContainer"] h4'),
      top: Math.round(sc.scrollTop), centered: !!a && a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < b.height / 4 };
  });
  let L = await lrcState();
  check('LRCLIB: seek → its own current line highlighted and centered in its own scroller (no Amazon lines present)', L.on === 1 && L.idx === 24 && L.centered && !L.amazonScroller, JSON.stringify(L));
  await page.evaluate(() => mockPlayer.pause());
  await page.waitForTimeout(300);
  const lrcTop = (await lrcState()).top;
  await page.waitForTimeout(1500);
  check('LRCLIB: paused → its scroll position stays put (nothing else scrolls it)', (await lrcState()).top === lrcTop, JSON.stringify(await lrcState()));
  const sbox = await page.locator('.amlt-stage-scroll').boundingBox();
  await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(300);
  const after = (await lrcState()).top;
  await page.evaluate(() => { mockPlayer.seek(2 + 3 * 27 + 1); mockPlayer.play(); });
  await page.waitForTimeout(1200);
  L = await lrcState();
  check('LRCLIB: its own pause after wheel input still works (4 s)', after < lrcTop && L.idx === 27 && L.top === after, JSON.stringify({ lrcTop, after, L }));
  await page.waitForTimeout(5500); // its pause ends 4 s after the wheel; it re-centers on the next line change
  check('LRCLIB: afterwards it centers its current line as before', (await lrcState()).centered, JSON.stringify(await lrcState()));

  check('no page errors', errors.length === 0, JSON.stringify(errors));
  await ctx.close();
  fs.writeFileSync(__dirname + '/results-scroll.json', JSON.stringify(results, null, 1));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL (crash)', e); process.exit(1); });
