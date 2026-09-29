// v1.3.6: romanized LRCLIB lyrics (Japanese romaji, Korean romanization, Chinese pinyin). lrclib.net, Google Translate and
// Gemini are MOCKED (placeholder key); every lyric line below is invented test text written for these tests (no real lyrics).
// Covers: detection (romanized songs flagged, invented English/Spanish/Italian/Indonesian songs not), preferring a copy in
// the original script from the same LRCLIB results, the romanized-only fallback (romanization slot, translation as the
// main line, "Original lyrics" never repeating the romaji, toggles), Gemini's language verdict and original-script guess,
// the local hiragana guess, popup status lines, and the cache (old romanized results looked up again, song entries dropped).
const { chromium } = require('playwright');
const fs = require('fs');
const EXT = require('path').resolve(__dirname, '..', 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, info = '') => { results.push([cond ? 'PASS' : 'FAIL', name, info]); console.log(cond ? 'PASS' : 'FAIL', name, info); };

// ---- invented lyrics ----
const C = {
  ja: ['kimi no koe ga kikoeru yoru ni', 'boku wa hitori de sora wo miteita', 'kokoro no naka de namida ga hikaru', 'itsumo no michi wo aruite yuku',
    'Hold on to the paper lantern light', 'sekai ga owatte mo kimi to issho', 'yume no tsuzuki wo sagashite', 'kaze ni notte tōku made'],
  jaWapuro: ['ashita mo kitto aeru kara', 'tooku no machi de matteru yo', 'hoshi no kakera wo atsumete', 'nee, kikoeteru? boku no kotoba',
    'mou nakanaide ii yo', 'futari de kaerou kono michi wo', 'sakura no ki no shita de'],
  ko: ['naega neoui ireumeul bureul ttae', 'uri haruga jeomureo gado', 'saranghae geudae maeumeul', 'oneul bameun byeori bitna',
    'Stay with me tonight', 'dasi hamkke georeul su isseulkka', 'neomu bogo sipeo jigeum'],
  zh: ['wo xiang ni zai zhe ge ye wan', 'ni de xiao rong xiang yang guang', 'women yiqi zou guo chun tian', 'xin li de hua shuo bu chu kou',
    'yuan fang de feng chui guo shan qiu', 'wo hai zai zhe li deng ni'],
  zhTones: ['wǒ xiǎng nǐ zài zhè ge yè wǎn', 'nǐ de xiào róng xiàng yáng guāng', 'wǒmen yìqǐ zǒu guò chūn tiān', 'xīn lǐ de huà shuō bù chū kǒu', 'wǒ hái zài zhè lǐ děng nǐ'],
  en: [
    ['Go go go, the night is young', 'We ride the metro to the sea', 'Nobody knows my name tonight', 'Take me home before the morning', 'Oh oh oh, the radio sings', 'Hide away, hide away'],
    ['Na na na, na na na', 'Come on, come on, sing it loud', 'Maybe tomorrow we will know', 'Tokyo lights and a paper moon', 'Kimono sleeves and a neon sign', 'Sayonara, my summer love'],
    ['Mama told me not to go', 'Banana boats along the bay', 'I made a promise to the tide', 'Ohio rain on a Sunday', 'So we go, so we go', 'Karaoke in a tiny bar'],
    ['Paper lanterns on the river', 'Tea for two and a tangerine', 'Every rose has a hidden name', 'Hold my hand across the bridge', 'Salt in the air, sand in the shoes', 'We are the ones who stay'],
  ],
  es: ['Te espero bajo la luna', 'Mi corazón no tiene nombre', 'La noche cae sobre el mar', 'Dame la mano y vamos ya', 'Nunca te voy a olvidar', 'Bailamos hasta el amanecer'],
  it: ['Amore mio, dimmi di sì', 'La luna sopra il mare', 'Ti porto via con me stanotte', 'Sono tutta la tua vita', 'Che bella sera, amore', 'Domani ancora insieme'],
  id: ['Aku rindu padamu malam ini', 'Bulan di atas kota tua', 'Jangan pergi dariku sayang', 'Kita berjalan di bawah hujan', 'Hatiku selalu untukmu', 'Sampai nanti kita bertemu'],
};
// The same (invented) song in Japanese script, for "prefer the native copy".
const JA_NATIVE = ['君の声が聞こえる夜に', '僕はひとりで空を見ていた', '心の中で涙が光る', 'いつもの道を歩いてゆく',
  'Hold on to the paper lantern light', '世界が終わっても君と一緒', '夢の続きを探して', '風に乗って遠くまで'];
