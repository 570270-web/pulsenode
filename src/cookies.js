/**
 * A cookie jar that lives on the server, not in the browser.
 *
 * Why: the proxied site's cookies are issued for ITS host (comic.naver.com).
 * Our browser is talking to OUR host, so it would never send them back. So we
 * keep them ourselves, keyed by a session id we hand the browser, and attach
 * the right ones to every upstream request.
 *
 * The matching rules below are storage-agnostic: Node keeps jars in a Map,
 * the Cloudflare Worker keeps them in D1.
 *
 * The `Domain` attribute is honoured, as RFC 6265 describes it. A site that
 * sets `Domain=.naver.com` on nid.naver.com expects that cookie on
 * www.naver.com too; pinning every cookie to the host that answered broke
 * naver's login, where the session cookie never reached the portal after the
 * redirect, so a finished login looked like a logout. Cookies set without a
 * Domain stay host-only, exactly as a browser stores them.
 */

const SESSION_COOKIE = 'pl_sid';
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;
const MAX_COOKIES_PER_SESSION = 300;
const MAX_COOKIE_SIZE = 4096;

/** sid -> { jar: Cookie[], touched: number } (Node only) */
const sessions = new Map();

const clock = () => Date.now();

function touch(sid) {
  const state = sessions.get(sid);
  if (!state) return null;
  state.touched = clock();
  return state;
}

function prune() {
  const cutoff = clock() - SESSION_TTL_MS;
  for (const [sid, state] of sessions) {
    if (state.touched < cutoff) sessions.delete(sid);
  }
}

/**
 * Find (or start) this visitor's jar. The cookie is HttpOnly so a proxied
 * page's script cannot read — and replay — someone else's session id.
 * Returns { sid, isNew }; the caller is responsible for sending the cookie.
 */
export function resolveSession(cookieHeader) {
  prune();

  const found = /(?:^|;\s*)pl_sid=([A-Za-z0-9-]{8,64})/.exec(String(cookieHeader || ''));
  if (found && touch(found[1])) return { sid: found[1], isNew: false };

  if (sessions.size >= MAX_SESSIONS) {
    let oldestSid = null;
    let oldestTime = Infinity;
    for (const [sid, state] of sessions) {
      if (state.touched < oldestTime) {
        oldestTime = state.touched;
        oldestSid = sid;
      }
    }
    if (oldestSid) sessions.delete(oldestSid);
  }

  const sid = crypto.randomUUID();
  sessions.set(sid, { jar: [], touched: clock() });
  return { sid, isNew: true };
}

/**
 * Stateless session lookup: the browser tells us which jar is theirs, so a
 * runtime without memory between requests (a Worker) still finds the right one.
 */
export function readSession(cookieHeader) {
  const found = /(?:^|;\s*)pl_sid=([A-Za-z0-9-]{8,64})/.exec(String(cookieHeader || ''));
  return { sid: found ? found[1] : crypto.randomUUID(), isNew: !found };
}

/** `Secure` keeps the cookie off plain http; only add it when we are on https. */
function cookieAttributes(secure) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
}

/** The Set-Cookie value that ties a browser to its jar. */
export function sessionCookie(sid, secure = false) {
  return `${SESSION_COOKIE}=${sid}; ${cookieAttributes(secure)}`;
}

/**
 * Which site is this browser currently browsing through the proxy?
 *
 * A proxied page's scripts also build root-relative paths (`/api/...`), which
 * land on OUR origin. The Referer usually says which page they came from; this
 * cookie is the fallback for requests that carry no Referer (see
 * src/root-fallback.js). It is per browser, not per tab, so it is only a hint.
 */
const SITE_COOKIE = 'pl_site';

export function siteCookie(origin, secure = false) {
  return `${SITE_COOKIE}=${encodeURIComponent(origin)}; ${cookieAttributes(secure)}`;
}

export function readSiteCookie(cookieHeader) {
  const found = /(?:^|;\s*)pl_site=([^;]+)/.exec(String(cookieHeader || ''));
  if (!found) return null;
  try {
    const origin = decodeURIComponent(found[1]);
    return /^https?:\/\//i.test(origin) ? origin : null;
  } catch {
    return null;
  }
}

