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
// "Translate this song" (selected translator, Google if Gemini can't): enabled only when the active tab shows Amazon Music lyrics.
let tabId = null, busy = false;
async function findSong() {
  // In the page's floating panel (iframe) getCurrent() is the Amazon tab itself; in the toolbar popup it's undefined.
  const tab = (await chrome.tabs.getCurrent()) || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const song = tab && (await chrome.tabs.sendMessage(tab.id, { type: 'song' }).catch(() => null));
  tabId = song && song.key ? tab.id : null;
  $('force').disabled = busy || !tabId;
  const note = LRC_NOTES[(song && song.lrc) || ''];
  $('song').textContent = 'This song: ' + (tabId ? await describe(song) : note && !song.key ? note.song : 'no song. Open the lyrics view in Amazon Music.');
  $('lrcNote').hidden = !note;
  $('lrcNote').textContent = note ? note.text : '';
  $('lrcNote').dataset.kind = (song && song.lrc) || '';
}
// LRCLIB state for songs Amazon has no lyrics for (from the page; see lrcStatus() in content.js).
const LRC_NOTES = {
  synced: { text: 'Lyrics added from LRCLIB (synced)' },
  unsynced: { text: 'Lyrics added from LRCLIB (unsynced)' },
  'hidden-synced': { text: 'Lyrics from LRCLIB (synced), panel hidden for this song', song: 'lyrics panel hidden.' },
  'hidden-unsynced': { text: 'Lyrics from LRCLIB (unsynced), panel hidden for this song', song: 'lyrics panel hidden.' },
  pending: { text: 'Amazon has no lyrics; looking on LRCLIB…', song: 'no lyrics on Amazon.' },
  none: { text: 'Amazon has no lyrics; none found on LRCLIB', song: 'no lyrics on Amazon.' },
  error: { text: "Amazon has no lyrics; LRCLIB didn't answer, will retry", song: 'no lyrics on Amazon.' },
};

// "This song": detected language(s) + how its lines are translated, from the cache entry the background keeps.
const langName = (code) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code.replace(/^iw/, 'he').split('-')[0]); } catch (e) { return code; } };
async function describe({ key, lines, pending, failed }) {
  const { ['song:' + key]: entry = { lines: {} }, geminiKey, idx = {} } = await chrome.storage.local.get(['song:' + key, 'geminiKey', 'idx']);
  const tl = $('tl').value;
  const gemOn = !!geminiKey && $('translator').value === 'gemini' && !(entry.noGemini && entry.noGemini[tl]);
  const langs = {}, used = new Set();
  let served = 0;
  for (const l of lines) {
    const c = entry.lines[l] || {};
    const fromGem = gemOn && c.g && tl in c.g;
    const t = fromGem ? c.g[tl] : c.t && c.t[tl];
    const lang = c.sl || (t === '' ? tl : ''); // Gemini leaves lines already in the target language unchanged
    if (lang) langs[langName(lang)] = (langs[langName(lang)] || 0) + 1;
    if (t !== undefined) served++;
    if (t) used.add(fromGem ? 'Gemini' : 'Google');
  }
  const names = Object.keys(langs).sort((a, b) => langs[b] - langs[a]).slice(0, 3).join(' + ');
  const state = pending ? 'Translating…' : failed ? 'Some lines failed, retrying' : !served ? 'Not translated yet'
    : !used.size ? `Already in ${langName(tl)}, no translation needed`
    : `Translated with ${['Gemini', 'Google'].filter((x) => used.has(x)).join(' + ')}` + (idx[key] - (entry.ts || 0) > 3000 ? ' (from cache)' : '');
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

let timer = 0;
const refresh = () => { clearTimeout(timer); timer = setTimeout(render, 100); };

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
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'sync' && changes.translator) await showTranslator(changes.translator.newValue);
    refresh();
    findSong();
  });
  setInterval(render, 30000); // keeps "last reply … ago" current
  setInterval(findSong, 1000); // follows song changes and in-flight requests in the Amazon tab
})();
$('tl').addEventListener('change', (e) => { chrome.storage.sync.set({ tl: e.target.value }); refresh(); });
$('translator').addEventListener('change', (e) => { chrome.storage.sync.set({ translator: e.target.value }); refresh(); });
$('size').addEventListener('change', (e) => chrome.storage.sync.set({ size: Number(e.target.value) }));
for (const k of TOGGLES) $(k).addEventListener('change', (e) => chrome.storage.sync.set({ [k]: e.target.checked }));
if (window.top !== window) addEventListener('keydown', (e) => { if (e.key === 'Escape') parent.postMessage('amlt-close', 'https://music.amazon.com'); });
$('settings').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