const lrc = (lines, step = 4) => lines.map((l, i) => `[00:${String(2 + i * step).padStart(2, '0')}.00]${l}`).join('\n');
const rec = (id, trackName, artistName, duration, lyr) => ({ id, name: trackName, trackName, artistName, albumName: 'Mock Album', duration, instrumental: false,
  plainLyrics: lyr.plain || (lyr.synced ? lyr.synced.replace(/\[[^\]]*\]/g, '') : null), syncedLyrics: lyr.synced || null });
const A = 'Mock Singer';
const GET = {
  'Paper Crane (Test)': rec(101, 'Paper Crane (Test)', A, 200, { synced: lrc(C.ja) }),              // romaji synced…
  'Night Ferry (Test)': rec(111, 'Night Ferry (Test)', A, 200, { synced: lrc(C.ja) }),              // romaji only
  'Harbor Song (Test)': rec(121, 'Harbor Song (Test)', A, 200, { synced: lrc(C.ko) }),              // Korean romanization only
  'Spring Road (Test)': rec(131, 'Spring Road (Test)', A, 200, { synced: lrc(C.zhTones) }),         // pinyin only
  'Blue Kite (Test)': rec(141, 'Blue Kite (Test)', A, 200, { synced: lrc(C.jaWapuro) }),            // romaji; Gemini will say Korean
  'Tea Garden (Test)': rec(151, 'Tea Garden (Test)', A, 200, { synced: lrc(C.jaWapuro) }),          // romaji; Gemini will say "none"
  'Metro Sea (Test)': rec(161, 'Metro Sea (Test)', A, 200, { synced: lrc(C.en[0]) }),               // English
};
const SEARCH = {
  'Paper Crane (Test)': [rec(101, 'Paper Crane (Test)', A, 200, { synced: lrc(C.ja) }),
    rec(103, 'Paper Crane (Test)', A, 190, { synced: lrc(JA_NATIVE) }),                              // native, but 10 s off → no
    rec(104, 'Paper Crane (Test)', 'Other Band', 200, { synced: lrc(JA_NATIVE) }),                  // native, other artist → no
    rec(102, 'Paper Crane (Test)', A, 201.5, { synced: lrc(JA_NATIVE) })],                          // …native, 1.5 s off → yes
  'Night Ferry (Test)': [rec(111, 'Night Ferry (Test)', A, 200, { synced: lrc(C.ja) }), rec(112, 'Night Ferry (Test)', A, 199, { plain: C.ja.join('\n') }),
    rec(113, 'Night Ferry (Test)', A, 150, { synced: lrc(JA_NATIVE) })],                            // native only 50 s off → no
  'Harbor Song (Test)': [rec(121, 'Harbor Song (Test)', A, 200, { synced: lrc(C.ko) })],
};

