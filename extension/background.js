// Background service worker: translation requests (Gemini with the user's key, or Google Translate), LRCLIB lyrics
// lookups (only for songs Amazon has no lyrics for) and the cache.
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
// A line is Latin unless it holds a LETTER of another script. Symbols, punctuation, emoji, digits (♪, curly quotes, dashes,
// fullwidth punctuation) and Common/Inherited-script letters (e.g. the modifier apostrophe U+02BC) never count.
const NON_LATIN = /[^\P{L}\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
// Cyrillic/Greek letters that look exactly like Latin ones. Lyrics sites sometimes have one typed into an English line
// (e.g. Cyrillic "е" U+0435 in an English word), which made the whole song look non-Latin before 1.3.3.
const LOOKALIKE = new Map('аa еe оo рp сc уy хx іi јj ѕs ԁd ԛq ԝw һh ӏl АA ВB ЕE КK МM НH ОO РP СC ТT ХX ІI ЈJ ЅS ҮY ΑA ΒB ΕE ΖZ ΗH ΙI ΚK ΜM ΝN ΟO ΡP ΤT ΥY ΧX οo ιi νv κk ρp'
  .split(' ').map((p) => [...p]));
// A mostly-Latin line whose only other-script letters are look-alikes → the same line with their Latin twins
// (used for the script test and sent to Google; the cache still keys the line as shown on the page).
function latinize(line) {
  const letters = [...line].filter((c) => /\p{L}/u.test(c));
  const foreign = letters.filter((c) => NON_LATIN.test(c));
  if (!foreign.length || foreign.length * 2 >= letters.length || !foreign.every((c) => LOOKALIKE.has(c))) return line;
  return [...line].map((c) => LOOKALIKE.get(c) || c).join('');
}
const isLatin = (l) => !NON_LATIN.test(latinize(l));
const scriptOf = (s) => (s = latinize(s), (SCRIPTS.find(([, re]) => re.test(s)) || [NON_LATIN.test(s) ? 'other' : 'latin'])[0]);
const MOSTLY = 0.25; // a song counts as mostly Latin when at most this share of its lines are in another script

const norm = (l) => (l || '').toLowerCase().replace(/^iw\b/, 'he');
const sameLang = (a, b) => {
  a = norm(a); b = norm(b);
  return a === b || (a.split('-')[0] === b.split('-')[0] && a.split('-')[0] !== 'zh');
};
const simplify = (s) => s.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
const fetchT = (url, opts) => fetch(url, { ...opts, credentials: 'omit', signal: AbortSignal.timeout(LIMITS.timeoutMs) });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const job = msg && msg.type === 'lyrics' ? handle(msg) : msg && msg.type === 'testKey' ? testKey(msg.key)
    : msg && msg.type === 'lrclib' ? lrclib(msg) : null;
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
  await chrome.storage.local.remove('lyricsBtnSeen'); // v1.3.0 detection state, no longer used
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
  if (force) { if (entry.noGemini) delete entry.noGemini[tl]; if (entry.mostly) delete entry.mostly[tl]; (entry.force ||= {})[tl] = 1; }
  let useGemini = !!geminiKey && translator !== 'google' && !(entry.noGemini && entry.noGemini[tl]);
  const latin = lines.filter(isLatin), other = lines.filter((l) => !isLatin(l));
  let mostly = !!(entry.mostly && entry.mostly[tl]); // mostly in the target language: Gemini only gets the non-Latin lines
  const forGem = (l) => useGemini && !(mostly && isLatin(l));
  const gem = (l) => forGem(l) && entry.lines[l] && entry.lines[l].g && tl in entry.lines[l].g;
  const hasT = (l) => entry.lines[l] && entry.lines[l].t && tl in entry.lines[l].t;
  let changed = !!force, geminiCode;

  // Google: romanization + translation (language detected per batch). Returns false if a request failed.
  const google = async (list, perLine) => {
    let ok = true;
    const single = perLine ? list.filter(isLatin) : [];
    for (const batch of [...batches(list.filter((l) => !single.includes(l))), ...single.map((l) => [l])]) {
      try {
        const res = await translate(batch.map(latinize), tl);
        batch.forEach((line, i) => {
          const c = cell(line);
          c.sl = res.sl;
          c.r = isLatin(line) ? '' : res.r[i] || '';
          const t = res.t[i] || '';
          c.t[tl] = sameLang(res.sl, tl) || simplify(t) === simplify(latinize(line)) ? '' : t;
        });
        changed = true;
      } catch (e) {
        ok = false;
        console.warn('[lyrics-translate] Google request failed, will retry later:', e.message || e);
      }
    }
    return ok;
  };

  // 0. Latin or mostly Latin song (at most a quarter of its lines in another script; symbols and look-alike letters don't
  //    count): detect the Latin lines' language with Google first (free), once per song and language (entry.chk) and again
  //    for new lines. That includes songs cached with Gemini before 1.3.3. Latin lines in the target language →
  //    no whole-song Gemini request, for replays too, and the Gemini status is left alone:
  //    - no other lines: nothing goes to Gemini (noGemini);
  //    - a few non-Latin lines (e.g. a Japanese phrase): only those go to the selected translator (mostly).
  //    This song's cached Gemini output for its Latin lines contradicts that and is dropped (other songs are untouched).
  //    If detection fails, Gemini is tried as usual.
  if (useGemini && !(entry.force && entry.force[tl]) && latin.length && other.length <= lines.length * MOSTLY
      && (!(entry.chk && entry.chk[tl]) || latin.some((l) => !hasT(l)))) {
    await google(latin.filter((l) => !hasT(l)));
    if (latin.every(hasT)) {
      (entry.chk ||= {})[tl] = 1;
      changed = true;
      if (latin.every((l) => sameLang(entry.lines[l].sl, tl))) {
        for (const l of latin) if (entry.lines[l].g) delete entry.lines[l].g[tl];
        if (other.length) { (entry.mostly ||= {})[tl] = 1; mostly = true; }
        else { (entry.noGemini ||= {})[tl] = 1; useGemini = false; }
      }
    }
  }

  // 1. Gemini: the whole song in one request, or only its non-Latin lines when it's mostly in the target language
  //    (skipped while backing off after an error).
  const paused = (geminiStatus && geminiStatus.until) > Date.now();
  const gemLines = lines.filter(forGem);
  if (useGemini && force && paused) geminiCode = geminiStatus.code; // popup names the reason for the pause
  if (useGemini && gemLines.length && (force || gemLines.some((l) => !gem(l))) && !paused) {
    const res = await gemini(gemLines, tl, geminiKey);
    geminiCode = res.out ? 'ok' : res.code;
    if (res.out) {
      gemLines.forEach((l, i) => { const c = cell(l); (c.g ||= {})[tl] = simplify(res.out[i]) === simplify(l) ? '' : res.out[i]; });
    } else if (res.code === 'mismatch') {
      (entry.noGemini ||= {})[tl] = 1; // this song stays on Google
      useGemini = false;
    }
    changed ||= !!res.out || res.code === 'mismatch';
    await setStatus(res);
  }

  // 2. Google: romanization for non-Latin lines, and translation for anything Gemini didn't cover.
  //    Forced: every line Gemini didn't cover is translated again, ignoring cached (possibly empty) translations.
  const ok = await google(lines.filter((l) => (!gem(l) && (force || !hasT(l))) || (!isLatin(l) && !(entry.lines[l] && 'r' in entry.lines[l]))), force);

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
  if (old.length) await chrome.storage.local.remove(old.flatMap((k) => ['song:' + k, 'lrc:' + k]));
}

