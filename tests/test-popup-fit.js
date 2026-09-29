// v1.3.5: the toolbar popup (and the same popup.html in the page's floating panel) must fit without scroll bars.
// Browsers size an extension popup to its content, capped at 800x600. This test emulates that: it loads popup.html as a
// real extension page (chrome-extension://<id>/popup.html), measures the content's preferred size, sets the viewport to
// min(800, width) x min(600, height) and checks document scrollWidth/scrollHeight against clientWidth/clientHeight.
// Classic (space-taking) scroll bars are enabled (Playwright's --hide-scrollbars is dropped), like Edge/Chrome on Windows,
// so a vertical bar eating width and causing a horizontal one is reproduced. Worst-case status lines are written into the DOM.
// Store state = temporary copy whose background.js stubs getSelf() to "normal" (as in test-update.js). GitHub is mocked.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EXT = require('path').resolve(__dirname, '..', 'extension');
const SHOT = process.env.SHOT || 'after';
const results = [];
const check = (name, cond, info = '') => { results.push([cond ? 'PASS' : 'FAIL', name, info]); console.log(cond ? 'PASS' : 'FAIL', name, info); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REL = 'https://github.com/NoodlesNom/lyrics-translate-for-amazon-music/releases';
const MAX_H = 590; // browsers cap popups at 600 px; keep a margin

const LONG = {
  glabel: 'Gemini working · last reply 23 h ago',
  song: ['Tu Sei L\u2019Unica Donna Per Me (Live at the Royal Albert Hall, London \u2013 2019 Remastered Deluxe Edition) by Mock Singer, Another Very Long Artist Name & The Symphony Orchestra of Somewhere Far Away',
    'English + Japanese · Mostly English · translated 12 lines with Gemini + Google (from cache)'],
  lrcNote: 'Lyrics added from LRCLIB (synced) · open the full view to see them',
  forceMsg: "Couldn't reach the page. Reload it and try again.",
  counter: 'Saved songs: 1234 (Gemini 1200 · Google 1234) · ~12.3 MB',
  updMsg: 'Checked just now · GitHub is limiting requests right now. Try again later.',
};
// Unbreakable strings (long words / URLs) must wrap instead of widening the page.
const UNBREAKABLE = ['Supercalifragilisticexpialidocious_Extended_Club_Remix_Version_2026 by https://www.example.com/a/very/long/path/without/any/spaces/at/all', 'English · Already in English, no translation needed'];

async function launch(ext) {
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'],
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  await ctx.route(/api\.github\.com/, (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ tag_name: 'v1.3.10', html_url: `${REL}/tag/v1.3.10`, name: 'v1.3.10', draft: false, prerelease: false }) }));
  await ctx.route(/clients5\.google\.com|translate\.googleapis\.com/, (route) => { const q = new URLSearchParams(route.request().postData() || '').get('q'); route.fulfill({ contentType: 'application/json', body: JSON.stringify([[[q, q, null, null]], null, 'en']) }); });
  await ctx.route(/lrclib\.net/, (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await ctx.route('https://music.amazon.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(__dirname + '/mock.html') }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  return { ctx, sw, extId: sw.url().split('/')[2] };
}

// Freeze popup.js's timers (they rewrite "This song" every second) and write the given texts ("This song" through
// popup.js's own showSong(title by artist, state), or plain text if this popup.js has none).
const fill = (target, texts) => target.evaluate((texts) => {
  for (let i = 1; i < 5000; i++) { clearInterval(i); clearTimeout(i); }
  const $ = (id) => document.getElementById(id);
  for (const [id, t] of Object.entries(texts)) {
    if (id === 'song') { if (typeof showSong === 'function') showSong(...t); else $(id).textContent = 'This song: ' + t.join(' · '); continue; }
    $(id).textContent = t; if (id === 'lrcNote') { $(id).hidden = false; $(id).dataset.kind = 'synced-closed'; } }
  $('force').disabled = false;
}, texts);

// Scroll state of the document and of any inner scroll area.
const scrollState = (target) => target.evaluate(() => {
  const d = document.documentElement;
  const inner = [...document.querySelectorAll('body *')].filter((e) => { const cs = getComputedStyle(e); return /auto|scroll/.test(cs.overflowY + cs.overflowX) && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1); })
    .map((e) => ({ id: e.id || e.className || e.tagName, sh: e.scrollHeight, ch: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth, thin: getComputedStyle(e).scrollbarWidth }));
  const wide = [...document.querySelectorAll('body, body *')].filter((e) => !e.hidden && e.getBoundingClientRect().right > d.clientWidth + 0.5).map((e) => e.id || e.tagName);
  return { sw: d.scrollWidth, cw: d.clientWidth, sh: d.scrollHeight, ch: d.clientHeight, inner, wide,
    docScrollbar: getComputedStyle(d).scrollbarWidth + '/' + getComputedStyle(d).scrollbarColor };
});

// Emulate the browser's popup sizing: preferred content size, capped at 800x600.
async function popupFit(pop) {
  await pop.setViewportSize({ width: 800, height: 600 });
  await sleep(150);
  const pref = await pop.evaluate(() => {
    const b = document.body, cs = getComputedStyle(b), r = b.getBoundingClientRect();
    return { w: Math.ceil(r.right + parseFloat(cs.marginRight)), h: Math.ceil(r.bottom + parseFloat(cs.marginBottom) + window.scrollY) };
  });
  const vp = { width: Math.min(800, pref.w), height: Math.min(600, pref.h) };
  await pop.setViewportSize(vp);
  await sleep(150);
  return { pref, vp, ...(await scrollState(pop)) };
}
const noScroll = (m) => m.sw <= m.cw && m.sh <= m.ch && !m.inner.length && !m.wide.length;
const brief = (m) => JSON.stringify({ pref: m.pref, vp: m.vp, scroll: `${m.sw}x${m.sh} in ${m.cw}x${m.ch}`, inner: m.inner, wide: m.wide.slice(0, 5) });
const SIZES = ['0.85', '1', '1.2', '1.45'];

async function popupChecks(ctx, sw, extId, label, withUpdate) {
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForTimeout(800);
  // Rendered, not just the hidden property (1.3.4's ".updrow { display: flex }" beat [hidden], so store copies showed the button).
  const vis = await pop.evaluate(() => Object.fromEntries(['updRow', 'updBtn', 'updNew', 'updPriv'].map((id) => { const e = document.getElementById(id); return [id, !e.hidden && e.getClientRects().length > 0]; })));
  check(`${label}: Updates UI ${withUpdate ? 'rendered (row, button, update line, privacy note)' : 'not rendered at all (no row, button, update line or privacy note)'}`, Object.values(vis).every((v) => v === withUpdate), JSON.stringify(vis));
  // As opened (real texts: nothing playing).
  let m = await popupFit(pop);
  check(`${label}: as opened → no scroll bars, height ≤ ${MAX_H}px`, noScroll(m) && m.pref.h <= MAX_H, brief(m));
  // Longest status lines, every text size setting (display-only, but checked anyway).
  const worst = [];
  for (const s of SIZES) {
    await sw.evaluate((s) => chrome.storage.sync.set({ size: Number(s) }), s);
    await pop.reload(); await pop.waitForTimeout(700);
    await fill(pop, withUpdate ? LONG : Object.fromEntries(Object.entries(LONG).filter(([k]) => k !== 'updMsg')));
    m = await popupFit(pop); worst.push(m);
    if (s === '1') await pop.screenshot({ path: `${__dirname}/popup-fit-${SHOT}-${withUpdate ? 'update' : 'store'}.png` });
  }
  check(`${label}: longest status lines, all 4 text sizes → no scroll bars in either direction, height ≤ ${MAX_H}px`, worst.every((w) => noScroll(w) && w.pref.h <= MAX_H), worst.map(brief).join(' | '));
  console.log(`   ${label} worst case: preferred ${worst[1].pref.w}x${worst[1].pref.h}, document ${worst[1].sw}x${worst[1].sh} in ${worst[1].cw}x${worst[1].ch}`);
  // Unbreakable title / URL must wrap.
  await fill(pop, { song: UNBREAKABLE });
  m = await popupFit(pop);
  check(`${label}: unbreakable long word + URL in "This song" wrap (no horizontal overflow)`, m.sw <= m.cw && !m.wide.length, brief(m));
  await sw.evaluate(() => chrome.storage.sync.set({ size: 1 }));
  await pop.close();
  return worst[1];
}

(async () => {
  const out = {};
  // ---------- Unpacked copy with an update available ----------
  let { ctx, sw, extId } = await launch(EXT);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !((await sw.evaluate(() => chrome.storage.local.get('upd'))).upd || {}).latest) await sleep(250);
  out.update = await popupChecks(ctx, sw, extId, 'unpacked + update available', true);

  // Remaining scroll bars (if any) must be styled, never the default ones.
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`); await pop.waitForTimeout(500);
  const styled = await pop.evaluate(() => [document.documentElement, ...document.querySelectorAll('body, body *')]
    .filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY)).map((e) => ({ id: e.id || e.tagName, w: getComputedStyle(e).scrollbarWidth, c: getComputedStyle(e).scrollbarColor })));
  check('any element that may scroll has a thin, themed scroll bar (scrollbar-width: thin + scrollbar-color)', styled.length > 0 && styled.every((s) => s.w === 'thin' && s.c !== 'auto'), JSON.stringify(styled));
  const ox = await pop.evaluate(() => [getComputedStyle(document.documentElement).overflowX, getComputedStyle(document.body).overflowX]);
  check('horizontal scrolling is switched off (overflow-x: hidden)', ox.includes('hidden'), JSON.stringify(ox));
  await pop.close();

  // ---------- In-page panel (floating button on music.amazon.com), same unpacked + update state ----------
  for (const vp of [{ width: 1100, height: 1000 }, { width: 1100, height: 760 }, { width: 1100, height: 560 }]) {
    const page = await ctx.newPage();
    await page.setViewportSize(vp);
    await page.goto('https://music.amazon.com/?song=1');
    await page.waitForTimeout(2500);
    await page.click('button.amlt-float');
    await page.locator('iframe.amlt-panel').waitFor({ timeout: 5000 });
    await page.frameLocator('iframe.amlt-panel').locator('#tl').waitFor({ timeout: 5000 });
    const fr = await (await page.locator('iframe.amlt-panel').elementHandle()).contentFrame(); await page.waitForTimeout(1500);
    const real = await fr.evaluate(() => document.getElementById('song').textContent);
    let m = await scrollState(fr);
    const box = await page.locator('iframe.amlt-panel').boundingBox();
    const tall = vp.height >= 1000; // room for the whole popup (≤ 590 px) below the panel's top (124 px)
    check(`panel (window ${vp.width}x${vp.height}): real song → ${tall ? 'no scroll bars at all' : 'no page scroll bar, no horizontal overflow'}`,
      /^This song: Paper Lantern \(Test\) by Mock Artist · /.test(real) && m.sw <= m.cw && m.sh <= m.ch && !m.wide.length && (!tall || !m.inner.length), `${real} | panel ${Math.round(box.width)}x${Math.round(box.height)} ${JSON.stringify(m)}`);
    await fill(fr, LONG); await page.waitForTimeout(400);
    m = await scrollState(fr);
    const box2 = await page.locator('iframe.amlt-panel').boundingBox();
    check(`panel (window ${vp.width}x${vp.height}): longest lines → ${tall ? 'no scroll bars at all, panel fits its content' : 'only the inner area scrolls (thin), no horizontal overflow'}`,
      m.sw <= m.cw && m.sh <= m.ch && !m.wide.length && (tall ? !m.inner.length : m.inner.every((i) => i.thin === 'thin' && i.sw <= i.cw)) && box2.y + box2.height <= vp.height,
      `panel ${Math.round(box2.width)}x${Math.round(box2.height)} ${JSON.stringify(m)}`);
    if (vp.height === 1000) await page.screenshot({ path: `${__dirname}/popup-fit-${SHOT}-panel.png`, clip: { x: box2.x - 20, y: box2.y - 20, width: box2.width + 40, height: box2.height + 40 } });
    await page.close();
  }
  await ctx.close();

  // ---------- Store copy (no Updates section) ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amlt-fit-'));
  fs.cpSync(EXT, dir, { recursive: true });
  fs.writeFileSync(dir + '/background.js', `// TEST STUB: pretend to be a store install\nchrome.management.getSelf = () => Promise.resolve({ installType: 'normal', id: chrome.runtime.id });\n` + fs.readFileSync(EXT + '/background.js', 'utf8'));
  ({ ctx, sw, extId } = await launch(dir));
  out.store = await popupChecks(ctx, sw, extId, 'store copy', false);
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const passed = results.filter((r) => r[0] === 'PASS').length;
  console.log(`\n${passed}/${results.length} passed`);
  fs.writeFileSync(__dirname + `/results-popup-fit${SHOT === 'after' ? '' : '-' + SHOT}.json`, JSON.stringify({ results, out: { update: brief(out.update), store: brief(out.store) } }, null, 1));
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
