// Background service worker: translation requests (Gemini with the user's key, or Google Translate) and the cache.
'use strict';

// Google Translate web endpoints (same format; the second is tried if the first fails). Always used for romanization.
const GOOGLE = [
  'https://clients5.google.com/translate_a/single?client=dict-chrome-ex',
  'https://translate.googleapis.com/translate_a/single?client=gtx',
];
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const SEP = '\n|\n';        // line separator that survives both translation and romanization
const MAX_CHARS = 1800;     // per Google request
const LIMITS = { songs: 2000, lines: 400, timeoutMs: 20000 }; // cached songs (LRU by last play), lines per song

const SCRIPTS = [
  ['hangul', /\p{Script=Hangul}/u],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['han', /\p{Script=Han}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['thai', /\p{Script=Thai}/u],
  ['greek', /\p{Script=Greek}/u],
];
const NON_LATIN = /[^\P{L}\p{Script=Latin}]/u;
const scriptOf = (s) => (SCRIPTS.find(([, re]) => re.test(s)) || [NON_LATIN.test(s) ? 'other' : 'latin'])[0];

const norm = (l) => (l || '').toLowerCase().replace(/^iw\b/, 'he');
const sameLang = (a, b) => {
  a = norm(a); b = norm(b);
  return a === b || (a.split('-')[0] === b.split('-')[0] && a.split('-')[0] !== 'zh');
};
const simplify = (s) => s.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
const fetchT = (url, opts) => fetch(url, { ...opts, credentials: 'omit', signal: AbortSignal.timeout(LIMITS.timeoutMs) });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const job = msg && msg.type === 'lyrics' ? handle(msg) : msg && msg.type === 'testKey' ? testKey(msg.key) : null;
  if (!job) return;
  job.then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

// v1.0.x caches have no LRU index yet: add them to it once.
chrome.runtime.onInstalled.addListener(async () => {
  const all = await chrome.storage.local.get(null);
  const idx = all.idx || {};
  for (const k of Object.keys(all)) if (k.startsWith('song:') && !(k.slice(5) in idx)) idx[k.slice(5)] = all[k].ts || 0;
  await chrome.storage.local.set({ idx });
});

// lines = all unique lyric lines of the current song, in order.
// force = popup button "Translate this song": clear the skip flag, never language-skip this song again, and
// translate it afresh with the selected translator (Gemini unless paused; Google re-detects each Latin line on its own).
async function handle({ key, lines, tl, force }) {
  const sk = 'song:' + key;
  const { [sk]: stored, geminiKey, geminiStatus } = await chrome.storage.local.get([sk, 'geminiKey', 'geminiStatus']);
  const { translator } = await chrome.storage.sync.get('translator');
  const entry = stored || { lines: {} };
  const cell = (l) => entry.lines[l] || (entry.lines[l] = { t: {} });
  if (force) { if (entry.noGemini) delete entry.noGemini[tl]; (entry.force ||= {})[tl] = 1; }
  let useGemini = !!geminiKey && translator !== 'google' && !(entry.noGemini && entry.noGemini[tl]);
  const gem = (l) => useGemini && entry.lines[l] && entry.lines[l].g && tl in entry.lines[l].g;
  const hasT = (l) => entry.lines[l] && entry.lines[l].t && tl in entry.lines[l].t;
  let changed = !!force, geminiCode;

  // Google: romanization + translation (language detected per batch). Returns false if a request failed.
  const google = async (list, perLine) => {
    let ok = true;
    const latin = perLine ? list.filter((l) => !NON_LATIN.test(l)) : [];
    for (const batch of [...batches(list.filter((l) => !latin.includes(l))), ...latin.map((l) => [l])]) {
      try {
        const res = await translate(batch, tl);
        batch.forEach((line, i) => {
          const c = cell(line);
          c.sl = res.sl;
          c.r = NON_LATIN.test(line) ? res.r[i] || '' : '';
          const t = res.t[i] || '';
          c.t[tl] = sameLang(res.sl, tl) || simplify(t) === simplify(line) ? '' : t;
        });
        changed = true;
      } catch (e) {
        ok = false;
        console.warn('[lyrics-translate] Google request failed, will retry later:', e.message || e);
      }
    }
    return ok;
  };

  // 0. Latin-only song: detect its language with Google first (free). Already in the target language → no Gemini,
  //    for replays too, and the Gemini status is left alone. If detection fails, Gemini is tried as usual.
  if (useGemini && !(entry.force && entry.force[tl]) && lines.some((l) => !gem(l)) && !lines.some((l) => NON_LATIN.test(l))) {
    await google(lines.filter((l) => !hasT(l)));
    if (lines.every((l) => hasT(l) && sameLang(entry.lines[l].sl, tl))) {
      (entry.noGemini ||= {})[tl] = 1;
      useGemini = false;
      changed = true;
    }
  }

  // 1. Gemini: the whole song in one request (skipped while backing off after an error).
  const paused = (geminiStatus && geminiStatus.until) > Date.now();
  if (useGemini && force && paused) geminiCode = geminiStatus.code; // popup names the reason for the pause
  if (useGemini && (force || lines.some((l) => !gem(l))) && !paused) {
    const res = await gemini(lines, tl, geminiKey);
    geminiCode = res.out ? 'ok' : res.code;
    if (res.out) {
      lines.forEach((l, i) => { const c = cell(l); (c.g ||= {})[tl] = simplify(res.out[i]) === simplify(l) ? '' : res.out[i]; });
    } else if (res.code === 'mismatch') {
      (entry.noGemini ||= {})[tl] = 1; // this song stays on Google
      useGemini = false;
    }
    changed ||= !!res.out || res.code === 'mismatch';
    await setStatus(res);
  }

  // 2. Google: romanization for non-Latin lines, and translation for anything Gemini didn't cover.
  //    Forced: every line Gemini didn't cover is translated again, ignoring cached (possibly empty) translations.
  const ok = await google(lines.filter((l) => (!gem(l) && (force || !hasT(l))) || (NON_LATIN.test(l) && !(entry.lines[l] && 'r' in entry.lines[l]))), force);

  await persist(key, entry, changed);
  const results = {};
  for (const l of lines) {
    const c = entry.lines[l];
    const t = gem(l) ? c.g[tl] : c && c.t && tl in c.t ? c.t[tl] : undefined;
    if (t !== undefined) results[l] = { r: c.r || '', t };
  }
  return { ok, results, gemini: geminiCode };
}

// ---------- Gemini ----------
async function gemini(lines, tl, apiKey) {
  let lang = tl;
  try { lang = `${new Intl.DisplayNames(['en'], { type: 'language' }).of(tl)} (${tl})`; } catch (e) { /* keep code */ }
  const body = {
    systemInstruction: { parts: [{ text:
      `You translate song lyrics into ${lang}. Translate naturally and faithfully, keeping the meaning, tone and imagery, ` +
      'and use the context of the whole song. The input is a numbered list of lyric lines. Return a JSON array with exactly ' +
      `${lines.length} strings: one translation per input line, in the same order. Do not merge, split, add, drop or number lines. ` +
      `If a line is already in ${lang}, return it unchanged.` }] },
    contents: [{ role: 'user', parts: [{ text: lines.map((l, i) => `${i + 1}. ${l}`).join('\n') }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: { type: 'ARRAY', items: { type: 'STRING' }, minItems: lines.length, maxItems: lines.length },
    },
  };
  let res;
  try {
    res = await fetchT(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { code: e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'error' };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data && data.error) || {};
    const text = JSON.stringify(err);
    if (res.status === 429 || err.status === 'RESOURCE_EXHAUSTED') {
      const delay = /"retryDelay":"(\d+(?:\.\d+)?)s"/.exec(text);
      return { code: 'quota', retryMs: Math.max(60000, delay ? delay[1] * 1000 : 0) };
    }
    if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid/i.test(text)) return { code: 'badkey' };
    return { code: 'error' };
  }
  try {
    const parts = data.candidates[0].content.parts.filter((p) => !p.thought);
    const out = JSON.parse(parts.map((p) => p.text).join(''));
    if (Array.isArray(out) && out.length === lines.length && out.every((s) => typeof s === 'string')) return { out: out.map((s) => s.trim()) };
  } catch (e) { /* fall through */ }
  return { code: 'mismatch' };
}

// Last real Gemini outcome (shown in the popup; untouched when a song comes from the cache).
// Back off after errors: quota → retry delay (≥1 min), invalid key → until the key changes, others → 1 min.
async function setStatus(res) {
  const code = res.out ? 'ok' : res.code; // ok | quota | badkey | timeout | error | mismatch
  const wait = { quota: res.retryMs, badkey: 365 * 864e5, timeout: 60000, error: 60000 }[code] || 0;
  await chrome.storage.local.set({ geminiStatus: { code, at: Date.now(), until: wait ? Date.now() + wait : 0 } });
}

async function testKey(key) {
  if (!key) ({ geminiKey: key } = await chrome.storage.local.get('geminiKey'));
  if (!key) return { ok: false, error: 'No key saved.' };
  const res = await gemini(['こんにちは'], 'en', key);
  await setStatus(res);
  if (res.out) return { ok: true, message: `OK (${GEMINI_MODEL})` };
  return { ok: false, error: { quota: 'Quota or rate limit hit. Try again later.', badkey: 'The key was rejected.', timeout: 'No answer within 20 s.', mismatch: 'Unexpected reply.' }[res.code] || 'Request failed.' };
}

// ---------- Google Translate ----------
// Group lines by script (so the auto-detected language fits every line), then chunk by size.
function batches(lines) {
  const groups = {};
  for (const l of lines) (groups[scriptOf(l)] ||= []).push(l);
  if (groups.han && groups.kana) groups.kana.push(...groups.han.splice(0)); // kanji-only lines in a Japanese song
  const out = [];
  for (const g of Object.values(groups)) {
    let cur = [], size = 0;
    for (const l of g) {
      if (cur.length && size + l.length > MAX_CHARS) { out.push(cur); cur = []; size = 0; }
      cur.push(l); size += l.length + SEP.length;
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

// Translate a batch; if lines can't be mapped back 1:1, split the batch in halves and retry.
async function translate(lines, tl) {
  const res = parse(await request(lines, tl), lines.length);
  if (res || lines.length === 1) return res || { sl: '', t: [], r: [] };
  const mid = Math.ceil(lines.length / 2);
  const [a, b] = [await translate(lines.slice(0, mid), tl), await translate(lines.slice(mid), tl)];
  return { sl: a.sl || b.sl, t: [...pad(a.t, mid), ...b.t], r: [...pad(a.r, mid), ...b.r] };
}
const pad = (arr, n) => Array.from({ length: n }, (_, i) => arr[i] || '');

async function request(lines, tl) {
  const q = lines.map((l) => l.replace(/\|/g, '/')).join(SEP);
  let last;
  for (const base of GOOGLE) {
    try {
      const res = await fetchT(`${base}&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&dt=rm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: 'q=' + encodeURIComponent(q),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { last = e; }
  }
  throw last;
}

// Response: data[0] = segments; [trans, orig, ...] for translation, [null, null, null, romanization] for dt=rm.
function parse(data, n) {
  const segs = Array.isArray(data && data[0]) ? data[0] : [];
  const trans = segs.filter((s) => s && typeof s[0] === 'string').map((s) => s[0]).join('');
  const rom = segs.filter((s) => s && s[0] == null && typeof s[3] === 'string').map((s) => s[3]).join(' ');
  const split = (s) => (n === 1 ? [s.trim()] : s.split(/\s*\|\s*/).map((x) => x.trim()));
  const t = split(trans), r = rom ? split(rom) : [];
  if (t.length !== n || (rom && r.length !== n)) return null;
  return { sl: typeof data[2] === 'string' ? data[2] : '', t, r };
}

// ---------- Cache: song:<key> entries + a small LRU index {key: lastPlayed} ----------
async function persist(key, entry, changed) {
  const { idx = {} } = await chrome.storage.local.get('idx');
  idx[key] = Date.now();
  if (changed) entry.ts = idx[key]; // last time new results were stored (popup: "from cache" when played later)
  const over = Object.keys(idx).length - LIMITS.songs;
  if (over > 0) await evict(idx, over, key);
  if (!changed) return chrome.storage.local.set({ idx });
  const lineKeys = Object.keys(entry.lines);
  lineKeys.slice(0, Math.max(0, lineKeys.length - LIMITS.lines)).forEach((k) => delete entry.lines[k]);
  const data = { ['song:' + key]: entry, idx };
  try {
    await chrome.storage.local.set(data);
  } catch (e) { // most likely the ~10 MB quota: drop the oldest 10% and retry once
    await evict(idx, Math.max(1, Math.ceil(Object.keys(idx).length / 10)), key);
    try { await chrome.storage.local.set(data); } catch (e2) {
      console.warn('[lyrics-translate] cache write failed:', e2.message || e2);
      await chrome.storage.local.set({ idx }).catch(() => {});
    }
  }
}

async function evict(idx, n, keep) {
  const old = Object.keys(idx).filter((k) => k !== keep).sort((a, b) => idx[a] - idx[b]).slice(0, n);
  old.forEach((k) => delete idx[k]);
  if (old.length) await chrome.storage.local.remove(old.map((k) => 'song:' + k));
}
