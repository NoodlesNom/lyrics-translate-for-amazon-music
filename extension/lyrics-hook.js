/* Page world. Reads the TrackLyricsPage response Amazon Music already sends
 * when the full lyrics view opens. Does not send its own request. Auth
 * headers are never read. Only lyric lines and times are posted out. */
(function () {
  if (window.__amltLyricsHook) return;
  window.__amltLyricsHook = true;

  const nativeFetch = window.fetch.bind(window);
  let latest = null;

  function requestUrl(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
    } catch (e) {}
    return '';
  }

  function isGql(url) {
    try {
      return new URL(url, window.location.href).hostname === 'gql.music.amazon.com';
    } catch (e) {
      return typeof url === 'string' && url.indexOf('https://gql.music.amazon.com/') === 0;
    }
  }

  function bodyText(body) {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return null;
    if (typeof body === 'object' && typeof body.toString === 'function') {
      try {
        const text = body.toString();
        if (text && text !== '[object Object]' && text !== '[object ArrayBuffer]') return text;
      } catch (e) {}
    }
    return null;
  }

  function trackLyricsOp(body) {
    const batched = Array.isArray(body);
    const ops = batched ? body : [body];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op || typeof op !== 'object') continue;
      const name = op.operationName === 'TrackLyricsPage';
      const query = typeof op.query === 'string' && /\bTrackLyricsPage\b/.test(op.query);
      if (!name && !query) continue;
      const vars = op.variables && typeof op.variables === 'object' ? op.variables : {};
      const trackId = typeof vars.trackId === 'string' ? vars.trackId : '';
      return { index: i, batched: batched, trackId: trackId };
    }
    return null;
  }

  function hintFromText(text) {
    if (!text) return null;
    let json;
    try { json = JSON.parse(text); } catch (e) { return null; }
    return trackLyricsOp(json);
  }

  function numOrNull(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && isFinite(Number(v))) return Number(v);
    return null;
  }

  function linesOf(track) {
    const lyrics = track && track.lyrics;
    const raw = lyrics && Array.isArray(lyrics.lines) ? lyrics.lines : null;
    if (!raw) return [];
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const line = raw[i];
      if (!line || typeof line !== 'object') continue;
      out.push({
        text: typeof line.text === 'string' ? line.text : '',
        start: numOrNull(line.startTimeMillis),
        end: numOrNull(line.endTimeMillis)
      });
    }
    return out;
  }

  function extract(json, hint) {
    const roots = Array.isArray(json) ? json : [json];
    let root = null;
    if (hint && hint.batched && roots[hint.index]) root = roots[hint.index];
    if (!root) {
      for (let i = 0; i < roots.length; i++) {
        const data = roots[i] && roots[i].data;
        if (data && data.track && (data.track.lyrics || data.track.hasLyrics === false)) { root = roots[i]; break; }
      }
    }
    const track = root && root.data && root.data.track;
    if (!track || typeof track !== 'object') return null;
    if (!(track.lyrics && Array.isArray(track.lyrics.lines)) && track.lyrics != null && track.hasLyrics !== false) return null;
    const responseId = typeof track.id === 'string' ? track.id : '';
    const ids = [];
    if (hint && hint.trackId) ids.push(hint.trackId);
    if (responseId && ids.indexOf(responseId) < 0) ids.push(responseId);
    return { ids: ids, lines: linesOf(track) };
  }

  function publish(pack) {
    if (!pack) return;
    const lines = [];
    const src = pack.lines || [];
    for (let i = 0; i < src.length; i++) {
      const line = src[i] || {};
      lines.push({
        text: typeof line.text === 'string' ? line.text : '',
        start: typeof line.start === 'number' && isFinite(line.start) ? line.start : null,
        end: typeof line.end === 'number' && isFinite(line.end) ? line.end : null
      });
    }
    const ids = [];
    const rawIds = pack.ids || [];
    for (let i = 0; i < rawIds.length; i++) {
      if (typeof rawIds[i] === 'string' && rawIds[i] && ids.indexOf(rawIds[i]) < 0) ids.push(rawIds[i]);
    }
    latest = { ids: ids, lines: lines };
    let origin = '*';
    try {
      if (location.origin && location.origin !== 'null') origin = location.origin;
    } catch (e) {}
    try {
      window.postMessage({
        source: 'amlt-page',
        type: 'lyrics',
        trackId: ids[0] || '',
        ids: ids,
        lines: lines
      }, origin);
    } catch (e) {}
  }

  function take(hint, json) {
    if (!hint || !json) return;
    const pack = extract(json, hint);
    if (pack) publish(pack);
  }

  function hintFromRequest(input, init) {
    const method = (init && init.method) || (input && input.method) || 'GET';
    const url = requestUrl(input);
    if (!isGql(url) || String(method).toUpperCase() !== 'POST') return Promise.resolve(null);
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) return Promise.resolve(hintFromText(bodyText(init.body)));
    // A Request's body can be read only via a clone, before fetch consumes it. Headers are not read.
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return input.clone().text().then(hintFromText).catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  window.fetch = function (input, init) {
    let hinted = Promise.resolve(null);
    try { hinted = hintFromRequest(input, init); } catch (e) {}
    const pending = nativeFetch(input, init);
    return Promise.resolve(hinted).then(function (hint) {
      if (!hint) return pending;
      return pending.then(function (response) {
        try {
          response.clone().json().then(function (json) { take(hint, json); }).catch(function () {});
        } catch (e) {}
        return response;
      });
    }, function () { return pending; });
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__amltLyrics = { method: method, url: String(url || '') };
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    let hinted = null;
    try {
      const meta = this.__amltLyrics;
      if (meta && isGql(meta.url) && String(meta.method || 'GET').toUpperCase() === 'POST') {
        hinted = hintFromText(bodyText(body));
      }
    } catch (e) {}
    if (hinted) {
      this.addEventListener('load', function () {
        let json = null;
        try {
          if (this.responseType === 'json') json = this.response;
          else if (!this.responseType || this.responseType === 'text') json = JSON.parse(this.responseText);
        } catch (e) { json = null; }
        take(hinted, json);
      });
    }
    return xhrSend.apply(this, arguments);
  };

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    try {
      if (location.origin && event.origin !== location.origin) return;
    } catch (e) { return; }
    const data = event.data;
    if (!data || data.source !== 'amlt-ext' || data.type !== 'pull') return;
    if (latest) publish(latest);
  });
})();
