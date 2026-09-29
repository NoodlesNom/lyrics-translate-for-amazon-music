// v1.3.4 update notice (unpacked copies only). api.github.com is MOCKED via Playwright routing (no real GitHub request).
// Unpacked = the real extension folder loaded with --load-extension (chrome.management.getSelf() really answers
// "development", without the "management" permission). Store copies are simulated with a temporary copy of the extension
// whose background.js starts with a stub making getSelf() answer "normal" (or "sideload").
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EXT = require('path').resolve(__dirname, '..', 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, info = '') => { results.push([cond ? 'PASS' : 'FAIL', name, info]); console.log(cond ? 'PASS' : 'FAIL', name, info); };
const REL = 'https://github.com/NoodlesNom/lyrics-translate-for-amazon-music/releases';
const VER = JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8')).version; // the installed version (1.3.5)
const VRE = VER.replace(/\./g, '\\.');

let mode = 'newer', delay = 0, gh = [];
async function onGithub(route) {
  gh.push({ url: route.request().url(), method: route.request().method(), cookie: route.request().headers().cookie || '' });
  if (delay) await sleep(delay);
  const rel = (tag, url = `${REL}/tag/${tag}`) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ tag_name: tag, html_url: url, name: tag, draft: false, prerelease: false }) });
  if (mode === 'newer') return rel('v1.3.10');
  if (mode === 'same') return rel('v' + VER);
  if (mode === 'older') return rel('v1.3.3');
  if (mode === 'badurl') return rel('v1.3.11', 'https://evil.example/download');
  if (mode === '403') return route.fulfill({ status: 403, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: '{"message":"API rate limit exceeded"}' });
  if (mode === '429') return route.fulfill({ status: 429, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
  if (mode === '404') return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: '{"message":"Not Found"}' });
  if (mode === 'offline') return route.abort('internetdisconnected');
}
const onGoogle = (route) => { const q = new URLSearchParams(route.request().postData() || '').get('q'); route.fulfill({ contentType: 'application/json', body: JSON.stringify([[[q, q, null, null]], null, 'en']) }); };

