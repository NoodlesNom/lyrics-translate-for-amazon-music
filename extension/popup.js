'use strict';
const DEFAULTS = { tl: 'en', rom: true, trans: true, orig: false, translator: '', size: 1, float: true, lrclib: true };
const TOGGLES = ['rom', 'trans', 'orig', 'float', 'lrclib'];
const FALLBACK = { quota: 'quota hit', timeout: 'timed out', error: 'error', mismatch: 'unexpected reply', badkey: 'rejected the key' };
const $ = (id) => document.getElementById(id);

const ago = (ms) => {
  const m = Math.floor(ms / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
};
const size = (b) => (b < 100 * 1024 ? `~${Math.max(1, Math.round(b / 1024))} KB` : `~${(b / 1048576).toFixed(1)} MB`);

// Gemini indicator + saved-songs counter, from chrome.storage.local (status written by background.js).
async function render() {
  const all = await chrome.storage.local.get(null);
  const st = all.geminiStatus;
  let state = 'gray', label;
  if ($('translator').value === 'google') label = 'Off (Google selected)';
  else if (!all.geminiKey) label = 'No key';
  else if (!st) label = 'Not used yet';
  else if (st.code === 'ok') { state = 'green'; label = `Gemini working · last reply ${ago(Date.now() - st.at)}`; }
  else if (st.code === 'badkey') { state = 'red'; label = 'Invalid key'; }
  else { state = 'amber'; label = `Using Google (${FALLBACK[st.code] || 'error'})`; }
  $('gstate').dataset.state = state;
  $('glabel').textContent = label;

  // Per translator = songs whose every cached line has a translation from it in the selected language.
  const tl = $('tl').value;
  const songs = Object.keys(all).filter((k) => k.startsWith('song:')).map((k) => Object.values(all[k].lines || {}));
  const full = (f) => songs.filter((ls) => ls.length && ls.every((c) => c[f] && tl in c[f])).length;
  const bytes = await chrome.storage.local.getBytesInUse(null);
  const saved = Object.keys(all.idx || {}).filter((k) => !(all['lrc:' + k] && all['lrc:' + k].none && !all['song:' + k])).length; // LRCLIB "not found" markers aren't songs
  $('counter').textContent = `Saved songs: ${saved} (Gemini ${full('g')} · Google ${full('t')}) · ${size(bytes)}`;
}
// "Translate this song" (selected translator, Google if Gemini can't): enabled only when the active tab shows lyric lines
// (Amazon's lyrics in the full view, or LRCLIB lyrics shown there). "This song" names the mini-player's song whenever one is playing.
let tabId = null, busy = false;
async function findSong() {
  // In the page's floating panel (iframe) getCurrent() is the Amazon tab itself; in the toolbar popup it's undefined.
  const tab = (await chrome.tabs.getCurrent()) || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const song = tab && (await chrome.tabs.sendMessage(tab.id, { type: 'song' }).catch(() => null));
  tabId = song && song.key ? tab.id : null;
  $('force').disabled = busy || !tabId;
  const name = song && song.title ? song.title + (song.artist ? ' by ' + song.artist : '') : '';
  const detail = tabId ? await describe(song) : '';
  showSong(name, detail);
  const kind = noteKind(song);
  $('lrcNote').hidden = !kind;
  $('lrcNote').textContent = romanNote(song, kind) || NOTES[kind] || '';
  $('lrcNote').dataset.kind = kind;
}
// "This song: <title> by <artist>" (at most 2 lines, full text in the tooltip), then the language/translation state on its
// own line. The element's text stays "This song: <title> by <artist> · <state>" (the separator is only hidden visually).
function showSong(name, detail) {
  const el = $('song'), text = 'This song: ' + ([name, detail].filter(Boolean).join(' · ') || 'nothing playing in Amazon Music.');
  if (el.textContent === text) return;
  el.title = name ? text : '';
  if (!name) { el.textContent = text; return; }
  const span = (className, textContent) => Object.assign(document.createElement('span'), { className, textContent });
  el.replaceChildren(span('t', 'This song: ' + name), ...(detail ? [span('sep', ' · '), span('d', detail)] : []));
}
// Where this song's lyrics come from (see lyricsState() and lrcStatus() in content.js). Hidden while Amazon's own lines are shown.
const NOTES = {
  amazon: 'Amazon has lyrics: open the lyrics view to translate them',
  checking: 'Checking for lyrics…',
  off: 'Amazon has no lyrics (finding lyrics on LRCLIB is off)',
  synced: 'Lyrics added from LRCLIB (synced)',
  unsynced: 'Lyrics added from LRCLIB (unsynced)',
  'synced-closed': 'Lyrics added from LRCLIB (synced) \u00b7 open the full view to see them',
  'unsynced-closed': 'Lyrics added from LRCLIB (unsynced) \u00b7 open the full view to see them',
  pending: 'Amazon has no lyrics; looking on LRCLIB…',
  none: 'Amazon has no lyrics; none found on LRCLIB',
  error: "Amazon has no lyrics; LRCLIB didn't answer, will retry",
};
// v1.3.6: LRCLIB only had a romanization (romaji, Korean romanization, pinyin); shown while those lyrics are on screen.
const ROMAN_GUESS = { gemini: ' · original script guessed by Gemini', local: ' · original: hiragana guess' };
function romanNote(s, kind) {
  const r = s && s.roman;
  if (!r || !r.lang || (kind !== 'synced' && kind !== 'unsynced')) return '';
  const guess = r.guess ? ROMAN_GUESS[r.guess] || '' : r.guess === '' && r.lang !== 'ja' ? ' · translation and original need Gemini' : '';
  return `LRCLIB lyrics were already romanized (${langName(r.lang)})${guess}${kind === 'unsynced' ? ' · not synced' : ''}`;
}
function noteKind(s) {
  if (!s) return '';
  if (s.key) return s.source === 'lrclib' ? s.lrc || '' : '';
  if (s.lyrics === 'none') return s.lrc || ($('lrclib').checked ? 'pending' : 'off');
  return s.lyrics === 'amazon' || s.lyrics === 'checking' ? s.lyrics : '';
}

// "This song": detected language(s) + how its lines are translated, from the cache entry the background keeps.
const langName = (code) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code.replace(/^iw/, 'he').split('-')[0]); } catch (e) { return code; } };
const sameLang = (a, b) => { [a, b] = [a, b].map((x) => x.toLowerCase().replace(/^iw\b/, 'he')); return a === b || (a.split('-')[0] === b.split('-')[0] && a.split('-')[0] !== 'zh'); };
async function describe({ key, lines, pending, failed, roman }) {
  const { ['song:' + key]: entry = { lines: {} }, geminiKey, idx = {} } = await chrome.storage.local.get(['song:' + key, 'geminiKey', 'idx']);
  const tl = $('tl').value;
  const gemOn = !!geminiKey && $('translator').value === 'gemini' && !(entry.noGemini && entry.noGemini[tl]);
  const langs = {}, used = new Set();
  let served = 0, translated = 0, untranslated = 0; // untranslated: lines in another language without a translation
  for (const l of lines) {
    const c = entry.lines[l] || {};
    const fromGem = gemOn && c.g && tl in c.g;
    const t = fromGem ? c.g[tl] : c.t && c.t[tl];
    const lang = c.sl || (t === '' ? tl : ''); // Gemini leaves lines already in the target language unchanged
    if (lang) langs[langName(lang)] = (langs[langName(lang)] || 0) + 1;
    if (t !== undefined) served++;
    if (t) { used.add(fromGem ? 'Gemini' : 'Google'); translated++; }
    else if (t === '' && c.sl && !sameLang(c.sl, tl)) untranslated++;
  }
  const names = Object.keys(langs).sort((a, b) => langs[b] - langs[a]).slice(0, 3).join(' + ');
  const by = ['Gemini', 'Google'].filter((x) => used.has(x)).join(' + ');
  const cached = idx[key] - (entry.ts || 0) > 3000 ? ' (from cache)' : '';
  // Mostly in the target language (at most a quarter of the lines needed translating, e.g. a Japanese phrase in an English song).
  const state = pending ? 'Translating…' : failed ? 'Some lines failed, retrying' : !served ? 'Not translated yet'
    // romanized LRCLIB lyrics (1.3.6) are never "already in" the target language: their lines just got no translation
    : !used.size && untranslated && roman && roman.lang ? 'Romanized lyrics, no translation available'
    : !used.size ? `Already in ${langName(tl)}, no translation needed`
    : translated * 4 <= served ? `Mostly ${langName(tl)} · translated ${translated} line${translated === 1 ? '' : 's'} with ${by}${cached}`
    : `Translated with ${by}${cached}`;
  return (names ? names + ' · ' : '') + state;
}
const say = (text) => { $('forceMsg').textContent = text; };
$('force').addEventListener('click', async () => {
  $('force').disabled = busy = true;
  say('Translating…');
  const res = await chrome.tabs.sendMessage(tabId, { type: 'force' }).catch(() => null);
  const code = res && res.gemini;
  say(!res || !('ok' in res) ? "Couldn't reach the page. Reload it and try again."
    : code === 'ok' ? 'Done: translated with Gemini.'
    : !res.ok ? 'Google Translate failed. Try again in a minute.'
    : code ? `Gemini ${FALLBACK[code] || 'error'}, so translated with Google.` : 'Done: translated with Google.');
  busy = false;
  $('force').disabled = !tabId;
});