// ---------- LRCLIB: lyrics for songs Amazon has none for ----------
// Only the song's title, artist and duration are sent (to lrclib.net, without cookies). LRCLIB asks clients to identify
// themselves; browsers don't let extensions set User-Agent, so its documented alternative header Lrclib-Client is used.
// Results share the song LRU: lrc:<key> = { id, dur, synced } | { id, dur, plain } (kept until evicted) | { none: 1, dur, until } (7 days).
const LRCLIB = 'https://lrclib.net/api';
const LRC_CLIENT = `Lyrics Translate & Romanize for Amazon Music v${chrome.runtime.getManifest().version} (https://github.com/NoodlesNom/lyrics-translate-for-amazon-music)`;
const LRC_NONE_MS = 7 * 864e5, LRC_MAX_DIFF = 3;
const lrcJobs = new Map();
let lrcPauseUntil = 0; // after a 429: honor Retry-After

async function lrclib({ key, title, artist, duration }) {
  if (!key || !title || !artist || !(duration > 0)) return { status: 'error' };
  const lk = 'lrc:' + key;
  const { [lk]: hit } = await chrome.storage.local.get(lk);
  // Same title/artist but another duration (e.g. a live version) is looked up again.
  if (hit && (!hit.none || hit.until > Date.now()) && !(Math.abs((hit.dur || duration) - duration) > LRC_MAX_DIFF)) {
    await touch(key);
    return lrcView(hit);
  }
  if (lrcPauseUntil > Date.now()) return { status: 'error', retryMs: lrcPauseUntil - Date.now() };
  if (!lrcJobs.has(key)) {
    lrcJobs.set(key, lrcLookup(title, artist, duration).then(async (rec) => {
      const dur = Math.round(duration);
      const value = rec ? (rec.syncedLyrics ? { id: rec.id, dur, synced: rec.syncedLyrics } : { id: rec.id, dur, plain: rec.plainLyrics }) : { none: 1, dur, until: Date.now() + LRC_NONE_MS };
      await storeLrc(key, value);
      return lrcView(value);
    }, (e) => ({ status: 'error', retryMs: e.retryMs || 0 })).finally(() => lrcJobs.delete(key)));
  }
  return lrcJobs.get(key);
}

