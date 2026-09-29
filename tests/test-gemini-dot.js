// v1.3.6: Gemini status dot on the in-page floating button. Same states/colors as the popup's indicator, only while Gemini is
// the selected translator, tooltip names the state, updates live. Gemini/Google/LRCLIB are MOCKED; placeholder key only.
const { chromium } = require('playwright');
const fs = require('fs');
const EXT = require('path').resolve(__dirname, '..', 'extension');
const results = [];
const check = (name, cond, info = '') => { results.push([cond ? 'PASS' : 'FAIL', name, info]); console.log(cond ? 'PASS' : 'FAIL', name, info); };
const FAKE_KEY = 'placeholder-not-a-real-key-TEST';
const COLORS = { green: 'rgb(61, 220, 132)', amber: 'rgb(255, 179, 0)', red: 'rgb(255, 82, 82)', gray: 'rgb(138, 143, 145)' };

(async () => {
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const ver = JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8')).version;
  await ctx.route(/api\.github\.com/, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ tag_name: 'v' + ver, html_url: 'https://github.com/NoodlesNom/lyrics-translate-for-amazon-music/releases/latest' }) }));
  let gemMode = 'ok';
  await ctx.route(/generativelanguage\.googleapis\.com/, (r) => {
    if (gemMode === 'quota') return r.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }) });
    const body = JSON.parse(r.request().postData() || '{}');
    const lines = ((body.contents && body.contents[0].parts[0].text) || '').split('\n');
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(lines.map((l, i) => 'Gemini line ' + (i + 1))) }] } }] }) });
  });
  await ctx.route(/clients5\.google\.com|translate\.googleapis\.com/, (r) => { const q = new URLSearchParams(r.request().postData() || '').get('q'); r.fulfill({ contentType: 'application/json', body: JSON.stringify([[[q, q, null, null]], null, 'ja']) }); });
  await ctx.route(/lrclib\.net/, (r) => r.fulfill({ status: 404, body: '' }));
  await ctx.route('https://music.amazon.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(__dirname + '/mock.html') }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const dot = () => page.evaluate(() => {
    const b = document.querySelector('button.amlt-float'), d = b && b.querySelector('.amlt-gdot');
    if (!d) return { present: false, title: b && b.title };
    const r = d.getBoundingClientRect(), br = b.getBoundingClientRect(), cs = getComputedStyle(d);
    return { present: true, state: d.dataset.state, color: cs.backgroundColor, ring: cs.borderTopWidth + ' ' + cs.borderTopColor, w: Math.round(r.width), title: b.title,
      corner: Math.abs(r.right - br.right) <= 4 && Math.abs(r.bottom - br.bottom) <= 4, opacity: [b, d].map((e) => getComputedStyle(e).opacity).join('/') };
  });
  const until = (fn, t = 4000) => page.waitForFunction(fn, null, { timeout: t }).then(() => true, () => false);
  const set = (local, sync) => sw.evaluate(([l, s]) => Promise.all([l ? chrome.storage.local.set(l) : 0, s ? chrome.storage.sync.set(s) : 0]), [local, sync]);

  // Google (no key, no translator chosen): no dot
  await page.goto('https://music.amazon.com/?song=1&stage=0'); await page.waitForTimeout(1500);
  let d = await dot();
  check('no key, Google by default → floating button has NO Gemini dot, plain tooltip', !d.present && d.title === 'Lyrics Translate', JSON.stringify(d));
  // Gemini selected, no key → gray
  await set(null, { translator: 'gemini' });
  await until(() => document.querySelector('.amlt-gdot'));
  d = await dot();
  check('Gemini selected but no key → gray dot, "Gemini: no key saved" (live, no reload)', d.present && d.state === 'gray' && d.color === COLORS.gray && d.title === 'Lyrics Translate · Gemini: no key saved', JSON.stringify(d));
  check('dot: about 8 px (+ a thin dark ring) in the button\'s bottom-right corner, never dimmed', d.w >= 9 && d.w <= 12 && /^1(\.5)?px rgb\(15, 17, 17\)$/.test(d.ring) && d.corner && d.opacity === '1/1', JSON.stringify(d));
  await set({ geminiKey: FAKE_KEY });
  await until(() => /not used yet/.test(document.querySelector('.amlt-float').title));
  d = await dot();
  check('key saved, not used yet → gray, "Gemini: not used yet"', d.state === 'gray' && d.title === 'Lyrics Translate · Gemini: not used yet', JSON.stringify(d));
  // Real (mocked) Gemini reply → green
  await page.goto('https://music.amazon.com/?song=1');
  await until(() => document.querySelector('.amlt-gdot[data-state=green]'), 15000);
  d = await dot();
  check('after a successful Gemini reply → green, "Gemini working"', d.state === 'green' && d.color === COLORS.green && d.title === 'Lyrics Translate · Gemini working', JSON.stringify(d));
  // Quota error (the background writes geminiStatus) → amber, live
  await set({ geminiStatus: { code: 'quota', at: Date.now(), until: Date.now() + 60000 } });
  await until(() => document.querySelector('.amlt-gdot[data-state=amber]'));
  d = await dot();
  check('status changes to quota → amber, "Gemini error: quota hit (using Google)" (live)', d.state === 'amber' && d.color === COLORS.amber && d.title === 'Lyrics Translate · Gemini error: quota hit (using Google)', JSON.stringify(d));
  await set({ geminiStatus: { code: 'timeout', at: Date.now(), until: Date.now() + 60000 } });
  await until(() => /timed out/.test(document.querySelector('.amlt-float').title));
  d = await dot();
  check('timeout → amber, "Gemini error: timed out (using Google)"', d.state === 'amber' && /timed out \(using Google\)$/.test(d.title), JSON.stringify(d));
  await page.screenshot({ path: __dirname + '/float-dot.png', clip: { x: 1000, y: 70, width: 100, height: 60 } });
  await set({ geminiStatus: { code: 'badkey', at: Date.now(), until: Date.now() + 864e5 } });
  await until(() => document.querySelector('.amlt-gdot[data-state=red]'));
  d = await dot();
  check('rejected key → red, "Gemini error: invalid key"', d.state === 'red' && d.color === COLORS.red && d.title === 'Lyrics Translate · Gemini error: invalid key', JSON.stringify(d));
  // Same meaning as the popup: open the popup page and compare its indicator state
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${sw.url().split('/')[2]}/popup.html`); await pop.waitForTimeout(500);
  const pstate = await pop.getAttribute('#gstate', 'data-state'), pdot = await pop.evaluate(() => getComputedStyle(document.querySelector('#gstate .dot')).backgroundColor);
  check('same state and color as the popup\'s Gemini indicator', pstate === 'red' && pdot === (await dot()).color, `${pstate} ${pdot}`);
  await pop.close();
  // Switch to Google → hidden; back to Gemini → shown again
  await set(null, { translator: 'google' });
  check('translator switched to Google Translate → dot removed, plain tooltip (live)', await until(() => !document.querySelector('.amlt-gdot') && document.querySelector('.amlt-float').title === 'Lyrics Translate'));
  await set({ geminiStatus: { code: 'ok', at: Date.now(), until: 0 } }, { translator: 'gemini' });
  check('back to Gemini (status ok) → green dot again', await until(() => document.querySelector('.amlt-gdot[data-state=green]')));
  await sw.evaluate(() => chrome.storage.sync.remove('translator'));
  await page.waitForTimeout(600);
  check('no translator chosen + key saved (popup default = Gemini) → dot shown', (await dot()).present);
  check('the key never reaches the page (not in any attribute or text)', !(await page.content()).includes(FAKE_KEY));
  await set(null, { float: false });
  check('floating button off → no button, no dot', await until(() => !document.querySelector('.amlt-float, .amlt-gdot')));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
  console.log(`\n${results.filter((r) => r[0] === 'PASS').length}/${results.length} passed`);
  if (results.some((r) => r[0] === 'FAIL')) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
