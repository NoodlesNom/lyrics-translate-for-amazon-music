// Gemini translator + LRU cache tests. The Gemini endpoint is MOCKED via Playwright routing (no real Gemini calls);
// Google Translate is answered from fixtures.json (real responses recorded earlier). The key used here is a fake placeholder.
const { chromium } = require('playwright');
const fs = require('fs');
const EXT = require('path').resolve(__dirname, '..', 'extension');
const fixtures = JSON.parse(fs.readFileSync(__dirname + '/fixtures.json', 'utf8'));
const FAKE_KEY = 'placeholder-not-a-real-key-TEST';
const LINES = 'div[style*="padding-top: 191px"] > div > h4';
const NON_LATIN = /[^\P{L}\p{Script=Latin}]/u;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, info = '') => { results.push([cond ? 'PASS' : 'FAIL', name, info]); console.log(cond ? 'PASS' : 'FAIL', name, info); };

// Invented Latin-script songs (mock songs 5 and 6) get synthetic Google answers instead of fixtures.
const EN_LINES = ['We fold the paper planes at dawn', 'The kettle hums a sleepy tune', 'Our shadows lean against the door', 'Tomorrow waits beyond the hill'];
// v1.3.3 songs 15/16 (invented): English lines as Google receives them (look-alike letter already turned Latin), two Japanese lines.
const EN2 = ['We leave the porch light on for you', '\u201cHold on,\u201d the radio hums \u2014 so low', 'Paper cups and borrowed rain\uff01', 'Tomorrow keeps a seat for two \ud83c\udfb5',
  'The ferry lights are blinking slow', 'We trade our coats for summer air', 'I hum the chorus, half asleep', '\u2014 and the gulls reply \u266a',
  'Salt on the window, sun on the stairs', 'We\u2019ll be home before the tide', 'Paper boats in a row\u2026'];
const JA2 = { '\u300c港の灯りが揺れている\u300d': ['\u201cThe harbor lights are swaying\u201d', 'Minato no akari ga yurete iru'], '猫が屋根で眠る': ['The cat sleeps on the roof', 'Neko ga yane de nemuru'] };
const ES = { 'Las olas cantan en la arena': 'The waves sing on the sand', 'Mi barco duerme junto al muelle': 'My boat sleeps by the pier', 'La luna pinta el agua de plata': 'The moon paints the water silver' };
function synthetic(q) {
  const ls = q.split('\n|\n');
  if (ls.every((l) => EN_LINES.includes(l) || EN2.includes(l))) return [[[q, q, null, null]], null, 'en'];
  if (ls.every((l) => JA2[l])) return [[[ls.map((l) => JA2[l][0]).join('\n|\n'), q, null, null], [null, null, null, ls.map((l) => JA2[l][1]).join(' | ')]], null, 'ja'];
  if (ls.every((l) => l in ES)) return [[[ls.map((l) => ES[l]).join('\n|\n'), q, null, null]], null, 'es'];
  if (ls.every((l) => l in ES || EN_LINES.includes(l))) return [[[q, q, null, null]], null, 'en']; // mixed batch: detected as English
}
let gmode = 'ok', gfail = false, gReqs = [], tReqs = [];
async function onGemini(route) {
  const req = route.request();
  const body = JSON.parse(req.postData() || '{}');
  const lines = ((body.contents && body.contents[0].parts[0].text) || '').split('\n').map((s) => s.replace(/^\d+\.\s/, ''));
  gReqs.push({ url: req.url(), keyOk: req.headers()['x-goog-api-key'] === FAKE_KEY, body, lines });
  const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) }).catch(() => {});
  if (gmode === 'quota') return json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded (simulated)', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }] } });
  if (gmode === 'badkey') return json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } });
  if (gmode === 'hang') { await sleep(4000); return json(200, {}); }
  let out = lines.map((l, i) => (NON_LATIN.test(l) || l in ES ? `Gemini line ${i + 1}` : l)); // unchanged if already English
  if (gmode === 'mismatch') out = out.slice(1);
  json(200, { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(out) }] } }] });
}
async function onGoogle(route) {
  const req = route.request();
  const q = new URLSearchParams(req.postData() || '').get('q');
  const tl = new URL(req.url()).searchParams.get('tl');
  tReqs.push(q);
  if (gfail) return route.fulfill({ status: 429, body: '' });
  const hit = fixtures[tl + '::' + q] || (tl === 'en' && synthetic(q));
  if (!hit) console.log('  (no Google fixture for', JSON.stringify(q.slice(0, 40)), ')');
  route.fulfill(hit ? { contentType: 'application/json', body: JSON.stringify(hit) } : { status: 429, body: '' });
}