function lrcView(v) {
  if (v.none) return { status: 'none' };
  if (v.synced) return { status: 'found', id: v.id, synced: parseLrc(v.synced), plain: null };
  return { status: 'found', id: v.id, synced: null, plain: (v.plain || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
}

// 1. /api/get with title, artist and duration (LRCLIB's own ±2 s match), checked again here.
// 2. If that finds nothing, or only unsynced lyrics: /api/search (title + first artist); only close matches count:
//    same normalized title and artist, duration within 3 s. Synced beats plain, then the closest duration.
async function lrcLookup(title, artist, duration) {
  let best = null;
  const got = await lrcFetch('/get', { track_name: title, artist_name: artist, duration: Math.round(duration) });
  if (lrcMatch(got, title, artist, duration)) best = got;
  if (best && best.syncedLyrics) return best;
  let list;
  try {
    list = await lrcFetch('/search', { track_name: title, artist_name: artists(artist)[0] || artist });
  } catch (e) {
    if (best) return best;
    throw e;
  }
  const cands = (Array.isArray(list) ? list : []).filter((r) => lrcMatch(r, title, artist, duration));
  cands.sort((a, b) => (!!b.syncedLyrics - !!a.syncedLyrics) || Math.abs(a.duration - duration) - Math.abs(b.duration - duration));
  if (cands[0] && (cands[0].syncedLyrics || !best)) best = cands[0];
  return best;
}

async function lrcFetch(path, params) {
  let res;
  try {
    res = await fetchT(`${LRCLIB}${path}?${new URLSearchParams(params)}`, { headers: { 'Lrclib-Client': LRC_CLIENT } });
  } catch (e) {
    throw Object.assign(new Error('network'), { retryMs: 0 });
  }
  if (res.status === 404) return null;
  if (res.status === 429) {
    const ra = Number(res.headers.get('Retry-After'));
    lrcPauseUntil = Date.now() + (ra > 0 ? ra * 1000 : 60000);
    throw Object.assign(new Error('rate limited'), { retryMs: lrcPauseUntil - Date.now() });
  }
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { retryMs: 0 });
  return res.json();
}

// Matching helpers: lowercase, no accents, "&" = "and", punctuation ignored; "(feat. …)" dropped from titles.
const fold = (s) => (s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ')
  .replace(/['\u2019`\u00b4]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const FEAT = /\s*[([]\s*(?:feat|ft|featuring|with)\b[^)\]]*[)\]]|\s+(?:feat|ft|featuring)\.?\s.*$/i;
const baseTitle = (t) => fold((t || '').replace(FEAT, '').replace(/\s+-\s+.*$/, '').replace(/\s*[([][^)\]]*[)\]]/g, ''));
const artists = (s) => (s || '').split(/\s*(?:,|&|\/|;|\+|\u3001|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*/i).map((a) => a.trim()).filter(Boolean);
function lrcMatch(r, title, artist, duration) {
  if (!r || r.instrumental || !(r.syncedLyrics || r.plainLyrics) || typeof r.duration !== 'number') return false;
  if (Math.abs(r.duration - duration) > LRC_MAX_DIFF) return false;
  const t1 = r.trackName || r.name || '';
  const sameTitle = fold(t1.replace(FEAT, '')) === fold(title.replace(FEAT, '')) || (!!baseTitle(title) && baseTitle(t1) === baseTitle(title));
  const a = artists(artist).map(fold), b = artists(r.artistName).map(fold);
  const sameArtist = fold(r.artistName) === fold(artist) || (!!a[0] && b.includes(a[0])) || (!!b[0] && a.includes(b[0]));
  return sameTitle && sameArtist;
}

// Synced LRC → [[seconds, text], ...] sorted by time. Handles several stamps per line, [offset:±ms] and word stamps.
function parseLrc(text) {
  let offset = 0;
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
    if (off) { offset = Number(off[1]) / 1000; continue; }
    const stamps = [];
    let rest = raw, m;
    while ((m = /^\s*\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/.exec(rest))) {
      stamps.push(Number(m[1]) * 60 + parseFloat(m[2].replace(':', '.')));
      rest = rest.slice(m[0].length);
    }
    const line = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim();
    for (const t of stamps) out.push([Math.max(0, Math.round((t - offset) * 1000) / 1000), line]);
  }
  out.sort((x, y) => x[0] - y[0]);
  while (out.length && !out[0][1]) out.shift(); // leading empty stamps
  return out;
}

async function touch(key) {
  const { idx = {} } = await chrome.storage.local.get('idx');
  idx[key] = Date.now();
  await chrome.storage.local.set({ idx });
}

async function storeLrc(key, value) {
  const { idx = {} } = await chrome.storage.local.get('idx');
  idx[key] = Date.now();
  const over = Object.keys(idx).length - LIMITS.songs;
  if (over > 0) await evict(idx, over, key);
  const data = { ['lrc:' + key]: value, idx };
  try {
    await chrome.storage.local.set(data);
  } catch (e) { // quota: drop the oldest 10% and retry once
    await evict(idx, Math.max(1, Math.ceil(Object.keys(idx).length / 10)), key);
    await chrome.storage.local.set(data).catch((e2) => console.warn('[lyrics-translate] LRCLIB cache write failed:', e2.message || e2));
  }
}
