/** Every proxied resource lives under this prefix: /_p/<base64url(origin)>/<target path> */
export const PROXY_PATH = '/_p/';

/**
 * Where the site token lives once the /_p/ prefix leaves the address bar.
 *
 * A single-page app needs its own path (`/webtoon/list`), so the client script
 * swaps the prefix for this query parameter. It is what makes a copied address
 * open in another browser, where there is no cookie to remember the site.
 */
export const SITE_PARAM = '_pl';

/**
 * Encoding and decoding are the hottest string work in the proxy: one page's
 * markup repeats the same origin token hundreds of times, and every request
 * decodes the token in its own path.
 *
 * So both directions are memoised, and the TextEncoder is built once instead of
 * per call. A Cloudflare Worker gets 10 ms of CPU per request on the free plan,
 * and this is where a large document was spending it.
 */
const CACHE_LIMIT = 512;
const tokens = new Map();
const origins = new Map();
const encoder = new TextEncoder();

/** base64url without Buffer, so the same code runs on Node and on Workers. */
function encode(text) {
  let binary = '';
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function remember(cache, key, value) {
  // A clear is a cheap cap: the cache only has to hold the origins one page uses.
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

/** The token for one origin, reused across every link that points at it. */
function originToken(origin) {
  return tokens.get(origin) || remember(tokens, origin, encode(origin));
}

function decode(token) {
  if (origins.has(token)) return origins.get(token);
  let origin = null;
  try {
    const binary = atob(token.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(token.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    origin = new TextDecoder().decode(bytes);
  } catch {
    origin = null;
  }
  return remember(origins, token, origin);
}

/**
 * Why the token holds only the origin, and the target's own path follows it:
 *
 *   https://pm.pstatic.net/resources/js/main.js
 *   -> /_p/aHR0cHM6Ly9wbS5wc3RhdGljLm5ldA/resources/js/main.js
 *
 * A proxied JavaScript module resolves its own relative imports against the URL
 * it was loaded from. With the whole target URL inside the token, `./nlog2.js`
 * became /_p/nlog2.js and the proxy answered 400 — every script-driven page
 * looked half empty. Keeping the path means that import becomes
 * /_p/<same token>/resources/js/nlog2.js, which maps back to the right file.
 */
export function proxyPathFromUrl(url) {
  const path = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
  return `${PROXY_PATH}${originToken(url.origin)}${path}${url.search}`;
}

/**
 * The /_p/ directory a document's relative references resolve against.
 *
 * A document served from /_p/<token>/game/42/index.html has to resolve
 * `Build/x.data.br` as /_p/<token>/game/42/Build/x.data.br. That is what the
 * browser does on the site itself, but inside the proxy a frame whose address
 * was replaced by the portal path would resolve it against the portal instead —
 * the assets land on /kr/game/... and 404. Injecting this as <base href> keeps
 * the frame's own directory as the base, whatever the address bar says.
 */
export function proxyBasePath(absoluteUrl) {
  let url;
  try {
    url = new URL(absoluteUrl);
  } catch {
    return null;
  }
  const path = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
  // A query string is not part of the directory relative URLs resolve against.
  const directory = path.slice(0, path.lastIndexOf('/') + 1);
  return `${PROXY_PATH}${originToken(url.origin)}${directory}`;
}

export function proxyPathFor(absoluteUrl) {
  let url;
  try {
    url = new URL(absoluteUrl);
  } catch {
    return null;
  }
  return proxyPathFromUrl(url);
}

/**
 * Turn a /_p/ request path (plus its query string) back into the target URL.
 * Also accepts the old links where the segment held the whole URL.
 */
export function targetFromProxyPath(pathname, search = '') {
  if (!pathname || !pathname.startsWith(PROXY_PATH)) return null;

  const rest = pathname.slice(PROXY_PATH.length);
  const slash = rest.indexOf('/');
  const segment = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? '' : rest.slice(slash);
  const decoded = decode(segment);
  if (!decoded) return null;

  try {
    const target = new URL(decoded + tail + search);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    return target.href;
  } catch {
    return null;
  }
}

/**
 * Turn any reference found inside a page (href, src, url()) into an absolute
 * URL, relative to the URL the page was actually served from.
 * Returns null for schemes we deliberately leave untouched.
 */
export function resolveUrlObject(base, ref) {
  if (typeof ref !== 'string') return null;
  const raw = ref.trim();
  if (!raw || raw.startsWith('#')) return null;
  if (/^(javascript|mailto|tel|sms|data|blob|about|magnet|chrome|ftp):/i.test(raw)) return null;
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * The same, as a string.
 *
 * Rewriting a reference needs the parsed URL, not its text: `proxyPathFor(href)`
 * parsed every absolute URL a second time. Callers that build a proxy path use
 * resolveUrlObject + proxyPathFromUrl instead.
 */
export function resolveUrl(base, ref) {
  const url = resolveUrlObject(base, ref);
  return url ? url.href : null;
}

/** Used by the "open this address" box, where the scheme may be missing. */
export function normalizeInputUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function isPrivateV4(host) {
  const [a, b] = host.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Keep the proxy from being used to reach the machine it runs on (SSRF guard).
 * This only inspects literal hosts; it is not a DNS-rebinding-proof filter.
 */
export function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateV4(host);
  if (host.includes(':')) {
    return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe80/.test(host) || host.startsWith('::ffff:127.');
  }
  return false;
}

export function isBlockedUrl(absoluteUrl) {
  try {
    const url = new URL(absoluteUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
    return isBlockedHost(url.hostname);
  } catch {
    return true;
  }
}
