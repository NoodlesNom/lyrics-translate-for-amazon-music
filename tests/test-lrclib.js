// LRCLIB fallback tests (v1.3.2: LRCLIB lyrics shown only in Amazon's full view, in the spot of Amazon's own lyrics; no-lyrics
// detection from the mini-player's "Lyrics available" badge and the full view's empty lyrics column). lrclib.net is MOCKED via
// Playwright routing: every lyric line below is invented test text written for these tests (no real lyrics anywhere).
// Google Translate is answered synthetically.
const { chromium } = require('playwright');
const fs = require('fs');
const EXT = require('path').resolve(__dirname, '..', 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, info = '') => { results.push([cond ? 'PASS' : 'FAIL', name, info]); console.log(cond ? 'PASS' : 'FAIL', name, info); };

// ---- invented lyrics ----
const SYNCED = ['[00:02.00]紙の月が川に浮かぶ', '[00:06.00]ランプの下で名前を呼んだ', '[00:10.00]Tin roofs are drumming in the rain',
  '[00:14.00]We count the freight trains after nine', '[00:18.00]', '[00:20.00]紙の月が川に浮かぶ'].join('\n');
const PLAIN = 'Chalk birds are drawn along the wall\nThe ferry sleeps until the spring\n\nSomebody whistles out of tune';
const rec = (id, trackName, artistName, duration, lyr) => ({ id, name: trackName, trackName, artistName, albumName: 'Mock Album', duration, instrumental: false,
  plainLyrics: lyr.plain || (lyr.synced ? lyr.synced.replace(/\[[^\]]*\]/g, '') : null), syncedLyrics: lyr.synced || null });
const GET = {
  'Glass Harbor (Test)': rec(1, 'Glass Harbor (Test)', 'Mock Singer', 200.4, { synced: SYNCED }),
  'Far Off (Test)': rec(2, 'Far Off (Test)', 'Mock Singer', 190, { synced: SYNCED }),          // server "match" with a wrong duration
  'Split Signal (Test)': rec(3, 'Split Signal (Test)', 'Mock Singer, Guest', 200, { plain: PLAIN }), // plain only…
};
const SEARCH = {
  'Tin Roof (Test)': [rec(10, 'Tin Roof (Test)', 'Mock Singer', 195, { synced: SYNCED }),          // duration 15 s off
    rec(11, 'Tin Roof (Test)', 'Other Band', 180, { synced: SYNCED }),                              // other artist
    rec(12, 'Tin Roof (Test) (feat. Guest)', 'Mock Singer', 181.3, { plain: PLAIN })],             // close match, plain
  'Far Off (Test)': [rec(20, 'Far Off (Test)', 'Mock Singer', 184.5, { synced: SYNCED })],          // 4.5 s off → rejected
  'Split Signal (Test)': [rec(3, 'Split Signal (Test)', 'Mock Singer, Guest', 200, { plain: PLAIN }),
    rec(30, 'Split Signal', 'Mock Singer', 199.2, { synced: SYNCED })],                             // …but search has synced
};
const LONG = ['[61:38.00]Lanterns drift across the late canal', '[61:44.00]The night bus hums a second verse', '[61:50.00]We fold the map and wait for day'].join('\n'); // h:mm:ss track
GET['Long Night (Test)'] = rec(4, 'Long Night (Test)', 'Mock Orchestra', 3725, { synced: LONG });
// v1.3.3 (invented): an English song as lyrics sites have it: a Cyrillic look-alike "\u0435" typed into one English word,
// curly quotes, an em dash, fullwidth "！", an emoji, "♪" and empty stamps; and a mostly English song with two Japanese lines.
const HOMO = ['[00:02.00]Porch light burning past the l\u0435vee', '[00:06.00]\u201cStay a while,\u201d the screen door sings', '[00:10.00]', '[00:12.00]\u266a',
  '[00:14.00]Coffee rings on yesterday\u2019s news\uff01', '[00:18.00]Nobody\u2019s counting \u2014 not tonight \ud83c\udf19', '[00:22.00]Porch light burning past the l\u0435vee'].join('\n');
const MOSTLY_EN = ['[00:02.00]Harbor bells are ringing low', '[00:06.00]紙の月が川に浮かぶ', '[00:10.00]We row until the lanterns fade', '[00:14.00]\u266a',
  '[00:16.00]Gulls are drawing circles wide', '[00:20.00]ランプの下で名前を呼んだ', '[00:24.00]Oars keep time \u2014 \u201cone, two\u201d', '[00:28.00]The tide forgets our names',
  '[00:32.00]Salt and pine along the shore'].join('\n');
GET['Porch Light (Test)'] = rec(40, 'Porch Light (Test)', 'Mock Singer', 200, { synced: HOMO });
GET['Harbor Bells (Test)'] = rec(41, 'Harbor Bells (Test)', 'Mock Singer', 200, { synced: MOSTLY_EN });
const JA = { '紙の月が川に浮かぶ': ['A paper moon floats on the river', 'Kami no tsuki ga kawa ni ukabu'], 'ランプの下で名前を呼んだ': ['I called your name under the lamp', 'Ranpu no shita de namae o yonda'] };

let lmode = 'ok', lReqs = [];
async function onLrclib(route) {
  const u = new URL(route.request().url());
  lReqs.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), client: route.request().headers()['lrclib-client'] || '' });
  if (lmode === '429') return route.fulfill({ status: 429, headers: { 'Retry-After': '2' }, contentType: 'application/json', body: '{"code":429}' });
  const t = u.searchParams.get('track_name');
  if (u.pathname === '/api/get') return GET[t] ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(GET[t]) }) : route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":404,"name":"TrackNotFound"}' });
  if (u.pathname === '/api/search') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(SEARCH[t] || []) });
  route.fulfill({ status: 404, body: '' });
}
let gReqs = [];
async function onGoogle(route) {
  const q = new URLSearchParams(route.request().postData() || '').get('q');
  gReqs.push(q);
  const ls = q.split('\n|\n');
  if (ls.every((l) => JA[l])) return route.fulfill({ contentType: 'application/json', body: JSON.stringify([[[ls.map((l) => JA[l][0]).join('\n|\n'), q, null, null], [null, null, null, ls.map((l) => JA[l][1]).join(' | ')]], null, 'ja']) });
  route.fulfill({ contentType: 'application/json', body: JSON.stringify([[[q, q, null, null]], null, 'en']) }); // English: unchanged
}

