import { proxyPathFor, resolveUrl } from './url.js';

/**
 * CSS rewriting is pure string work, so both runtimes (Node/Express and the
 * Cloudflare Worker) share this file.
 */

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi;

/**
 * Rewrite every url(...) and @import inside a stylesheet.
 *
 * url() runs first on purpose. The @import pass emits `@import url("/_p/...")`,
 * and a url() pass after it would see that already-proxied address, resolve it
 * against the site's own origin and prefix it a second time
 * (/_p/<A>/_p/<A>/...). The site answers that with 403.
 */
export function rewriteCss(css, base) {
  return String(css)
    .replace(CSS_URL_RE, (match, quote, ref) => {
      const absolute = resolveUrl(base, ref);
      return absolute ? `url("${proxyPathFor(absolute)}")` : match;
    })
    .replace(CSS_IMPORT_RE, (match, quote, ref) => {
      const absolute = resolveUrl(base, ref);
      return absolute ? `@import url("${proxyPathFor(absolute)}")` : match;
    });
}

/** Rewrite each candidate of a srcset attribute. */
export function rewriteSrcset(value, base) {
  return value
    .split(',')
    .map((candidate) => {
      const [ref, ...descriptor] = candidate.trim().split(/\s+/);
      if (!ref) return '';
      const absolute = resolveUrl(base, ref);
      if (!absolute) return candidate.trim();
      return [proxyPathFor(absolute), ...descriptor].join(' ');
    })
    .filter(Boolean)
    .join(', ');
}