const annotations = (page) => page.evaluate((LINES) => [...document.querySelectorAll(LINES)].map((h4) => {
  const q = (s) => h4.querySelector(':scope > .amlt > ' + s);
  return { text: [...h4.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(''),
    rom: q('.amlt-rom') && q('.amlt-rom').textContent, trans: q('.amlt-trans') && q('.amlt-trans').textContent,
    h4Size: getComputedStyle(h4).fontSize };
}), LINES);
const waitCount = (page, n) => page.waitForFunction((n) => document.querySelectorAll('.amlt').length >= n, n, { timeout: 30000 });
const waitTrans = (page, text) => page.waitForFunction((t) => [...document.querySelectorAll('.amlt-trans')].some((n) => n.textContent === t), text, { timeout: 30000 });

(async () => {
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: { width: 1100, height: 1000 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route(/api\.github\.com/, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ tag_name: 'v' + JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8')).version, html_url: 'https://github.com/NoodlesNom/lyrics-translate-for-amazon-music/releases/latest' }) })); // v1.3.4 update check (unpacked): mocked, same version
  await ctx.route(/generativelanguage\.googleapis\.com/, onGemini);
  await ctx.route(/clients5\.google\.com|translate\.googleapis\.com/, onGoogle);
  let lrclibHits = 0; // songs here all have Amazon lyrics (badge shown), so LRCLIB must never be asked
  await ctx.route(/lrclib\.net/, (r) => { lrclibHits++; r.fulfill({ status: 404, body: '' }); });
  await ctx.route('https://music.amazon.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(__dirname + '/mock.html') }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const local = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys);
  const status = async () => (await local('geminiStatus')).geminiStatus || {};
  const clearCache = () => sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('song:') || k === 'idx'));
  });
  const clearStatus = () => sw.evaluate(() => chrome.storage.local.remove('geminiStatus'));
  const errors = [];
  let pop;
  // Indicator / counter read from the open popup (waits briefly for live updates).
  const ind = async (label, state) => {
    const ok = await pop.waitForFunction(([l, st]) => document.querySelector('#glabel').textContent.startsWith(l) && document.querySelector('#gstate').dataset.state === st, [label, state], { timeout: 5000 }).then(() => true, () => false);
    return [ok, `${await pop.getAttribute('#gstate', 'data-state')}: ${await pop.textContent('#glabel')}`];
  };
  const counter = async (text) => {
    const ok = await pop.waitForFunction((t) => document.querySelector('#counter').textContent.startsWith(t), text, { timeout: 5000 }).then(() => true, () => false);
    return [ok, await pop.textContent('#counter')];
  };

  // 1. Options page: save (masked), test key
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  check('options: key field is a password input', (await opt.getAttribute('#key', 'type')) === 'password');
  await opt.fill('#key', FAKE_KEY);
  await opt.click('#save'); await opt.waitForTimeout(300);
  const stored = await local('geminiKey');
  const translatorAfterSave = (await sw.evaluate(() => chrome.storage.sync.get('translator'))).translator;
  const savedText = await opt.textContent('#saved');
  check('options: key saved to chrome.storage.local (not sync), translator switched to Gemini', stored.geminiKey === FAKE_KEY && translatorAfterSave === 'gemini'
    && !('geminiKey' in (await sw.evaluate(() => chrome.storage.sync.get(null)))));
  check('options: saved key shown masked (last 4 only), input cleared', savedText === 'Saved key: ••••••••' + FAKE_KEY.slice(-4) && !savedText.includes(FAKE_KEY) && (await opt.inputValue('#key')) === '', savedText);
  pop = await ctx.newPage();
  await pop.setViewportSize({ width: 320, height: 450 });
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  check('indicator: key saved, Gemini not called yet → gray "Not used yet"', ...await ind('Not used yet', 'gray'));
  check('counter: empty cache → "Saved songs: 0 (Gemini 0 · Google 0)"', ...await counter('Saved songs: 0 (Gemini 0 · Google 0) · ~'));
  await opt.click('#test'); await opt.waitForFunction(() => document.querySelector('#result').textContent !== 'Testing…');
  const okText = await opt.textContent('#result');
  check('options: Test key → OK with model name (one tiny request)', /^OK \(gemini-/.test(okText) && gReqs.length === 1 && gReqs[0].lines.length === 1, okText);
  await opt.screenshot({ path: __dirname + '/options.png' });
  check('indicator (live): successful request → green "Gemini working · last reply just now"', ...await ind('Gemini working · last reply just now', 'green'));
  gmode = 'badkey';
  await opt.click('#test'); await opt.waitForFunction(() => document.querySelector('#result').textContent !== 'Testing…');
  check('options: Test key with a rejected key → error message', (await opt.textContent('#result')) === 'Error: The key was rejected.');
  check('indicator (live): auth failure → red "Invalid key"', ...await ind('Invalid key', 'red'));
  gmode = 'ok';
  await opt.click('#test'); await opt.waitForFunction(() => /OK|Error/.test(document.querySelector('#result').textContent));
  check('options: successful test clears the invalid-key status', (await status()).code === 'ok');
  await opt.close();

  // 2. Gemini happy path
  gReqs = []; tReqs = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('https://music.amazon.com/?song=1');
  await waitCount(page, 10); await page.waitForTimeout(1200);
  let a = await annotations(page);
  const g = gReqs[0] || { body: {}, lines: [] };
  const gc = g.body.generationConfig || {};
  check('Gemini: exactly one request for the whole song (12 lyric lines, numbered)', gReqs.length === 1 && g.lines.length === 12, `requests=${gReqs.length} lines=${g.lines.length}`);
  check('Gemini: key sent in x-goog-api-key header, not in URL; model constant in URL', g.keyOk && !/[?&]key=/.test(g.url) && /models\/gemini-[\w.-]+:generateContent$/.test(g.url), g.url);
  check('Gemini: JSON schema (array of strings, fixed length), low temperature, system instruction', gc.responseMimeType === 'application/json' && gc.responseSchema.type === 'ARRAY'
    && gc.responseSchema.items.type === 'STRING' && gc.responseSchema.minItems === 12 && gc.temperature <= 0.3 && /song lyrics into English/.test(g.body.systemInstruction.parts[0].text));
  const nl = a.filter((x) => NON_LATIN.test(x.text));
  check('Gemini: results mapped to the right lines', nl.length === 10 && nl.every((x) => x.trans === `Gemini line ${g.lines.indexOf(x.text) + 1}`), JSON.stringify(nl.slice(0, 2)));
  check('Gemini: English lines unchanged → no translation shown', a.filter((x) => /\p{L}/u.test(x.text) && !NON_LATIN.test(x.text)).every((x) => !x.trans));
  check('romanization still from Google (5 script groups, no Latin group)', nl.every((x) => x.rom) && tReqs.length === 5 && !tReqs.some((q) => /city lights/.test(q)), `google=${tReqs.length}`);
  check('English-first layout works with Gemini (original hidden only on translated lines)', nl.every((x) => x.h4Size === '0px') && a.filter((x) => !NON_LATIN.test(x.text)).every((x) => x.h4Size === '28px'));
  await page.screenshot({ path: __dirname + '/screenshot-gemini.png' });
  check('counter: 1 song added (Gemini-complete; Google only has the non-Latin lines)', ...await counter('Saved songs: 1 (Gemini 1 · Google 0) · ~'));

  // 3. Progressive rendering → still one request per song
  gReqs = [];
  await page.evaluate(() => window.setSongChunked(2));
  await waitCount(page, 8); await page.waitForTimeout(1200);
  check('chunked line list (3 + 5 lines over ~750 ms) → one Gemini request with all 8 lines', gReqs.length === 1 && gReqs[0].lines.length === 8, `requests=${gReqs.length} lines=${gReqs.map((r) => r.lines.length)}`);
  check('counter: 2 songs (song 2 is all non-Latin, so Google also has every line)', ...await counter('Saved songs: 2 (Gemini 2 · Google 1) · ~'));
  const atBefore = (await status()).at;

  // 4. Cache per translator
  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=1');
  await waitCount(page, 10); await page.waitForTimeout(800);
  check('reload: Gemini translations served from cache (0 requests)', gReqs.length === 0 && tReqs.length === 0);
  check('served from cache: last real Gemini outcome kept unchanged', (await status()).at === atBefore && (await ind('Gemini working', 'green'))[0]);
  await sw.evaluate(() => chrome.storage.sync.set({ translator: 'google' }));
  await waitTrans(page, 'A small star shines in the window at night'); await page.waitForTimeout(800);
  a = await annotations(page);
  check('switch to Google: Google translations shown, not the Gemini cache; 0 Gemini requests', a.some((x) => x.trans === 'Quiet snow falls on the roofs') && !a.some((x) => /^Gemini line/.test(x.trans || '')) && gReqs.length === 0, `google requests=${tReqs.length}`);
  check('indicator (live): Google selected → gray "Off (Google selected)"', ...await ind('Off (Google selected)', 'gray'));
  check('counter (live): song 1 now also complete for Google', ...await counter('Saved songs: 2 (Gemini 2 · Google 2) · ~'));
  gReqs = []; tReqs = [];
  await sw.evaluate(() => chrome.storage.sync.set({ translator: 'gemini' }));
  await page.waitForFunction(() => [...document.querySelectorAll('.amlt-trans')].some((n) => /^Gemini line/.test(n.textContent)), null, { timeout: 10000 });
  check('switch back to Gemini: Gemini cache used again, 0 requests', gReqs.length === 0 && tReqs.length === 0);
  check('indicator back to green after switching to Gemini', ...await ind('Gemini working', 'green'));
  await pop.screenshot({ path: __dirname + '/popup-status.png' });
  await sw.evaluate(() => chrome.storage.local.get('geminiStatus').then(({ geminiStatus: s }) => chrome.storage.local.set({ geminiStatus: { ...s, at: s.at - 125000 } })));
  check('indicator shows how long ago: "last reply 2 min ago"', ...await ind('Gemini working · last reply 2 min ago', 'green'));

  // 4b. Source language vs. target: Latin-only songs are language-checked with Google first
  const atKeep = (await status()).at;
  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=5');
  await page.waitForFunction(() => document.querySelectorAll('.amlt').length >= 4, null, { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500);
  check('(a) all-English song, target en: 0 Gemini requests (Google detected "en")', gReqs.length === 0 && tReqs.length === 1, `gemini=${gReqs.length} google=${tReqs.length}`);
  check('(a) status timestamp unchanged, indicator keeps last real outcome', (await status()).at === atKeep && (await ind('Gemini working · last reply 2 min ago', 'green'))[0]);
  a = await annotations(page);
  check('(a) English lines stay as the main line, no translation shown', a.length === 4 && a.every((x) => !x.trans && x.h4Size === '28px'));
  check('(a) counter: English song counts as saved for Google, not Gemini', ...await counter('Saved songs: 3 (Gemini 2 · Google 3) · ~'));
  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=5'); await page.waitForTimeout(1500);
  check('(a) replay: 0 Gemini and 0 Google requests', gReqs.length === 0 && tReqs.length === 0, `gemini=${gReqs.length} google=${tReqs.length}`);
  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=6');
  await waitTrans(page, 'Gemini line 1'); await page.waitForTimeout(800);
  check('(b) all-Spanish song, target en: exactly one Gemini request (after one Google detection request)', gReqs.length === 1 && gReqs[0].lines.length === 3 && tReqs.length === 1, `gemini=${gReqs.length} google=${tReqs.length}`);
  a = await annotations(page);
  check('(b) Gemini translation shown for the Spanish lines', a.every((x, i) => x.trans === `Gemini line ${i + 1}`), JSON.stringify(a.map((x) => x.trans)));
  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=7');
  await waitTrans(page, 'Gemini line 1'); await page.waitForTimeout(800);
  check('(c) Japanese song with English lines: exactly one Gemini request for the whole song, no Latin detection request', gReqs.length === 1 && gReqs[0].lines.length === 4 && !tReqs.some((q) => /city lights/.test(q)), `gemini=${gReqs.length} google=${tReqs.length}`);
  gReqs = []; tReqs = []; gfail = true;
  await page.goto('https://music.amazon.com/?song=6&title=Mar%20Azul%202');
  await waitTrans(page, 'Gemini line 1'); await page.waitForTimeout(500);
  gfail = false;
  check('(d) Google detection fails on a Latin-only song → Gemini still tried and shown', gReqs.length === 1 && tReqs.length >= 1, `gemini=${gReqs.length} google=${tReqs.length}`);

  // 4b2. v1.3.3: English songs as lyrics sites have them (invented lines) must not go to Gemini as a whole.
  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=15');
  await page.waitForFunction(() => document.querySelectorAll('.amlt').length >= 5, null, { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500);
  a = await annotations(page);
  check('(e) English song with a Cyrillic look-alike letter (U+0435) and symbols (curly quotes, em dash, fullwidth !, emoji, ♪): 0 Gemini requests, 1 Google detection request (4 lines, look-alike sent as Latin)',
    gReqs.length === 0 && tReqs.length === 1 && !tReqs[0].includes('\u0435') && tReqs[0].split('\n|\n').length === 4, `gemini=${gReqs.length} google=${tReqs.length}`);
  check('(e) no translation and no romanization under any line', a.length === 5 && a.every((x) => !x.trans && !x.rom), JSON.stringify(a.map((x) => [x.trans, x.rom])));
  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=16');
  await waitTrans(page, 'Gemini line 2'); await page.waitForTimeout(800);
  a = await annotations(page);
  const S16 = a.map((x) => x.text);
  const ja16 = a.filter((x) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(x.text));
  check('(f) mostly English song (7 English + 2 Japanese lines): no whole-song Gemini request, ONE Gemini request with only the 2 Japanese lines',
    gReqs.length === 1 && ja16.length === 2 && JSON.stringify(gReqs[0].lines) === JSON.stringify(ja16.map((x) => x.text)), `gemini=${gReqs.map((r) => r.lines.length)}`);
  check('(f) Google: 1 detection request for the 7 English lines, 1 romanization request for the 2 Japanese lines', tReqs.length === 2 && tReqs[0].split('\n|\n').length === 7 && tReqs[1].split('\n|\n').length === 2, `google=${tReqs.map((q) => q.split('\n|\n').length)}`);
  check('(f) Japanese lines: Gemini translation + romanization; English lines: nothing added', ja16.every((x, i) => x.trans === `Gemini line ${i + 1}` && x.rom === JA2[x.text][1])
    && a.filter((x) => !ja16.includes(x)).every((x) => !x.trans && !x.rom), JSON.stringify(a.map((x) => [x.trans, x.rom])));
  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=16');
  await waitTrans(page, 'Gemini line 2'); await page.waitForTimeout(800);
  check('(f) replay: everything from the cache, 0 Gemini and 0 Google requests', gReqs.length === 0 && tReqs.length === 0, `gemini=${gReqs.length} google=${tReqs.length}`);
  // (g) A song cached by <= 1.3.2 as Gemini-translated (English lines "rewritten" by Gemini): the check now runs once, the
  //     contradicting Gemini output for the English lines is dropped, the Japanese lines keep theirs; other songs untouched.
  const staleKey = 'song:ms:Lantern Bay Stale (Test)|English Mock', otherKey = 'song:ms:Paper Lantern (Test)|Mock Artist';
  const otherBefore = JSON.stringify((await local(otherKey))[otherKey]);
  await sw.evaluate(async ([k, lines]) => {
    const e = { lines: {}, ts: Date.now() - 864e5 };
    lines.forEach((l, i) => { e.lines[l] = /[\u3040-\u30ff\u4e00-\u9fff]/.test(l) ? { sl: 'ja', r: 'Stale romaji ' + (i + 1), t: { en: 'Stale Google ' + (i + 1) }, g: { en: 'Stale Gemini line ' + (i + 1) } } : { t: {}, g: { en: 'Stale Gemini rewrite ' + (i + 1) } }; });
    const { idx = {} } = await chrome.storage.local.get('idx');
    idx[k.slice(5)] = e.ts;
    await chrome.storage.local.set({ [k]: e, idx });
  }, [staleKey, S16]);
  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=16&title=Lantern%20Bay%20Stale%20(Test)');
  await waitTrans(page, 'Stale Gemini line 3'); await page.waitForTimeout(1000);
  a = await annotations(page);
  const staleAfter = (await local(staleKey))[staleKey];
  check('(g) stale ≤1.3.2 Gemini cache of a mostly English song: 0 Gemini requests, 1 Google detection request, stale rewrites of English lines not shown',
    gReqs.length === 0 && tReqs.length === 1 && a.every((x) => !/Stale Gemini rewrite/.test(x.trans || '')) && a.filter((x) => !/[\u3040-\u30ff\u4e00-\u9fff]/.test(x.text)).every((x) => !x.trans), `gemini=${gReqs.length} google=${tReqs.length} ${JSON.stringify(a.map((x) => x.trans))}`);
  check('(g) the Japanese lines keep their cached Gemini translations; entry marked checked + mostly, English lines lost only their Gemini text',
    JSON.stringify(a.filter((x) => x.trans).map((x) => x.trans)) === '["Stale Gemini line 3","Stale Gemini line 6"]' && staleAfter.chk.en === 1 && staleAfter.mostly.en === 1
    && S16.filter((l) => !/[\u3040-\u30ff\u4e00-\u9fff]/.test(l)).every((l) => !('en' in staleAfter.lines[l].g) && staleAfter.lines[l].t.en === ''), JSON.stringify(a.map((x) => x.trans)));
  check('(g) other songs\' cache entries are left alone', JSON.stringify((await local(otherKey))[otherKey]) === otherBefore);

  // 4c. Popup "Translate this song" button. Playwright's popup is a normal tab, so the popup's idea of the
  //     active tab is pointed at the mock Amazon tab (tabs.query stub); the messaging itself is real.
  const tabId = await sw.evaluate(async () => {
    for (const t of await chrome.tabs.query({})) if (((await chrome.tabs.sendMessage(t.id, { type: 'song' }).catch(() => null)) || {}).key) return t.id;
  });
  const pointPopupAt = (id) => pop.evaluate(async (id) => { chrome.tabs.getCurrent = async () => undefined; chrome.tabs.query = async () => [{ id }]; await findSong(); }, id);
  const clickTranslate = async () => {
    await pop.click('#force');
    await pop.waitForFunction(() => !['', 'Translating…'].includes(document.querySelector('#forceMsg').textContent), null, { timeout: 30000 });
    return pop.textContent('#forceMsg');
  };
  const transOf = async () => (await annotations(page)).map((x) => x.trans || '');
  const songLine = async (text) => {
    const ok = await pop.waitForFunction((t) => document.querySelector('#song').textContent === 'This song: ' + t, text, { timeout: 8000 }).then(() => true, () => false);
    return [ok, await pop.textContent('#song')];
  };
  await page.goto('https://music.amazon.com/?song=0&mini=0'); await page.waitForTimeout(800);
  await pointPopupAt(tabId);
  const offNoLyrics = await pop.isDisabled('#force');
  await pointPopupAt(999999);
  await pointPopupAt(tabId);
  check('"This song": nothing playing (no mini-player, no lyrics) → "nothing playing in Amazon Music."', ...await songLine('nothing playing in Amazon Music.'));
  await pointPopupAt(999999);
  check('(d) no current song (Amazon tab without lyrics, or no Amazon tab) → button disabled', tabId && offNoLyrics && (await pop.isDisabled('#force')) && (await pop.textContent('#force')) === 'Translate this song');

  await page.goto('https://music.amazon.com/?song=5'); await page.waitForTimeout(1200);
  await pointPopupAt(tabId);
  check('"This song": English song, target en → "<title> by <artist> · English · Already in English, no translation needed"', ...await songLine('Paper Planes (Test) by English Mock · English · Already in English, no translation needed'));
  await page.goto('https://music.amazon.com/?song=7'); await page.waitForTimeout(1200);
  check('"This song": Japanese song (with English lines) translated by Gemini, replayed → Japanese + English, Gemini, from cache', ...await songLine('Mixed Lantern (Test) by Mock Artist · Japanese + English · Translated with Gemini (from cache)'));
  await pop.screenshot({ path: __dirname + '/popup-song.png' });
  await page.goto('https://music.amazon.com/?song=15'); await page.waitForTimeout(1200);
  check('"This song": English song with a look-alike letter and symbols → "English · Already in English, no translation needed"', ...await songLine('Kettle Glow (Test) by English Mock · English · Already in English, no translation needed'));
  const songRe = async (re) => {
    const ok = await pop.waitForFunction((src) => new RegExp(src).test(document.querySelector('#song').textContent), re.source, { timeout: 8000 }).then(() => true, () => false);
    return [ok, await pop.textContent('#song')];
  };
  await page.goto('https://music.amazon.com/?song=16'); await page.waitForTimeout(1200);
  check('"This song": mostly English song → "English + Japanese · Mostly English · translated 2 lines with Gemini"', ...await songRe(/^This song: Lantern Bay \(Test\) by English Mock · English \+ Japanese · Mostly English · translated 2 lines with Gemini( \(from cache\))?$/));
  await page.goto('https://music.amazon.com/?song=16&title=Lantern%20Bay%20Stale%20(Test)'); await page.waitForTimeout(1200);
  check('"This song": formerly Gemini-cached song → truthful "Mostly English · translated 2 lines with Gemini"', ...await songRe(/^This song: Lantern Bay Stale \(Test\) by English Mock · English \+ Japanese · Mostly English · translated 2 lines with Gemini( \(from cache\))?$/));
  await page.goto('https://music.amazon.com/?song=16'); await page.waitForTimeout(1200);
  await pointPopupAt(tabId);
  gReqs = []; tReqs = [];
  const msgM = await clickTranslate();
  check('(f) "Translate this song" on the mostly English song still sends the whole song to Gemini (the user asked)', gReqs.length === 1 && gReqs[0].lines.length === 9 && msgM === 'Done: translated with Gemini.', `${msgM} gemini=${gReqs.map((r) => r.lines.length)}`);

  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=8'); await page.waitForTimeout(1800);
  const skipped = gReqs.length === 0 && tReqs.length === 1 && (await transOf()).every((t) => !t);
  await pointPopupAt(tabId);
  const enabled = !(await pop.isDisabled('#force'));
  const atForce = (await status()).at;
  gReqs = []; tReqs = [];
  const msgA = await clickTranslate();
  await page.waitForFunction(() => [...document.querySelectorAll('.amlt-trans')].some((n) => n.textContent === 'Gemini line 2'), null, { timeout: 10000 }).catch(() => {});
  let tr = await transOf();
  check('(a) mixed English/Spanish song detected as English was skipped; button enabled for the current song', skipped && enabled);
  check('(a) click → exactly one Gemini request, Spanish lines now translated, English lines unchanged', gReqs.length === 1 && gReqs[0].lines.length === 4
    && JSON.stringify(tr) === JSON.stringify(['', 'Gemini line 2', '', 'Gemini line 4']) && msgA === 'Done: translated with Gemini.', `${msgA} ${JSON.stringify(tr)} gemini=${gReqs.length}`);
  check('(a) status dot updates as usual (new Gemini reply)', (await status()).at > atForce && (await ind('Gemini working · last reply just now', 'green'))[0]);
  await pop.screenshot({ path: __dirname + '/popup-force.png' });
  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=8');
  await waitTrans(page, 'Gemini line 2'); await page.waitForTimeout(800);
  check('(a) replay: served from the Gemini cache, no language check, 0 requests', gReqs.length === 0 && tReqs.length === 0
    && JSON.stringify(await transOf()) === JSON.stringify(['', 'Gemini line 2', '', 'Gemini line 4']), `gemini=${gReqs.length} google=${tReqs.length}`);

  gmode = 'mismatch'; gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=6');
  await waitTrans(page, 'Gemini line 1'); await pointPopupAt(tabId);
  const msgC = await clickTranslate();
  await waitTrans(page, 'The waves sing on the sand').catch(() => {});
  tr = await transOf();
  check('(c) mismatch on a forced song → Google fallback shown, with a note', gReqs.length === 1 && (await status()).code === 'mismatch'
    && JSON.stringify(tr) === JSON.stringify(Object.values(ES)) && msgC === 'Gemini unexpected reply, so translated with Google.', `${msgC} ${JSON.stringify(tr)}`);
  check('"This song": after the Google fallback → "Spanish · Translated with Google"', ...await songLine('Mar Azul (Test) by Mock Español · Spanish · Translated with Google'));
  gmode = 'ok';

  await sw.evaluate(() => chrome.storage.local.remove('geminiKey'));
  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=8&title=Mixed%20Tide%202'); await page.waitForTimeout(1500);
  const before = await transOf();
  await pointPopupAt(tabId);
  tReqs = [];
  const msgB = await clickTranslate();
  await waitTrans(page, 'My boat sleeps by the pier').catch(() => {});
  tr = await transOf();
  check('(b) no key: button works through Google, each Latin line re-detected on its own, no Gemini request', before.every((t) => !t) && gReqs.length === 0 && tReqs.length === 4
    && JSON.stringify(tr) === JSON.stringify(['', 'The waves sing on the sand', '', 'My boat sleeps by the pier']) && msgB === 'Done: translated with Google.', `${msgB} ${JSON.stringify(tr)} google=${tReqs.length}`);
  gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=8&title=Mixed%20Tide%202');
  await waitTrans(page, 'My boat sleeps by the pier'); await page.waitForTimeout(500);
  check('(b) replay of the forced Google song: cached per-line translations, 0 requests', gReqs.length === 0 && tReqs.length === 0);
  await sw.evaluate((k) => chrome.storage.local.set({ geminiKey: k }), FAKE_KEY);

  // 4d. Display-only settings must not re-translate: 3 size changes through the popup → 0 messages, 0 requests
  await page.goto('https://music.amazon.com/?song=1'); await waitCount(page, 10); await page.waitForTimeout(1500);
  await sw.evaluate(() => { self.__lyricsMsgs = 0; if (!self.__counting) { self.__counting = 1; chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'lyrics') self.__lyricsMsgs++; }); } });
  gReqs = []; tReqs = [];
  const sizes = [];
  for (const [v, px] of [['1.2', '33.6px'], ['1.45', '40.6px'], ['1', '28px']]) {
    await pop.selectOption('#size', v);
    await page.waitForFunction((px) => getComputedStyle(document.querySelector('.amlt-trans')).fontSize === px, px, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(700);
    sizes.push(await page.evaluate(() => getComputedStyle(document.querySelector('.amlt-trans')).fontSize));
  }
  const lyricsMsgs = await sw.evaluate(() => self.__lyricsMsgs);
  check('3 size changes via popup: font size changes live, 0 lyrics messages, 0 Gemini, 0 Google requests', JSON.stringify(sizes) === '["33.6px","40.6px","28px"]'
    && lyricsMsgs === 0 && gReqs.length === 0 && tReqs.length === 0, `sizes=${sizes} lyricsMsgs=${lyricsMsgs} gemini=${gReqs.length} google=${tReqs.length}`);
  await page.goto('https://music.amazon.com/?song=2&title=Counter%20Check'); await waitCount(page, 8);
  check('(control) the message counter does see lyrics messages for a new song', (await sw.evaluate(() => self.__lyricsMsgs)) >= 1);
  const entry = (await local('song:ms:Paper Lantern (Test)|Mock Artist'))['song:ms:Paper Lantern (Test)|Mock Artist'];
  const first = entry.lines['夜の窓に小さな星が光る'];
  check('cache stores Gemini (g) and Google (t) translations separately per language', first.g.en === 'Gemini line 1' && first.t.en === 'A small star shines in the window at night', JSON.stringify(first));

  // 5. Length mismatch → Google for that song
  await clearCache(); gmode = 'mismatch'; gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=3');
  await waitTrans(page, 'Birds sing on a snowy morning'); await page.waitForTimeout(800);
  check('length mismatch → Google translation for that song', gReqs.length === 1 && (await status()).code === 'mismatch');
  gReqs = [];
  await page.goto('https://music.amazon.com/?song=3');
  await waitCount(page, 3); await page.waitForTimeout(800);
  check('mismatched song stays on Google (no new Gemini request on reload)', gReqs.length === 0);
  check('indicator: song fell back → amber "Using Google (unexpected reply)"', ...await ind('Using Google (unexpected reply)', 'amber'));

  // 6. 429 quota → Google + backoff + popup status
  await clearCache(); gmode = 'quota'; gReqs = []; tReqs = [];
  await page.goto('https://music.amazon.com/?song=2');
  await waitTrans(page, 'Moonlight falls on the quiet river'); await page.waitForTimeout(800);
  let st = await status();
  check('429 → silent Google fallback, status "quota", back-off ≥ 60 s', gReqs.length === 1 && st.code === 'quota' && st.until - Date.now() > 50000);
  check('indicator: 429 → amber "Using Google (quota hit)"', ...await ind('Using Google (quota hit)', 'amber'));
  await clearCache(); gReqs = [];
  await page.goto('https://music.amazon.com/?song=2');
  await waitCount(page, 8); await page.waitForTimeout(800);
  check('during back-off Gemini is not retried (0 requests), Google used', gReqs.length === 0);

  // 7. Invalid key
  await clearStatus(); await clearCache(); gmode = 'badkey'; gReqs = [];
  await page.goto('https://music.amazon.com/?song=2');
  await waitTrans(page, 'Moonlight falls on the quiet river'); await page.waitForTimeout(800);
  check('invalid key → Google fallback, status "badkey"', gReqs.length === 1 && (await status()).code === 'badkey');
  check('indicator: invalid key → red "Invalid key"', ...await ind('Invalid key', 'red'));

  // 8. Timeout (shortened to 1.5 s for the test)
  await clearStatus(); await clearCache(); gmode = 'hang'; gReqs = [];
  await sw.evaluate(() => { LIMITS.timeoutMs = 1500; });
  const t0 = Date.now();
  await page.goto('https://music.amazon.com/?song=2');
  await waitTrans(page, 'Moonlight falls on the quiet river');
  check('Gemini timeout → Google fallback, status "timeout"', (await status()).code === 'timeout' && Date.now() - t0 < 10000, `${Date.now() - t0} ms`);
  check('indicator: timeout → amber "Using Google (timed out)"', ...await ind('Using Google (timed out)', 'amber'));
  await sw.evaluate(() => { LIMITS.timeoutMs = 20000; });

  // 9. LRU eviction by last play (cap 3 for the test)
  await clearStatus(); await clearCache(); gmode = 'ok';
  await sw.evaluate(() => { LIMITS.songs = 3; });
  const visit = async (t) => { await page.goto(`https://music.amazon.com/?song=1&title=${t}`); await waitCount(page, 10); await page.waitForTimeout(300); };
  const counts = [];
  for (const t of ['A', 'B', 'C', 'A', 'D']) { await visit(t); counts.push((await counter(`Saved songs: ${Math.min(3, counts.length + 1)} (`))[1]); }
  check('counter: A,B,C added → 1,2,3; A replayed → 3; D added with B evicted → 3', JSON.stringify(counts.map((c) => c.split(' · ~')[0])) === JSON.stringify([1, 2, 3, 3, 3].map((n) => `Saved songs: ${n} (Gemini ${n} · Google 0)`)), counts.join(' | '));
  let idx = (await local('idx')).idx || {};
  let songs = Object.keys(await local(null)).filter((k) => k.startsWith('song:')).sort();
  check('LRU: A,B,C played, A replayed, D added → B (least recently played) evicted', JSON.stringify(Object.keys(idx).sort()) === JSON.stringify(['ms:A|Mock Artist', 'ms:C|Mock Artist', 'ms:D|Mock Artist'])
    && JSON.stringify(songs) === JSON.stringify(['song:ms:A|Mock Artist', 'song:ms:C|Mock Artist', 'song:ms:D|Mock Artist']), songs.join(', '));

  // 10. Storage quota error on write → evict more and retry once
  await sw.evaluate(() => {
    const orig = chrome.storage.local.set.bind(chrome.storage.local);
    self.__quotaThrown = 0;
    chrome.storage.local.set = (items) => {
      if (Object.keys(items).some((k) => k.startsWith('song:')) && !self.__quotaThrown) { self.__quotaThrown++; return Promise.reject(new Error('QUOTA_BYTES quota exceeded')); }
      return orig(items);
    };
  });
  await visit('E');
  idx = (await local('idx')).idx || {};
  songs = Object.keys(await local(null)).filter((k) => k.startsWith('song:')).sort();
  const thrown = await sw.evaluate(() => self.__quotaThrown);
  check('quota error: oldest songs evicted, write retried once, new song cached and shown', thrown === 1 && JSON.stringify(songs) === JSON.stringify(['song:ms:D|Mock Artist', 'song:ms:E|Mock Artist'])
    && Object.keys(idx).length === 2 && (await page.locator('.amlt:not(:empty)').count()) === 10, songs.join(', '));
  check('counter after quota eviction → 2 songs', ...await counter('Saved songs: 2 (Gemini 2 · Google 0) · ~'));
  check('counter shows approximate storage used', /· ~\d+(\.\d)? (KB|MB)$/.test(await pop.textContent('#counter')), await pop.textContent('#counter'));
  await sw.evaluate(() => { LIMITS.songs = 2000; });

  // 11. Popup: translator dropdown, defaults, settings link
  await clearStatus();
  await pop.reload(); await pop.waitForTimeout(400);
  const opts = await pop.$$eval('#translator option', (o) => o.map((x) => x.value + '=' + x.textContent));
  check('popup has Translator dropdown: Gemini (needs key) / Google Translate', JSON.stringify(opts) === JSON.stringify(['gemini=Gemini (needs key)', 'google=Google Translate']) && (await pop.inputValue('#translator')) === 'gemini');
  await pop.screenshot({ path: __dirname + '/popup.png' });
  await sw.evaluate(() => chrome.storage.sync.remove('translator'));
  await pop.reload(); await pop.waitForTimeout(300);
  const withKey = await pop.inputValue('#translator');
  await sw.evaluate(() => chrome.storage.local.remove('geminiKey'));
  await pop.reload(); await pop.waitForTimeout(300);
  check('popup default: Gemini when a key is saved, else Google', withKey === 'gemini' && (await pop.inputValue('#translator')) === 'google');
  await sw.evaluate(() => chrome.storage.sync.set({ translator: 'gemini' }));
  check('indicator: Gemini selected but no key → gray "No key"', ...await ind('No key', 'gray'));
  const [optPage] = await Promise.all([ctx.waitForEvent('page'), pop.click('#settings')]);
  await optPage.waitForLoadState();
  check('popup "Settings" link opens the options page', optPage.url().endsWith('/options.html'));

  check('no page errors', errors.length === 0, errors.join(' | '));
  check('LRCLIB never queried for songs Amazon has lyrics for', lrclibHits === 0, `hits=${lrclibHits}`);
  const logText = fs.existsSync(__dirname + '/run-gemini.log') ? fs.readFileSync(__dirname + '/run-gemini.log', 'utf8') : '';
  check('fake key never appears in the log output', !logText.includes(FAKE_KEY));
  await ctx.close();
  fs.writeFileSync(__dirname + '/results-gemini.json', JSON.stringify(results, null, 1));
  console.log(`\n${results.filter((r) => r[0] === 'PASS').length}/${results.length} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
