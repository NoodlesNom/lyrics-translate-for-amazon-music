// Extra check: recovery after a failed request (the extension retries ~60 s later), on the real-structure mock.
const { chromium } = require('playwright');
const fs = require('fs');
const EXT = require('path').resolve(__dirname, '..', 'extension');
const fixtures = JSON.parse(fs.readFileSync(__dirname + '/fixtures.json', 'utf8'));
let fail = false, count = 0;
(async () => {
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route(/clients5\.google\.com|translate\.googleapis\.com/, async (route) => {
    count++;
    if (fail) return route.fulfill({ status: 429, body: '' });
    const q = new URLSearchParams(route.request().postData()).get('q');
    const key = 'en::' + q;
    if (!fixtures[key]) {
      const res = await route.fetch({ url: 'https://clients5.google.com/translate_a/single?client=dict-chrome-ex&sl=auto&tl=en&dt=t&dt=rm' });
      if (!res.ok()) return route.fulfill({ status: res.status(), body: '' });
      fixtures[key] = await res.json(); fs.writeFileSync(__dirname + '/fixtures.json', JSON.stringify(fixtures));
    }
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixtures[key]) });
  });
  let lrclibHits = 0; // songs here all have Amazon lyrics (badge shown), so LRCLIB must never be asked
  await ctx.route(/lrclib\.net/, (r) => { lrclibHits++; r.fulfill({ status: 404, body: '' }); });
  await ctx.route('https://music.amazon.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(__dirname + '/mock.html') }));
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent('serviceworker');
  const page = await ctx.newPage();
  fail = true;
  await page.goto('https://music.amazon.com/?song=3');
  await page.waitForTimeout(3000);
  const first = () => page.evaluate(() => document.querySelector('h4[role="heading"][aria-hidden="true"] > .amlt')?.innerText || null);
  console.log(`failed phase: requests=${count}, annotation=${await first()}`);
  fail = false;
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelectorAll('.amlt').length === 3, null, { timeout: 150000 });
  if (lrclibHits) throw new Error('LRCLIB was queried ' + lrclibHits + ' times');
  console.log(`PASS recovered after ${Math.round((Date.now() - t0) / 1000)} s; requests total=${count}; first line: ${JSON.stringify(await first())}`);
  await ctx.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
