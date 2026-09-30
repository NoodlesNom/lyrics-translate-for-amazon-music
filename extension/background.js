// Background service worker: translation requests (Gemini with the user's key, or Google Translate), LRCLIB lyrics
// lookups (only for songs Amazon has no lyrics for), the cache, and (unpacked copies only) the update check.
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
// ---------- Romanized lyrics (v1.3.6): LRCLIB sometimes has only a romanization (Latin letters) of a Japanese, Korean or
// Chinese song. detectRoman(lines) → { lang: 'ja' | 'ko' | 'zh' | '', lines: [the romanized lines] }.
// Per word: does it split fully into syllables of Hepburn/kunrei romaji, Revised Romanization, or pinyin? Per line: a
// line is a candidate when at least 2/3 of its words split and under 30% are common English/Romance words. Per song: at
// least half the lines (and 3) must be candidates, AND the candidate lines need language-specific evidence: frequent
// function/common words of that language that are not English words (wa/ga/wo/kimi/kokoro… · naega/neoui/saranghae… ·
// wo/ni/de/xiang/zhe…) plus structural marks (tsu/shi/kya, long vowels/macrons, no word ending in a consonant other than n ·
// eo/eu/ae digraphs, words ending in ng/l/k · x/q/zh initials, iang/iong, tone marks). English songs fail the English-word
// share and lack those words, so they aren't flagged even when many of their words happen to split into syllables.
const ROMAN_IGNORE = new Set('oh ooh ohh ah ahh aah yeah yeh ya hey eh uh huh hmm mm mmm ha haha la lalala whoa woah wow ay ayy yo woo ooo'.split(' '));
const ROMAN_FOREIGN = new Set(('the and you your yours you\'re i i\'m im i\'ve ive i\'ll ill i\'d my mine me\'s it it\'s its is are was were be been am ' +
  'of in on at for with from by up down out over into onto this that these those there their they them then than what when where who why how ' +
  'all just can can\'t cant don\'t dont won\'t wont will would could should not never ever every love loving lover heart night day days time ' +
  'baby know like want need feel see look come came gone going get got give take make made let say said tell think thought keep hold ' +
  'if but or because cause so\'s our ours us we\'re she he\'s his her him one only still again away back here now more some something ' +
  'nothing anything everything world life eyes hands home light dark fire rain sky sun moon dream dreams alone together forever tonight ' +
  'way right left long little much many over under around through without with within have has had do does did doing been being ' +
  'que el los las y en por para con sin mi tu yo su lo del al una uno pero como cuando donde amor vida corazón corazon quiero siempre nunca ' +
  'il di che non per sono ti amo io mio mia tuo cuore sempre ancora questa questo le les et est pas moi toi un une des du je suis avec dans ' +
  'você nao não meu minha eu com para um uma é és está ich du und nicht der die das ist mein dein').split(' '));
const RE_JA = /^(?:(?:ky|gy|sh|sy|ch|cy|ty|jy|zy|dy|ny|hy|by|py|my|ry|ts|[kgsztdnhbpmrfvj])?[aiueo]|y[auo]|w[aoie]|n(?![aiueoy])|([kgsztdhbpmfcj])(?=\1)|t(?=ch))+$/;
const RE_KO = /^(?:(?:kk|tt|pp|ss|jj|ch|sh|[gkndtrlmbpsjh])?(?:yae|yeo|wae|ae|ya|eo|ye|wa|oe|yo|wo|we|wi|yu|eu|ui|a|e|o|u|i)(?:ng|ll|[kntlmpgbd](?![aeiouwy]))?)+$/;
const RE_ZH = /^(?:[jqx](?:iang|iong|ian|iao|ing|ia|ie|iu|in|i|uan|un|ue|u)|(?:zh|ch|sh|[bpmfdtnlgkhrzcsyw])?(?:iang|iong|uang|ang|eng|ing|ong|ian|iao|uai|uan|ai|ei|ao|ou|an|en|in|un|ia|ie|iu|ua|uo|ui|ue|er|a|o|e|i|u|v))+$/;
const ROMAN = {
  ja: { re: RE_JA, words: new Set(('wa ga wo ni mo ne yo ka tte kimi boku ore watashi atashi anata omae kokoro sekai yume sora ai koi namida ' +
    'hikari kaze hoshi tsuki yoru asa ashita kyou kinou itsumo zutto mada mou motto kitto dake nai naka hitori futari issho mune koe hana ' +
    'ame toki kono sono ano nani doko itsu dare suki daisuki sayonara arigatou desu masu deshita shite iru aru naru kara demo dakara sore ' +
    'kore soshite mitai yori nara tabi michi basho omoi omoide egao kotoba mirai ima mata sugu tsuyoku yasashii kanashii sabishii aitai ' +
    'dakishimete kanojo kare zo ze shinai shiranai wakaranai kimochi mieru kikoeru mitsumete wasurenai hajimete owari nanda nandemo ' +
    'dokomade tomo naze nante koto mono hito sagashite yukkuri mamoru shinjite tsutaetai negai inori kagayaku kienai tte shi wo ga ne').split(' ')),
    mark: /tsu|shi|chi|[kgnhbpmr]y[auo]|([kstp])\1|ou$|uu|ii|oo|aa/ },
  ko: { re: RE_KO, words: new Set(('naega nega neoui naui neo nae uri urin saranghae saranghae saranghaeyo sarang haru geudae maeum oneul nuneul ' +
    'jeongmal gachi hamkke eopseo eobseo isseo dasi modeun ije geu hana nal mal bogo sipeo sipda neomu jom chaja achim bam haneul byeol ' +
    'kkum nunmul gieok yeogi jigeum eonjena hangsang cheoeum majimak nareul neoreul nado neodo neon nan geureon ireon eotteoke wae ' +
    'nuga mwo mwoya eodi eonje hajiman geurigo geuraeseo jebal gwaenchana annyeong haengbok apa apeun gidaryeo tteonaji tteona ' +
    'saranghandago bogoshipda bogosipeo gomawo mianhae naegen neoege nae ne').split(' ')),
    mark: /eo|eu|ae|ui|[^n]g$|ng$|[lkpm]$/ },
  zh: { re: RE_ZH, words: new Set(('wo ni ta de shi bu le zai ai xiang women nimen tamen zhe zhege nage shenme weishenme meiyou yige ' +
    'xin tian kan ting shuo zhidao xihuan aiqing yongyuan hai yao hui jiu dou ba ne zhi rang gei dui gen xia li qu lai dao guo zhong ' +
    'ren sheng meng feng yu hua yue liang suo yi qi ru ruguo keyi kaixin shijie shiguang yiqi huiyi xingfu wenrou qingchu mingtian ' +
    'zuotian jintian yijing haishi zhiyou buyao bushi keshi danshi yinwei suoyi dengdai sinian xiangnian zhen de xiaoshi yan lei').split(' ')),
    mark: /^(?:x|q|zh)|iang|iong|uang|ian|iao|ong$|ui$|uo$|iu$/ },
};

