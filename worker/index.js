import { applySetCookies, cookieHeaderFrom, readSession, readSiteCookie, sessionCookie, siteCookie } from '../src/cookies.js';
import { rewriteCss } from '../src/css.js';
import { renderErrorPage, renderHome, renderSearch, renderSearchFailed } from '../src/pages.js';
import { requestKind } from '../src/request-kind.js';
import { isDroppedHeader } from '../src/response-headers.js';
import { fallbackTarget, isDocumentRequest } from '../src/root-fallback.js';
import { challengeMessage, isChallengePage, redirectStatus, upstreamHeaders } from '../src/upstream.js';
import { SITE_PARAM, isBlockedUrl, normalizeInputUrl, proxyPathFor, resolveUrl, targetFromProxyPath } from '../src/url.js';
import { rewriteHtml, rewriteHtmlResponse } from './html.js';
import { loadJar, saveJar } from './jar.js';
import { searchWeb } from './search.js';

/**
 * The same ProxyLab, as a Cloudflare Worker. Express cannot run on Workers,
 * but the routing, URL scheme, rewriting rules and cookie jar are shared with
 * the Node server in src/.
 */

const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });

const fail = (status, message) => html(renderErrorPage(status, message), status);

const goTo = (requestUrl, path) => Response.redirect(new URL(path, requestUrl).href, 302);

async function textWithCharset(response) {
  const buffer = await response.arrayBuffer();
  const match = /charset\s*=\s*"?([\w-]+)/i.exec(response.headers.get('content-type') || '');
  try {
    return new TextDecoder((match?.[1] || 'utf-8').toLowerCase()).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function proxy(request, requestUrl, env, explicitTarget) {
  const target = explicitTarget || targetFromProxyPath(requestUrl.pathname, requestUrl.search);
  if (!target) return fail(400, '주소를 해석할 수 없습니다. /_p/<base64url 오리진>/<경로> 형태여야 합니다.');
  if (isBlockedUrl(target)) return fail(403, '이 주소로는 프록시가 접근할 수 없습니다.');

  // No server memory here: the browser's own pl_sid names its jar in D1.
  const { sid, isNew } = readSession(request.headers.get('cookie'));
  // `Secure` keeps the cookies off plain http; local `wrangler dev` is http.
  const secure = requestUrl.protocol === 'https:';
  // Only a document navigation may claim "this is the site the visitor is on".
  // Sites also serve JSON/JS labelled text/html (naver does), and letting those
  // overwrite the cookie sent later root-relative requests to the wrong host.
  const isDocument = isDocumentRequest({
    secFetchDest: request.headers.get('sec-fetch-dest'),
    accept: request.headers.get('accept'),
  });
  // What the browser will do with the body decides whether it is markup.
  const requestType = requestKind(request.headers.get('sec-fetch-dest'));
  const withSession = (response, siteOrigin) => {
    if (!isNew && !siteOrigin) return response;
    const out = new Response(response.body, response);
    if (isNew) out.headers.append('set-cookie', sessionCookie(sid, secure));
    // Scripts in this document will call absolute paths; the cookie says where
    // they belong when a request arrives without a Referer.
    if (siteOrigin) out.headers.append('set-cookie', siteCookie(siteOrigin, secure));
    return out;
  };

  const method = request.method === 'HEAD' ? 'GET' : request.method;
  // The jar is reloaded per request: a deployed Worker has no memory between
  // requests, so D1 (or the in-memory fallback) is the source of truth. A brand
  // new session has nothing stored yet, so skip the read entirely.
  const jar = isNew ? [] : await loadJar(env, sid);
  // Its own Referer/Origin, the browser's Sec-Fetch-* headers and our jars's
  // cookies: the same rules the Node server uses (src/upstream.js).
  const headers = new Headers(
    upstreamHeaders((name) => request.headers.get(name), target, {
      cookie: cookieHeaderFrom(jar, target),
      method,
    }),
  );

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: method === 'GET' ? undefined : request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '시간 초과' : error?.message;
    return withSession(fail(502, `대상 서버에 연결하지 못했습니다 (${reason}).`));
  }

  // Capture cookies before any early return: a login redirect sets them.
  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  if (applySetCookies(jar, upstream.url || target, setCookies)) {
    try {
      await saveJar(env, sid, jar);
    } catch (error) {
      console.error('[proxylab] cookie store failed:', error.message);
    }
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get('location');
    const next = location && resolveUrl(target, location);
    if (!next) return withSession(fail(502, '대상 서버가 해석할 수 없는 리다이렉트를 보냈습니다.'));
    const status = redirectStatus(upstream.status);
    return withSession(Response.redirect(new URL(proxyPathFor(next), requestUrl).href, status));
  }

  const upstreamType = upstream.headers.get('content-type') || '';
  const kind = upstreamType.toLowerCase();

  if (kind.includes('text/html') || kind.includes('application/xhtml')) {
    // A document the browser is going to render needs no look at the body first:
    // the bytes go from the site through HTMLRewriter to the browser while the
    // document is still arriving. Everything below has to read the body, and
    // stays buffered because of it — a bot wall is recognised by its text, and a
    // script labelled text/html is passed on undecoded.
    if (upstream.ok && upstream.body && requestType === 'page') {
      const finalUrl = upstream.url || target;
      return withSession(
        html(rewriteHtmlResponse(upstream, finalUrl).body, upstream.status),
        isDocument ? new URL(finalUrl).origin : null,
      );
    }

    const raw = await textWithCharset(upstream);

    // Sites label more than HTML as text/html: JSON (naver's /nvhaproxy) and even
    // JavaScript (naver's gnb template). What the browser asked for decides, not
    // the body: only a page gets the markup pass, and a script has to be sent as
    // JavaScript or the browser refuses to run it.
    if (requestType === 'script') {
      return withSession(
        new Response(raw, {
          status: upstream.status,
          headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
        }),
      );
    }
    if (requestType !== 'page') {
      const wantsJson = /application\/json/i.test(request.headers.get('accept') || '');
      return withSession(
        new Response(raw, {
          status: upstream.status,
          headers: {
            'content-type': wantsJson ? 'application/json; charset=utf-8' : upstreamType,
            'cache-control': 'no-store',
          },
        }),
      );
    }

    if (isChallengePage(upstream.status, raw)) return withSession(fail(502, challengeMessage(target)));
    return withSession(
      html(await rewriteHtml(raw, upstream.url || target), upstream.status),
      isDocument ? new URL(upstream.url || target).origin : null,
    );
  }

  if (kind.includes('text/css')) {
    const css = rewriteCss(await textWithCharset(upstream), upstream.url || target);
    return withSession(
      new Response(css, {
        status: upstream.status,
        headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' },
      }),
    );
  }

  const passthrough = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!isDroppedHeader(name)) passthrough.set(name, value);
  });
  passthrough.set('cache-control', 'no-store');
  return withSession(new Response(upstream.body, { status: upstream.status, headers: passthrough }));
}

