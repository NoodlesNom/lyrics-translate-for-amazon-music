// End-to-end test of the unpacked extension against the local mock page.
// music.amazon.com is routed to mock.html; translate requests are answered from fixtures.json
// (real responses recorded from the endpoint), falling back to the real endpoint on a miss.
const { chromium } = require('playwright');
const fs = require('fs');
const EXT = require('path').resolve(__dirname, '..', 'extension');
const FIX = __dirname + '/fixtures.json';
const fixtures = JSON.parse(fs.readFileSync(FIX, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, info = '') => { results.push([cond ? 'PASS' : 'FAIL', name, info]); console.log(cond ? 'PASS' : 'FAIL', name, info); };

let mode = 'fixture';           // 'fixture' | 'fail' | 'live'
let requests = [];
async function onTranslate(route) {
  const req = route.request();
  const url = new URL(req.url());
  const q = new URLSearchParams(req.postData() || '').get('q');
  const tl = url.searchParams.get('tl');
  requests.push({ host: url.host, tl, q });
  if (mode === 'fail') return route.fulfill({ status: 429, body: 'rate limited (simulated)' });
  if (mode === 'live') return route.continue();
  const key = tl + '::' + q;
  if (!fixtures[key]) {
    for (let i = 0; i < 6 && !fixtures[key]; i++) {       // record from the real endpoint (box IP is rate-limited)
      const res = await route.fetch({ url: 'https://clients5.google.com/translate_a/single?client=dict-chrome-ex&sl=auto&tl=' + tl + '&dt=t&dt=rm' });
      if (res.ok()) { fixtures[key] = await res.json(); fs.writeFileSync(FIX, JSON.stringify(fixtures)); }
      else { console.log('  (recording miss got HTTP', res.status(), '- backing off)'); await sleep(20000 * (i + 1)); }
    }
  }
  if (!fixtures[key]) return route.fulfill({ status: 429, body: '' });
  route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixtures[key]) });
}

