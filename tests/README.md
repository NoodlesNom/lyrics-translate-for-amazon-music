# Tests

End-to-end tests that load the unpacked extension (`../extension`) in headless Chromium with Playwright and run it against `mock.html`, a local copy of the structure of Amazon Music's full view (the expanded Now Playing overlay: art, title, artist, transport, and the lyrics column `Stage_OverlaysContainer`, filled for songs with lyrics and empty/0 px wide for songs without, with the geometry measured on the live site at 1600x820) and of the mini-player's markup (test IDs, ARIA labels, the "Lyrics available" badge, the Enter Full Screen button). The full view can be opened/closed, and the mini-player title can be absent, hidden or visible while it's open. `music.amazon.com` is routed to the mock page, Google Translate requests are answered from `fixtures.json`, and the Gemini API is mocked with a placeholder key (no real key is used or needed).

All lyric lines in `mock.html`, `fixtures.json` and the tests (including the mocked LRCLIB answers) are invented test text.

```sh
cd tests
npm install
npx playwright install chromium
npm test
```

- `test.js`: rendering, layout, romanization/translation, settings, floating button, selectors, failure handling.
- `test-gemini.js`: Gemini translator, fallback to Google, skipping songs already in the target language (incl. look-alike letters, symbols, mostly-English songs and stale caches), status dot, popup "This song" line and button, LRU cache and counter.
- `test-lrclib.js`: the LRCLIB fallback for songs Amazon has no lyrics for (lrclib.net is mocked): no-lyrics detection from the mini-player badge and the full view's empty lyrics column (badge present, absent, late, other badges, no song; mini-player title absent while the full view is open), song identity from `Stage_Title`/`Stage_Subtitle`, the clock from the slider's aria-label (m:ss and h:mm:ss, with or without aria-valuenow/max, generic slider fallback), placement in Amazon's lyrics spot (clear of art, title and controls; on resize), Amazon-like styling, no panel on the normal page, synced highlighting and scrolling with seek/pause, removal on full view close / song change / Amazon lines appearing, matching, translation and text size of the fetched lines, cache and 7-day "not found" marker, rate limiting, the popup toggle and the "This song" notices (full view open and closed). It also covers the v1.3.3 language skip for LRCLIB lines (English lyrics with symbols and a look-alike letter, a mostly English song with two Japanese lines, a stale Gemini cache) and writes `fullview-1.3.2.png`.
- `test-update.js`: the v1.3.4 update notice (api.github.com is mocked). The real unpacked folder (`chrome.management.getSelf()` says `development`, without the `management` permission): check ~5 s after start, stored result, NEW badge, popup update line/link/how-to, "Check for updates" with "Checking…", up to date / newer / older / 403 / 429 / offline / 404, the 60 s cooldown ("Checked just now"), the daily and 3 h retry timing triggered by the popup and content-script messages, numeric version compare and install-type rules. Store copies (a temporary copy whose `getSelf()` is stubbed to `normal` or `sideload`) make zero GitHub requests and show no badge or update UI. The other suites answer GitHub with the installed version.
- `test-extra.js`: recovery after a failed request (takes about a minute).