async function proxyUnknown(request, url, env) {
  const target = fallbackTarget({
    referer: request.headers.get('referer'),
    site: readSiteCookie(request.headers.get('cookie')),
    // A copied address keeps the site in ?_pl= once the /_p/ prefix is gone.
    token: url.searchParams.get(SITE_PARAM),
    pathname: url.pathname,
    search: url.search,
  });
  if (!target) return null;

  // A document has to live under /_p/, or its own relative links resolve wrong.
  if (request.method === 'GET' && isDocumentRequest({
    secFetchDest: request.headers.get('sec-fetch-dest'),
    accept: request.headers.get('accept'),
  })) {
    return Response.redirect(new URL(proxyPathFor(target), url).href, 302);
  }

  return proxy(request, url, env, target);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/') return html(renderHome());
  if (path === '/favicon.ico') return new Response(null, { status: 204 });

  if (path === '/search') {
    const query = (url.searchParams.get('q') || '').trim();
    if (!query) return goTo(url, '/');

    let results = [];
    try {
      results = await searchWeb(query);
    } catch (error) {
      console.error('[proxylab] search failed:', error.message);
    }

    return html(results.length ? renderSearch(query, results) : renderSearchFailed(query));
  }

  if (path === '/namu') {
    const name = (url.searchParams.get('q') || '').trim().replace(/^\/?w\//, '');
    if (!name) return goTo(url, '/');
    // 나무위키 문서 주소는 https://namu.wiki/w/<문서명> 이다.
    return goTo(url, proxyPathFor(`https://namu.wiki/w/${encodeURIComponent(name)}`));
  }

  if (path === '/open') {
    const target = normalizeInputUrl(url.searchParams.get('url'));
    if (!target) return goTo(url, '/');
    return goTo(url, proxyPathFor(target));
  }

  if (path.startsWith('/_p/')) return proxy(request, url, env);

  if (env?.ASSETS) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
  }

  // Scripts in a proxied page ask for root-relative paths (`/nvhaproxy/...`).
  // Those land here, so send them to the site that page came from.
  const proxied = await proxyUnknown(request, url, env);
  if (proxied) return proxied;
  return fail(404, '페이지를 찾을 수 없습니다.');
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      // An uncaught error becomes an opaque platform page; explain it instead.
      console.error('[proxylab] unhandled:', error?.stack || error?.message);
      return fail(502, `요청을 처리하지 못했습니다 (${error?.message || '알 수 없는 오류'}).`);
    }
  },
};
