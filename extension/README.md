# Lyrics Translate & Romanize for Amazon Music (Edge extension)

> **Not affiliated with Amazon.** This is an independent, unofficial extension. Amazon Music is a trademark of Amazon.com, Inc. or its affiliates.

Adds two small, dimmed lines under each lyric line in the Amazon Music web player (https://music.amazon.com):

1. **Romanization** – only for non-Latin scripts (Japanese → romaji, Chinese → pinyin, Korean → revised romanization, Russian/Cyrillic, Arabic, Hebrew, Hindi/Devanagari, Thai, Greek, …).
2. **Translation** into your chosen language (default English). Hidden when the line is already in that language.

By default the **translation becomes the main line**: it's shown at the same size and boldness as Amazon's lyric text, with the romanization in small text below it, and the original text is hidden. Lines without a translation (already in your language, still loading, failed, or translation switched off) keep showing the original as usual.

Click the toolbar icon to pick the target language and switch romanization, translation and **Show original lyrics** on or off. With "Show original lyrics" on, the original stays as the big line and the romanization and translation appear in small text underneath. **Text size** (Small / Default / Large / Extra large) scales all the lyric text the extension shows (the main line, 28px by default, and the romanization, 18px by default) without zooming the rest of the player, so auto-scrolling keeps working. Changes apply immediately.

## Translation services and privacy

**Google Translate (default, no key).** Translations and romanizations come from Google Translate's free web endpoint (`clients5.google.com`, with `translate.googleapis.com` as a fallback). No API key or account is needed. **The text of the lyric lines on screen is sent to Google to be translated.**

**Gemini (optional, your own free key).** For more natural translations that use the whole song as context, you can have Google's Gemini model (`gemini-3.5-flash-lite`) do the translating:

1. Get a free API key at [Google AI Studio](https://aistudio.google.com/apikey).
2. Click the extension icon → **Settings**, paste the key, click **Save**, then **Test key**.
3. In the popup, choose **Translator: Gemini (needs key)**. It's picked automatically when a key is saved.

When Gemini is on, **the song's lyric lines are sent to Google's Gemini API**, one request per song. Songs written only in Latin script are first language-checked with the free Google Translate step: if they're already in your target language (e.g. an English song with English selected), Gemini isn't called at all, now or on replays. Romanization still comes from Google Translate. The key is stored **only in this browser** (`chrome.storage.local`, not synced) and is sent only to `generativelanguage.googleapis.com`, in a request header. Free-tier rate limits and daily quotas apply, and on the free tier Google may use the content to improve its products. If Gemini hits a quota, rejects the key, times out (20 s) or returns something unexpected, the extension switches to Google Translate for that song without interrupting you, shows it in the popup, and waits a while before trying Gemini again.

**Popup status.** Next to the Translator choice, a colored dot shows how Gemini is doing: green "Gemini working · last reply 2 min ago", amber "Using Google (quota hit / timed out / error / unexpected reply)" after the last Gemini attempt fell back, red "Invalid key", or gray "No key", "Not used yet" or "Off (Google selected)". It reflects the last real Gemini request (songs served from the cache don't change it). Below, "Saved songs: 12 (Gemini 8 · Google 6) · ~0.3 MB" shows how many songs are cached, how many of them are fully translated into the selected language by each translator (a song can count for both), and roughly how much storage the extension uses. Both update live.

**Floating button.** A small round button in the top-right corner of the Amazon Music page (below the top bar) opens the same settings in a panel on the page. Click outside it or press Esc to close it. Turn it off with **Show floating button** in the popup. (To make this work, `popup.html`, `popup.js` and the 48px icon are web-accessible, but only to music.amazon.com.)

**This song.** Under the status dot, the popup shows the current song's detected language(s) and state, e.g. "Japanese + English · Translated with Gemini (from cache)", "English · Already in English, no translation needed", "Translating…" or "Some lines failed, retrying" (it needs the lyrics view open in the active tab).

**Translate this song.** If a song was left (partly) untranslated, for example an English/Spanish mix that was detected as English, click **Translate this song** in the popup while its lyrics are open. It translates the whole song again with the selected translator (Gemini, or Google if Gemini is paused or fails, or if Google is selected or no key is saved; Google then detects each Latin-script line's language separately) and remembers not to skip that song again.

**Lyrics when Amazon has none (LRCLIB).** If Amazon Music itself has no lyrics for the song that's playing, the extension looks the song up on [LRCLIB](https://lrclib.net) (a free, open lyrics database, no key or account) and shows the lyrics in a small panel above the player bar, at the right. With synced lyrics the line being sung is highlighted and the panel follows playback, including seeking and pausing. Unsynced lyrics are shown as plain text. The usual translation and romanization apply to these lines too, and the popup's "This song" area says "Lyrics added from LRCLIB (synced)" or "(unsynced)", or "Amazon has no lyrics; none found on LRCLIB". The panel's **–** button minimizes it and **×** hides it for the current song. Turn the feature off with **Find lyrics when Amazon has none** in the popup (on by default).

- It only runs when **Amazon indicates there are no lyrics**: the lyrics button in the player bar is disabled, or missing (only counted once the extension has seen a lyrics button in the player bar before, so a player layout without one never triggers it), or the lyrics view shows its no-lyrics message. A closed lyrics view isn't enough, and when Amazon has lyrics nothing new happens. Amazon's state has to hold for about 1.5 seconds before anything is looked up.
- **What is sent to lrclib.net:** only the song's **title, artist and duration** (no cookies). The request carries an `Lrclib-Client` header naming the extension and its GitHub page, as LRCLIB asks clients to do (browsers don't let extensions set `User-Agent`).
- **Matching:** first LRCLIB's `/api/get` with title, artist and duration. If that finds nothing, or only unsynced lyrics, `/api/search` is tried, and a result counts only if its title and artist match after normalizing (case, accents, punctuation, "feat." parts, "&"/"and") and its duration is within 3 seconds. Synced lyrics win over plain ones. If nothing matches closely, nothing is shown (no guessing).
- **Cache:** each song is fetched once. Found lyrics are kept in the same cache as translations (same 2000-song LRU). "Not found" is remembered for 7 days, then the song is checked again. If LRCLIB is rate-limiting (HTTP 429), the extension waits as long as its `Retry-After` header says.
- **Timing:** the playback position is read from a page `<audio>`/`<video>` element if one is reachable, otherwise from the player bar's progress slider and elapsed/duration (or remaining) time. The bar's clock only changes once a second, so the extension extrapolates between ticks while playing and stops as soon as the clock stops.

Nothing else is sent anywhere: no cookies, no song history, no analytics.

**Cache.** Results are cached in the browser (`chrome.storage.local`): up to 2000 songs, each with up to 400 lines, stored separately per translator and target language. When the cache is full, or the browser's ~10 MB storage limit is reached, the least recently played songs are removed first. Switching translators doesn't reuse the other translator's results.

Permissions (and why each is needed):

- `storage`: saves your settings (`chrome.storage.sync`), and your Gemini key, the Gemini status, the translation cache and the LRCLIB lyrics cache (`chrome.storage.local`, this browser only).
- Content script on `https://music.amazon.com/*`: reads the lyric lines shown on the page and the player bar (song, playback time, lyrics button), and adds the translation/romanization lines, the floating button and the LRCLIB lyrics panel. It runs on no other site.
- Host access to `https://clients5.google.com/*` and `https://translate.googleapis.com/*`: the Google Translate web endpoints (the second is a fallback) used for translation and romanization.
- Host access to `https://generativelanguage.googleapis.com/*`: the Gemini API, contacted only when you've saved your own key and Gemini is selected.
- Host access to `https://lrclib.net/*`: the LRCLIB lyrics API, contacted only for songs Amazon has no lyrics for (title, artist and duration), and only while **Find lyrics when Amazon has none** is on.
- `web_accessible_resources` (`popup.html`, `popup.js`, `icons/icon48.png`, only for `https://music.amazon.com/*`): lets the floating button show its icon and open the popup as an in-page panel.

No other permissions are requested (no `tabs`, no access to other sites, no cookies, no history).

## Install in Microsoft Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode** (toggle in the left sidebar).
3. Click **Load unpacked** and select this folder (the one that contains `manifest.json`).
4. Open Amazon Music, play a song, and open the lyrics view.

**After updating the files:** go to `edge://extensions`, click **Reload** on the extension card, then refresh the Amazon Music tab.

## Known limits

- Amazon Music's web player (React Native Web) has no documented structure, and its `css-*` / `r-*` class names are generated, so the extension doesn't use them. A lyric line is found as an `h4[role="heading"][aria-hidden="true"]` inside `[data-testid="Stage_OverlaysContainer"]`. If Amazon changes that, a fallback looks for the same kind of h4 inside any `aria-hidden` scroll area, in lists of at least 3 lines. The selectors are at the top of `content.js` (marked `AMAZON MUSIC SELECTORS`).
- With "Show original lyrics" off, the original is hidden with CSS only (its font size is set to 0 in `content.css`). Amazon's own elements and text aren't modified, so selecting and copying a line may still pick up the hidden original.
- The extra lines go inside each lyric line, so they pick up its color, right alignment and the blue highlight on the current line. They make each line taller, so if Amazon relies on fixed line heights for auto-scrolling, the current line may not stay perfectly centered.
- To tell songs apart for the cache, the extension uses the browser's media-session info, then the Now Playing title heading plus the text right after it (assumed to be the artist), then a hash of the lyrics. The artist position hasn't been verified.
- Songs with only 1 or 2 lyric lines are ignored (that's the price of the 3-line safety rule).
- The Google endpoint is unofficial and rate-limited. If it refuses requests, lines stay unannotated and the extension tries again about a minute later.
- Lines are grouped by script and the language is detected once per group, so a song that mixes two languages in the same script (e.g. English and Spanish) is translated as if it were one language.
- In a song with kana, lines written only in kanji are treated as Japanese. In a song with no kana, they're treated as Chinese (pinyin).
- Romanization quality is whatever Google returns. Thai uses a diacritic-heavy transliteration that's hard to read, Japanese uses macrons (ō, ī), and Japanese words are sometimes run together.
- Gemini translations can occasionally be looser than a literal translation, and if a new song renders only part of its lines at first, the extension waits about half a second for the list to settle before sending it.
- The saved-songs counter reads the whole cache each time the popup opens or the cache changes. That's quick for normal cache sizes but may take a moment with thousands of songs.
- Only `music.amazon.com` is supported (not regional domains like `music.amazon.co.jp` or `.de`).
- LRCLIB fallback: the player bar is found by structure (the short, full-width container at the bottom of the window around the Play/Pause button that also holds a progress slider or an m:ss time), and the song by the media session (the bar's `/albums/` / `/artists/` links as a fallback). These selectors are at the top of `content.js`. As of v1.3.0 they're tested on a mock page, not yet checked against the live player: if Amazon's bar is structured differently, the fallback simply stays off. Detecting the no-lyrics state relies on the lyrics button's `aria-label` containing "lyric" and on English no-lyrics wording, so other UI languages may only work via the disabled button.
- LRCLIB lyrics are community-contributed and can be wrong, incomplete or badly timed. LRCLIB's `/api/get` can also start a background fetch on their side for songs it doesn't have yet, so a song that wasn't found may appear there later (the extension checks again after 7 days).
- The LRCLIB panel is the extension's own panel above the player bar. It doesn't replace Amazon's lyrics view, and the sync is only as precise as the player's clock (about ±0.3 s when only a one-second clock is available).