// ---- full-view helpers ----
const VP = { width: 1600, height: 820 }; // the viewport the live full view was measured at
const stageInfo = (page) => page.evaluate(() => {
  const root = document.querySelector('.amlt-stage');
  if (!root) return null;
  const txt = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('');
  const R = (e) => e && e.getBoundingClientRect();
  const cs = (e) => getComputedStyle(e);
  const lines = [...root.querySelectorAll('.amlt-stage-line')];
  const on = root.querySelector('.amlt-stage-on');
  const sc = root.querySelector('.amlt-stage-scroll');
  const r = R(root), scR = R(sc), onR = R(on);
  const artEl = document.querySelector('[data-testid="Imagery,Stage_TileImage"]'), art = R(artEl);
  const obst = [...document.querySelectorAll('[data-testid="Stage_Title"], [data-testid="Stage_Subtitle"], [data-testid*="MiniPlayer_"], [aria-label="Minimize"], [aria-label="Enter Full Screen"], button.amlt-float')]
    .filter((e) => e.getClientRects().length).map(R).filter((q) => q.width && q.height);
  const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
  const credit = root.querySelector('.amlt-stage-credit');
  return { n: lines.length, plain: root.classList.contains('amlt-stage-plain'), active: on ? txt(on) : null, activeIdx: lines.indexOf(on),
    credit: credit && credit.textContent, creditOpacity: credit && cs(credit).color,
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) },
    art: art && { right: Math.round(art.right), top: Math.round(art.top), bottom: Math.round(art.bottom) },
    clearOfArt: !!art && r.left >= art.right + 24, nObst: obst.length, clearOfObstacles: obst.length >= 6 && obst.every((q) => apart(r, q)),
    inView: r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.height > 100, shown: cs(root).visibility === 'visible',
    bodyChild: root.parentElement === document.body, position: cs(root).position, bg: cs(root).backgroundColor, border: cs(root).borderTopWidth + ' ' + cs(root).borderTopStyle,
    headers: root.querySelectorAll('button, h1, h2, h3, [class*="head"]').length, scrollbar: sc.offsetWidth - sc.clientWidth, scrollable: sc.scrollHeight > sc.clientHeight,
    activeInView: onR ? onR.top >= scR.top - 1 && onR.bottom <= scR.bottom + 1 : null,
    activeCentered: onR ? Math.abs((onR.top + onR.bottom) / 2 - (scR.top + scR.bottom) / 2) < scR.height / 4 : null,
    lines: lines.map((l) => ({ text: txt(l), trans: l.querySelector('.amlt-trans') && l.querySelector('.amlt-trans').textContent, rom: l.querySelector('.amlt-rom') && l.querySelector('.amlt-rom').textContent,
      size: cs(l).fontSize, color: cs(l).color, align: cs(l).textAlign, font: cs(l).fontFamily, spacing: cs(l).letterSpacing, h: l.offsetHeight })) };
});
const ours = (page) => page.evaluate(() => [...document.querySelectorAll('.amlt-stage, .amlt-lrc, [class*="amlt-lrc"]')].length);
const waitStage = (page, t = 8000) => page.waitForSelector('.amlt-stage', { timeout: t }).then(() => true, () => false);
const waitGone = (page, t = 3000) => page.waitForFunction(() => !document.querySelector('.amlt-stage'), null, { timeout: t }).then(() => true, () => false);
const lrcKey = (n) => 'lrc:asin:B0MOCK' + String(n).padStart(4, '0');
const waitActive = (page, text, t = 3000) => page.waitForFunction((text) => { const el = document.querySelector('.amlt-stage-on'); return (el ? [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('') : null) === text; }, text, { timeout: t }).then(() => true, () => false);
const near = (a, b, tol = 12) => Math.abs(a - b) <= tol;

(async () => {
  const manifest = JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8'));
  check('manifest 1.3.5: no new permissions (storage + the same four hosts)', manifest.version === '1.3.5' && JSON.stringify(manifest.permissions) === '["storage"]'
    && JSON.stringify(manifest.host_permissions) === JSON.stringify(['https://clients5.google.com/*', 'https://translate.googleapis.com/*', 'https://generativelanguage.googleapis.com/*', 'https://lrclib.net/*']));
  const src = fs.readFileSync(EXT + '/content.js', 'utf8') + fs.readFileSync(EXT + '/content.css', 'utf8');
  check('old side panel code/CSS removed (no .amlt-lrc, no minimize/hide buttons)', !/amlt-lrc|amlt-lrc-min|data-act|lrcHidden|lrcMin/.test(src));

  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: VP,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route(/api\.github\.com/, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ tag_name: 'v' + JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8')).version, html_url: 'https://github.com/NoodlesNom/lyrics-translate-for-amazon-music/releases/latest' }) })); // v1.3.4 update check (unpacked): mocked, same version
  await ctx.route(/lrclib\.net/, onLrclib);
  await ctx.route(/clients5\.google\.com|translate\.googleapis\.com/, onGoogle);
  // Gemini (MOCKED, placeholder key, only set in section 10): records requests; non-Latin lines → "Gemini line <n>", others unchanged.
  let gemReqs = [];
  await ctx.route(/generativelanguage\.googleapis\.com/, (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    const lines = ((body.contents && body.contents[0].parts[0].text) || '').split('\n').map((x) => x.replace(/^\d+\.\s/, ''));
    gemReqs.push(lines);
    const out = lines.map((l, i) => (/[^\P{L}\p{Script=Latin}]/u.test(l) ? `Gemini line ${i + 1}` : l));
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(out) }] } }] }) });
  });
  await ctx.route('https://music.amazon.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(__dirname + '/mock.html') }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const setSettings = (s) => sw.evaluate((s) => chrome.storage.sync.set(s), s);
  const local = (k) => sw.evaluate((k) => chrome.storage.local.get(k), k);
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const go = async (qs, wait = 3500) => { lReqs = []; await page.goto('https://music.amazon.com/?' + qs); await page.waitForTimeout(wait); };
  let S;

  // ---------- 1. The mock ----------
  const mock = await page.goto('https://music.amazon.com/?song=1&stage=0').then(() => page.evaluate(() => {
    const t = document.querySelector('a[data-testid="MiniPlayer_Title"][role="link"]'), row = t.parentElement;
    const b = row.querySelector('div[data-testid="Box,BadgeGroup"] > div[data-testid="Badge"][aria-label="Lyrics available"]');
    const ids = [...document.querySelectorAll('[data-testid*="MiniPlayer_"]')].map((e) => e.getAttribute('data-testid'));
    return { title: t.getAttribute('aria-label'), href: t.getAttribute('href'), badge: b && b.textContent, badgeInMiniTestid: !!(b && b.closest('[data-testid*="MiniPlayer_"]')),
      artist: row.nextElementSibling.querySelector('a[href^="/artists/"]').getAttribute('aria-label'), ids, stage: !!document.querySelector('[data-testid*="Stage_"]'),
      enter: !!document.querySelector('button[data-testid="IconButton"][aria-label="Enter Full Screen"]'),
      slider: document.querySelector('[data-testid="Slider,MiniPlayer_ProgressSlider"] [role="slider"]').getAttribute('aria-label'),
      timeTexts: [...document.querySelectorAll('#miniPlayer *')].some((e) => [...e.childNodes].some((n) => n.nodeType === 3 && /\d:\d\d/.test(n.nodeValue))) };
  }));
  check('mock normal page: mini-player mirrors the live markup (testids, aria-labels, /tracks/ASIN, badge, slider label, Enter Full Screen), no full view mounted',
    mock.title === 'Paper Lantern (Test)' && mock.href === '/tracks/B0MOCK0001?do=play' && mock.badge === 'LYRICS' && !mock.badgeInMiniTestid && mock.artist === 'Mock Artist' && !mock.stage && mock.enter
    && ['IconButton,MiniPlayer_Pause', 'IconButton,MiniPlayer_PreviousButton', 'IconButton,MiniPlayer_NextButton', 'IconButton,MiniPlayer_PlayQueueButton', 'IconButton,MiniPlayer_ContextMenu', 'IconButton,MiniPlayer_Follow_Follow', 'Slider,MiniPlayer_ProgressSlider', 'MiniPlayer_Title'].every((i) => mock.ids.includes(i))
    && /^Playback \d+:\d\d of 3:35$/.test(mock.slider) && !mock.timeTexts, JSON.stringify(mock));
  const geo = (qs) => page.goto('https://music.amazon.com/?' + qs).then(() => page.waitForTimeout(300)).then(() => page.evaluate(() => {
    const R = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), n: e.children.length }; };
    return { art: R('div[data-testid="Imagery,Stage_TileImage"][role="img"]'), title: R('a[data-testid="Stage_Title"]'), sub: R('div[data-testid="Stage_Subtitle"]'),
      pause: R('[data-testid="IconButton,MiniPlayer_Pause"]'), box: R('div[data-testid="Stage_OverlaysContainer"]'), outer: R('div[data-testid="Box,Box,Stage_OverlaysContainer"]'),
      bg: R('div[data-testid="Stage_Background"]'), minimize: R('button[aria-label="Minimize"][data-testid="IconButton,OpenMiniPlayerIconButton"]'),
      miniTitle: !!document.querySelector('[data-testid="MiniPlayer_Title"]'), fs: document.fullscreenElement, inSection: !!document.querySelector('section[role="region"] [data-testid="Stage_OverlaysContainer"]') };
  }));
  const g1 = await geo('song=1');
  check('mock full view (1600x820) with Amazon lyrics: art 500x500 at 52,88; title y 632; artist y 674; transport ~743; lyrics column 857,120 659x446; no MiniPlayer_Title; not the Fullscreen API',
    g1.art.x === 52 && g1.art.y === 88 && g1.art.w === 500 && g1.art.h === 500 && g1.title.y === 632 && g1.sub.y === 674 && near(g1.pause.y + g1.pause.h / 2, 743, 15)
    && near(g1.box.x, 857, 3) && g1.box.y === 120 && near(g1.box.w, 659, 3) && g1.box.h === 446 && g1.outer.w === VP.width && g1.outer.h === 510 && g1.bg.w === VP.width && g1.bg.h === VP.height
    && g1.minimize && !g1.miniTitle && g1.fs === null && g1.inSection, JSON.stringify(g1));
  const g9 = await geo('song=9');
  check('mock full view without Amazon lyrics: Stage_OverlaysContainer present but EMPTY, 0 wide at x 1516, y 120, h 460', g9.box.n === 0 && g9.box.w === 0 && g9.box.x === 1516 && g9.box.y === 120 && g9.box.h === 460, JSON.stringify(g9.box));

  // ---------- 2. Detection ----------
  await go('song=1', 2500);
  check('detect: full view with Amazon lines → no lookup, nothing of ours, Amazon lines annotated', lReqs.length === 0 && !(await ours(page)) && (await page.locator('h4 > .amlt').count()) > 0, `reqs=${lReqs.length}`);
  await go('song=1&stage=0');
  check('detect: badge present, full view closed → no lookup, nothing', lReqs.length === 0 && !(await ours(page)), `reqs=${lReqs.length}`);
  await go('song=9&badge=on&stage=0');
  check('detect: badge present (no lines anywhere) → "Amazon has lyrics" → nothing', lReqs.length === 0 && !(await ours(page)), `reqs=${lReqs.length}`);
  await go('song=9&badge=on&stagemini=hidden');
  check('detect: full view open, empty lyrics column, but the (hidden) mini-player title has the badge → badge wins: no lookup, nothing', lReqs.length === 0 && !(await ours(page)), `reqs=${lReqs.length}`);
  await go('song=12&badge=late&badgeDelay=1200&stage=0', 4000);
  check('detect: badge appears late (1.2 s, within the settle window) → no lookup', lReqs.length === 0 && !(await ours(page)), `reqs=${lReqs.length}`);
  await go('song=9&mini=0');
  check('detect: nothing playing (no mini-player, no full view) → no lookup', lReqs.length === 0 && !(await ours(page)), `reqs=${lReqs.length}`);
  lReqs = []; await page.goto('https://music.amazon.com/?song=9&stage=0&start=3');
  await page.waitForTimeout(1000);
  const early = lReqs.length;
  await page.waitForTimeout(2500);
  const normalKids = await page.evaluate(() => [...document.body.children].filter((e) => /amlt/.test(e.className)).map((e) => e.className));
  check('normal page: badge absent → looked up only after the ~1.8 s settle (a decoy badge elsewhere is ignored)', early === 0 && lReqs.length === 1 && lReqs[0].path === '/api/get', `reqsAt1s=${early} reqs=${JSON.stringify(lReqs.map((r) => r.path))}`);
  check('normal page: NO lyrics panel at all (only the floating button is ours)', !(await ours(page)) && JSON.stringify(normalKids) === '["amlt-float"]', JSON.stringify(normalKids));
  check('request: /api/get with the mini-player title, artist (aria-labels) and duration from the slider label (whole seconds)', JSON.stringify(lReqs[0] && lReqs[0].q) === JSON.stringify({ track_name: 'Glass Harbor (Test)', artist_name: 'Mock Singer', duration: '200' }), JSON.stringify(lReqs[0] && lReqs[0].q));
  check('request: identifies the client via the Lrclib-Client header', (lReqs[0] && lReqs[0].client) === `Lyrics Translate & Romanize for Amazon Music v${manifest.version} (https://github.com/NoodlesNom/lyrics-translate-for-amazon-music)`, lReqs[0] && lReqs[0].client);
  lReqs = [];
  await page.click('button[aria-label="Enter Full Screen"]');
  const t0 = Date.now();
  const openShown = await waitStage(page, 2000);
  const openMs = Date.now() - t0;
  S = await stageInfo(page);
  const noMini = await page.evaluate(() => !document.querySelector('[data-testid="MiniPlayer_Title"]'));
  check('open the full view (Enter Full Screen): the lyrics appear at once in Amazon\'s lyrics spot, though MiniPlayer_Title is gone (same song via the Stage_Title), 0 new requests',
    openShown && openMs < 1200 && noMini && S && S.n === 6 && lReqs.length === 0, `after ${openMs} ms, reqs=${lReqs.length}`);
  check('open: follows the clock from the full view\'s slider (0:07+ → line 2)', await waitActive(page, 'ランプの下で名前を呼んだ'));
  await page.click('button[aria-label="Minimize"]');
  check('close the full view (Minimize) → removed immediately, nothing left on the normal page', (await waitGone(page, 500)) && !(await ours(page)));
  await page.click('button[aria-label="Enter Full Screen"]');
  check('open again → shown again (from memory)', await waitStage(page, 1500));

  lReqs = []; await page.goto('https://music.amazon.com/?song=9');
  await page.waitForTimeout(1000);
  const earlyStage = lReqs.length;
  const shownStage = await waitStage(page);
  check('full view open from the start, no mini-player title, no /tracks/ link on Stage_Title: empty lyrics column for the settle window → looked up with the Stage_Title / Stage_Subtitle song → shown',
    earlyStage === 0 && shownStage && lReqs.length === 1 && JSON.stringify(lReqs[0].q) === JSON.stringify({ track_name: 'Glass Harbor (Test)', artist_name: 'Mock Singer', duration: '200' }), `reqsAt1s=${earlyStage} ${JSON.stringify(lReqs.map((r) => r.q))}`);
  await go('song=9&stagehref=tracks', 3000);
  check('full view: Stage_Title with a /tracks/<ASIN> link → keyed by that ASIN (cached from the normal page, 0 requests)', !!(await stageInfo(page)) && lReqs.length === 0, `reqs=${lReqs.length}`);
  await go('song=9&hdbadge=1&stagemini=hidden');
  check('detect: only a non-lyrics badge (HD) in the group → still no lyrics → shown (from cache, 0 requests)', !!(await stageInfo(page)) && lReqs.length === 0, `reqs=${lReqs.length}`);
  await go('song=9&badge=late&badgeDelay=4500&stagemini=hidden', 3000);
  const before45 = !!(await stageInfo(page));
  await page.waitForTimeout(2500);
  check('detect: badge that shows up after ours (4.5 s) → removed again', before45 && !(await ours(page)));
  await go('song=12', 4000);
  check('detect: LRCLIB has nothing → looked up (get + search), nothing shown, no guess', lReqs.length === 2 && !(await ours(page)), JSON.stringify(lReqs.map((r) => r.path)));

  // ---------- 3. Placement and look ----------
  await go('song=9&start=0&stagehref=tracks', 2500);
  await waitStage(page);
  S = await stageInfo(page);
  check('place: in Amazon\'s lyrics spot (≈ x 857-1516, y 120-566 at 1600x820), right of the art, on screen', S && near(S.rect.x, 857) && near(S.rect.right, 1516) && near(S.rect.y, 120) && near(S.rect.bottom, 566) && S.clearOfArt && S.inView && S.shown, JSON.stringify(S && S.rect));
  check('place: overlaps none of art, title, artist, Previous/Pause/Next, slider, Minimize, floating button', S && S.clearOfArt && S.clearOfObstacles, `obstacles=${S && S.nObst}`);
  check('place: our own fixed-position <body> child (never inside Amazon\'s React-managed lyrics column)', S && S.bodyChild && S.position === 'fixed' && (await page.evaluate(() => document.querySelector('[data-testid="Stage_OverlaysContainer"]').children.length)) === 0);
  check('look: no panel background, border or header; scrollbar hidden; a small "Lyrics from LRCLIB" credit', S && S.bg === 'rgba(0, 0, 0, 0)' && /^0px/.test(S.border) && S.headers === 0 && S.scrollbar === 0 && S.credit === 'Lyrics from LRCLIB', JSON.stringify(S && { bg: S.bg, border: S.border, headers: S.headers, scrollbar: S.scrollbar, credit: S.credit }));
  await page.waitForFunction(() => document.querySelectorAll('.amlt-stage .amlt').length >= 6, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  S = await stageInfo(page);
  const en = S.lines.filter((l) => /^[A-Z]/.test(l.text));
  check('look: Amazon\'s lyric style: EmberModernDisplayStd-Bold, right-aligned, letter-spacing 0.2px, dim rgba(255,255,255,0.3) lines, ~72-80 px per line',
    S.lines.every((l) => /^EmberModernDisplayStd-Bold/.test(l.font) && l.align === 'right' && l.spacing === '0.2px') && en.every((l) => l.color === 'rgba(255, 255, 255, 0.3)' && l.h >= 70 && l.h <= 82), JSON.stringify(en));
  await page.evaluate(() => mockPlayer.seek(7));
  await waitActive(page, 'ランプの下で名前を呼んだ');
  await page.waitForTimeout(500); // color transition
  S = await stageInfo(page);
  check('look: current line white (rgb(255,255,255)), others stay dim', S.lines[1].color === 'rgb(255, 255, 255)' && S.lines.filter((l, i) => i !== 1).every((l) => l.color === 'rgba(255, 255, 255, 0.3)'), JSON.stringify(S.lines.map((l) => l.color)));
  await page.setViewportSize({ width: 1100, height: 700 }); await page.waitForTimeout(500);
  S = await stageInfo(page);
  const art700 = await page.evaluate(() => Math.round(document.querySelector('[data-testid="Imagery,Stage_TileImage"]').getBoundingClientRect().right));
  check('place: window resized to 1100x700 → recomputed from the smaller art, still right of it, clear of the controls, on screen', S && S.art.right === art700 && art700 < 552 && S.clearOfArt && S.clearOfObstacles && S.inView && S.shown, JSON.stringify(S && { rect: S.rect, art: S.art }));
  await page.setViewportSize(VP); await page.waitForTimeout(500);
  S = await stageInfo(page);
  check('place: back to 1600x820 → back in the measured spot', S && near(S.rect.x, 857) && near(S.rect.bottom, 566), JSON.stringify(S && S.rect));
  await go('song=9&stagemini=bar&stagehref=tracks', 3000);
  S = await stageInfo(page);
  const barTop = await page.evaluate(() => document.getElementById('miniPlayer').getBoundingClientRect().top);
  check('place: a mini-player bar that stays visible under the full view is never covered', S && S.rect.bottom <= barTop && S.clearOfObstacles, JSON.stringify({ rect: S && S.rect, barTop }));

  // ---------- 4. Sync ----------
  await go('song=9&start=0&stagehref=tracks', 2500);
  await waitStage(page);
  await page.evaluate(() => mockPlayer.seek(7));
  check('sync: seek to 0:07 → line 2 (0:06) highlighted', await waitActive(page, 'ランプの下で名前を呼んだ'));
  await page.evaluate(() => mockPlayer.seek(1));
  check('sync: seek back to 0:01 (before the first line) → nothing highlighted', await page.waitForFunction(() => !document.querySelector('.amlt-stage-on'), null, { timeout: 3000 }).then(() => true, () => false));
  await page.evaluate(() => mockPlayer.seek(15));
  const at15 = await waitActive(page, 'We count the freight trains after nine');
  await page.waitForTimeout(1000);
  S = await stageInfo(page);
  check('sync: seek to 0:15 → line 4 (0:14), smoothly scrolled into the middle of our own scroll box', at15 && S.activeInView && S.activeCentered, JSON.stringify({ inView: S.activeInView, centered: S.activeCentered }));
  await page.evaluate(() => mockPlayer.seek(11));
  check('sync: seek backwards to 0:11 → line 3 (0:10)', await waitActive(page, 'Tin roofs are drumming in the rain'));
  await page.evaluate(() => { mockPlayer.seek(12.9); mockPlayer.pause(); });
  await page.waitForTimeout(3000);
  S = await stageInfo(page);
  check('sync: paused at 0:12 → stays on line 3 for 3 s (no drift into line 4)', S.active === 'Tin roofs are drumming in the rain', S.active);
  await page.evaluate(() => mockPlayer.play());
  check('sync: play again → reaches line 4 (0:14) on time', await waitActive(page, 'We count the freight trains after nine', 2600));
  await page.evaluate(() => mockPlayer.seek(18.5));
  check('sync: 0:18.5 → the ♪ break line', await waitActive(page, '♪'));
  await page.evaluate(() => mockPlayer.seek(3.2));
  await waitActive(page, '紙の月が川に浮かぶ');
  const tSwitch = await page.evaluate(() => new Promise((res) => { const t0 = performance.now(); (function w() { const el = document.querySelector('.amlt-stage-on'); if (el && el.firstChild.nodeValue === 'ランプの下で名前を呼んだ') res(mockPlayer.now()); else if (performance.now() - t0 > 6000) res(-1); else setTimeout(w, 20); })(); }));
  check('sync: highlight switches within ~0.5 s of the LRC time (0:06), from a 1 s resolution clock', tSwitch > 5.4 && tSwitch < 6.5, `switched at player time ${tSwitch.toFixed(2)} s`);
  for (const [mode, label] of [['slider=label', 'MiniPlayer slider with aria-label "Playback m:ss of m:ss" only'], ['slider=ms', 'aria-label + aria-valuenow/valuemax in ms'], ['stageslider=generic&slider=label', 'no MiniPlayer_ProgressSlider testid: any [role=slider] labelled "Playback … of …"']]) {
    await go(`song=9&${mode}&start=7&stagehref=tracks`, 2500);
    check(`clock: ${label} → line 2 at 0:07+`, (await waitStage(page)) && (await waitActive(page, 'ランプの下で名前を呼んだ')), JSON.stringify((await stageInfo(page)) && (await stageInfo(page)).active));
  }
  await sw.evaluate(() => chrome.storage.local.remove(['lrc:bar:Glass Harbor (Test)|Mock Singer']));
  await go('song=9&stageslider=generic&slider=label&start=3', 3500);
  check('clock: generic slider only → the duration for the lookup still comes from its label (200 s)', lReqs[0] && lReqs[0].q.duration === '200', JSON.stringify(lReqs.map((r) => r.q)));
  await go('song=14&slider=label&start=3700', 2500);
  const longLabel = await page.evaluate(() => document.querySelector('[role="slider"]').getAttribute('aria-label'));
  check('clock h:mm:ss: "Playback 1:01:4x of 1:02:05" → looked up with 3725 s', /^Playback 1:01:4\d of 1:02:05$/.test(longLabel) && (await waitStage(page)) && lReqs[0] && lReqs[0].q.duration === '3725', `${longLabel} ${JSON.stringify(lReqs.map((r) => r.q))}`);
  check('clock h:mm:ss: at 1:01:40 → the 61:38 line is highlighted', await waitActive(page, 'Lanterns drift across the late canal'));
  await page.evaluate(() => mockPlayer.seek(3705));
  check('clock h:mm:ss: seek to 1:01:45 → the 61:44 line', await waitActive(page, 'The night bus hums a second verse'));
  await page.evaluate(() => { mockPlayer.seek(3701); mockPlayer.pause(); });
  await page.waitForTimeout(2500);
  check('clock: Play button (aria-label "Play" = paused) stops the highlight advancing', (await stageInfo(page)).active === 'Lanterns drift across the late canal', (await stageInfo(page)).active);
  await go('song=9&paused=1&start=12.5&stagehref=tracks', 2500);
  await page.waitForTimeout(2500);
  S = await stageInfo(page);
  check('sync: page opened paused at 0:12 → line 3 and no advance', S && S.active === 'Tin roofs are drumming in the rain', S && S.active);

  // ---------- 5. Translation / romanization / text size ----------
  await go('song=9&start=7&stagehref=tracks', 3000);
  await page.waitForFunction(() => document.querySelectorAll('.amlt-stage .amlt-trans').length >= 2, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  S = await stageInfo(page);
  const ja = S.lines.filter((l) => JA[l.text]);
  check('translation: Japanese lines get translation (main line) + romanization below', ja.length === 3 && ja.every((l) => l.trans === JA[l.text][0] && l.rom === JA[l.text][1]), JSON.stringify(ja));
  check('translation: English lines unchanged (already in the target language → no translation)', S.lines.filter((l) => /^[A-Z]/.test(l.text)).every((l) => !l.trans));
  const sizes = () => page.evaluate(() => { const t = document.querySelector('.amlt-stage .amlt-trans'), r = document.querySelector('.amlt-stage .amlt-rom'); return [getComputedStyle(t).fontSize, getComputedStyle(r).fontSize]; });
  check('translation: original behind the "Show original" toggle (0px), translation 28px, romanization 18px, English lines 28px — same as Amazon\'s lines', S.lines[0].size === '0px' && JSON.stringify(await sizes()) === '["28px","18px"]' && S.lines[2].size === '28px', JSON.stringify([S.lines[0].size, S.lines[2].size, await sizes()]));
  await page.screenshot({ path: __dirname + '/fullview-1.3.2.png' });
  await setSettings({ orig: true }); await page.waitForTimeout(500);
  S = await stageInfo(page);
  check('translation: "Show original lyrics" on → original 28px with translation 18px below', S.lines[0].size === '28px' && (await sizes())[0] === '18px');
  await setSettings({ orig: false, size: 1.2 }); await page.waitForTimeout(600);
  S = await stageInfo(page);
  check('text size Large → 33.6px / 21.6px on these lines too', JSON.stringify(await sizes()) === '["33.6px","21.6px"]' && S.lines[2].size === '33.6px', JSON.stringify(await sizes()));
  await setSettings({ size: 1 }); await page.waitForTimeout(300);
  check('translation: the song is cached under the track key (ASIN)', !!(await local('song:asin:B0MOCK0009'))['song:asin:B0MOCK0009']);
  gReqs = [];
  await setSettings({ tl: 'es' }); await page.waitForTimeout(1500);
  check('translation: target language change retranslates these lines', gReqs.length > 0);
  await setSettings({ tl: 'en' }); await page.waitForTimeout(1500);

  // ---------- 6. Removal: song change, Amazon lines, full view closed ----------
  await page.evaluate(() => setSong(1));
  const gone = await waitGone(page, 1500);
  await page.waitForFunction(() => document.querySelectorAll('h4 > .amlt').length >= 10, null, { timeout: 10000 }).catch(() => {});
  check('song change (full view open) to a song with Amazon lyrics → ours removed at once, Amazon lines annotated', gone && (await page.locator('h4 > .amlt').count()) >= 10);
  lReqs = [];
  await page.evaluate(() => setSong(9));
  check('song change: back to the lyric-less song → shown again, no new request', (await waitStage(page, 5000)) && lReqs.length === 0, `reqs=${lReqs.length}`);
  await page.evaluate(() => { window.__t0 = performance.now(); setSong(10); });
  const oldGone = await waitGone(page, 600);
  const plainAt = await page.waitForFunction(() => document.querySelector('.amlt-stage.amlt-stage-plain') && performance.now() - window.__t0, null, { timeout: 6000 }).then((h) => h.jsonValue(), () => -1);
  check('song change: to another lyric-less song → old lyrics removed at once, the new song\'s after the settle window', oldGone && plainAt >= 1700, `newAt=${Math.round(plainAt)} ms`);
  await go('song=9&stagehref=tracks', 3000);
  await page.evaluate(() => { window.__t0 = performance.now(); addAmazonLines(['Invented line one (Test)', 'Invented line two (Test)', 'Invented line three (Test)']); });
  const amzAt = await page.waitForFunction(() => !document.querySelector('.amlt-stage') && performance.now() - window.__t0, null, { timeout: 2000 }).then((h) => h.jsonValue(), () => -1);
  check('Amazon\'s own lines appear later for the same song → ours removed immediately (Amazon wins)', amzAt >= 0 && amzAt < 500, `removed after ${Math.round(amzAt)} ms`);
  await page.waitForTimeout(2500);
  check('…and not shown again while Amazon\'s lines are there', !(await ours(page)));
  await go('song=9&stagehref=tracks', 3000);
  await page.evaluate(() => { window.__t0 = performance.now(); closeStage(); });
  const closeAt = await page.waitForFunction(() => !document.querySelector('.amlt-stage') && performance.now() - window.__t0, null, { timeout: 2000 }).then((h) => h.jsonValue(), () => -1);
  check('full view closed (unmounted) → removed within 0.3 s; nothing on the normal page', closeAt >= 0 && closeAt < 300 && !(await ours(page)), `after ${Math.round(closeAt)} ms`);
  await go('song=9&stagehref=tracks&stageclose=hide', 3000);
  const hadIt = !!(await stageInfo(page));
  await page.evaluate(() => closeStage());
  check('full view closed but left mounted (slid out of the window, faded) → counts as closed, removed', hadIt && (await waitGone(page, 800)) && (await page.evaluate(() => !!document.querySelector('[data-testid="Stage_OverlaysContainer"]'))));
  await page.evaluate(() => openStage());
  check('…and shown again when it slides back in', await waitStage(page, 1500));
  await page.evaluate(() => closeStage());
  await page.evaluate(() => setSong(10));
  await page.waitForTimeout(3000);
  lReqs = [];
  await page.evaluate(() => openStage());
  S = (await waitStage(page, 2000)) && (await stageInfo(page));
  check('song changed while closed (lookup done in the background) → opening the full view shows the new song\'s lyrics at once', S && S.plain && lReqs.length === 0);

  // ---------- 7. Matching ----------
  await go('song=10&stagehref=tracks', 4000);
  S = await stageInfo(page);
  check('match: search fallback rejects wrong duration (15 s) and wrong artist, accepts "(feat. Guest)" title / "& Guest" artist at 1.3 s', S && S.plain && S.n === 3 && S.credit === 'Lyrics from LRCLIB · not synced', JSON.stringify(S && { plain: S.plain, n: S.n, credit: S.credit }));
  await page.waitForTimeout(1500);
  S = await stageInfo(page);
  check('match: unsynced (plain) lyrics → all lines white, no highlight, scrollable box', (await page.locator('.amlt-stage-on').count()) === 0 && S.lines.every((l) => l.color === 'rgb(255, 255, 255)'), JSON.stringify(S.lines.map((l) => l.color)));
  await go('song=11&stagehref=tracks', 4000);
  let c11 = (await local(lrcKey(11)))[lrcKey(11)];
  check('match: /api/get answer 10 s off and search answer 4.5 s off both rejected → nothing shown', !(await ours(page)) && lReqs.length === 2, JSON.stringify(lReqs.map((r) => r.path)));
  const days = c11 && (c11.until - Date.now()) / 864e5;
  check('cache: "not found" marker stored with ~7-day expiry', c11 && c11.none === 1 && days > 6.9 && days <= 7, JSON.stringify(c11));
  await go('song=11&stagehref=tracks', 3000);
  check('cache: not-found song replayed → 0 requests', lReqs.length === 0, `reqs=${lReqs.length}`);
  await sw.evaluate(async () => { const k = 'lrc:asin:B0MOCK0011'; const v = (await chrome.storage.local.get(k))[k]; v.until = Date.now() - 1000; await chrome.storage.local.set({ [k]: v }); });
  await go('song=11&stagehref=tracks', 4000);
  check('cache: expired not-found marker → looked up again', lReqs.length === 2, `reqs=${lReqs.length}`);
  await go('song=13&stagehref=tracks', 4000);
  S = await stageInfo(page);
  check('match: /api/get has only plain lyrics → search finds a close synced match (199.2 s) → synced used', S && !S.plain && S.n === 6 && lReqs.map((r) => r.path).join() === '/api/get,/api/search', JSON.stringify(lReqs.map((r) => r.q)));
  await go('song=9&stage=0', 3000);
  const c9 = (await local([lrcKey(9), 'idx']));
  check('cache: found song stored once (synced LRC) in the shared LRU index under its ASIN; replay → 0 requests', lReqs.length === 0 && c9[lrcKey(9)].synced && 'asin:B0MOCK0009' in c9.idx, `reqs=${lReqs.length}`);
  await go('song=9&nomedia=1&stagehref=tracks', 4000);
  check('no media session: everything comes from the page → shown (same ASIN key, 0 requests)', (await stageInfo(page)) && lReqs.length === 0, JSON.stringify(lReqs.map((r) => r.q)));

  // ---------- 8. Popup: toggle + "This song" notices ----------
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 302, height: 560 });
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForTimeout(400);
  const tabId = await sw.evaluate(async () => { for (const t of await chrome.tabs.query({})) if (await chrome.tabs.sendMessage(t.id, { type: 'song' }).catch(() => null)) return t.id; });
  const pointPopupAt = (id) => pop.evaluate(async (id) => { chrome.tabs.getCurrent = async () => undefined; chrome.tabs.query = async () => [{ id }]; await findSong(); }, id);
  const note = async () => { await pointPopupAt(tabId); return pop.evaluate(() => ({ hidden: document.getElementById('lrcNote').hidden, note: document.getElementById('lrcNote').textContent, song: document.getElementById('song').textContent, force: !document.getElementById('force').disabled })); };
  let n;
  await go('song=9&stage=0', 3000); n = await note();
  check('popup: LRCLIB synced, full view CLOSED → "Lyrics added from LRCLIB (synced) · open the full view to see them", song named, button off (nothing on screen)', !n.hidden && n.note === 'Lyrics added from LRCLIB (synced) · open the full view to see them' && n.song === 'This song: Glass Harbor (Test) by Mock Singer' && !n.force, JSON.stringify(n));
  await pop.screenshot({ path: __dirname + '/popup-lrclib-closed.png' });
  await page.evaluate(() => openStage()); await waitStage(page, 2000); await page.waitForTimeout(1500); n = await note();
  check('popup: full view OPEN → "Lyrics added from LRCLIB (synced)"; This song = title/artist + translation state; Translate button works', !n.hidden && n.note === 'Lyrics added from LRCLIB (synced)' && /^This song: Glass Harbor \(Test\) by Mock Singer · Japanese \+ English · Translated with Google/.test(n.song) && n.force, JSON.stringify(n));
  await pop.screenshot({ path: __dirname + '/popup-lrclib.png' });
  await go('song=10&stagehref=tracks', 3000); n = await note();
  check('popup: "Lyrics added from LRCLIB (unsynced)", multi-artist name kept as one string', !n.hidden && n.note === 'Lyrics added from LRCLIB (unsynced)' && n.song.startsWith('This song: Tin Roof (Test) by Mock Singer & Guest · '), JSON.stringify(n));
  await go('song=10&stage=0', 3000); n = await note();
  check('popup: unsynced, full view closed → "Lyrics added from LRCLIB (unsynced) · open the full view to see them"', n.note === 'Lyrics added from LRCLIB (unsynced) · open the full view to see them', JSON.stringify(n));
  await go('song=11&stagehref=tracks', 3000); n = await note();
  check('popup: "Amazon has no lyrics; none found on LRCLIB" with the song name', !n.hidden && n.note === 'Amazon has no lyrics; none found on LRCLIB' && n.song === 'This song: Far Off (Test) by Mock Singer' && !n.force, JSON.stringify(n));
  await pop.screenshot({ path: __dirname + '/popup-lrclib-none.png' });
  await go('song=11', 300); n = await note();
  check('popup: right after a title change with an empty lyrics column → "Checking for lyrics…"', n.note === 'Checking for lyrics…' && n.song === 'This song: Far Off (Test) by Mock Singer', JSON.stringify(n));
  await go('song=1&stage=0', 2500); n = await note();
  check('popup: badge present, full view closed → song name + "Amazon has lyrics: open the lyrics view to translate them", button off', !n.hidden && n.note === 'Amazon has lyrics: open the lyrics view to translate them' && n.song === 'This song: Paper Lantern (Test) by Mock Artist' && !n.force, JSON.stringify(n));
  await pop.screenshot({ path: __dirname + '/popup-amazon-closed.png' });
  await go('song=1', 2500); n = await note();
  check('popup: full view with Amazon lyrics → song name (from Stage_Title) + translation state, no notice, button on', n.hidden && /^This song: Paper Lantern \(Test\) by Mock Artist · \S/.test(n.song) && n.force, JSON.stringify(n));
  await go('song=1&mini=0', 2000); n = await note();
  check('popup: nothing playing → "nothing playing"', n.hidden && n.song === 'This song: nothing playing in Amazon Music.' && !n.force, JSON.stringify(n));
  const counter = await pop.textContent('#counter');
  const all = await local(null);
  const noneMarkers = Object.keys(all.idx).filter((k) => all['lrc:' + k] && all['lrc:' + k].none && !all['song:' + k]).length;
  check('popup counter doesn\'t count LRCLIB "not found" markers as saved songs', noneMarkers >= 2 && /Saved songs: (\d+)/.exec(counter)[1] === String(Object.keys(all.idx).length - noneMarkers), `${counter} idx=${Object.keys(all.idx).length} none=${noneMarkers}`);
  check('popup toggle "Find lyrics when Amazon has none" exists, default on, tooltip no longer mentions a panel', (await pop.isChecked('#lrclib')) && /Find lyrics when Amazon has none/.test(await pop.textContent('label:has(#lrclib)')) && /full view/.test(await pop.getAttribute('label:has(#lrclib)', 'title')));
  await go('song=9&stagehref=tracks', 3000);
  await pop.click('#lrclib'); await page.waitForTimeout(600);
  check('toggle off → stored, lyrics removed live', (await sw.evaluate(() => chrome.storage.sync.get('lrclib'))).lrclib === false && !(await ours(page)));
  await sw.evaluate(() => chrome.storage.local.remove(['lrc:asin:B0MOCK0010']));
  await go('song=10&stagehref=tracks', 3500); n = await note();
  check('toggle off → lyric-less song: no request, nothing shown; popup says Amazon has none and the lookup is off', lReqs.length === 0 && !(await ours(page)) && n.note === 'Amazon has no lyrics (finding lyrics on LRCLIB is off)' && n.song === 'This song: Tin Roof (Test) by Mock Singer & Guest', `reqs=${lReqs.length} ${JSON.stringify(n)}`);
  await pop.click('#lrclib');
  check('toggle on again → looked up and shown', await waitStage(page, 6000));

  // ---------- 9. Rate limit (429 + Retry-After) ----------
  await sw.evaluate(() => chrome.storage.local.remove(['lrc:asin:B0MOCK0012']));
  lmode = '429';
  await go('song=12&stagehref=tracks', 6000); n = await note();
  check('429: honored, not cached as "not found", no hammering (1 request in 6 s); popup says it will retry', lReqs.length === 1 && !(await local(lrcKey(12)))[lrcKey(12)] && /will retry/.test(n.note), `reqs=${lReqs.length} ${n.note}`);
  lmode = 'ok';

  // ---------- 10. v1.3.3: LRCLIB lines of an English song never go to Gemini as a whole (target English, Gemini selected) ----------
  await sw.evaluate(() => Promise.all([chrome.storage.local.set({ geminiKey: 'placeholder-not-a-real-key-TEST' }), chrome.storage.sync.set({ translator: 'gemini' })]));
  const isJa = (t) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(t);
  gemReqs = []; gReqs = [];
  await go('song=9&title=Porch%20Light%20(Test)&asin=B0MOCKP001&stagehref=tracks', 4500);
  S = await stageInfo(page);
  check('(v1.3.3) LRCLIB English song with a Cyrillic look-alike letter + symbols: shown, 0 Gemini requests, 1 Google detection request (look-alike sent as Latin)',
    S && S.n === 7 && gemReqs.length === 0 && gReqs.length === 1 && gReqs[0].split('\n|\n').length === 4 && !gReqs[0].includes('\u0435'), `n=${S && S.n} gemini=${gemReqs.length} google=${gReqs.length}`);
  const porchLines = S ? [...new Set(S.lines.map((l) => l.text).filter((t) => /\p{L}/u.test(t)))] : [];
  check('(v1.3.3) …no translation and no romanization on any LRCLIB line', S && S.lines.every((l) => !l.trans && !l.rom), JSON.stringify(S && S.lines.map((l) => [l.trans, l.rom])));
  n = await note();
  check('(v1.3.3) popup: "English · Already in English, no translation needed" + "Lyrics added from LRCLIB (synced)"', n.song === 'This song: Porch Light (Test) by Mock Singer · English · Already in English, no translation needed' && n.note === 'Lyrics added from LRCLIB (synced)', JSON.stringify(n));

  gemReqs = []; gReqs = [];
  await go('song=9&title=Harbor%20Bells%20(Test)&asin=B0MOCKP002&stagehref=tracks', 4500);
  await page.waitForFunction(() => [...document.querySelectorAll('.amlt-stage .amlt-trans')].length >= 2, null, { timeout: 8000 }).catch(() => {});
  S = await stageInfo(page);
  const jaL = S ? S.lines.filter((l) => isJa(l.text)) : [];
  check('(v1.3.3) LRCLIB mostly English song (6 English + 2 Japanese lines): ONE Gemini request with only the 2 Japanese lines, no whole-song request',
    gemReqs.length === 1 && JSON.stringify(gemReqs[0]) === JSON.stringify(jaL.map((l) => l.text)), `gemini=${JSON.stringify(gemReqs.map((r) => r.length))}`);
  check('(v1.3.3) …Japanese lines: Gemini translation + romanization; English lines: nothing added', jaL.length === 2 && jaL.every((l, i) => l.trans === `Gemini line ${i + 1}` && l.rom === JA[l.text][1])
    && S.lines.filter((l) => !isJa(l.text)).every((l) => !l.trans && !l.rom), JSON.stringify(S && S.lines.map((l) => [l.trans, l.rom])));
  n = await note();
  check('(v1.3.3) popup: "English + Japanese · Mostly English · translated 2 lines with Gemini"', /^This song: Harbor Bells \(Test\) by Mock Singer · English \+ Japanese · Mostly English · translated 2 lines with Gemini( \(from cache\))?$/.test(n.song), JSON.stringify(n));

  // The reported case: an English LRCLIB song cached by 1.3.2 as Gemini-translated → no longer overrides the skip rule.
  const keep = JSON.stringify((await local('song:asin:B0MOCK0009'))['song:asin:B0MOCK0009']);
  await sw.evaluate(async (lines) => {
    const e = { lines: {}, ts: Date.now() - 864e5 };
    lines.forEach((l, i) => { e.lines[l] = { t: {}, g: { en: 'Stale Gemini rewrite ' + (i + 1) } }; });
    const { idx = {} } = await chrome.storage.local.get('idx');
    idx['asin:B0MOCKP003'] = e.ts;
    await chrome.storage.local.set({ 'song:asin:B0MOCKP003': e, idx });
  }, porchLines);
  gemReqs = []; gReqs = [];
  await go('song=9&title=Porch%20Light%20(Test)&asin=B0MOCKP003&stagehref=tracks', 4500);
  S = await stageInfo(page);
  const e3 = (await local('song:asin:B0MOCKP003'))['song:asin:B0MOCKP003'];
  check('(v1.3.3) stale 1.3.2 Gemini cache of an English LRCLIB song: 0 Gemini requests, stale rewrites not shown, song now marked "no Gemini", its Gemini text dropped',
    porchLines.length === 4 && S && gemReqs.length === 0 && gReqs.length === 1 && S.lines.every((l) => !l.trans) && e3.noGemini.en === 1 && Object.values(e3.lines).every((c) => !('en' in c.g)), `gemini=${gemReqs.length} google=${gReqs.length} ${JSON.stringify(S && S.lines.map((l) => l.trans))}`);
  n = await note();
  check('(v1.3.3) …popup is truthful: "English · Already in English, no translation needed"', n.song === 'This song: Porch Light (Test) by Mock Singer · English · Already in English, no translation needed', JSON.stringify(n));
  check('(v1.3.3) …other songs\' cache entries untouched', JSON.stringify((await local('song:asin:B0MOCK0009'))['song:asin:B0MOCK0009']) === keep);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
  fs.writeFileSync(__dirname + '/results-lrclib.json', JSON.stringify(results, null, 1));
  console.log(`\n${results.filter((r) => r[0] === 'PASS').length}/${results.length} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
