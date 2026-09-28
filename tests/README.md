# Tests

End-to-end tests that load the unpacked extension (`../extension`) in headless Chromium with Playwright and run it against `mock.html`, a local copy of the Amazon Music lyrics view's structure. `music.amazon.com` is routed to the mock page, Google Translate requests are answered from `fixtures.json`, and the Gemini API is mocked with a placeholder key (no real key is used or needed).

All lyric lines in `mock.html`, `fixtures.json` and the tests are invented test text.

```sh
cd tests
npm install
npx playwright install chromium
npm test
```

- `test.js`: rendering, layout, romanization/translation, settings, floating button, selectors, failure handling.
- `test-gemini.js`: Gemini translator, fallback to Google, status dot, popup "This song" line and button, LRU cache and counter.
- `test-extra.js`: recovery after a failed request (takes about a minute).
