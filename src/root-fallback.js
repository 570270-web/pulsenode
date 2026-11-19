import { SITE_PARAM, isBlockedUrl, targetFromProxyPath } from './url.js';

/**
 * Requests that a proxied page's own scripts make with root-relative paths
 * (`/nvhaproxy/v2/pc/lazy`) arrive at OUR origin, without a /_p/ token, so the
 * proxy has to work out which site they belong to.
 *
 * Referer is the reliable answer: the browser sends the URL of the document the
 * request came from, and that URL names its site — either as /_p/<token>/... or,
 * once the client script has cleaned the address bar, as ?_pl=<token>. (Upstream
 * `Referrer-Policy` headers/meta tags are stripped on the way through, otherwise
 * the browser would shorten the Referer to just our origin.)
 *
 * A document copied out of the address bar carries ?_pl=<token> too. That is the
 * only thing that lets a shared link open in another browser, where there is no
 * pl_site cookie yet.
 *
 * Some requests carry no Referer at all (`no-referrer` sites, prefetches). For
 * those, `pl_site` remembers the last proxied document of this session — less
 * precise, but it keeps those requests working.
 *
 * Both runtimes call these functions, so the rules live in one place.
 */

/** The origin named by a `?_pl=<token>` value. */
export function originFromToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  // A token is an origin; let the /_p/ parser do the decoding.
  const target = targetFromProxyPath(`/_p/${token}/`, '');
  return target ? new URL(target).origin : null;
}

/** Drop our own `?_pl=` marker from a query string. */
export function stripSiteParam(search = '') {
  const raw = String(search || '');
  const body = raw.startsWith('?') ? raw.slice(1) : raw;
  if (!body) return '';
  let params;
  try {
    params = new URLSearchParams(body);
  } catch {
    return `?${body}`;
  }
  if (!params.has(SITE_PARAM)) return `?${body}`;
  params.delete(SITE_PARAM);
  const left = params.toString();
  return left ? `?${left}` : '';
}

/**
 * The target document a Referer belongs to, or null when it is not one of ours.
 *
 * The full URL matters: a request's Referer is the page that made it, so
 * translating it back gives the site both the right origin and the right path.
 */
export function targetFromReferer(referer) {
  if (!referer) return null;
  let url;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }

  // Still under /_p/<token>/...: a reload, or a link the server redirected.
  const viaPath = targetFromProxyPath(url.pathname, url.search);
  if (viaPath) return viaPath;

  // Cleaned address bar: the token moved into ?_pl=<token>.
  const origin = originFromToken(url.searchParams.get(SITE_PARAM));
  if (!origin) return null;
  return `${origin}${url.pathname}${stripSiteParam(url.search)}`;
}

function usableOrigin(origin) {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The target URL an untokened request should be forwarded to, or null.
 *
 * `token` is the ?_pl= parameter: it is an explicit statement about which site
 * the address belongs to, so it wins over the Referer (a pasted link has a
 * Referer only if it was clicked somewhere).
 */
export function fallbackTarget({ referer, site, token, pathname, search = '' }) {
  const fromReferer = targetFromReferer(referer);
  const origin =
    originFromToken(token) || (fromReferer && new URL(fromReferer).origin) || usableOrigin(site);
  if (!origin || !pathname?.startsWith('/')) return null;

  const target = `${origin}${pathname}${stripSiteParam(search)}`;
  return isBlockedUrl(target) ? null : target;
}

/**
 * A top-level navigation asks for a document. Those must be redirected to the
 * /_p/ form before being served, or the address bar keeps a bare path and the
 * page's own relative links resolve against the wrong base.
 */
export function isDocumentRequest({ secFetchDest, accept } = {}) {
  if (secFetchDest) return secFetchDest === 'document';
  return /text\/html/i.test(accept || '');
}