async function launch(ext) {
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  await ctx.route(/api\.github\.com/, onGithub);
  await ctx.route(/github\.com\/NoodlesNom/, (r) => r.fulfill({ contentType: 'text/html', body: '<p>release page (mock)</p>' }));
  await ctx.route(/clients5\.google\.com|translate\.googleapis\.com/, onGoogle);
  await ctx.route(/lrclib\.net/, (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await ctx.route('https://music.amazon.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(__dirname + '/mock.html') }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  return { ctx, sw, extId: sw.url().split('/')[2] };
}
const popState = (pop) => pop.evaluate(() => ({
  newHidden: document.getElementById('updNew').hidden, newText: document.getElementById('updNew').innerText.replace(/\s+/g, ' ').trim(),
  href: document.getElementById('updLink').getAttribute('href'), target: document.getElementById('updLink').target,
  rowHidden: document.getElementById('updRow').hidden, privHidden: document.getElementById('updPriv').hidden,
  msg: document.getElementById('updMsg').textContent, btn: document.getElementById('updBtn').textContent }));
const waitMsg = (pop, re, t = 5000) => pop.waitForFunction((re) => new RegExp(re).test(document.getElementById('updMsg').textContent), re.source, { timeout: t }).then(() => true, () => false);
const waitGh = async (n, t = 10000) => { const t0 = Date.now(); while (gh.length < n && Date.now() - t0 < t) await sleep(100); return gh.length >= n; };

(async () => {
  const manifest = JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8'));
  check('manifest 1.3.5: still only "storage" + the same four hosts (no management, alarms or GitHub host permission)', manifest.version === '1.3.5'
    && JSON.stringify(manifest.permissions) === '["storage"]'
    && JSON.stringify(manifest.host_permissions) === JSON.stringify(['https://clients5.google.com/*', 'https://translate.googleapis.com/*', 'https://generativelanguage.googleapis.com/*', 'https://lrclib.net/*']), JSON.stringify([manifest.permissions, manifest.host_permissions]));

  // ================= Unpacked copy (real --load-extension) =================
  let { ctx, sw, extId } = await launch(EXT);
  const local = (k) => sw.evaluate((k) => chrome.storage.local.get(k).then((o) => o[k]), k);
  const setUpd = (u) => sw.evaluate((u) => chrome.storage.local.set({ upd: u }), u);
  const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
  const self = await sw.evaluate(() => chrome.management.getSelf().then((i) => ({ installType: i.installType, id: i.id })));
  check('unpacked: chrome.management.getSelf() works without the management permission and says "development"', self.installType === 'development' && self.id === extId, JSON.stringify(self));
  check('unpacked: no GitHub request right at startup (check waits ~5 s)', gh.length === 0, String(gh.length));
  check('unpacked: daily check runs ~5 s after the worker starts → exactly 1 request to the releases/latest API', (await waitGh(1)) && gh.length === 1
    && gh[0].url === 'https://api.github.com/repos/NoodlesNom/lyrics-translate-for-amazon-music/releases/latest' && gh[0].method === 'GET' && !gh[0].cookie, JSON.stringify(gh));
  await sleep(500);
  let upd = await local('upd');
  check('unpacked: result stored in chrome.storage.local (latest 1.3.10, release page, time)', upd && upd.latest === '1.3.10' && upd.url === `${REL}/tag/v1.3.10` && Date.now() - upd.at < 15000 && !upd.err, JSON.stringify(upd));
  check(`unpacked: newer release (1.3.10 > ${VER}, numeric compare) → badge "NEW"`, (await badge()) === 'NEW');
  const bg = await sw.evaluate(() => chrome.action.getBadgeBackgroundColor({}));
  check('unpacked: badge color is the subtle blue #1a6fd1', JSON.stringify(bg) === JSON.stringify([26, 111, 209, 255]), JSON.stringify(bg));

  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 320, height: 640 });
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForTimeout(700);
  let P = await popState(pop);
  check('popup: "Update available: v1.3.10 · Download" + how-to line', !P.newHidden && /^Update available: v1\.3\.10 · Download Download the ZIP, unzip it over your extension folder, then press Reload in chrome:\/\/extensions\.$/.test(P.newText), P.newText);
  check('popup: Download links to the release page (new tab)', P.href === `${REL}/tag/v1.3.10` && P.target === '_blank', P.href);
  check('popup: "Check for updates" button + privacy note shown for the unpacked copy; "Last checked just now"', !P.rowHidden && !P.privHidden && P.btn === 'Check for updates' && P.msg === 'Last checked just now', JSON.stringify(P));
  await pop.screenshot({ path: __dirname + '/popup-update.png', fullPage: true });
  check('popup open within 24 h: no new request', gh.length === 1, String(gh.length));

  await pop.click('#updBtn');
  check('button within 60 s of the last check: reuses it, no request, "Checked just now · Update available: v1.3.10"', (await waitMsg(pop, /^Checked just now · Update available: v1\.3\.10$/)) && gh.length === 1, (await popState(pop)).msg + ' reqs=' + gh.length);

  // same version, delayed answer → "Checking…" first
  mode = 'same'; delay = 900;
  await setUpd({ ...(await local('upd')), at: Date.now() - 120e3 });
  await pop.click('#updBtn');
  await pop.waitForTimeout(250);
  P = await popState(pop);
  check('button after the cooldown: "Checking…" while the request runs (button disabled)', P.msg === 'Checking…' && (await pop.$eval('#updBtn', (b) => b.disabled)), P.msg);
  check(`…then "You're up to date (v${VER})", 1 new request`, (await waitMsg(pop, new RegExp(`^You're up to date \\(v${VRE}\\)$`))) && gh.length === 2, (await popState(pop)).msg + ' reqs=' + gh.length);
  await pop.waitForTimeout(300);
  P = await popState(pop);
  check('versions match → badge cleared and the update line hidden', (await badge()) === '' && P.newHidden, JSON.stringify([await badge(), P.newHidden]));
  delay = 0;
  await pop.click('#updBtn');
  check(`clicking again right away: "Checked just now · You're up to date (v${VER})", no request`, (await waitMsg(pop, new RegExp(`^Checked just now · You're up to date \\(v${VRE}\\)$`))) && gh.length === 2, (await popState(pop)).msg);
  for (let i = 0; i < 3; i++) await pop.click('#updBtn');
  await pop.waitForTimeout(400);
  check('several quick clicks: still no request (cooldown)', gh.length === 2, String(gh.length));

  let n0 = 0;
  const back = async () => setUpd({ ...(await local('upd')), at: Date.now() - 120e3 });
  const clickFor = async (m, re) => { mode = m; await back(); const n = gh.length; await pop.click('#updBtn'); const ok = await waitMsg(pop, re); await pop.waitForTimeout(300); return ok && gh.length === n + 1; };
  check('older release on GitHub (v1.3.3): up to date, no badge', (await clickFor('older', new RegExp(`^You're up to date \\(v${VRE}\\)$`))) && (await badge()) === '' && (await popState(pop)).newHidden);
  check('newer again: update line + badge come back', (await clickFor('newer', /^Update available: v1\.3\.10$/)) && (await badge()) === 'NEW' && !(await popState(pop)).newHidden);
  check('HTTP 403 (rate limit): short message, last known release kept (badge + update line stay)', (await clickFor('403', /^GitHub is limiting requests right now\. Try again later\.$/))
    && (await badge()) === 'NEW' && !(await popState(pop)).newHidden && (await local('upd')).err === 'ratelimit' && (await local('upd')).latest === '1.3.10', JSON.stringify(await local('upd')));
  check('HTTP 429: same short message', await clickFor('429', /^GitHub is limiting requests right now\. Try again later\.$/));
  check('network error (offline): "Couldn\'t reach GitHub. Check your connection and try again."', await clickFor('offline', /^Couldn't reach GitHub\. Check your connection and try again\.$/));
  n0 = gh.length;
  await pop.click('#updBtn');
  check('…a click within the cooldown after an error reuses it too: "Checked just now · Couldn\'t reach GitHub…", no request', (await waitMsg(pop, /^Checked just now · Couldn't reach GitHub/)) && gh.length === n0, String(gh.length - n0));
  check('HTTP 404 (no releases): "No releases published yet."', await clickFor('404', /^No releases published yet\.$/));
  check('release page URL not on the project\'s GitHub → link falls back to releases/latest', (await clickFor('badurl', /^Update available: v1\.3\.11$/)) && (await popState(pop)).href === `${REL}/latest`, (await popState(pop)).href);

  // ---- daily automatic check (worker start / popup / content-script messages), no alarms ----
  const resetGuard = () => sw.evaluate(() => { autoCheckedAt = 0; });
  mode = 'newer';
  await setUpd({ at: Date.now() - 23 * 36e5, latest: VER, url: `${REL}/tag/v${VER}`, err: '' });
  await pop.waitForTimeout(300);
  await resetGuard(); let n = gh.length;
  await pop.reload(); await pop.waitForTimeout(1200);
  check('auto: last check 23 h ago → popup open makes no request', gh.length === n, String(gh.length - n));
  await setUpd({ at: Date.now() - 25 * 36e5, latest: VER, url: `${REL}/tag/v${VER}`, err: '' });
  await resetGuard(); n = gh.length;
  const page = await ctx.newPage();
  await page.goto('https://music.amazon.com/?song=5');
  await page.waitForFunction(() => document.querySelectorAll('.amlt').length >= 1 || document.querySelectorAll('h4[role="heading"]').length > 3, null, { timeout: 10000 }).catch(() => {});
  check('auto: last check 25 h ago → a content-script message (lyrics on the Amazon page) triggers 1 request', (await waitGh(n + 1, 8000)) && gh.length === n + 1, String(gh.length - n));
  await sleep(500);
  check('auto: …badge "NEW", and the open popup updates itself (update line shown)', (await badge()) === 'NEW' && !(await popState(pop)).newHidden);
  await setUpd({ at: Date.now() - 2 * 36e5, latest: VER, url: '', err: 'offline' });
  await resetGuard(); n = gh.length; await pop.reload(); await pop.waitForTimeout(1200);
  check('auto: failed check 2 h ago → not retried yet (retry after 3 h)', gh.length === n, String(gh.length - n));
  await setUpd({ at: Date.now() - 4 * 36e5, latest: VER, url: '', err: 'offline' });
  await resetGuard(); n = gh.length; await pop.reload();
  check('auto: failed check 4 h ago → retried on popup open', (await waitGh(n + 1, 5000)) && gh.length === n + 1, String(gh.length - n));
  await sleep(400);
  await resetGuard(); n = gh.length;
  for (let i = 0; i < 5; i++) await sw.evaluate(() => autoCheck());
  await sleep(400);
  check('auto: repeated triggers right after a check → no extra requests', gh.length === n, String(gh.length - n));

  // ---- helpers ----
  const cmp = await sw.evaluate(() => [isNewer('1.3.10', '1.3.9'), isNewer('v1.3.4', '1.3.4'), isNewer('1.4', '1.3.9'), isNewer('1.3.4.1', '1.3.4'), isNewer('1.3', '1.3.0'),
    isNewer('v2.0.0-beta', '1.9.9'), isNewer('1.3.3', '1.3.4'), isNewer('garbage', '1.3.4'), isNewer('', '1.3.4'), isNewer('V1.10.0', '1.9.99')]);
  check('version compare: 1.3.10>1.3.9, v1.3.4=1.3.4, 1.4>1.3.9, 1.3.4.1>1.3.4, 1.3=1.3.0, v2.0.0-beta>1.9.9, 1.3.3<1.3.4, junk/empty never newer, V1.10.0>1.9.99',
    JSON.stringify(cmp) === JSON.stringify([true, false, true, true, false, true, false, false, false, true]), JSON.stringify(cmp));
  const kinds = await sw.evaluate(() => [isStoreCopy('jjfhmmdjbkcamelimddcogoopaljflff', 'development'), isStoreCopy('abcdefghijklmnopabcdefghijklmnop', 'normal'),
    isStoreCopy('abcdefghijklmnopabcdefghijklmnop', 'sideload'), isStoreCopy('abcdefghijklmnopabcdefghijklmnop', 'admin'), isStoreCopy('abcdefghijklmnopabcdefghijklmnop', 'unknown'),
    isStoreCopy('abcdefghijklmnopabcdefghijklmnop', 'development')]);
  check('install type: store ID → store even if "development"; normal/sideload/admin/unknown → store; only development (other ID) → unpacked',
    JSON.stringify(kinds) === JSON.stringify([true, true, true, true, true, false]), JSON.stringify(kinds));
  await setUpd({ at: Date.now(), latest: VER, url: `${REL}/tag/v${VER}`, err: '' });
  await sw.evaluate(() => chrome.action.setBadgeText({ text: 'NEW' }));
  await sw.evaluate(() => applyBadge());
  check('after updating (stored latest = this version), the worker clears the badge', (await badge()) === '');
  await ctx.close();

  // ================= Store copies (getSelf stubbed) =================
  for (const type of ['normal', 'sideload']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amlt-store-'));
    fs.cpSync(EXT, dir, { recursive: true });
    fs.writeFileSync(dir + '/background.js', `// TEST STUB: pretend to be a ${type} install\nchrome.management.getSelf = () => Promise.resolve({ installType: '${type}', id: chrome.runtime.id });\n` + fs.readFileSync(EXT + '/background.js', 'utf8'));
    gh = []; mode = 'newer';
    ({ ctx, sw, extId } = await launch(dir));
    const lget = (k) => sw.evaluate((k) => chrome.storage.local.get(k).then((o) => o[k]), k);
    const pg = await ctx.newPage();
    await pg.goto('https://music.amazon.com/?song=5');
    await sleep(7000); // past the 5 s start delay, with content-script messages
    const sp = await ctx.newPage();
    await sp.goto(`chrome-extension://${extId}/popup.html`);
    await sp.waitForTimeout(800);
    const S = await popState(sp);
    const ans = await sp.evaluate(() => chrome.runtime.sendMessage({ type: 'update', manual: true }));
    await sw.evaluate(() => chrome.storage.local.set({ upd: { at: 1, latest: '9.9.9', url: 'x', err: '' } }));
    await sw.evaluate(() => { autoCheckedAt = 0; return autoCheck(); });
    await sp.reload(); await sp.waitForTimeout(800);
    const S2 = await popState(sp);
    const b = await sw.evaluate(() => chrome.action.getBadgeText({}));
    check(`store copy (${type}): zero GitHub requests (startup, Amazon page, popup, manual message, stale stored check)`, gh.length === 0, JSON.stringify(gh));
    check(`store copy (${type}): background answers { store: true } to the popup`, ans && ans.store === true && Object.keys(ans).length === 1, JSON.stringify(ans));
    check(`store copy (${type}): no button, no update line, no update privacy note (even with a stored newer version), no badge`,
      S.rowHidden && S.newHidden && S.privHidden && S2.rowHidden && S2.newHidden && S2.privHidden && b === '', JSON.stringify([S, S2, b]));
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r[0] === 'PASS').length;
  console.log(`\n${passed}/${results.length} passed`);
  fs.writeFileSync(__dirname + '/results-update.json', JSON.stringify(results, null, 1));
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
