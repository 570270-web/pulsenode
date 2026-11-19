import { cookieHeaderFor, resolveSession, sessionCookie, siteCookie, storeCookies } from './cookies.js';
import { renderErrorPage } from './pages.js';
import { rewriteCss } from './css.js';
import { requestKind } from './request-kind.js';
import { isDroppedHeader } from './response-headers.js';
import { isDocumentRequest } from './root-fallback.js';
import { rewriteHtml } from './rewrite.js';
import { challengeMessage, isChallengePage, redirectStatus, upstreamHeaders } from './upstream.js';
import { isBlockedUrl, proxyPathFor, resolveUrl, targetFromProxyPath } from './url.js';

function fail(res, status, message) {
  res.status(status).type('html').send(renderErrorPage(status, message));
}

function decodeBody(buffer, contentType) {
  const match = /charset\s*=\s*"?([\w-]+)/i.exec(String(contentType || ''));
  const label = (match?.[1] || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

export async function handleProxy(req, res, explicitTarget) {
  const [pathname, query] = String(req.originalUrl || req.url).split('?');
  const target = explicitTarget || targetFromProxyPath(pathname, query ? `?${query}` : '');
  if (!target) {
    return fail(res, 400, '주소를 해석할 수 없습니다. /_p/<base64url 오리진>/<경로> 형태여야 합니다.');
  }
  if (isBlockedUrl(target)) {
    return fail(res, 403, '이 주소로는 프록시가 접근할 수 없습니다.');
  }

  const { sid, isNew } = resolveSession(req.headers.cookie);
  // `Secure` would make the browser drop our cookies on plain-http local dev.
  const secure = Boolean(req.secure) || req.get('x-forwarded-proto') === 'https';
  // Only a document navigation may claim "this is the site the visitor is on".
  // Sites also serve JSON/JS labelled text/html (naver does), and letting those
  // overwrite the cookie sent later root-relative requests to the wrong host.
  const isDocument = isDocumentRequest({ secFetchDest: req.get('sec-fetch-dest'), accept: req.get('accept') });
  // What the browser will do with the body decides whether it is markup.
  const requestType = requestKind(req.get('sec-fetch-dest'));
  if (isNew) res.setHeader('set-cookie', sessionCookie(sid, secure));

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const body = method === 'GET' ? undefined : req.body;

  // What the site expects to see: its own Referer and Origin, the browser's
  // Sec-Fetch-* headers, and the cookies from our jar (src/upstream.js).
  const headers = upstreamHeaders((name) => req.get(name), target, {
    cookie: cookieHeaderFor(sid, target),
    method,
  });

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: body && body.length ? body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '시간 초과' : error?.cause?.code || error?.message;
    return fail(res, 502, `대상 서버에 연결하지 못했습니다 (${reason}).`);
  }

  // Cookies must be captured before any early return, or a redirect that sets
  // the login session would lose it.
  storeCookies(sid, upstream.url || target, upstream.headers.getSetCookie?.());

  // Follow redirects ourselves so the browser stays inside the proxy.
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get('location');
    const next = location && resolveUrl(target, location);
    if (!next) return fail(res, 502, '대상 서버가 해석할 수 없는 리다이렉트를 보냈습니다.');
    return res.redirect(redirectStatus(upstream.status), proxyPathFor(next));
  }

  upstream.headers.forEach((value, name) => {
    if (!isDroppedHeader(name)) res.setHeader(name, value);
  });
  res.setHeader('cache-control', 'no-store');

  const upstreamType = upstream.headers.get('content-type') || '';
  const kind = upstreamType.toLowerCase();

  if (kind.includes('text/html') || kind.includes('application/xhtml')) {
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const raw = decodeBody(buffer, upstreamType);

    // Sites label more than HTML as text/html: JSON (naver's /nvhaproxy) and even
    // JavaScript (naver's gnb template). What the browser asked for decides, not
    // the body: only a page gets the markup pass, and a script has to be sent as
    // JavaScript or the browser refuses to run it.
    if (requestType === 'script') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.status(upstream.status).send(raw);
      return;
    }
    if (requestType !== 'page') {
      if (/application\/json/i.test(req.get('accept') || '')) res.setHeader('content-type', 'application/json; charset=utf-8');
      res.status(upstream.status).send(raw);
      return;
    }

    if (isChallengePage(upstream.status, raw)) return fail(res, 502, challengeMessage(target));
    // Scripts in this document will call absolute paths; the cookie says where
    // they belong when a request arrives without a Referer.
    if (isDocument) {
      const site = siteCookie(new URL(upstream.url || target).origin, secure);
      res.setHeader('set-cookie', isNew ? [sessionCookie(sid, secure), site] : [site]);
    }
    res.type('text/html; charset=utf-8').status(upstream.status).send(rewriteHtml(raw, upstream.url || target));
    return;
  }

  if (kind.includes('text/css')) {
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const css = rewriteCss(decodeBody(buffer, upstreamType), upstream.url || target);
    res.type('text/css; charset=utf-8').status(upstream.status).send(css);
    return;
  }

  res.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
}