// Google (mocked): Japanese script lines → translation + romanization; romanized lines → "EN: <line>"; English unchanged.
const JA_T = Object.fromEntries(JA_NATIVE.map((l, i) => [l, [`Native translation ${i + 1}`, C.ja[i]]]));
const ROM = new Set([...C.ja, ...C.jaWapuro, ...C.ko, ...C.zhTones].filter((l) => !/^[A-Z][a-z]+ /.test(l) || /^[a-z]/.test(l)));
let gReqs = [];
async function onGoogle(route) {
  const q = new URLSearchParams(route.request().postData() || '').get('q');
  gReqs.push(q);
  const ls = q.split('\n|\n');
  if (ls.every((l) => JA_T[l])) return route.fulfill({ contentType: 'application/json', body: JSON.stringify([[[ls.map((l) => JA_T[l][0]).join('\n|\n'), q, null, null], [null, null, null, ls.map((l) => JA_T[l][1]).join(' | ')]], null, 'ja']) });
  const t = ls.map((l) => (/^[a-zǎǐǒǔěāīūēōáíóúéàìòùè]/.test(l) ? 'EN: ' + l : l));
  route.fulfill({ contentType: 'application/json', body: JSON.stringify([[[t.join('\n|\n'), q, null, null]], null, ls.some((l) => /^[a-z]/.test(l)) ? 'ja' : 'en']) });
}
let lReqs = [];
async function onLrclib(route) {
  const u = new URL(route.request().url());
  lReqs.push({ path: u.pathname, q: Object.fromEntries(u.searchParams) });
  const t = u.searchParams.get('track_name');
  if (u.pathname === '/api/get') return GET[t] ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(GET[t]) }) : route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":404}' });
  if (u.pathname === '/api/search') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(SEARCH[t] || (GET[t] ? [GET[t]] : [])) });
  route.fulfill({ status: 404, body: '' });
}
// Gemini (mocked): romanized requests (object schema) answer { lang: gemLang, lines: [{ t, o }] } with invented guesses.
let gemReqs = [], gemLang = 'ko';
const KO_GUESS = ['내가 너의 이름을 부를 때', '우리 하루가 저물어 가도', '사랑해 그대 마음을', '오늘 밤은 별이 빛나', '', '다시 함께 걸을 수 있을까', '너무 보고 싶어 지금'];

const stageLines = (page) => page.evaluate(() => [...document.querySelectorAll('.amlt-stage-line')].map((l) => {
  const txt = [...l.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('');
  const b = l.querySelector(':scope > .amlt');
  const vis = (e) => !!e && getComputedStyle(e).display !== 'none';
  const q = (s) => b && b.querySelector(s);
  const info = (e) => e && { text: e.textContent, shown: vis(e), big: e.classList.contains('amlt-big'), size: getComputedStyle(e).fontSize, order: getComputedStyle(e).order, top: Math.round(e.getBoundingClientRect().top) };
  const shownTexts = b ? [...b.children].filter(vis).sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top).map((e) => e.textContent) : [];
  return { text: txt, roman: l.classList.contains('amlt-roman'), rblock: !!(b && b.classList.contains('amlt-rblock')), lineSize: getComputedStyle(l).fontSize,
    orig: info(q('.amlt-orig')), rom: info(q('.amlt-rom')), trans: info(q('.amlt-trans')), guessMark: q('.amlt-orig') ? getComputedStyle(q('.amlt-orig'), '::before').content : '',
    guessTitle: q('.amlt-orig') ? q('.amlt-orig').title : '', shownTexts };
}));

