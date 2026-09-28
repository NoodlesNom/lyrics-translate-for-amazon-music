# Lyrics Translate & Romanize for Amazon Music

A free Microsoft Edge extension (Manifest V3, plain JS/HTML/CSS) that translates the lyrics in the Amazon Music web player ([music.amazon.com](https://music.amazon.com)) and adds romanization for non-Latin scripts.

> **Not affiliated with Amazon.** This is an independent, unofficial extension. It is not made, endorsed or supported by Amazon. Amazon Music is a trademark of Amazon.com, Inc. or its affiliates.

**Get it on [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/lyrics-translate-romanize-for-amazon-music/jjfhmmdjbkcamelimddcogoopaljflff)**

**Website:** https://noodlesnom.github.io/lyrics-translate-for-amazon-music/ · **Privacy policy:** [PRIVACY.md](PRIVACY.md) ([web version](https://noodlesnom.github.io/lyrics-translate-for-amazon-music/privacy.html)) · **Support:** [GitHub issues](https://github.com/NoodlesNom/lyrics-translate-for-amazon-music/issues)

![Translated lyrics on a demo page with invented lines](docs/img/1-translated.png)

## Features

- **Two translators:** free Google Translate (no key, no account), or Google Gemini with your own free API key (saved only in your browser) for natural, whole-song translations. If Gemini hits a quota, rejects the key, times out or replies unexpectedly, the song is translated with Google Translate automatically.
- **Romanization** for non-Latin scripts: Japanese (romaji), Chinese (pinyin), Korean, Cyrillic, Arabic, Hebrew, Devanagari, Thai, Greek and more.
- **Translation as the main line**, with the romanization underneath. Turn on **Show original lyrics** to keep the original as the big line instead.
- **Popup:** target language (23 languages), translator dropdown, romanization and translation toggles, text size (85–145%), a "This song" status line, a Gemini status dot, a saved-songs counter and a **Translate this song** button.
- **Floating button** on the page that opens the popup as an in-page panel.
- **Per-song cache:** up to 2000 songs, per translator and language; the least recently played songs are removed first.
- **Skips songs already in your language**, so an English song with English selected never uses your Gemini quota.

## Install

- **Microsoft Edge Add-ons (recommended):** [install from the store](https://microsoftedge.microsoft.com/addons/detail/lyrics-translate-romanize-for-amazon-music/jjfhmmdjbkcamelimddcogoopaljflff).
- **Load unpacked:** download the ZIP from the [latest release](https://github.com/NoodlesNom/lyrics-translate-for-amazon-music/releases/latest) (or clone this repo), open `edge://extensions`, turn on **Developer mode**, click **Load unpacked** and select the folder that contains `manifest.json` (the [`extension`](extension) folder in this repo).

Full usage notes, the Gemini setup and known limits are in [extension/README.md](extension/README.md).

## Privacy

The developer collects no data and there are no analytics. The lyric lines on screen are sent to Google Translate, and to Google Gemini if you added your own key, only to translate or romanize them. The key is stored only in `chrome.storage.local`, settings in `chrome.storage.sync` and the cache in `chrome.storage.local`; removing the extension clears them. See [PRIVACY.md](PRIVACY.md).

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Settings (sync storage); Gemini key, Gemini status and the translation cache (local storage). |
| Content script on `https://music.amazon.com/*` | Reads the lyric lines on screen and adds the translation/romanization lines and the floating button. Runs on no other site. |
| `https://clients5.google.com/*`, `https://translate.googleapis.com/*` | Google Translate web endpoints (the second is a fallback) for translation and romanization. |
| `https://generativelanguage.googleapis.com/*` | Gemini API, only when you saved your own key and Gemini is selected. |
| `web_accessible_resources`: `popup.html`, `popup.js`, `icons/icon48.png` (only for `music.amazon.com`) | Lets the floating button show its icon and open the popup as an in-page panel. |

## Repository layout

- `extension/`: the extension itself (load this folder unpacked, or zip its contents for the store).
- `docs/`: the GitHub Pages website and privacy policy.
- `tests/`: Playwright tests that load the unpacked extension against a local mock of the lyrics view. All lyric lines in the mock and fixtures are invented test text.

## License

[MIT](LICENSE) © NoodlesNom