const LINES = 'div[style*="padding-top: 191px"] > div > h4';
const annotations = (page) => page.evaluate((LINES) => [...document.querySelectorAll(LINES)].map((h4) => {
  const b = h4.querySelector(':scope > .amlt');
  const vis = (n) => !!(n && getComputedStyle(n).display !== 'none');
  const rom = b && b.querySelector('.amlt-rom'), tr = b && b.querySelector('.amlt-trans');
  const text = [...h4.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('');
  return { text, rom: rom && rom.textContent, trans: tr && tr.textContent, romVisible: vis(rom), transVisible: vis(tr) };
}), LINES);
// React-owned nodes must stay exactly as React left them: row = [h4, spacer], h4.firstChild = original text node.
const snapshotReactNodes = (page) => page.evaluate((LINES) => {
  window.__rows = [...document.querySelectorAll(LINES)].map((h4) => ({ row: h4.parentElement, h4, spacer: h4.nextElementSibling, text: h4.firstChild, attrs: [...h4.attributes].filter((a) => a.name !== 'style').map((a) => a.name + '=' + a.value).join('|') }));
}, LINES);
const reactNodesIntact = (page) => page.evaluate(() => window.__rows.every(({ row, h4, spacer, text }) =>
  row.isConnected && row.children.length === 2 && row.children[0] === h4 && row.children[1] === spacer && h4.firstChild === text && spacer.childNodes.length === 0
    && [...h4.attributes].filter((a) => a.name !== 'style').map((a) => a.name + '=' + a.value).join('|') === window.__rows.find((r) => r.h4 === h4).attrs && h4.style.fontSize === '24px'));
const layout = (page) => page.evaluate((LINES) => [...document.querySelectorAll(LINES)].map((h4) => {
  const cs = (n) => n && getComputedStyle(n);
  const tr = h4.querySelector(':scope > .amlt > .amlt-trans'), rom = h4.querySelector(':scope > .amlt > .amlt-rom');
  const text = [...h4.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('');
  return { text, h4Size: cs(h4).fontSize, h4Color: cs(h4).color, hasTr: !!tr,
    trSize: tr && cs(tr).fontSize, trWeight: tr && cs(tr).fontWeight, trFont: tr && cs(tr).fontFamily, trColor: tr && cs(tr).color,
    romSize: rom && cs(rom).fontSize, romStyle: rom && cs(rom).fontStyle,
    trAboveRom: !!(tr && rom && tr.getBoundingClientRect().top < rom.getBoundingClientRect().top) };
}), LINES);
const nonLyricAnnotated = (page) => page.evaluate((LINES) => {
  const lyric = new Set(document.querySelectorAll(LINES));
  return [...document.querySelectorAll('.amlt')].filter((b) => !lyric.has(b.parentElement)).map((b) => b.parentElement.outerHTML.slice(0, 120));
}, LINES);
const waitAnnotated = (page, n) => page.waitForFunction((n) => document.querySelectorAll('.amlt').length >= n, n, { timeout: 60000 * 5 });
const isLatin = (s) => !/[^\P{L}\p{Script=Latin}]/u.test(s);

(async () => {
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 1000 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await ctx.route(/api\.github\.com/, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ tag_name: 'v' + JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8')).version, html_url: 'https://github.com/NoodlesNom/lyrics-translate-for-amazon-music/releases/latest' }) })); // v1.3.4 update check (unpacked): mocked, same version
  await ctx.route(/clients5\.google\.com|translate\.googleapis\.com/, onTranslate);
  let lrclibHits = 0; // songs here all have Amazon lyrics (badge shown), so LRCLIB must never be asked
  await ctx.route(/lrclib\.net/, (r) => { lrclibHits++; r.fulfill({ status: 404, body: '' }); });
  await ctx.route('https://music.amazon.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(__dirname + '/mock.html') }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const setSettings = (s) => sw.evaluate((s) => chrome.storage.sync.set(s), s);
  const errors = [];

  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  let a;
  // 0. One real, un-intercepted request made by the extension itself
  mode = 'live'; requests = [];
  await page.goto('https://music.amazon.com/?song=4');
  const live = await page.waitForFunction(() => document.querySelectorAll('.amlt').length === 3, null, { timeout: 15000 }).then(() => true, () => false);
  a = await annotations(page);
  check('LIVE endpoint request from the extension (box IP may be rate-limited)', live, JSON.stringify(a) + ` hosts=${requests.map((r) => r.host)}`);
  mode = 'fixture';


  // 1. Initial annotation
  requests = [];
  await page.goto('https://music.amazon.com/?song=1');
  await snapshotReactNodes(page);
  await waitAnnotated(page, 10);
  await page.waitForTimeout(800);
  a = await annotations(page);
  check('annotation block is inside the h4, after its text node; React nodes not moved/removed', await reactNodesIntact(page));
  check('nothing else annotated (title h4, overlay decoy, background decoys)', (await nonLyricAnnotated(page)).length === 0, (await nonLyricAnnotated(page)).join(' | '));
  const nonLatin = a.filter((x) => /\p{L}/u.test(x.text) && !isLatin(x.text));
  check('romanization + translation under every non-Latin line', nonLatin.length === 10 && nonLatin.every((x) => x.rom && x.trans));
  check('English lines: no romanization, no translation (target en)', a.filter((x) => isLatin(x.text)).every((x) => !x.rom && !x.trans));
  check('batched: one request per script group (6 groups)', requests.length === 6, `requests=${requests.length}`);
  console.log(JSON.stringify(a, null, 1));
  // 1b. English-first mode (default: "Show original lyrics" OFF)
  let L = await layout(page);
  const tr = L.filter((x) => x.hasTr), noTr = L.filter((x) => !x.hasTr);
  check('default: originals hidden (h4 font-size 0) only on translated lines', tr.length === 10 && tr.every((x) => x.h4Size === '0px'));
  check('default: English / untranslated lines keep the original, enlarged to 28px', noTr.length === 3 && noTr.every((x) => x.h4Size === '28px'));
  check('default: translation is the main line (28px, bold, Amazon font, inherits line color)', tr.every((x) => x.trSize === '28px' && x.trWeight === '700' && /EmberModernDisplayStd-Bold/.test(x.trFont) && x.trColor === x.h4Color), JSON.stringify(tr[0]));
  check('default: translation above romanization; romanization 18px, not italic', tr.every((x) => x.trAboveRom && x.romSize === '18px' && x.romStyle === 'normal'));
  check('default: React nodes/attributes/inline style untouched', await reactNodesIntact(page));
  await page.screenshot({ path: __dirname + '/screenshot-english-first.png' });
  await setSettings({ orig: true }); await page.waitForTimeout(400);
  L = await layout(page);
  check('orig ON restores v1.0.1 layout (original 28px, translation + romanization 18px below)', L.every((x) => x.h4Size === '28px') && L.filter((x) => x.hasTr).every((x) => x.trSize === '18px' && !x.trAboveRom && x.romSize === '18px'));
  await page.screenshot({ path: __dirname + '/screenshot-real-structure.png' });
  await page.screenshot({ path: __dirname + '/screenshot.png' });
  await setSettings({ orig: false }); await page.waitForTimeout(400);
  check('orig OFF again hides originals live', (await layout(page)).filter((x) => x.hasTr).every((x) => x.h4Size === '0px'));
  await setSettings({ trans: false }); await page.waitForTimeout(400);
  L = await layout(page);
  check('translation OFF brings originals back (romanization small below)', L.every((x) => x.h4Size === '28px') && L.filter((x) => x.romSize).every((x) => x.romSize === '18px'));
  await setSettings({ trans: true }); await page.waitForTimeout(400);
  check('translation ON again → English-first again', (await layout(page)).filter((x) => x.hasTr).every((x) => x.h4Size === '0px'));
  await page.screenshot({ path: __dirname + '/screenshot-size.png' });

  // 1c. Text size (popup select → --amlt-scale, live)
  const sizePop = await ctx.newPage();
  await sizePop.goto(`chrome-extension://${extId}/popup.html`);
  const sizeOpts = await sizePop.$$eval('#size option', (o) => o.map((x) => x.value));
  check('popup has Text size select (Small / Default / Large / Extra large), Default selected', JSON.stringify(sizeOpts) === '["0.85","1","1.2","1.45"]' && (await sizePop.inputValue('#size')) === '1');
  await sizePop.selectOption('#size', '1.2');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.amlt-trans')).fontSize === '33.6px', null, { timeout: 5000 }).catch(() => {});
  L = await layout(page);
  check('popup size Large → computed sizes update live on the page (28→33.6px, 18→21.6px)', (await sw.evaluate(() => chrome.storage.sync.get('size'))).size === 1.2
    && L.filter((x) => x.hasTr).every((x) => x.trSize === '33.6px' && x.romSize === '21.6px') && L.filter((x) => !x.hasTr).every((x) => x.h4Size === '33.6px'), JSON.stringify(L[0]));
  await sizePop.selectOption('#size', '1.45');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.amlt-trans')).fontSize === '40.6px', null, { timeout: 5000 }).catch(() => {});
  await sizePop.close();
  const boxes = async () => page.evaluate(() => [...document.querySelectorAll('div[style*="padding-top: 191px"] > div')].map((row) => {
    const r = row.getBoundingClientRect(), h = row.querySelector('h4').getBoundingClientRect(), b = row.querySelector('.amlt');
    return { top: r.top, bottom: r.bottom, h4Bottom: h.bottom, blockBottom: b ? b.getBoundingClientRect().bottom : h.bottom };
  }));
  const bx = await boxes();
  const overlap = bx.some((b, i) => (i && b.top < bx[i - 1].bottom - 0.5) || b.blockBottom > b.bottom + 0.5 || b.h4Bottom > b.bottom + 0.5);
  check('Extra large (40.6px / 26.1px): rows grow to fit, no row or annotation overlaps the next', !overlap && (await layout(page)).filter((x) => x.hasTr).every((x) => x.trSize === '40.6px' && x.romSize === '26.1px'), JSON.stringify(bx.slice(0, 2)));
  const nearEnd = bx.length - 2;
  // v1.3.5: the extension re-centers the white line (which cycles through the lines in this mock) unless the user just
  // scrolled the lyrics, so a user wheel comes first: this check is about rows being tall enough, not about who scrolls.
  const scBox = await page.locator('[data-testid="Stage_OverlaysContainer"] .r-150rngu').boundingBox();
  await page.mouse.move(scBox.x + scBox.width / 2, scBox.y + scBox.height / 2); await page.mouse.wheel(0, 40); await page.waitForTimeout(100);
  await page.evaluate((i) => window.scrollToLine(i), nearEnd); await page.waitForTimeout(200);
  const vis = await page.evaluate((i) => {
    const sc = document.querySelector('[data-testid="Stage_OverlaysContainer"] .r-150rngu').getBoundingClientRect();
    const r = document.querySelectorAll('div[style*="padding-top: 191px"] > div')[i].getBoundingClientRect();
    return { visible: r.top >= sc.top && r.bottom <= sc.bottom, scrolled: document.querySelector('[data-testid="Stage_OverlaysContainer"] .r-150rngu').scrollTop };
  }, nearEnd);
  check('Extra large: a line near the end, scrolled to by row heights, is fully visible', vis.visible && vis.scrolled > 0, JSON.stringify(vis));
  await page.screenshot({ path: __dirname + '/screenshot-size-xl.png' });
  await setSettings({ size: 1 });
  await page.evaluate(() => { document.querySelector('[data-testid="Stage_OverlaysContainer"] .r-150rngu').scrollTop = 0; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.amlt-trans')).fontSize === '28px', null, { timeout: 5000 }).catch(() => {});
  check('size back to Default → 28px again', (await layout(page)).filter((x) => x.hasTr).every((x) => x.trSize === '28px'));

  // 1d. Floating button → in-page panel with the popup
  const fb = page.locator('button.amlt-float');
  await fb.waitFor({ timeout: 5000 }).catch(() => {});
  const fbBox = await fb.boundingBox(), ctlBox = await page.locator('#topControls').boundingBox();
  const vp = page.viewportSize();
  const apart = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  check('floating button: small, top-right, fixed, not covering the top-right controls', fbBox && fbBox.width <= 36 && vp.width - (fbBox.x + fbBox.width) < 40 && fbBox.y < 130
    && (await fb.evaluate((e) => getComputedStyle(e).position)) === 'fixed' && apart(fbBox, ctlBox), JSON.stringify({ fbBox, ctlBox }));
  await fb.click();
  const frameEl = page.locator('iframe.amlt-panel');
  await frameEl.waitFor({ timeout: 5000 }).catch(() => {});
  const panelFrame = page.frameLocator('iframe.amlt-panel');
  await panelFrame.locator('#tl').waitFor({ timeout: 5000 }).catch(() => {});
  const inPanel = await panelFrame.locator('#song').evaluate((e) => new Promise((r) => { const t0 = Date.now(); (function w() { if (!/no song/.test(e.textContent) || Date.now() - t0 > 4000) r(e.textContent); else setTimeout(w, 200); })(); })).catch(() => '');
  check('click → panel with the popup opens; it finds this tab (This song shows the current song)', (await frameEl.count()) === 1 && /This song: .*Translated with Google/.test(inPanel) && !(await panelFrame.locator('#force').isDisabled()), inPanel);
  await page.screenshot({ path: __dirname + '/screenshot-float.png' });
  await page.mouse.click(700, 500);
  check('click outside closes the panel', (await frameEl.count()) === 0);
  await fb.click(); await panelFrame.locator('#tl').waitFor({ timeout: 5000 }).catch(() => {});
  await panelFrame.locator('#tl').press('Escape'); await page.waitForTimeout(300);
  const escInside = (await frameEl.count()) === 0;
  await fb.click(); await frameEl.waitFor({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  check('Esc closes the panel (inside the panel and on the page); clicking the button again toggles it', escInside && (await frameEl.count()) === 0);
  await fb.click(); await panelFrame.locator('#float').waitFor({ timeout: 5000 }).catch(() => {});
  const floatDefault = await panelFrame.locator('#float').isChecked();
  await panelFrame.locator('#float').click(); await page.waitForTimeout(500);
  check('"Show floating button" (default on) unchecked in the panel → button and panel removed', floatDefault && (await fb.count()) === 0 && (await frameEl.count()) === 0
    && (await sw.evaluate(() => chrome.storage.sync.get('float'))).float === false);
  await setSettings({ float: true });
  await fb.waitFor({ timeout: 5000 }).catch(() => {});
  check('turned back on → button returns', (await fb.count()) === 1);

  // 2. Live toggles
  await setSettings({ rom: false }); await page.waitForTimeout(400);
  a = await annotations(page);
  check('rom off hides romanization live, translation stays', a.filter((x) => x.rom).every((x) => !x.romVisible) && a.filter((x) => x.trans).every((x) => x.transVisible));
  await setSettings({ trans: false }); await page.waitForTimeout(400);
  a = await annotations(page);
  check('trans off hides translation live', a.filter((x) => x.trans).every((x) => !x.transVisible) && a.filter((x) => x.rom).every((x) => !x.romVisible));
  await setSettings({ rom: true, trans: true }); await page.waitForTimeout(400);
  a = await annotations(page);
  check('both back on shows lines again', a.filter((x) => x.rom || x.trans).every((x) => (!x.rom || x.romVisible) && (!x.trans || x.transVisible)));

  // 3. No observer loop: page clock + current-line highlight tick every 500 ms
  var before = await page.evaluate(() => window.amltInserts);
  await page.waitForTimeout(5000);
  var after = await page.evaluate(() => window.amltInserts);
  check('no observer loop (0 annotation inserts over 5 s idle with ticking page)', after === before, `inserts ${before}->${after}`);

  // 3b. React-style text resets on a single h4
  requests = [];
  before = await page.evaluate(() => window.amltInserts);
  await page.evaluate(() => window.resetText(0));                       // same text: wipes our child block
  await page.waitForFunction((L) => document.querySelectorAll(L)[0].querySelector('.amlt'), LINES);
  await page.waitForTimeout(1500);
  a = await annotations(page);
  after = await page.evaluate(() => window.amltInserts);
  check('React resets h4 textContent (same text) → block re-added once, no network, no loop', a[0].rom === 'Yoru no mado ni chīsana hoshi ga hikaru' && after - before === 1 && requests.length === 0, `inserts +${after - before}, requests=${requests.length}`);
  await page.evaluate(() => window.resetText(0, '青い傘を持って歩いた'));  // new text via textContent
  await page.waitForFunction((L) => document.querySelectorAll(L)[0].querySelector('.amlt'), LINES);
  await page.waitForTimeout(600);
  a = await annotations(page);
  check('React sets new textContent → annotation matches the new text', a[0].text === '青い傘を持って歩いた' && a[0].rom === 'aoi kasa o motte aruita' && a[0].trans === 'I walked with a blue umbrella');
  await page.evaluate(() => window.setNodeValue(0, 'Тихий снег ложится на крыши'));  // text node updated in place
  await page.waitForFunction((L) => /Tikhiy/.test(document.querySelectorAll(L)[0].querySelector('.amlt')?.textContent || ''), LINES, { timeout: 5000 }).catch(() => {});
  a = await annotations(page);
  const blocksInH4 = await page.evaluate((L) => document.querySelectorAll(L)[0].querySelectorAll('.amlt').length, LINES);
  check('text node changed in place → stale block replaced (exactly one block)', a[0].rom === 'Tikhiy sneg lozhitsya na kryshi' && blocksInH4 === 1, `rom=${a[0].rom} blocks=${blocksInH4}`);
  await page.evaluate(() => window.resetText(0, '夜の窓に小さな星が光る'));
  await page.waitForTimeout(800);

  // 4. Re-render of the same lines (virtual scroll) → re-annotated from memory, no network
  requests = [];
  await page.evaluate(() => window.setSong(1));                         // React remounts the whole list
  await waitAnnotated(page, 10); await page.waitForTimeout(600);
  check('whole list remounted → re-annotated from memory without network', (await page.locator('.amlt:not(:empty)').count()) === 10 && (await page.locator('.amlt').count()) === 13 && requests.length === 0, `requests=${requests.length}`);

  // 5. Song change
  requests = [];
  await page.evaluate(() => window.setSong(2));
  await waitAnnotated(page, 8); await page.waitForTimeout(800);
  a = await annotations(page);
  check('song change: new lines annotated', a.length === 8 && a.every((x) => x.rom && x.trans), `requests=${requests.length}`);
  console.log(JSON.stringify(a, null, 1));
  check('song change: nothing else annotated', (await nonLyricAnnotated(page)).length === 0);
  await page.screenshot({ path: __dirname + '/screenshot-song2.png' });

  // 6. Reload → cache hit, no network
  requests = [];
  await page.goto('https://music.amazon.com/?song=1');
  await waitAnnotated(page, 10); await page.waitForTimeout(800);
  check('reload same song: served from chrome.storage.local cache, 0 requests', requests.length === 0, `requests=${requests.length}`);
  const cache = await sw.evaluate(() => chrome.storage.local.get(null));
  check('cache keyed by title+artist (mediaSession)', Object.keys(cache).some((k) => k === 'song:ms:Paper Lantern (Test)|Mock Artist'), Object.keys(cache).join(', '));

  // 7. Change target language → retranslate
  requests = [];
  await setSettings({ tl: 'es' });
  await page.waitForFunction(() => [...document.querySelectorAll('.amlt-trans')].some((n) => /[ñáéíóú]|\b(el|la|los|las|de|en)\b/i.test(n.textContent)), null, { timeout: 60000 * 8 });
  await page.waitForTimeout(1500);
  a = await annotations(page);
  check('target change retranslates (es); English lines now translated', a.filter((x) => isLatin(x.text) && /\p{L}/u.test(x.text)).every((x) => x.trans) && requests.every((r) => r.tl === 'es') && requests.length > 0, `requests=${requests.length}`);
  check('romanization unchanged after target change', a.filter((x) => !isLatin(x.text)).every((x) => x.rom));
  console.log(JSON.stringify(a, null, 1));
  await page.screenshot({ path: __dirname + '/screenshot-es.png' });
  await setSettings({ tl: 'en' });
  await page.waitForTimeout(1500);

  // 8. Failure handling (simulated 429 on both endpoints)
  mode = 'fail'; requests = [];
  await page.evaluate(() => window.setSong(3));
  await page.waitForTimeout(4000);
  check('failure: no crash, no annotation, bounded requests (no hammering)', (await page.locator('.amlt').count()) === 0 && requests.length === 2, `requests=${requests.length} errors=${errors.length}`);
  mode = 'fixture';

  // 9b. Fallback selector (testid missing) and title-h4 song key (no mediaSession)
  requests = [];
  await page.goto('https://music.amazon.com/?song=2&notestid=1&nomedia=1');
  await waitAnnotated(page, 8); await page.waitForTimeout(800);
  check('fallback selector (no Stage_OverlaysContainer testid) finds lines, decoys untouched', (await page.locator('.amlt').count()) === 8 && (await nonLyricAnnotated(page)).length === 0, `requests=${requests.length}`);
  const cache2 = await sw.evaluate(() => chrome.storage.local.get(null));
  check('song key falls back to WidgetHeader title + next line', 'song:dom:River Moon (Test)|Another Mock' in cache2, Object.keys(cache2).join(', '));

  // 10. Popup screenshot
  await page.close();                                                    // so the popup's language change doesn't trigger page requests
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 320, height: 450 });
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForTimeout(500);
  check('popup reflects stored settings (orig default off)', (await pop.$eval('#tl', (e) => e.value)) === 'en' && (await pop.$eval('#rom', (e) => e.checked)) && !(await pop.$eval('#orig', (e) => e.checked)));
  await pop.click('#orig'); await pop.waitForTimeout(200);
  check('popup orig toggle writes storage', (await sw.evaluate(() => chrome.storage.sync.get('orig'))).orig === true);
  await pop.click('#orig'); await pop.waitForTimeout(200);
  await pop.selectOption('#tl', 'ja'); await pop.waitForTimeout(200);
  check('popup writes chrome.storage.sync', (await sw.evaluate(() => chrome.storage.sync.get('tl'))).tl === 'ja');
  await pop.selectOption('#tl', 'en');
  await pop.screenshot({ path: __dirname + '/popup.png' });

  check('no page errors', errors.length === 0, errors.join(' | '));
  check('LRCLIB never queried for songs Amazon has lyrics for', lrclibHits === 0, `hits=${lrclibHits}`);
  await ctx.close();
  fs.writeFileSync(__dirname + '/results.json', JSON.stringify(results, null, 1));
  console.log(`\n${results.filter((r) => r[0] === 'PASS').length}/${results.length} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