/** RFC 6265 domain-match. */
function domainMatches(host, cookie) {
  if (host === cookie.domain) return true;
  return !cookie.hostOnly && host.endsWith(`.${cookie.domain}`);
}

/** RFC 6265 path-match. */
function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** Default-Path of RFC 6265: the directory part of the request path. */
function defaultPath(pathname) {
  if (!pathname.startsWith('/')) return '/';
  const last = pathname.lastIndexOf('/');
  return last <= 0 ? '/' : pathname.slice(0, last);
}

export function parseSetCookie(header) {
  const parts = String(header).split(';');
  const pair = parts.shift() || '';
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;

  const cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: '',
    hostOnly: true,
    path: '',
    expires: null,
    secure: false,
    httpOnly: false,
    created: 0,
  };
  if (!cookie.name) return null;

  for (const part of parts) {
    const index = part.indexOf('=');
    const key = (index < 0 ? part : part.slice(0, index)).trim().toLowerCase();
    const value = index < 0 ? '' : part.slice(index + 1).trim();

    if (key === 'domain' && value) {
      cookie.domain = value.replace(/^\./, '').toLowerCase();
      cookie.hostOnly = false;
    } else if (key === 'path') {
      cookie.path = value.startsWith('/') ? value : '';
    } else if (key === 'expires') {
      const time = Date.parse(value);
      if (!Number.isNaN(time)) cookie.expires = time;
    } else if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expires = clock() + seconds * 1000;
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    }
  }

  return cookie;
}

/** Remember every Set-Cookie an upstream response handed us. Returns true if the jar changed. */
export function applySetCookies(jar, targetUrl, setCookieHeaders) {
  if (!setCookieHeaders?.length) return false;

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }
  const host = target.hostname.toLowerCase();
  let changed = false;

  for (const header of setCookieHeaders) {
    const cookie = parseSetCookie(header);
    if (!cookie) continue;
    if (cookie.value.length > MAX_COOKIE_SIZE) continue;

    // RFC 6265: a Domain attribute widens who may receive this cookie, so the
    // host that set it has to be inside that domain; without one the cookie is
    // host-only.
    if (cookie.domain) {
      if (host !== cookie.domain && !host.endsWith(`.${cookie.domain}`)) continue;
    } else {
      cookie.domain = host;
      cookie.hostOnly = true;
    }
    cookie.path = cookie.path || defaultPath(target.pathname);

    const same = (c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path;
    const index = jar.findIndex(same);

    if (cookie.expires !== null && cookie.expires <= clock()) {
      if (index >= 0) {
        jar.splice(index, 1);
        changed = true;
      }
      continue;
    }

    cookie.created = clock();
    if (index >= 0) jar[index] = cookie;
    else jar.push(cookie);
    changed = true;
  }

  while (jar.length > MAX_COOKIES_PER_SESSION) jar.shift();
  return changed;
}

/** The Cookie header (or '') to send upstream for this URL. */
export function cookieHeaderFrom(jar, targetUrl) {
  if (!jar.length) return '';

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return '';
  }

  const host = target.hostname.toLowerCase();
  const path = target.pathname || '/';
  const isSecure = target.protocol === 'https:';
  const matched = [];

  for (let index = jar.length - 1; index >= 0; index -= 1) {
    const cookie = jar[index];
    if (cookie.expires !== null && cookie.expires <= clock()) {
      jar.splice(index, 1);
      continue;
    }
    if (cookie.secure && !isSecure) continue;
    if (!domainMatches(host, cookie)) continue;
    if (!pathMatches(path, cookie.path)) continue;
    matched.push(cookie);
  }

  // Longest path first, then oldest: the order a real browser sends.
  matched.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  return matched.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** Node adapter: the Cookie header for this session. */
export function cookieHeaderFor(sid, targetUrl) {
  const state = touch(sid);
  return state ? cookieHeaderFrom(state.jar, targetUrl) : '';
}

/** Node adapter: remember an upstream response's cookies. */
export function storeCookies(sid, targetUrl, setCookieHeaders) {
  const state = touch(sid);
  if (state) applySetCookies(state.jar, targetUrl, setCookieHeaders);
}
