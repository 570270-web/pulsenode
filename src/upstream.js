import { targetFromReferer } from './root-fallback.js';

/**
 * What an upstream request should look like, and how a bot wall is recognised.
 *
 * Node has an express request and the Worker a fetch `Request`, so each passes
 * a `get(name)` function instead of the request itself. The decisions — which
 * headers a browser always sends, which Referer/Origin a site expects, which
 * reply is a challenge — are identical on both runtimes and live here so they
 * cannot drift apart.
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** A browser always sends these; without them a request looks scripted. */
const SEC_FETCH_HEADERS = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'];

/**
 * The headers to send upstream for this request.
 *
 * `cookie` comes from our own jar, never from the browser: the browser's Cookie
 * header carries our session id, not the target site's cookies.
 */
export function upstreamHeaders(get, target, { cookie = '', method = 'GET' } = {}) {
  const headers = {
    'user-agent': get('user-agent') || DEFAULT_UA,
    accept: get('accept') || '*/*',
    'accept-language': get('accept-language') || 'ko,en;q=0.8',
    'upgrade-insecure-requests': '1',
  };

  // The page the visitor was on, translated back into the site's own address
  // space (src/root-fallback.js). A login or captcha check compares the Referer
  // with its own domain, so our origin would fail. A direct navigation carries
  // no Referer at all; the target's root stands in.
  let referer = targetFromReferer(get('referer'));
  if (!referer) {
    try {
      referer = `${new URL(target).origin}/`;
    } catch {
      referer = null;
    }
  }
  if (referer) headers.referer = referer;

  for (const name of SEC_FETCH_HEADERS) {
    const value = get(name);
    if (value) headers[name] = value;
  }

  // Browsers send Origin on form posts and cross-origin requests; a site's CSRF
  // check compares it with its own origin, so ours has to be replaced.
  if (get('origin') || !/^(GET|HEAD)$/i.test(method)) {
    try {
      headers.origin = new URL(target).origin;
    } catch {
      // An unparsable target is rejected before this point.
    }
  }

  const contentType = get('content-type');
  if (contentType) headers['content-type'] = contentType;
  if (cookie) headers.cookie = cookie;

  return headers;
}

/** 307/308 keep the method and body; every other redirect degrades to a GET. */
export function redirectStatus(status) {
  return status === 307 || status === 308 ? status : 302;
}

/**
 * Bot walls (Cloudflare and friends) answer 403/429/503 with a challenge page.
 * Passing that through looks like our proxy is broken, so we explain it instead.
 */
export function isChallengePage(status, body) {
  if (status !== 403 && status !== 429 && status !== 503) return false;
  return /Attention Required!|cf-error-details|cf_chl_opt|Just a moment\.\.\.|Enable JavaScript and cookies to continue/i.test(
    String(body).slice(0, 4000),
  );
}

/** Why the page is not being shown: the proxy's IP is what got blocked. */
export function challengeMessage(target) {
  let host = target;
  try {
    host = new URL(target).hostname;
  } catch {
    // Keep the raw target in the message.
  }
  return `${host} 가 프록시의 접속을 봇으로 판단해 차단했습니다. 이 서버의 IP를 막고 있어서 헤더를 바꿔도 통하지 않습니다. 직접 실행 중인 네트워크에서는 열릴 수 있습니다.`;
}