(async () => {
  const manifest = JSON.parse(fs.readFileSync(EXT + '/manifest.json', 'utf8'));
  check('manifest 1.3.6: no new permissions (storage + the same four hosts)', manifest.version === '1.3.6' && JSON.stringify(manifest.permissions) === '["storage"]'
    && JSON.stringify(manifest.host_permissions) === JSON.stringify(['https://clients5.google.com/*', 'https://translate.googleapis.com/*', 'https://generativelanguage.googleapis.com/*', 'https://lrclib.net/*']), manifest.version);
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: { width: 1600, height: 820 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route(/api\.github\.com/, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ tag_name: 'v' + manifest.version, html_url: 'https://github.com/NoodlesNom/lyrics-translate-for-amazon-music/releases/latest' }) }));
  await ctx.route(/lrclib\.net/, onLrclib);
  await ctx.route(/clients5\.google\.com|translate\.googleapis\.com/, onGoogle);
  await ctx.route(/generativelanguage\.googleapis\.com/, (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    const lines = ((body.contents && body.contents[0].parts[0].text) || '').split('\n').map((x) => x.replace(/^\d+\.\s/, ''));
    const sys = body.systemInstruction.parts[0].text, schema = body.generationConfig.responseSchema;
    gemReqs.push({ lines, sys, schema });
    const out = schema.type === 'OBJECT'
      ? { lang: gemLang, lines: lines.map((l, i) => ({ t: `Gemini line ${i + 1}`, o: gemLang === 'none' || /^[A-Z]/.test(l) ? '' : gemLang === 'ko' ? KO_GUESS[i] || '한국어 추측' : '日本語の推測' })) }
      : lines.map((l, i) => `Gemini line ${i + 1}`);
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
  const song = (title, asin) => `song=9&title=${encodeURIComponent(title)}&asin=${asin}&stagehref=tracks&start=1`;
  const go = async (qs, wait = 4000) => { lReqs = []; gReqs = []; gemReqs = []; await page.goto('https://music.amazon.com/?' + qs); await page.waitForTimeout(wait); };
  const waitBlocks = (n) => page.waitForFunction((n) => document.querySelectorAll('.amlt-stage .amlt-trans').length >= n, n, { timeout: 8000 }).catch(() => {});

  // ---------- 1. Detection (the service worker's detectRoman) ----------
  const det = (lines) => sw.evaluate((lines) => detectRoman(lines), lines);
  let d;
  d = await det(C.ja);
  check('detect: invented Hepburn romaji song (with macrons and one English line) → Japanese; the English line is not marked romanized', d.lang === 'ja' && d.lines.length === 7 && !d.lines.includes(C.ja[4]), JSON.stringify(d.lines.length));
  d = await det(C.jaWapuro);
  check('detect: invented romaji without macrons (ou/oo long vowels) → Japanese, every line', d.lang === 'ja' && d.lines.length === C.jaWapuro.length);
  d = await det(C.ko);
  check('detect: invented Korean romanization (eo/eu, naega, neoui, saranghae, haru, uri) → Korean', d.lang === 'ko' && d.lines.length === 6);
  d = await det(C.zh);
  check('detect: invented pinyin without tone marks (xiang, zh/x/q, wo, ni, de) → Chinese', d.lang === 'zh' && d.lines.length === C.zh.length);
  d = await det(C.zhTones);
  check('detect: invented pinyin with tone marks → Chinese', d.lang === 'zh' && d.lines.length === C.zhTones.length);
  const en = await Promise.all(C.en.map(det));
  check('detect: 4 invented English songs (short vowel-ending words, "go go go", "na na na", "so we go", Tokyo/kimono/sayonara/karaoke loanwords) → not romanized',
    en.every((x) => x.lang === '' && !x.lines.length), JSON.stringify(en.map((x) => x.lang)));
  const other = await Promise.all([C.es, C.it, C.id].map(det));
  check('detect: invented Spanish, Italian and Indonesian songs (many vowel-ending words) → not romanized', other.every((x) => x.lang === ''), JSON.stringify(other.map((x) => x.lang)));
  d = await det([...JA_NATIVE]);
  check('detect: the song in Japanese script → not romanized (only Latin-letter songs count)', d.lang === '');
  d = await det(C.ja.slice(0, 2));
  check('detect: too little text (2 lines) → not flagged', d.lang === '');
  d = await det([...C.en[0], ...C.en[1], C.ja[0], C.ja[1]]);
  check('detect: an English song with two romaji lines → not a romanized song (whole-song context)', d.lang === '');
  const kana = await sw.evaluate(() => [toHiragana('kimi no koe ga kikoeru yoru ni'), toHiragana('boku wa hitori de sora wo miteita'), toHiragana('kaze ni notte tōku made'), toHiragana('dancing in the kaze')]);
  check('local hiragana guess: romaji → hiragana (sokuon, long vowels, lone "wa" → は, "wo" → を); English words stay Latin',
    kana[0] === 'きみのこえがきこえるよるに' && kana[1] === 'ぼくはひとりでそらをみていた' && kana[2] === 'かぜにのってとうくまで' && kana[3] === 'dancing in the かぜ', JSON.stringify(kana));

  // ---------- 2. Prefer a copy in the original script ----------
  await go(song('Paper Crane (Test)', 'B0MOCKR001'));
  await waitBlocks(6);
  let L = await stageLines(page);
  check('native copy: /api/get gave romaji → ONE extra /api/search with the same title/artist (no new data) → the Japanese-script copy (1.5 s off) is shown, not the 10 s-off one or another artist\'s',
    L.length === 8 && L[0].text === JA_NATIVE[0] && lReqs.map((r) => r.path).join() === '/api/get,/api/search' && JSON.stringify(lReqs[1].q) === JSON.stringify({ track_name: 'Paper Crane (Test)', artist_name: A }),
    JSON.stringify({ first: L[0] && L[0].text, reqs: lReqs.map((r) => r.path) }));
  check('native copy: everything works as normal (translation main line, Google romanization below, no romanized-line handling)',
    L.filter((l) => JA_T[l.text] && !/^[A-Z]/.test(l.text)).every((l) => !l.roman && !l.rblock && l.trans.text === JA_T[l.text][0] && l.rom.text === JA_T[l.text][1]), JSON.stringify(L[0]));
  let v = (await local('lrc:asin:B0MOCKR001'))['lrc:asin:B0MOCKR001'];
  check('native copy: cached with the 1.3.6 cache version (v 2) and the native id; replay → 0 requests', v && v.v === 2 && v.id === 102, JSON.stringify(v && { v: v.v, id: v.id }));
  await go(song('Paper Crane (Test)', 'B0MOCKR001'), 3000);
  check('native copy: replay → 0 LRCLIB requests', lReqs.length === 0 && (await stageLines(page))[0].text === JA_NATIVE[0], `reqs=${lReqs.length}`);

  // ---------- 3. Romaji only (Google, no Gemini key): romanization slot ----------
  await go(song('Night Ferry (Test)', 'B0MOCKR002'));
  await waitBlocks(7);
  L = await stageLines(page);
  const romL = L.filter((l) => l.roman), enL = L.find((l) => l.text === C.ja[4]);
  check('romaji only: no native copy within 3 s (the 50 s-off one is ignored) → the romaji copy (id 111), get + search', L.length === 8 && L[0].text === C.ja[0] && lReqs.map((r) => r.path).join() === '/api/get,/api/search', JSON.stringify(lReqs.map((r) => r.path)));
  check('romaji only: the 7 romaji lines are marked romanized, the English line is not', romL.length === 7 && enL && !enL.roman && !enL.rblock, JSON.stringify(L.map((l) => l.roman)));
  check('romaji only: romaji shown IN THE ROMANIZATION SLOT (18px, under the translation), translation (from the romaji) is the 28px main line',
    romL.every((l) => l.rblock && l.rom.text === l.text && l.rom.shown && !l.rom.big && l.rom.size === '18px' && l.trans.text === 'EN: ' + l.text && l.trans.big && l.trans.size === '28px' && l.trans.top < l.rom.top),
    JSON.stringify(romL[0]));
  check('romaji only: the romaji text itself is not shown again as the original (line text at 0px; each line shows exactly [translation, romaji])',
    romL.every((l) => l.lineSize === '0px' && JSON.stringify(l.shownTexts) === JSON.stringify(['EN: ' + l.text, l.text])), JSON.stringify(romL[0].shownTexts));
  check('romaji only: the English line stays an ordinary line (28px original, no translation, no romanization)', enL.lineSize === '28px' && !enL.trans && !enL.rom, JSON.stringify(enL));
  check('romaji only: Google asked once for all romaji lines (+ the English line in the same Latin batch), romanization never asked of Google as "original"', gReqs.length === 1, `google=${gReqs.length}`);
  await page.screenshot({ path: __dirname + '/fullview-romanized.png' });
  await setSettings({ orig: true }); await page.waitForTimeout(400);
  await page.screenshot({ path: __dirname + '/fullview-romanized-orig.png' });
  L = await stageLines(page);
  let r0 = L.find((l) => l.text === C.ja[0]);
  check('"Original lyrics" ON, Japanese without Gemini: the original slot shows a HIRAGANA GUESS (big line, marked "≈", tooltip), then romaji, then translation; the romaji is not duplicated',
    r0.orig && r0.orig.shown && r0.orig.big && r0.orig.text === 'きみのこえがきこえるよるに' && /≈/.test(r0.guessMark) && /guessed/i.test(r0.guessTitle)
    && JSON.stringify(r0.shownTexts) === JSON.stringify(['きみのこえがきこえるよるに', C.ja[0], 'EN: ' + C.ja[0]]) && r0.orig.size === '28px' && r0.trans.size === '18px', JSON.stringify(r0));
  await setSettings({ orig: false, rom: false }); await page.waitForTimeout(400);
  r0 = (await stageLines(page)).find((l) => l.text === C.ja[0]);
  check('Romanization toggle OFF → romaji hidden, translation remains the main line, no original', JSON.stringify(r0.shownTexts) === JSON.stringify(['EN: ' + C.ja[0]]), JSON.stringify(r0.shownTexts));
  await setSettings({ trans: false }); await page.waitForTimeout(400);
  r0 = (await stageLines(page)).find((l) => l.text === C.ja[0]);
  check('Translation and Romanization both OFF → the romaji is the only text left, so it shows as the main (28px) line', JSON.stringify(r0.shownTexts) === JSON.stringify([C.ja[0]]) && r0.rom.big && r0.rom.size === '28px', JSON.stringify(r0));
  await setSettings({ trans: true, rom: true, size: 1.2 }); await page.waitForTimeout(500);
  r0 = (await stageLines(page)).find((l) => l.text === C.ja[0]);
  check('toggles back on + text size Large → 33.6px translation / 21.6px romaji', r0.trans.size === '33.6px' && r0.rom.size === '21.6px' && r0.trans.shown && r0.rom.shown, JSON.stringify([r0.trans.size, r0.rom.size]));
  await setSettings({ size: 1 });

  // popup
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 320, height: 560 });
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForTimeout(400);
  const tabId = await sw.evaluate(async () => { for (const t of await chrome.tabs.query({})) if (await chrome.tabs.sendMessage(t.id, { type: 'song' }).catch(() => null)) return t.id; });
  const note = async () => { await pop.evaluate(async (id) => { chrome.tabs.getCurrent = async () => undefined; chrome.tabs.query = async () => [{ id }]; await findSong(); }, tabId);
    return pop.evaluate(() => ({ hidden: document.getElementById('lrcNote').hidden, note: document.getElementById('lrcNote').textContent, song: document.getElementById('song').textContent })); };
  let n = await note();
  check('popup: "LRCLIB lyrics were already romanized (Japanese) · original: hiragana guess"; This song names Japanese', !n.hidden && n.note === 'LRCLIB lyrics were already romanized (Japanese) · original: hiragana guess' && /· Japanese/.test(n.song), JSON.stringify(n));
  await pop.screenshot({ path: __dirname + '/popup-romanized.png' });
  let e2 = (await local('song:asin:B0MOCKR002'))['song:asin:B0MOCKR002'];
  check('cache: the song entry is marked with the romanized-song version (rv 2), romaji lines stored with sl ja + local guess', e2 && e2.rv === 2 && e2.lines[C.ja[0]].sl === 'ja' && e2.lines[C.ja[0]].og === 'local', JSON.stringify(e2 && e2.lines[C.ja[0]]));
  await go(song('Night Ferry (Test)', 'B0MOCKR002'), 3500);
  L = await stageLines(page);
  check('replay: 0 LRCLIB and 0 Google requests, still shown as romanization', lReqs.length === 0 && gReqs.length === 0 && L.filter((l) => l.roman && l.rom && l.rom.text === l.text).length === 7, `lrclib=${lReqs.length} google=${gReqs.length}`);

  // ---------- 4. Korean romanization + Gemini: language verdict and Hangul guess ----------
  await sw.evaluate(() => Promise.all([chrome.storage.local.set({ geminiKey: 'placeholder-not-a-real-key-TEST' }), chrome.storage.sync.set({ translator: 'gemini' })]));
  gemLang = 'ko';
  await page.waitForTimeout(1500);
  await go(song('Harbor Song (Test)', 'B0MOCKR003'));
  await waitBlocks(7);
  L = await stageLines(page);
  const koReqs = gemReqs.filter((x) => x.lines.includes(C.ko[0])), g = koReqs[0]; // (the previous song may still be re-translated after the switch to Gemini)
  check('Korean + Gemini: ONE Gemini request with every line, object schema { lang: ja|ko|zh|none, lines: [{ t, o }] }, prompt names Korean and asks for Hangul',
    koReqs.length === 1 && g.lines.length === 7 && g.schema.type === 'OBJECT' && JSON.stringify(g.schema.properties.lang.enum) === '["ja","ko","zh","none"]' && g.schema.properties.lines.items.required.join() === 't,o'
    && /romanization of Korean/.test(g.sys) && /Hangul for Korean/.test(g.sys), JSON.stringify(koReqs.map((x) => x.lines.length)));
  check('Korean + Gemini: romanization slot = the line, main line = Gemini translation, no original shown (toggle off)',
    L.filter((l) => l.roman).length === 6 && L.filter((l) => l.roman).every((l) => l.rom.text === l.text && l.trans.big && /^Gemini line/.test(l.trans.text) && (!l.orig || !l.orig.shown)), JSON.stringify(L[0]));
  await setSettings({ orig: true }); await page.waitForTimeout(400);
  L = await stageLines(page);
  check('Korean + Gemini, "Original lyrics" ON → Gemini\'s Hangul guess as the big line, marked "≈"; the English line has none',
    L[0].orig && L[0].orig.shown && L[0].orig.big && L[0].orig.text === KO_GUESS[0] && /≈/.test(L[0].guessMark) && /Gemini/.test(L[0].guessTitle) && !L[4].orig, JSON.stringify(L[0]));
  n = await note();
  check('popup: "LRCLIB lyrics were already romanized (Korean) · original script guessed by Gemini"', n.note === 'LRCLIB lyrics were already romanized (Korean) · original script guessed by Gemini', JSON.stringify(n));
  await setSettings({ orig: false });

  // ---------- 5. Gemini's verdict overrides the heuristic ----------
  gemLang = 'ko';
  await go(song('Blue Kite (Test)', 'B0MOCKR004'));
  await waitBlocks(7);
  n = await note();
  check('Gemini says Korean for lines the heuristic took as Japanese → the popup says Korean, the guess is Gemini\'s (no hiragana)',
    /romanization of Japanese/.test(gemReqs[0] && gemReqs[0].sys) && n.note === 'LRCLIB lyrics were already romanized (Korean) · original script guessed by Gemini', JSON.stringify(n));
  gemLang = 'none';
  await go(song('Tea Garden (Test)', 'B0MOCKR005'));
  await waitBlocks(7);
  await page.waitForTimeout(500);
  L = await stageLines(page);
  n = await note();
  check('Gemini says "none" (not a romanization) → ordinary lines: original text visible, translation as usual, no romanization slot, no "already romanized" note',
    L.every((l) => !l.roman && !l.rblock && !l.rom && l.trans && /^Gemini line/.test(l.trans.text)) && !/romanized/.test(n.note) && n.note === 'Lyrics added from LRCLIB (synced)', JSON.stringify({ l: L[0], n }));

  // ---------- 6. Pinyin, Google only: no original line ----------
  await setSettings({ translator: 'google', orig: true });
  await go(song('Spring Road (Test)', 'B0MOCKR006'));
  await waitBlocks(5);
  L = await stageLines(page);
  check('pinyin without Gemini: romanization slot filled, and with "Original lyrics" ON there is NO original line (no reliable local conversion), the pinyin is not duplicated',
    gemReqs.length === 0 && L.length === 5 && L.every((l) => l.roman && !l.orig && l.rom.text === l.text && l.lineSize === '0px' && l.shownTexts.filter((t) => t === l.text).length === 1), JSON.stringify(L[0]));
  n = await note();
  check('popup: "LRCLIB lyrics were already romanized (Chinese) · original script needs Gemini"', n.note === 'LRCLIB lyrics were already romanized (Chinese) · original script needs Gemini', JSON.stringify(n));
  await setSettings({ orig: false });

  // ---------- 7. English LRCLIB song: untouched ----------
  await go(song('Metro Sea (Test)', 'B0MOCKR007'));
  L = await stageLines(page);
  n = await note();
  check('English LRCLIB song (vowel-ending words, "go go go"): not romanized, no extra search call, original lines as before', L.length === 6 && L.every((l) => !l.roman && !l.rblock) && lReqs.map((r) => r.path).join() === '/api/get' && n.note === 'Lyrics added from LRCLIB (synced)', JSON.stringify({ reqs: lReqs.map((r) => r.path), n }));

  // ---------- 8. Cache: results from 1.3.5 ----------
  await sw.evaluate(async ({ romaji, en }) => {
    const { idx = {} } = await chrome.storage.local.get('idx');
    idx['asin:B0MOCKR010'] = idx['asin:B0MOCKR011'] = idx['asin:B0MOCKR012'] = Date.now() - 864e5;
    const stale = { lines: { 'kimi no koe ga kikoeru yoru ni': { t: { en: 'STALE 1.3.5 translation' }, sl: 'en', r: '' } }, noGemini: { en: 1 }, ts: Date.now() - 864e5 };
    await chrome.storage.local.set({ idx,
      'lrc:asin:B0MOCKR010': { id: 101, dur: 200, synced: romaji }, 'song:asin:B0MOCKR010': stale,       // 1.3.5 picked the romaji copy
      'lrc:asin:B0MOCKR011': { id: 161, dur: 200, synced: en },                                          // 1.3.5 English result
      'lrc:asin:B0MOCKR012': { v: 2, id: 111, dur: 200, synced: romaji }, 'song:asin:B0MOCKR012': stale }); // 1.3.6 lookup, pre-1.3.6 song entry
  }, { romaji: lrc(C.ja), en: lrc(C.en[0]) });
  await go(song('Paper Crane (Test)', 'B0MOCKR010'));
  await waitBlocks(6);
  L = await stageLines(page);
  v = (await local(['lrc:asin:B0MOCKR010', 'song:asin:B0MOCKR010']));
  check('cache: a 1.3.5 LRCLIB entry (no cache version) holding romaji → looked up again (get + search) → the native copy; stored as v 2',
    lReqs.map((r) => r.path).join() === '/api/get,/api/search' && L[0].text === JA_NATIVE[0] && v['lrc:asin:B0MOCKR010'].v === 2 && v['lrc:asin:B0MOCKR010'].id === 102, JSON.stringify(lReqs.map((r) => r.path)));
  check('cache: …and that song\'s old translations of the romaji are dropped', !JSON.stringify(v['song:asin:B0MOCKR010'] || {}).includes('STALE'), JSON.stringify(Object.keys((v['song:asin:B0MOCKR010'] || {}).lines || {}).length));
  await go(song('Metro Sea (Test)', 'B0MOCKR011'), 3000);
  check('cache: a 1.3.5 entry that is not romanized (English) is kept: 0 requests', lReqs.length === 0 && (await stageLines(page)).length === 6, `reqs=${lReqs.length}`);
  await go(song('Night Ferry (Test)', 'B0MOCKR012'));
  await waitBlocks(7);
  L = await stageLines(page);
  const e12 = (await local('song:asin:B0MOCKR012'))['song:asin:B0MOCKR012'];
  check('cache: a song entry from before 1.3.6 for a romanized song is reset (no stale translation shown, no leftover "no Gemini" flag, rv 2), 0 LRCLIB requests',
    lReqs.length === 0 && L[0].trans && L[0].trans.text === 'EN: ' + C.ja[0] && !JSON.stringify(e12).includes('STALE') && !e12.noGemini && e12.rv === 2, JSON.stringify({ reqs: lReqs.length, t: L[0].trans && L[0].trans.text }));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
  fs.writeFileSync(__dirname + '/results-romanized.json', JSON.stringify(results, null, 1));
  console.log(`\n${results.filter((r) => r[0] === 'PASS').length}/${results.length} passed`);
  if (results.some((r) => r[0] === 'FAIL')) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
