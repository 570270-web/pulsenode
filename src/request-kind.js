/**
 * What the browser is going to do with the response it asked for.
 *
 * `Sec-Fetch-Dest` is set by the browser itself, so it says what the request is
 * FOR (`document`, `script`, `image`, ...) rather than what the site claims it
 * is sending. That matters here because sites label all sorts of bodies as
 * `text/html` — naver serves JavaScript and JSON that way — so looking at the
 * bytes is guesswork while the request kind is a fact.
 *
 * Both runtimes call this, so the rule lives in one place.
 */
export function requestKind(secFetchDest) {
  const dest = String(secFetchDest || '').toLowerCase();

  // No header at all (an old browser, or a tool like curl): fall back to the
  // old behaviour and treat it as a page. A document that is not rewritten is
  // the one mistake the browser cannot recover from.
  if (!dest || dest === 'document' || dest === 'iframe' || dest === 'frame' || dest === 'embed' || dest === 'object') {
    return 'page';
  }
  if (dest === 'script' || dest === 'worker' || dest === 'sharedworker' || dest === 'serviceworker') {
    return 'script';
  }
  return 'other';
}
