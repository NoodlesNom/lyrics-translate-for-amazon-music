# Privacy Policy: Lyrics Translate & Romanize for Amazon Music

_Effective date: September 28, 2026_

This policy covers the Microsoft Edge extension "Lyrics Translate & Romanize for Amazon Music" (the "extension"), published by NoodlesNom. The extension is not affiliated with Amazon.

## Summary

- **The developer collects no data.** There are no analytics, no trackers, no advertising, no accounts and no servers run by the developer. Nothing is ever sent to the developer.
- **Lyric lines are sent to Google only to translate or romanize them.** The lyric lines shown on screen in the Amazon Music web player go to Google Translate, and to Google Gemini if you added your own API key.
- **For songs Amazon has no lyrics for, the song's title, artist and duration are sent to LRCLIB** (lrclib.net), a free lyrics database, to find lyrics for them. You can turn this off in the popup ("Find lyrics when Amazon has none").
- **Everything else stays in your browser.** Your Gemini key and the translation cache are kept in the extension's local storage, and your settings in the extension's sync storage. Removing the extension clears them.

## What the extension reads

The extension runs only on `https://music.amazon.com/*`. There it reads:

- the text of the lyric lines shown in the lyrics view, and
- the current song's title and artist (from the browser's media-session information, the Now Playing heading or the player bar), used as a local cache key so a song isn't translated twice, and, for songs Amazon has no lyrics for, to look up lyrics on LRCLIB, and
- from the player bar: the song's duration and playback position (to find the matching lyrics and highlight the current line) and whether Amazon's lyrics button is available.

It does not read cookies, your account, your listening history, or any other site.

## What is sent, to whom, and why

| Recipient | What is sent | When | Why |
| --- | --- | --- | --- |
| Google Translate (`clients5.google.com`, fallback `translate.googleapis.com`) | The lyric lines on screen and the target language code | When a song's lyrics are shown and aren't in the cache yet | To translate the lines, detect their language and romanize non-Latin lines |
| Google Gemini API (`generativelanguage.googleapis.com`) | The song's lyric lines, the target language, and **your own** API key (in a request header) | Only if you saved a Gemini key and Gemini is selected, and the song isn't already in your target language | To translate the lines |
| LRCLIB (`lrclib.net`) | The song's **title, artist and duration** (in seconds), plus a header naming the extension (`Lrclib-Client`) | Only when Amazon Music shows no lyrics for the song, "Find lyrics when Amazon has none" is on (default), and the song isn't already in the cache | To find the song's lyrics (synced if available) |

Requests are made without cookies (`credentials: omit`). Apart from the title, artist and duration sent to LRCLIB as described above, no song titles, artist names, history, identifiers or other personal data are sent. LRCLIB is an independent third-party service; see [lrclib.net](https://lrclib.net). Google processes its requests under its own terms and privacy policy ([Google Privacy Policy](https://policies.google.com/privacy), [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms)). On Gemini's free tier, Google may use submitted content to improve its products.

## What is stored, and where

All storage is the browser's own extension storage (`chrome.storage`). The developer can't access it.

- **Gemini API key**: `chrome.storage.local` only (this browser, never synced). You can remove it any time with **Remove key** on the Settings page.
- **Translation cache**: `chrome.storage.local`. For up to 2000 songs it keeps the song title and artist (as the cache key), the lyric lines, their translations and romanizations, and the time last played. The least recently played songs are removed first when the cache is full.
- **LRCLIB lyrics cache**: `chrome.storage.local`. For songs Amazon has no lyrics for, the lyrics found on LRCLIB (with the LRCLIB record id and the song duration), or a "not found" note that expires after 7 days, under the same title/artist cache key and 2000-song limit as the translation cache.
- **Gemini status** (the last Gemini result, such as "ok" or "quota", and its time): `chrome.storage.local`.
- **Settings** (target language, translator, text size and the on/off toggles, including "Find lyrics when Amazon has none"): `chrome.storage.sync`, so Microsoft Edge may sync them between your own signed-in browsers. Your key is never put in sync storage.

**Removing the extension deletes all of this data.**

## Children

The extension isn't directed at children and collects no personal information from anyone.

## Changes

If this policy changes, the updated version will be published at this address with a new effective date.

## Contact

Questions or requests: open an issue at <https://github.com/NoodlesNom/lyrics-translate-for-amazon-music/issues>.
