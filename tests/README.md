# Tests

End-to-end tests that load the unpacked extension (`../extension`) in headless Chromium with Playwright and run it against `mock.html`, a local copy of the Amazon Music lyrics view's structure and of the mini-player's markup (test IDs, ARIA labels, the "Lyrics available" badge). `music.amazon.com` is routed to the mock page, Google Translate requests are answered from `fixtures.json`, and the Gemini API is mocked with a placeholder key (no real key is used or needed).

All lyric lines in `mock.html`, `fixtures.json` and the tests (including the mocked LRCLIB answers) are invented test text.

```sh
cd tests
npm install
npx playwright install chromium
npm test
```

- `test.js`: rendering, layout, romanization/translation, settings, floating button, selectors, failure handling.
- `test-gemini.js`: Gemini translator, fallback to Google, status dot, popup "This song" line and button, LRU cache and counter.
- `test-lrclib.js`: the LRCLIB fallback for songs Amazon has no lyrics for (lrclib.net is mocked): no-lyrics detection from the mini-player badge (badge present, absent, appearing late within the settle window or after the panel, other badges, no mini-player), the clock from the slider's aria-label (m:ss and h:mm:ss, with or without aria-valuenow/max), the panel's position above the mini-player, matching (wrong duration/artist rejected), synced highlighting with seek/pause/song change, translation of the fetched lines, cache and 7-day "not found" marker, rate limiting, the popup toggle and the "This song" line and notice (including with the lyrics view closed).
- `test-extra.js`: recovery after a failed request (takes about a minute).
