import { proxyPathFromUrl, resolveUrlObject } from './url.js';

/**
 * The rewriting *rules* both runtimes share.
 *
 * Node walks a cheerio DOM (src/rewrite.js), the Worker streams HTMLRewriter
 * (worker/html.js). The attribute table, the CSP handling and the meta-refresh
 * parsing are written once, here — only the DOM walk itself differs.
 */

/** Every attribute whose value is a URL. */
export const URL_ATTRS = [
  { tag: 'a', attr: 'href' },
  { tag: 'area', attr: 'href' },
  { tag: 'link', attr: 'href' },
  { tag: 'use', attr: 'href' },
  { tag: 'img', attr: 'src' },
  { tag: 'script', attr: 'src' },
  { tag: 'iframe', attr: 'src' },
  { tag: 'frame', attr: 'src' },
  { tag: 'source', attr: 'src' },
  { tag: 'video', attr: 'src' },
  { tag: 'audio', attr: 'src' },
  { tag: 'track', attr: 'src' },
  { tag: 'embed', attr: 'src' },
  { tag: 'input', attr: 'src' },
  { tag: 'object', attr: 'data' },
  { tag: 'video', attr: 'poster' },
  { tag: 'form', attr: 'action' },
  { tag: 'button', attr: 'formaction' },
  { tag: 'input', attr: 'formaction' },
];

/** Meta tags that have to disappear: they would police our own origin. */
export const CSP_EQUIVS = new Set(['content-security-policy', 'content-security-policy-report-only']);

/**
 * Scripts a site serves to police *where* its content may be embedded.
 *
 * itch.io's htmlgame.js decides by reading `location.ancestorOrigins`, which the
 * spec marks unforgeable: it is an own, non-configurable property of every
 * Location, so no page script can make it report anything but our origin. A
 * frame that loads a game then gets navigated to itch.io/embed-hotlink instead
 * of starting, and the redirect leaves the proxy entirely.
 *
 * The frame's content is the site's own game, already fetched through this
 * proxy; the guard only refuses to let it run. Rewriting cannot satisfy a check
 * on an unforgeable value, so the tag is dropped. Add another entry when a site's
 * embed guard behaves the same way.
 */
const EMBED_GUARDS = [{ host: 'static.itch.io', path: '/htmlgame.js' }];

export function isEmbedGuard(absoluteUrl) {
  if (!absoluteUrl) return false;
  let url;
  try {
    url = new URL(absoluteUrl);
  } catch {
    return false;
  }
  return EMBED_GUARDS.some((guard) => url.hostname === guard.host && url.pathname === guard.path);
}


const META_REFRESH_RE = /url\s*=\s*['"]?([^'";]+)/i;

/** A reference found in a page -> the URL our browser should request instead. */
export function proxyTarget(ref, base) {
  const url = resolveUrlObject(base, ref);
  return url ? proxyPathFromUrl(url) : null;
}

/** Rewrite the URL inside <meta http-equiv="refresh" content="0; url=...">. */
export function proxiedRefreshContent(content, base) {
  const match = META_REFRESH_RE.exec(String(content || ''));
  if (!match) return null;
  const proxied = proxyTarget(match[1], base);
  return proxied ? String(content).replace(match[1], proxied) : null;
}