function romanWords(line) {
  const out = [];
  let marks = '';
  for (let w of line.normalize('NFD').toLowerCase().split(/[^\p{L}\p{M}'\u2019]+/u)) {
    if (!w) continue;
    if (/\u030c/.test(w) || /[aeiou][\u0301\u0300]/.test(w)) marks += 'z'; // caron or acute/grave on a vowel: pinyin tones
    if (/[aeiou][\u0304\u0302]/.test(w)) marks += 'j';                        // macron/circumflex: Hepburn long vowels (or pinyin tone 1)
    w = w.replace(/o\u0304|o\u0302/g, 'ou').replace(/([aeiu])[\u0304\u0302]/g, '$1$1').replace(/\p{M}/gu, '').replace(/['\u2019]/g, (m, i, s) => (i > 0 && i < s.length - 1 ? '\'' : ''));
    if (!/^\p{L}[\p{L}']*$/u.test(w) || ROMAN_IGNORE.has(w)) continue;
    out.push(w);
  }
  return { words: out, marks };
}

function detectRoman(lines) {
  const none = { lang: '', lines: [] };
  const info = lines.filter((l) => l && /\p{L}/u.test(l) && !NON_LATIN.test(latinize(l))).map((l) => ({ l, ...romanWords(l) })).filter((x) => x.words.length);
  const lettered = lines.filter((l) => l && /\p{L}/u.test(l)).length;
  if (info.length < 3 || info.length < lettered * 0.9) return none; // lines in another script: not a romanized song
  const isEng = ({ words }) => words.filter((w) => ROMAN_FOREIGN.has(w)).length >= words.length * 0.3;
  const eng = info.filter(isEng).length;
  let best = null;
  for (const [lang, L] of Object.entries(ROMAN)) {
    const cand = info.filter((x) => !isEng(x) && x.words.filter((w) => !w.includes('\'') && L.re.test(w)).length >= x.words.length * 2 / 3);
    // at least half the lines that aren't English (romanized songs often have English lines), and a quarter of all lines
    if (cand.length < 3 || cand.length < (info.length - eng) * 0.5 || cand.length < info.length * 0.25) continue;
    const ws = cand.flatMap((x) => x.words);
    const share = (f) => ws.filter(f).length / ws.length;
    const dict = share((w) => L.words.has(w)), mark = share((w) => L.mark.test(w));
    if (new Set(ws.filter((w) => L.words.has(w))).size < 3) continue; // several different words of that language, not one repeated
    const tones = cand.map((x) => x.marks).join('');
    let score = dict + mark * 0.5;
    if (lang === 'ja') {
      if (share((w) => /[^aeioun]$/.test(w)) > 0.1) continue; // Japanese words end in a vowel or n (a few loanwords aside)
      if (/z/.test(tones)) score -= 0.2;
      if (/j/.test(tones)) score += 0.1;
    } else if (lang === 'ko') {
      if (share((w) => /eo|eu/.test(w)) < 0.04 && dict < 0.15) continue; // eo/eu is the signature of Revised Romanization
    } else if (lang === 'zh') {
      if (/z/.test(tones)) score += 0.3;
      if (share((w) => /^(?:x|q|zh)/.test(w) || /iang|iong|uang/.test(w)) < 0.03 && !/z/.test(tones) && dict < 0.3) continue;
    }
    if (dict < 0.1 && !(dict >= 0.05 && mark >= 0.25)) continue;
    // every line with words that isn't English counts as romanized (lines with a loanword or a spelling the syllable test misses too),
    // and so does a MIXED line (romanized words + an English phrase, 1.3.6): a word of the language's list that isn't
    // English, or two romanized-looking words that aren't English, one of them 5+ letters. Only true English lines are left.
    const mixed = ({ words }) => {
      const r = words.filter((w) => !ROMAN_FOREIGN.has(w) && !w.includes('\'') && L.re.test(w));
      return r.some((w) => L.words.has(w)) || (r.length >= 2 && r.some((w) => w.length >= 5));
    };
    if (!best || score > best.score) best = { lang, score, lines: info.filter((x) => !isEng(x) || mixed(x)).map((x) => x.l) };
  }
  return best && best.score >= 0.15 ? { lang: best.lang, lines: [...new Set(best.lines)] } : none;
}

// Local fallback for the "Original lyrics" line of romanized JAPANESE songs without Gemini: romaji → hiragana, word by
// word (a word that isn't romaji, or is a common English word, stays as it is). Only a guess: no kanji, and of the
// particles only a lone "wa" → は and "wo" → を; shown only with "Original lyrics" on and marked as a guess.
const KANA_ROWS = { '': 'あいうえお', k: 'かきくけこ', g: 'がぎぐげご', s: 'さしすせそ', z: 'ざじずぜぞ', t: 'たちつてと', d: 'だぢづでど',
  n: 'なにぬねの', h: 'はひふへほ', b: 'ばびぶべぼ', p: 'ぱぴぷぺぽ', m: 'まみむめも', r: 'らりるれろ', f: 'ふぁ ふぃ ふ ふぇ ふぉ', v: 'ゔぁ ゔぃ ゔ ゔぇ ゔぉ' };
const KANA = new Map();
for (const [c, row] of Object.entries(KANA_ROWS)) {
  const cells = row.includes(' ') ? row.split(' ') : [...row];
  'aiueo'.split('').forEach((v, i) => KANA.set(c + v, cells[i]));
}
Object.entries({ ya: 'や', yu: 'ゆ', yo: 'よ', wa: 'わ', wo: 'を', wi: 'うぃ', we: 'うぇ', shi: 'し', chi: 'ち', tsu: 'つ', ji: 'じ', fu: 'ふ',
  she: 'しぇ', che: 'ちぇ', je: 'じぇ', ti: 'ち', tu: 'つ', si: 'し', zi: 'じ', hu: 'ふ', di: 'ぢ', du: 'づ' }).forEach(([k, v]) => KANA.set(k, v));
for (const [c, i] of Object.entries({ ky: 'き', gy: 'ぎ', ny: 'に', hy: 'ひ', by: 'び', py: 'ぴ', my: 'み', ry: 'り', sh: 'し', sy: 'し', ch: 'ち', cy: 'ち', ty: 'ち', j: 'じ', jy: 'じ', zy: 'じ', dy: 'ぢ' })) {
  KANA.set(c + 'a', i + 'ゃ'); KANA.set(c + 'u', i + 'ゅ'); KANA.set(c + 'o', i + 'ょ');
}
function wordToKana(w) {
  let out = '';
  for (let i = 0; i < w.length;) {
    const c = w[i], nx = w[i + 1];
    if (c === 'n' && (nx === undefined || nx === '\'' || !/[aiueoy]/.test(nx))) { out += 'ん'; i += nx === '\'' ? 2 : 1; continue; }
    if (nx && c === nx && /[kgsztdhbpmfcj]/.test(c)) { out += 'っ'; i++; continue; }
    if (c === 't' && nx === 'c') { out += 'っ'; i++; continue; }
    const hit = [3, 2, 1].map((n) => w.slice(i, i + n)).find((k) => KANA.has(k));
    if (!hit) return null;
    out += KANA.get(hit); i += hit.length;
  }
  return out;
}
const KANA_AMBIG = new Set(['made', 'are']); // English words that are also frequent romaji (まで, あれ): converted
// Mixed lines (romaji + an English phrase, 1.3.6): short romaji-looking words (up to 3 letters, e.g. "me", "go", "we")
// next to English words stay English unless they are Japanese particles/words between kana; a common English/Spanish
// word that is a Japanese word too (e.g. "yo") becomes kana between kana words. Punctuation separates phrases.
function toHiragana(line) {
  const parts = line.split(/([^\p{L}\p{M}'\u2019]+)/u);
  const ja = ROMAN.ja.words;
  const words = parts.map((p, i) => {
    if (i % 2) return null;
    const w = p.normalize('NFD').toLowerCase().replace(/o[\u0304\u0302]/g, 'ou').replace(/([aeiu])[\u0304\u0302]/g, '$1$1').replace(/\p{M}/gu, '').replace(/\u2019/g, '\'');
    if (!w) return null;
    const conv = w === 'wa' ? 'は' : RE_JA.test(w.replace(/'/g, '')) ? wordToKana(w) : null;
    const foreign = ROMAN_FOREIGN.has(w) && !KANA_AMBIG.has(w);
    return { w, conv, foreign, kana: !!conv && !foreign };
  });
  // neighbours of word i in the same phrase (only spaces between them)
  const near = (i) => [i - 2, i + 2].filter((j) => words[j] && /^\s+$/.test(parts[(i + j) / 2]));
  for (let changed = true; changed;) {
    changed = false;
    words.forEach((x, i) => {
      if (!x || !x.conv) return;
      const n = near(i), eng = n.filter((j) => !words[j].kana).length, kana = n.length - eng;
      let k = x.kana;
      if (x.kana && x.w.length <= 3 && x.w !== 'wa' && eng && (!kana || !ja.has(x.w))) k = false;       // "let me go"
      else if (!x.kana && x.foreign && ja.has(x.w) && n.length && !eng) k = true;                        // "... iranai yo"
      if (k !== x.kana) { x.kana = k; changed = true; }
    });
  }
  // kana words are joined without spaces; spaces stay around words that were left in Latin letters
  let s = '';
  parts.forEach((p, i) => {
    if (!(i % 2)) { s += words[i] && words[i].kana ? words[i].conv : p; return; }
    if (/^\s+$/.test(p) && words[i - 1] && words[i - 1].kana && words[i + 1] && words[i + 1].kana) return;
    s += p;
  });
  return s.trim();
}

const simplify = (s) => s.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
const fetchT = (url, opts) => fetch(url, { ...opts, credentials: 'omit', signal: AbortSignal.timeout(LIMITS.timeoutMs) });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  autoCheckSoon(); // unpacked copies: the daily update check piggybacks on normal activity (no alarms permission)
  const job = msg && msg.type === 'lyrics' ? handle(msg) : msg && msg.type === 'testKey' ? testKey(msg.key)
    : msg && msg.type === 'lrclib' ? lrclib(msg) : msg && msg.type === 'update' ? updateInfo(msg.manual) : msg && msg.type === 'gstate' ? gState() : null;
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
  await applyBadge(); // after an update the versions may match now: clear the badge
});

// lines = all unique lyric lines of the current song, in order.
// force = popup button "Translate this song": clear the skip flag, never language-skip this song again, and
// translate it afresh with the selected translator (Gemini unless paused; Google re-detects each Latin line on its own).
// roman (v1.3.6, LRCLIB songs only) = { lang, lines }: the lyrics are a romanization (detectRoman) and these lines are
// romanized. Those lines are translated as romaji/RR/pinyin, never language-skipped, and get an "original script" guess
// (o): from Gemini (same request, which also names the language and overrides the guess, "none" = not romanized after
// all), else for Japanese a local hiragana guess; Korean/Chinese get none without Gemini.
// Google can't translate a romanization: sent as is (auto-detected, or even with the language named) it comes back
// unchanged or nearly so, which left romanized songs without a translation. So romanized lines go to Google as the local
// hiragana guess with sl=ja (Japanese; Google translates that), and as the romanization with the language named for
// Korean/Chinese (usually still unchanged: those songs get their translation from Gemini). An answer that is still
// (nearly) the input is dropped (romTranslated), and the line shows its romanization as the main line.
// ROMAN_VER 4: song entries of romanized songs made before (1.3.5, or 1.3.6 test builds that stored the echoed romaji as
// "no translation", or took mixed romaji + English lines for English) are dropped and translated again.
const ROMAN_VER = 4;
const ROMAN_SL = { ja: 'ja', ko: 'ko', zh: 'zh-CN' };
const plainWords = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
function romTranslated(t, line, src, tl) {
  if (!t || simplify(t) === simplify(line) || simplify(t) === simplify(src)) return false;
  if (!sameLang(tl, 'ja') && /[\u3040-\u30ff]/.test(t)) return false; // kana left untranslated
  // Words of the romanization itself (not the English words that stayed Latin in the hiragana guess, which a real
  // translation keeps): an answer made mostly of them is an echo.
  const kept = new Set(src === line ? [] : plainWords(src));
  const words = plainWords(t), from = new Set(plainWords(line).filter((w) => !kept.has(w)));
  return !words.length || words.filter((w) => from.has(w)).length < words.length * 0.6;
}
async function handle({ key, lines, tl, force, roman }) {
  const sk = 'song:' + key;
  const { [sk]: stored, geminiKey, geminiStatus } = await chrome.storage.local.get([sk, 'geminiKey', 'geminiStatus']);
  const { translator } = await chrome.storage.sync.get('translator');
  const rm = roman && ROMAN[roman.lang] && Array.isArray(roman.lines) ? roman : null;
  const entry = stored && !(rm && stored.rv !== ROMAN_VER) ? stored : { lines: {} };
  if (rm) entry.rv = ROMAN_VER;
  const romanSet = new Set(rm ? rm.lines : []);
  const rlang = () => (!rm ? '' : entry.roman && 'lang' in entry.roman ? entry.roman.lang : rm.lang);
  const isRom = (l) => !!rlang() && romanSet.has(l);
  const cell = (l) => entry.lines[l] || (entry.lines[l] = { t: {} });
  if (force) { if (entry.noGemini) delete entry.noGemini[tl]; if (entry.mostly) delete entry.mostly[tl]; (entry.force ||= {})[tl] = 1; }
  let useGemini = !!geminiKey && translator !== 'google' && !(entry.noGemini && entry.noGemini[tl]);
  const latin = lines.filter(isLatin), other = lines.filter((l) => !isLatin(l));
  let mostly = !!(entry.mostly && entry.mostly[tl]); // mostly in the target language: Gemini only gets the non-Latin lines
  const forGem = (l) => useGemini && !(mostly && isLatin(l));
  const gem = (l) => forGem(l) && entry.lines[l] && entry.lines[l].g && tl in entry.lines[l].g;
  const hasT = (l) => entry.lines[l] && entry.lines[l].t && tl in entry.lines[l].t;
  let changed = !!force || (!!rm && entry !== stored), geminiCode;

  // Google: romanization + translation (language detected per batch). Returns false if a request failed.
  const google = async (list, perLine) => {
    let ok = true;
    const rom = list.filter(isRom);
    if (rom.length) {
      const lang = rlang(), src = (l) => { const h = lang === 'ja' ? toHiragana(l) : ''; return /[\u3040-\u309f]/.test(h) ? h : latinize(l); };
      for (const batch of batches(rom)) {
        try {
          const res = await translate(batch.map(src), tl, ROMAN_SL[lang]);
          batch.forEach((line, i) => {
            const c = cell(line), t = res.t[i] || '';
            Object.assign(c, { sl: lang, r: '' });
            c.t[tl] = romTranslated(t, line, src(line), tl) ? t : '';
          });
          changed = true;
        } catch (e) {
          ok = false;
          console.warn('[lyrics-translate] Google request failed, will retry later:', e.message || e);
        }
      }
      list = list.filter((l) => !isRom(l));
    }
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
  if (useGemini && !rm && !(entry.force && entry.force[tl]) && latin.length && other.length <= lines.length * MOSTLY
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
    const res = await gemini(gemLines, tl, geminiKey, rm && rm.lang);
    geminiCode = res.out ? 'ok' : res.code;
    if (res.out) {
      gemLines.forEach((l, i) => { const c = cell(l); (c.g ||= {})[tl] = simplify(res.out[i]) === simplify(l) ? '' : res.out[i]; });
      if (rm) { // romanized song: Gemini's language verdict and its original-script guesses
        entry.roman = { lang: res.lang === 'none' ? '' : ROMAN[res.lang] ? res.lang : rm.lang };
        gemLines.forEach((l, i) => {
          const c = cell(l), o = (res.orig && res.orig[i]) || '';
          if (isRom(l)) Object.assign(c, { sl: rlang(), o: NON_LATIN.test(o) ? o : '', og: 'gemini' }); // '' = Gemini sees nothing to rebuild
          else { delete c.o; delete c.og; }
        });
      }
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

  // 3. Romanized Japanese without a Gemini guess: local hiragana guess for the "Original lyrics" line.
  if (rlang() === 'ja') {
    for (const l of lines) {
      const c = entry.lines[l];
      if (!isRom(l) || !c || c.og === 'gemini') continue;
      const o = toHiragana(l);
      if (/[\u3040-\u309f]/.test(o) && (c.o !== o || c.og !== 'local')) { Object.assign(c, { o, og: 'local' }); changed = true; }
    }
  }

  await persist(key, entry, changed);
  const results = {};
  let guess = '';
  for (const l of lines) {
    const c = entry.lines[l];
    const t = gem(l) ? c.g[tl] : c && c.t && tl in c.t ? c.t[tl] : undefined;
    if (t === undefined) continue;
    results[l] = { r: c.r || '', t };
    if (isRom(l) && c.o && (c.og === 'gemini' || rlang() === 'ja')) {
      Object.assign(results[l], { o: c.o, og: c.og });
      if (c.og === 'gemini' || !guess) guess = c.og;
    }
  }
  return { ok, results, gemini: geminiCode, roman: rm ? { lang: rlang(), guess, by: entry.roman ? 'gemini' : 'guess' } : undefined };
}

// ---------- Gemini ----------
// roman = 'ja' | 'ko' | 'zh' (v1.3.6): the lines look like a romanization of that language. The reply is then an object:
// { lang: 'ja' | 'ko' | 'zh' | 'none', lines: [{ t: translation, o: the line rebuilt in the original script (a guess) }] }.
const ROMAN_NAMES = { ja: 'Japanese (romaji)', ko: 'Korean (Revised Romanization or similar)', zh: 'Mandarin Chinese (pinyin)' };
async function gemini(lines, tl, apiKey, roman) {
  let lang = tl;
  try { lang = `${new Intl.DisplayNames(['en'], { type: 'language' }).of(tl)} (${tl})`; } catch (e) { /* keep code */ }
  const body = roman ? {
    systemInstruction: { parts: [{ text:
      `You translate song lyrics into ${lang}. These lyrics are written in Latin letters and look like a romanization of ${ROMAN_NAMES[roman]}. ` +
      'The input is a numbered list of lyric lines. Return a JSON object. "lang": the language the romanized lines are in: "ja" (Japanese), ' +
      '"ko" (Korean), "zh" (Chinese), or "none" if they are not a romanization of one of these. ' +
      `"lines": an array with exactly ${lines.length} objects, one per input line, in the same order, each with "t" = the translation into ${lang} ` +
      '(natural and faithful, keeping the meaning, tone and imagery, using the context of the whole song; ' +
      `if a line is already in ${lang}, return it unchanged) and "o" = your best reconstruction of the line in its original script ` +
      '(kanji and kana for Japanese, Hangul for Korean, Chinese characters for Chinese), or "" if the line is not romanized. ' +
      'Do not merge, split, add, drop or number lines.' }] },
    contents: [{ role: 'user', parts: [{ text: lines.map((l, i) => `${i + 1}. ${l}`).join('\n') }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', required: ['lang', 'lines'], propertyOrdering: ['lang', 'lines'], properties: {
        lang: { type: 'STRING', enum: ['ja', 'ko', 'zh', 'none'] },
        lines: { type: 'ARRAY', minItems: lines.length, maxItems: lines.length, items: { type: 'OBJECT', required: ['t', 'o'], propertyOrdering: ['t', 'o'],
          properties: { t: { type: 'STRING' }, o: { type: 'STRING' } } } },
      } },
    },
  } : {
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
    if (roman) {
      const ls = out && out.lines;
      if (Array.isArray(ls) && ls.length === lines.length && ls.every((x) => x && typeof x.t === 'string')) {
        return { out: ls.map((x) => x.t.trim()), orig: ls.map((x) => (typeof x.o === 'string' ? x.o.trim() : '')), lang: typeof out.lang === 'string' ? out.lang.toLowerCase() : '' };
      }
    } else if (Array.isArray(out) && out.length === lines.length && out.every((s) => typeof s === 'string')) return { out: out.map((s) => s.trim()) };
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

// Gemini status for the floating button's dot (v1.3.6): same states and colors as the popup's indicator, shown only while
// Gemini is the selected translator (the popup's default: Gemini when a key is saved). The key itself never leaves here.
const GEM_ERR = { quota: 'quota hit', timeout: 'timed out', error: 'error', mismatch: 'unexpected reply' };
async function gState() {
  const { geminiKey, geminiStatus: st } = await chrome.storage.local.get(['geminiKey', 'geminiStatus']);
  const { translator } = await chrome.storage.sync.get('translator');
  if ((translator || (geminiKey ? 'gemini' : 'google')) !== 'gemini') return { show: false };
  if (!geminiKey) return { show: true, state: 'gray', label: 'Gemini: no key saved' };
  if (!st) return { show: true, state: 'gray', label: 'Gemini: not used yet' };
  if (st.code === 'ok') return { show: true, state: 'green', label: 'Gemini working' };
  if (st.code === 'badkey') return { show: true, state: 'red', label: 'Gemini error: invalid key' };
  return { show: true, state: 'amber', label: `Gemini error: ${GEM_ERR[st.code] || 'error'} (using Google)` };
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
// sl = source language (default: auto-detect).
async function translate(lines, tl, sl = 'auto') {
  const res = parse(await request(lines, tl, sl), lines.length);
  if (res || lines.length === 1) return res || { sl: '', t: [], r: [] };
  const mid = Math.ceil(lines.length / 2);
  const [a, b] = [await translate(lines.slice(0, mid), tl, sl), await translate(lines.slice(mid), tl, sl)];
  return { sl: a.sl || b.sl, t: [...pad(a.t, mid), ...b.t], r: [...pad(a.r, mid), ...b.r] };
}
const pad = (arr, n) => Array.from({ length: n }, (_, i) => arr[i] || '');

async function request(lines, tl, sl = 'auto') {
  const q = lines.map((l) => l.replace(/\|/g, '/')).join(SEP);
  let last;
  for (const base of GOOGLE) {
    try {
      const res = await fetchT(`${base}&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&dt=rm`, {
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
// Results share the song LRU: lrc:<key> = { v, id, dur, synced } | { v, id, dur, plain } (kept until evicted) | { none: 1, dur, until } (7 days).
// v = LRC_VER (1.3.6+). A found result from an older version is looked up again once when its lyrics are romanized
// (before 1.3.6 a copy in the original script was not preferred) or not in the title's script (an English translation
// from /api/get was kept). The song's translations are dropped only in that case, not for a cache already in script.
const LRCLIB = 'https://lrclib.net/api';
const LRC_CLIENT = `Lyrics Translate & Romanize for Amazon Music v${chrome.runtime.getManifest().version} (https://github.com/NoodlesNom/lyrics-translate-for-amazon-music)`;
const LRC_NONE_MS = 7 * 864e5, LRC_MAX_DIFF = 3, LRC_VER = 3;
const lrcJobs = new Map();
let lrcPauseUntil = 0; // after a 429: honor Retry-After

async function lrclib({ key, title, artist, duration }) {
  if (!key || !title || !artist || !(duration > 0)) return { status: 'error' };
  const lk = 'lrc:' + key;
  const { [lk]: hit } = await chrome.storage.local.get(lk);
  const cached = hit && !hit.none ? lrcLines(hit) : [];
  const kind = titleScript(title);
  // Once per LRC_VER: a romanized copy, or lyrics that are not in the title's script. Right-script caches stay.
  const stale = !!hit && !hit.none && hit.v !== LRC_VER && (!!detectRoman(cached).lang || (!!kind && !inTitleScript(cached, kind)));
  // Same title/artist but another duration (e.g. a live version) is looked up again.
  if (hit && !stale && (!hit.none || hit.until > Date.now()) && !(Math.abs((hit.dur || duration) - duration) > LRC_MAX_DIFF)) {
    await touch(key);
    return lrcView(hit);
  }
  if (lrcPauseUntil > Date.now()) return { status: 'error', retryMs: lrcPauseUntil - Date.now() };
  if (!lrcJobs.has(key)) {
    lrcJobs.set(key, lrcLookup(title, artist, duration).then(async (rec) => {
      const dur = Math.round(duration);
      const value = rec ? (rec.syncedLyrics ? { v: LRC_VER, id: rec.id, dur, synced: rec.syncedLyrics } : { v: LRC_VER, id: rec.id, dur, plain: rec.plainLyrics }) : { none: 1, dur, until: Date.now() + LRC_NONE_MS };
      if (stale) await chrome.storage.local.remove('song:' + key); // translations of the copy being replaced
      await storeLrc(key, value);
      return lrcView(value);
    }, (e) => ({ status: 'error', retryMs: e.retryMs || 0 })).finally(() => lrcJobs.delete(key)));
  }
  return lrcJobs.get(key);
}

// found → also roman: 'ja' | 'ko' | 'zh' | '' and romanLines (the romanized lines) for romanized lyrics (see detectRoman).
function lrcView(v) {
  if (v.none) return { status: 'none' };
  const synced = v.synced ? parseLrc(v.synced) : null;
  const plain = synced ? null : (v.plain || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const roman = detectRoman(synced ? synced.map(([, t]) => t) : plain);
  return { status: 'found', id: v.id, synced, plain, roman: roman.lang, romanLines: roman.lines };
}
// The lyric lines of a stored value or an LRCLIB record.
const lrcLines = (v) => {
  const synced = v.synced || v.syncedLyrics, plain = v.plain || v.plainLyrics;
  return synced ? parseLrc(synced).map(([, t]) => t) : (plain || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
};
// Written in the original script of lang: at least 30% of the lines with letters hold it (Japanese: kana, or kanji with some
// kana in the song; Korean: Hangul; Chinese: Chinese characters and no kana).
function nativeScript(lines, lang) {
  const ls = lines.filter((l) => /\p{L}/u.test(l));
  const has = (re) => ls.filter((l) => re.test(l)).length;
  const kana = has(/[\p{Script=Hiragana}\p{Script=Katakana}]/u), han = has(/\p{Script=Han}/u), hangul = has(/\p{Script=Hangul}/u);
  const n = lang === 'ja' ? (kana ? has(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u) : 0) : lang === 'ko' ? hangul : !kana ? han : 0;
  return ls.length > 0 && n >= ls.length * 0.3;
}
// Dominant non-Latin script of the Amazon title (SCRIPTS), or '' when the title is Latin — a lone look-alike letter
// in an otherwise Latin title does not count. Mostly kana (ties included) → 'ja'; Hangul → 'ko'; Han and no kana → 'zh'.
// Han that only outnumbers some kana → 'han' (kanji on the line; kana elsewhere in the song is fine).
function titleScript(title) {
  const letters = [...(title || '')].filter((c) => /\p{L}/u.test(c));
  const foreign = letters.filter((c) => NON_LATIN.test(c));
  if (!foreign.length || (foreign.length * 2 < letters.length && foreign.every((c) => LOOKALIKE.has(c)))) return '';
  const counts = {};
  for (const ch of foreign) {
    const s = scriptOf(ch);
    if (s !== 'latin') counts[s] = (counts[s] || 0) + 1;
  }
  let kind = '', n = 0;
  const kana = counts.kana || 0;
  const take = (k, c) => { if (c > n) { kind = k; n = c; } };
  take('ja', kana); // first, so a tie with han/hangul stays Japanese
  for (const [name, c] of Object.entries(counts)) {
    if (name === 'kana') continue;
    take(name === 'hangul' ? 'ko' : name === 'han' ? 'zh' : name, c);
  }
  if (!n || kind === 'other') return '';
  return kind === 'zh' && kana ? 'han' : kind;
}
// At least 30% of lines that contain letters use the title's script. English lines may remain.
// ja/ko/zh reuse nativeScript; 'han' and the other SCRIPTS names are letters of that script.
function inTitleScript(lines, kind) {
  if (kind === 'ja' || kind === 'ko' || kind === 'zh') return nativeScript(lines, kind);
  const ls = lines.filter((l) => /\p{L}/u.test(l));
  const re = (SCRIPTS.find(([name]) => name === kind) || [])[1];
  return !!re && ls.length > 0 && ls.filter((l) => re.test(l)).length >= ls.length * 0.3;
}

// 1. /api/get with title, artist and duration (LRCLIB's own ±2 s match), checked again here.
// 2. If that finds nothing, or only unsynced lyrics: /api/search (title + first artist); only close matches count:
//    same normalized title and artist, duration within 3 s. Synced beats plain, then the closest duration.
// 3. (1.3.6) If the chosen lyrics are romanized (romaji, Korean romanization, pinyin): another close match from the search
//    results (the same /api/search call, made now if step 2 didn't need it) that is written in the original script wins,
//    synced before plain, then the closest duration. No other data is sent.
// 4. If the Amazon title has a non-Latin letter and a close match is in that script, prefer it over a Latin/English one
//    (an /api/get translation must not hide the original). Same lrcMatch rules; synced, then closest duration, among those
//    matches only. If none are in the title's script, step 3 still applies.
async function lrcLookup(title, artist, duration) {
  let best = null, list = null;
  const search = () => lrcFetch('/search', { track_name: title, artist_name: artists(artist)[0] || artist });
  const byQuality = (a, b) => (!!b.syncedLyrics - !!a.syncedLyrics) || Math.abs(a.duration - duration) - Math.abs(b.duration - duration);
  const got = await lrcFetch('/get', { track_name: title, artist_name: artist, duration: Math.round(duration) });
  if (lrcMatch(got, title, artist, duration)) best = got;
  if (!(best && best.syncedLyrics)) {
    try {
      list = await search();
    } catch (e) {
      if (best) return best;
      throw e;
    }
    const cands = (Array.isArray(list) ? list : []).filter((r) => lrcMatch(r, title, artist, duration));
    cands.sort(byQuality);
    if (cands[0] && (cands[0].syncedLyrics || !best)) best = cands[0];
  }
  const kind = titleScript(title);
  if (kind) {
    if (!list) {
      try { list = await search(); } catch (e) { /* search down: fall through to today's choice */ }
    }
    const seen = new Set();
    const inScript = [best, ...(Array.isArray(list) ? list : [])].filter((r) => {
      if (!r || (r.id != null && seen.has(r.id)) || !lrcMatch(r, title, artist, duration) || !inTitleScript(lrcLines(r), kind)) return false;
      if (r.id != null) seen.add(r.id);
      return true;
    });
    inScript.sort(byQuality);
    if (inScript[0]) return inScript[0];
  }
  const roman = best ? detectRoman(lrcLines(best)).lang : '';
  if (!roman) return best;
  if (!list) {
    try { list = await search(); } catch (e) { return best; }
  }
  const native = (Array.isArray(list) ? list : []).filter((r) => r.id !== best.id && lrcMatch(r, title, artist, duration) && nativeScript(lrcLines(r), roman));
  native.sort(byQuality);
  return native[0] || best;
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

// ---------- Update notice: ONLY for unpacked ("Load unpacked") copies ----------
// Store copies are updated by the browser and never contact GitHub: no request, no badge, no popup UI.
// Install type comes from chrome.management.getSelf(), which needs no "management" permission. The store ID counts as
// a store copy whatever getSelf says. Unpacked copies read the latest release's version number from GitHub's public API
// (no host permission needed: api.github.com answers with Access-Control-Allow-Origin: *; no cookies, nothing personal
// sent) about once a day, checked when the service worker starts or gets a message (popup, content script), so no
// "alarms" permission either. The popup's "Check for updates" button asks too, at most once a minute.
const STORE_ID = 'jjfhmmdjbkcamelimddcogoopaljflff';
const REPO = 'https://github.com/NoodlesNom/lyrics-translate-for-amazon-music';
const RELEASES_API = 'https://api.github.com/repos/NoodlesNom/lyrics-translate-for-amazon-music/releases/latest';
const UPD = { dayMs: 864e5, retryMs: 3 * 36e5, cooldownMs: 60e3, startDelayMs: 5000 }; // failed checks are retried after 3 h

const isStoreCopy = (id, installType) => id === STORE_ID || installType !== 'development';
let selfType = null;
async function isUnpacked() {
  if (chrome.runtime.id === STORE_ID) return false;
  if (!selfType) selfType = chrome.management && chrome.management.getSelf ? chrome.management.getSelf().then((i) => i.installType, () => 'unknown') : Promise.resolve('unknown');
  return !isStoreCopy(chrome.runtime.id, await selfType);
}

// "v1.3.10" → [1, 3, 10]; numeric per part, missing parts are 0 (1.4 > 1.3.9, 1.3.10 > 1.3.9, 1.3.4.1 > 1.3.4).
const verParts = (v) => { const m = /^\s*v?(\d+(?:\.\d+)*)/i.exec(String(v || '')); return m ? m[1].split('.').map(Number) : null; };
function isNewer(latest, current) {
  const a = verParts(latest), b = verParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}
const currentVersion = () => chrome.runtime.getManifest().version;

// upd (chrome.storage.local) = { at: last check time, latest: '1.3.5', url: release page, err: '' | 'offline' | 'ratelimit' | 'http' }
async function applyBadge(upd) {
  if (!chrome.action) return;
  if (!(await isUnpacked())) return chrome.action.setBadgeText({ text: '' });
  if (!upd) upd = (await chrome.storage.local.get('upd')).upd || {};
  const newer = isNewer(upd.latest, currentVersion());
  await chrome.action.setBadgeText({ text: newer ? 'NEW' : '' });
  if (newer) {
    await chrome.action.setBadgeBackgroundColor({ color: '#1a6fd1' });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});
  }
}

let updJob = null;
function checkNow() {
  return updJob || (updJob = (async () => {
    const { upd: old = {} } = await chrome.storage.local.get('upd');
    const upd = { latest: old.latest || '', url: old.url || '', at: Date.now(), err: '' }; // a failed check keeps the last known release
    try {
      const res = await fetch(RELEASES_API, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
      if (res.status === 403 || res.status === 429) upd.err = 'ratelimit';
      else if (res.status === 404) upd.err = 'none';
      else if (!res.ok) upd.err = 'http';
      else {
        const rel = await res.json();
        if (!verParts(rel && rel.tag_name)) upd.err = 'http';
        else {
          upd.latest = verParts(rel.tag_name).join('.');
          upd.url = typeof rel.html_url === 'string' && rel.html_url.startsWith(REPO + '/releases/') ? rel.html_url : REPO + '/releases/latest';
        }
      }
    } catch (e) {
      upd.err = 'offline';
    }
    await chrome.storage.local.set({ upd });
    await applyBadge(upd);
    return upd;
  })().finally(() => { updJob = null; }));
}

let autoCheckedAt = 0;
async function autoCheck() {
  if (Date.now() - autoCheckedAt < 60e3) return; // at most one storage look per minute per worker
  autoCheckedAt = Date.now();
  if (!(await isUnpacked())) return;
  const { upd = {} } = await chrome.storage.local.get('upd');
  const wait = upd.err && upd.err !== 'none' ? UPD.retryMs : UPD.dayMs;
  if (!upd.at || Date.now() - upd.at >= wait || upd.at > Date.now()) await checkNow();
}
function autoCheckSoon() { autoCheck().catch((e) => console.warn('[lyrics-translate] update check failed:', e.message || e)); }

// Popup: { store: true } for store copies (the popup then shows nothing). Otherwise the current state; manual = the
// "Check for updates" button, which reuses a result younger than a minute ("Checked just now") instead of asking again.
async function updateInfo(manual) {
  if (!(await isUnpacked())) return { store: true };
  let { upd } = await chrome.storage.local.get('upd');
  let reused = false;
  if (manual) {
    if (upd && upd.at && Date.now() - upd.at < UPD.cooldownMs && !updJob) reused = true;
    else upd = await checkNow();
  }
  upd = upd || {};
  return { store: false, current: currentVersion(), latest: upd.latest || '', url: upd.url || REPO + '/releases/latest', at: upd.at || 0,
    err: upd.err || '', newer: isNewer(upd.latest, currentVersion()), reused };
}

// Worker start (browser start, first use, after an idle stop): refresh the badge and check if a day has passed.
applyBadge().catch(() => {});
setTimeout(autoCheckSoon, UPD.startDelayMs);