// Update notice: unpacked copies only. background.js answers { store: true } for store copies (and never contacts GitHub
// for them), and then nothing of this is shown.
const UPD_ERR = { offline: "Couldn't reach GitHub. Check your connection and try again.", ratelimit: 'GitHub is limiting requests right now. Try again later.',
  http: "Couldn't read the latest version from GitHub.", none: 'No releases published yet.' };
$('updCur').textContent = 'v' + chrome.runtime.getManifest().version;
$('updPage').textContent = /\bEdg\//.test(navigator.userAgent) ? 'edge://extensions' : 'chrome://extensions';
function showUpdate(u, msg) {
  const on = !!u && u.store === false;
  $('updRow').hidden = $('updPriv').hidden = !on;
  $('updNew').hidden = !(on && u.newer);
  if (!on) return;
  if (u.newer) { $('updVer').textContent = 'v' + u.latest; $('updLink').href = u.url; }
  if (msg === 'click') {
    const text = u.err ? UPD_ERR[u.err] || UPD_ERR.http : u.newer ? `Update available: v${u.latest}` : `You're up to date (v${u.current})`;
    $('updMsg').textContent = u.reused ? `Checked just now · ${text}` : text;
  } else if (msg === 'open') $('updMsg').textContent = u.at ? `Last checked ${ago(Date.now() - u.at)}` : '';
}
const loadUpdate = async (msg) => showUpdate(await chrome.runtime.sendMessage({ type: 'update' }).catch(() => null), msg);
$('updBtn').addEventListener('click', async () => {
  $('updBtn').disabled = true;
  $('updMsg').textContent = 'Checking…';
  const u = await chrome.runtime.sendMessage({ type: 'update', manual: true }).catch(() => null);
  $('updBtn').disabled = false;
  if (u) showUpdate(u, 'click'); else $('updMsg').textContent = "Couldn't check right now. Try again.";
});

