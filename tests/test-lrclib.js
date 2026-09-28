// LRCLIB fallback tests (v1.3.0). lrclib.net is MOCKED via Playwright routing: every lyric line below is invented
// test text written for these tests (no real lyrics anywhere). Google Translate is answered synthetically.
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

const panelInfo = (page) => page.evaluate(() => {
  const p = document.querySelector('.amlt-lrc');
  if (!p) return null;
  const txt = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('');
  const lines = [...p.querySelectorAll('.amlt-lrc-line')];
  const on = p.querySelector('.amlt-lrc-on');
  const r = p.getBoundingClientRect(), bar = document.getElementById('playerBar').getBoundingClientRect();
  return { n: lines.length, plain: p.classList.contains('amlt-lrc-plain'), active: on ? txt(on) : null, activeIdx: lines.indexOf(on), src: p.querySelector('.amlt-lrc-src').textContent,
    aboveBar: r.bottom <= bar.top, inView: r.top >= 0 && r.right <= innerWidth,
    lines: lines.map((l) => ({ text: txt(l), trans: l.querySelector('.amlt-trans') && l.querySelector('.amlt-trans').textContent, rom: l.querySelector('.amlt-rom') && l.querySelector('.amlt-rom').textContent, size: getComputedStyle(l).fontSize })) };
});
const waitPanel = (page, t = 8000) => page.waitForSelector('.amlt-lrc', { timeout: t }).then(() => true, () => false);
const waitActive = (page, text, t = 3000) => page.waitForFunction((text) => { const el = document.querySelector('.amlt-lrc-on'); return (el ? [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('') : null) === text; }, text, { timeout: t }).then(() => true, () => false);

(async () => {
  const manifest = JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8'));
  check('manifest 1.3.0: only lrclib.net added (permissions still just storage)', manifest.version === '1.3.0' && JSON.stringify(manifest.permissions) === '["storage"]'
    && JSON.stringify(manifest.host_permissions) === JSON.stringify(['https://clients5.google.com/*', 'https://translate.googleapis.com/*', 'https://generativelanguage.googleapis.com/*', 'https://lrclib.net/*']));

  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route(/lrclib\.net/, onLrclib);
  await ctx.route(/clients5\.google\.com|translate\.googleapis\.com/, onGoogle);
  await ctx.route(/generativelanguage\.googleapis\.com/, (r) => r.fulfill({ status: 500, body: '' }));
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

  // ---------- 1. Detection ----------
  await go('song=9&lyricsbtn=missing');
  check('detect: button missing but never seen a lyrics button yet → no lookup, no panel', lReqs.length === 0 && !(await panelInfo(page)), `reqs=${lReqs.length}`);
  await go('song=1', 2500);
  check('detect: Amazon has lyrics (lines shown) → no lookup, no panel', lReqs.length === 0 && !(await panelInfo(page)) && (await page.locator('h4 > .amlt').count()) > 0, `reqs=${lReqs.length}`);
  check('detect: an enabled lyrics button was seen and remembered', (await local('lyricsBtnSeen')).lyricsBtnSeen === true);
  await go('song=1&view=closed');
  check('detect: lyrics view CLOSED but Amazon has lyrics (button enabled) → no lookup, no panel', lReqs.length === 0 && !(await panelInfo(page)), `reqs=${lReqs.length}`);
  await go('song=9&lyricsbtn=enabled');
  check('detect: no lines on the page but lyrics button enabled → treated as "has lyrics" → nothing', lReqs.length === 0 && !(await panelInfo(page)), `reqs=${lReqs.length}`);
  lReqs = []; await page.goto('https://music.amazon.com/?song=9&lyricsbtn=missing');
  await page.waitForTimeout(1000);
  const early = lReqs.length;
  const shownMissing = await waitPanel(page);
  check('detect: lyrics button missing (after one was seen) → looked up after the state held ~1.5 s → panel', early === 0 && shownMissing && lReqs.length === 1 && lReqs[0].path === '/api/get', `reqsAt1s=${early} reqs=${JSON.stringify(lReqs.map((r) => r.path))}`);
  check('request: /api/get with track_name, artist_name, duration (whole seconds)', JSON.stringify(lReqs[0] && lReqs[0].q) === JSON.stringify({ track_name: 'Glass Harbor (Test)', artist_name: 'Mock Singer', duration: '200' }), JSON.stringify(lReqs[0] && lReqs[0].q));
  check('request: identifies the client via the Lrclib-Client header', /^Lyrics Translate & Romanize for Amazon Music v1\.3\.0 \(https:\/\/github\.com\/NoodlesNom\/lyrics-translate-for-amazon-music\)$/.test(lReqs[0] && lReqs[0].client), lReqs[0] && lReqs[0].client);
  await go('song=9');
  check('detect: lyrics button disabled → panel (from cache, 0 requests)', !!(await panelInfo(page)) && lReqs.length === 0, `reqs=${lReqs.length}`);
  await go('song=12&lyricsbtn=enabled&lyricsview=none', 4000);
  check('detect: lyrics view shows its empty state (button enabled) → looked up; LRCLIB has nothing → no panel, no guess', lReqs.length === 2 && !(await panelInfo(page)), JSON.stringify(lReqs.map((r) => r.path)));

  // ---------- 2. Sync ----------
  await go('song=9&start=0', 2500);
  await waitPanel(page);
  let P = await panelInfo(page);
  check('panel: 6 lines (empty LRC line shown as ♪), synced, sits above the player bar at the right', P && P.n === 6 && !P.plain && P.lines[4].text === '♪' && P.aboveBar && P.inView && P.src === 'from LRCLIB', JSON.stringify(P && { n: P.n, aboveBar: P.aboveBar, src: P.src }));
  await page.screenshot({ path: __dirname + '/screenshot-lrclib.png' });
  await page.evaluate(() => mockPlayer.seek(7));
  check('sync: seek to 0:07 → line 2 (0:06) highlighted', await waitActive(page, 'ランプの下で名前を呼んだ'));
  await page.evaluate(() => mockPlayer.seek(1));
  const before = await page.waitForFunction(() => !document.querySelector('.amlt-lrc-on'), null, { timeout: 3000 }).then(() => true, () => false);
  check('sync: seek back to 0:01 (before the first line) → nothing highlighted', before);
  await page.evaluate(() => mockPlayer.seek(15));
  check('sync: seek to 0:15 → line 4 (0:14)', await waitActive(page, 'We count the freight trains after nine'));
  await page.evaluate(() => mockPlayer.seek(11));
  check('sync: seek backwards to 0:11 → line 3 (0:10)', await waitActive(page, 'Tin roofs are drumming in the rain'));
  await page.evaluate(() => { mockPlayer.seek(12.9); mockPlayer.pause(); });
  await page.waitForTimeout(3000);
  P = await panelInfo(page);
  check('sync: paused at 0:12 → stays on line 3 for 3 s (no drift into line 4)', P.active === 'Tin roofs are drumming in the rain', P.active);
  await page.evaluate(() => mockPlayer.play());
  check('sync: play again → reaches line 4 (0:14) on time', await waitActive(page, 'We count the freight trains after nine', 2600));
  await page.evaluate(() => mockPlayer.seek(18.5));
  check('sync: 0:18.5 → the ♪ break line', await waitActive(page, '♪'));
  // precision: rollover of the 1-second clock is used to place the line within ~0.4 s
  await page.evaluate(() => mockPlayer.seek(3.2));
  await waitActive(page, '紙の月が川に浮かぶ');
  const tSwitch = await page.evaluate(() => new Promise((res) => { const t0 = performance.now(), p0 = mockPlayer.now(); (function w() { const el = document.querySelector('.amlt-lrc-on'); if (el && el.firstChild.nodeValue === 'ランプの下で名前を呼んだ') res(mockPlayer.now()); else if (performance.now() - t0 > 6000) res(-1); else setTimeout(w, 20); })(); }));
  check('sync: highlight switches within ~0.5 s of the LRC time (0:06), from a 1 s resolution clock', tSwitch > 5.4 && tSwitch < 6.5, `switched at player time ${tSwitch.toFixed(2)} s`);
  for (const [bar, label] of [['text', 'elapsed/duration texts only'], ['remaining', 'elapsed + remaining (-m:ss)'], ['slider', 'slider only (aria-valuenow/max + valuetext)']]) {
    await go(`song=9&bar=${bar}&start=7`, 2500);
    check(`sync: player bar with ${label} → line 2 at 0:07+`, (await waitPanel(page)) && (await waitActive(page, 'ランプの下で名前を呼んだ')), JSON.stringify((await panelInfo(page)) && (await panelInfo(page)).active));
  }
  await go('song=9&paused=1&start=12.5', 2500);
  await page.waitForTimeout(2500);
  P = await panelInfo(page);
  check('sync: page opened paused at 0:12 → line 3 and no advance', P && P.active === 'Tin roofs are drumming in the rain', P && P.active);

  // ---------- 3. Translation / romanization of fetched lines ----------
  await go('song=9&start=0', 3000);
  await page.waitForFunction(() => document.querySelectorAll('.amlt-lrc .amlt-trans').length >= 2, null, { timeout: 8000 }).catch(() => {});
  P = await panelInfo(page);
  const ja = P.lines.filter((l) => JA[l.text]);
  check('translation: Japanese panel lines get translation + romanization', ja.length === 3 && ja.every((l) => l.trans === JA[l.text][0] && l.rom === JA[l.text][1]), JSON.stringify(ja));
  check('translation: English panel lines unchanged (already English)', P.lines.filter((l) => /^[A-Z]/.test(l.text)).every((l) => !l.trans));
  check('translation: original hidden behind the translation as the main line (panel size 20px)', P.lines[0].size === '0px' && (await page.evaluate(() => getComputedStyle(document.querySelector('.amlt-lrc .amlt-trans')).fontSize)) === '20px' && P.lines[2].size === '20px');
  check('translation: the song is cached under the player title/artist key', !!(await local('song:ms:Glass Harbor (Test)|Mock Singer'))['song:ms:Glass Harbor (Test)|Mock Singer']);
  await setSettings({ tl: 'es' }); await page.waitForTimeout(1500);
  check('translation: target language change retranslates panel lines', gReqs.length > 0);
  await setSettings({ tl: 'en' }); await page.waitForTimeout(1500);

  // ---------- 4. Song change ----------
  await page.evaluate(() => setSong(1));
  const gone = await page.waitForFunction(() => !document.querySelector('.amlt-lrc'), null, { timeout: 3000 }).then(() => true, () => false);
  await page.waitForFunction(() => document.querySelectorAll('h4 > .amlt').length >= 10, null, { timeout: 10000 }).catch(() => {});
  check('song change: to a song with Amazon lyrics → panel removed, Amazon lines annotated', gone && (await page.locator('h4 > .amlt').count()) >= 10);
  lReqs = [];
  await page.evaluate(() => setSong(9));
  check('song change: back to the lyric-less song → panel again, no new request', (await waitPanel(page, 5000)) && lReqs.length === 0, `reqs=${lReqs.length}`);
  await page.evaluate(() => setSong(10));
  check('song change: to another lyric-less song → old panel replaced by the new song\'s lyrics', (await page.waitForFunction(() => document.querySelector('.amlt-lrc.amlt-lrc-plain'), null, { timeout: 6000 }).then(() => true, () => false)));

  // ---------- 5. Matching ----------
  await go('song=10', 4000);
  P = await panelInfo(page);
  check('match: search fallback rejects wrong duration (15 s) and wrong artist, accepts "(feat. Guest)" title / "& Guest" artist at 1.3 s', P && P.plain && P.n === 3 && P.src === 'from LRCLIB · not synced', JSON.stringify(P && { plain: P.plain, n: P.n, src: P.src }));
  await page.waitForTimeout(1500);
  check('match: unsynced (plain) lyrics → no highlighting', (await page.locator('.amlt-lrc-on').count()) === 0);
  await go('song=11', 4000);
  let c11 = (await local('lrc:ms:Far Off (Test)|Mock Singer'))['lrc:ms:Far Off (Test)|Mock Singer'];
  check('match: /api/get answer 10 s off and search answer 4.5 s off both rejected → nothing shown', !(await panelInfo(page)) && lReqs.length === 2, JSON.stringify(lReqs.map((r) => r.path)));
  const days = c11 && (c11.until - Date.now()) / 864e5;
  check('cache: "not found" marker stored with ~7-day expiry', c11 && c11.none === 1 && days > 6.9 && days <= 7, JSON.stringify(c11));
  await go('song=11', 3000);
  check('cache: not-found song replayed → 0 requests', lReqs.length === 0, `reqs=${lReqs.length}`);
  await sw.evaluate(async () => { const k = 'lrc:ms:Far Off (Test)|Mock Singer'; const v = (await chrome.storage.local.get(k))[k]; v.until = Date.now() - 1000; await chrome.storage.local.set({ [k]: v }); });
  await go('song=11', 4000);
  check('cache: expired not-found marker → looked up again', lReqs.length === 2, `reqs=${lReqs.length}`);
  await go('song=13', 4000);
  P = await panelInfo(page);
  check('match: /api/get has only plain lyrics → search finds a close synced match (199.2 s) → synced used', P && !P.plain && P.n === 6 && lReqs.map((r) => r.path).join() === '/api/get,/api/search', JSON.stringify(lReqs.map((r) => r.q)));
  await go('song=9', 3000);
  const c9 = (await local(['lrc:ms:Glass Harbor (Test)|Mock Singer', 'idx']));
  check('cache: found song stored once (synced LRC) in the shared LRU index; replay → 0 requests', lReqs.length === 0 && c9['lrc:ms:Glass Harbor (Test)|Mock Singer'].synced && 'ms:Glass Harbor (Test)|Mock Singer' in c9.idx, `reqs=${lReqs.length}`);
  await go('song=9&nomedia=1', 4000);
  check('player bar fallback (no media session): title/artist read from the bar links → lookup + panel', (await panelInfo(page)) && lReqs.length === 1 && lReqs[0].q.track_name === 'Glass Harbor (Test)' && lReqs[0].q.artist_name === 'Mock Singer', JSON.stringify(lReqs.map((r) => r.q)));

  // ---------- 6. Popup: toggle + "This song" notices ----------
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 302, height: 560 });
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForTimeout(400);
  const tabId = await sw.evaluate(async () => { for (const t of await chrome.tabs.query({})) if (await chrome.tabs.sendMessage(t.id, { type: 'song' }).catch(() => null)) return t.id; });
  const pointPopupAt = (id) => pop.evaluate(async (id) => { chrome.tabs.getCurrent = async () => undefined; chrome.tabs.query = async () => [{ id }]; await findSong(); }, id);
  const note = async () => { await pointPopupAt(tabId); return pop.evaluate(() => ({ hidden: document.getElementById('lrcNote').hidden, note: document.getElementById('lrcNote').textContent, song: document.getElementById('song').textContent, force: !document.getElementById('force').disabled })); };
  let n;
  await go('song=9', 3000); n = await note();
  check('popup notice: "Lyrics added from LRCLIB (synced)"; This song + Translate button work for LRCLIB lines', !n.hidden && n.note === 'Lyrics added from LRCLIB (synced)' && /Japanese \+ English · Translated with Google/.test(n.song) && n.force, JSON.stringify(n));
  await pop.screenshot({ path: __dirname + '/popup-lrclib.png' });
  await go('song=10', 3000); n = await note();
  check('popup notice: "Lyrics added from LRCLIB (unsynced)"', !n.hidden && n.note === 'Lyrics added from LRCLIB (unsynced)', JSON.stringify(n));
  await go('song=11', 3000); n = await note();
  check('popup notice: "Amazon has no lyrics; none found on LRCLIB"', !n.hidden && n.note === 'Amazon has no lyrics; none found on LRCLIB' && n.song === 'This song: no lyrics on Amazon.' && !n.force, JSON.stringify(n));
  await pop.screenshot({ path: __dirname + '/popup-lrclib-none.png' });
  await go('song=1', 2500); n = await note();
  check('popup notice: hidden for a song Amazon has lyrics for', n.hidden && !/no song|no lyrics/.test(n.song) && n.force, JSON.stringify(n));
  await go('song=9', 3000);
  await page.click('.amlt-lrc [data-act="close"]'); await page.waitForTimeout(600); n = await note();
  check('panel × hides it for this song; popup says so', !(await panelInfo(page)) && n.note === 'Lyrics from LRCLIB (synced), panel hidden for this song', JSON.stringify(n));
  await go('song=9', 3000);
  await page.click('.amlt-lrc [data-act="min"]'); await page.waitForTimeout(300);
  const minimized = await page.evaluate(() => getComputedStyle(document.querySelector('.amlt-lrc-body')).display === 'none');
  await page.click('.amlt-lrc [data-act="min"]');
  check('panel – minimizes / restores', minimized && (await page.evaluate(() => getComputedStyle(document.querySelector('.amlt-lrc-body')).display !== 'none')));
  const counter = await pop.textContent('#counter');
  const idx = (await local('idx')).idx;
  check('popup counter doesn\'t count LRCLIB "not found" markers as saved songs', /Saved songs: (\d+)/.exec(counter)[1] === String(Object.keys(idx).length - 2), `${counter} idx=${Object.keys(idx).length}`);
  check('popup toggle "Find lyrics when Amazon has none" exists, default on', (await pop.isChecked('#lrclib')) && /Find lyrics when Amazon has none/.test(await pop.textContent('label:has(#lrclib)')));
  await pop.click('#lrclib'); await page.waitForTimeout(600);
  check('toggle off → stored, panel removed live', (await sw.evaluate(() => chrome.storage.sync.get('lrclib'))).lrclib === false && !(await panelInfo(page)));
  await sw.evaluate(() => chrome.storage.local.remove(['lrc:ms:Tin Roof (Test)|Mock Singer & Guest']));
  await go('song=10', 3500); n = await note();
  check('toggle off → lyric-less song: no request, no panel, no notice', lReqs.length === 0 && !(await panelInfo(page)) && n.hidden, `reqs=${lReqs.length}`);
  await pop.click('#lrclib');
  check('toggle on again → looked up and shown', await waitPanel(page, 6000));

  // ---------- 7. Rate limit (429 + Retry-After) ----------
  await sw.evaluate(() => chrome.storage.local.remove(['lrc:ms:Nowhere (Test)|Mock Nobody']));
  lmode = '429';
  await go('song=12', 6000); n = await note();
  check('429: honored, not cached as "not found", no hammering (1 request in 6 s); popup says it will retry', lReqs.length === 1 && !(await local('lrc:ms:Nowhere (Test)|Mock Nobody'))['lrc:ms:Nowhere (Test)|Mock Nobody'] && /will retry/.test(n.note), `reqs=${lReqs.length} ${n.note}`);
  lmode = 'ok';

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
  fs.writeFileSync(__dirname + '/results-lrclib.json', JSON.stringify(results, null, 1));
  console.log(`\n${results.filter((r) => r[0] === 'PASS').length}/${results.length} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