// After the extension is reloaded or updated, a floating panel still open in an Amazon tab is left over from the old copy:
// its chrome.* calls throw "Extension context invalidated". It then stops its timers quietly instead of filling the
// Errors list (refreshing the Amazon tab brings back a working panel).
const alive = () => { try { return !!chrome.runtime.id; } catch (e) { return false; } };
const intervals = [];
const every = (fn, ms) => intervals.push(setInterval(() => {
  if (!alive()) { intervals.forEach(clearInterval); clearTimeout(timer); return; }
  Promise.resolve().then(fn).catch(() => {});
}, ms));
let timer = 0;
const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { if (alive()) render().catch(() => {}); }, 100); };

// Default translator: Gemini when a key is saved, else Google.
const showTranslator = async (value) => {
  const { geminiKey } = await chrome.storage.local.get('geminiKey');
  $('translator').value = value || (geminiKey ? 'gemini' : 'google');
};

(async () => {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('tl').value = s.tl;
  await showTranslator(s.translator);
  for (const k of TOGGLES) $(k).checked = s[k];
  $('size').value = String(s.size);
  render();
  findSong();
  loadUpdate('open');
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && changes.upd) loadUpdate();
    if (area === 'sync' && changes.translator) await showTranslator(changes.translator.newValue);
    refresh();
    findSong();
  });
  every(render, 30000); // keeps "last reply … ago" current
  every(findSong, 1000); // follows song changes and in-flight requests in the Amazon tab
})();
$('tl').addEventListener('change', (e) => { chrome.storage.sync.set({ tl: e.target.value }); refresh(); });
$('translator').addEventListener('change', (e) => { chrome.storage.sync.set({ translator: e.target.value }); refresh(); });
$('size').addEventListener('change', (e) => chrome.storage.sync.set({ size: Number(e.target.value) }));
for (const k of TOGGLES) $(k).addEventListener('change', (e) => chrome.storage.sync.set({ [k]: e.target.checked }));
// In the page's floating panel (iframe): Esc closes it, and the panel is sized to fit the content (content.js caps it to
// the window; below that cap only #main scrolls).
if (window.top !== window) {
  document.documentElement.classList.add('in-panel');
  addEventListener('keydown', (e) => { if (e.key === 'Escape') parent.postMessage('amlt-close', 'https://music.amazon.com'); });
  new ResizeObserver(() => parent.postMessage({ amlt: 'height', h: Math.ceil(document.querySelector('.top').offsetHeight + $('main').scrollHeight) }, 'https://music.amazon.com')).observe($('content'));
}
$('settings').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
