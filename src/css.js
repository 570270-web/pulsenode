import { proxyPathFromUrl, resolveUrlObject } from './url.js';

/**
 * CSS rewriting is pure string work, so both runtimes (Node/Express and the
 * Cloudflare Worker) share this file.
 */

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi;

/** A reference -> the address this browser should fetch instead (or null). */
function proxiedRef(ref, base) {
  const url = resolveUrlObject(base, ref);
  return url ? proxyPathFromUrl(url) : null;
}

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
      const absolute = proxiedRef(ref, base);
      return absolute ? `url("${absolute}")` : match;
    })
    .replace(CSS_IMPORT_RE, (match, quote, ref) => {
      const absolute = proxiedRef(ref, base);
      return absolute ? `@import url("${absolute}")` : match;
    });
}

/** Rewrite each candidate of a srcset attribute. */
export function rewriteSrcset(value, base) {
  return value
    .split(',')
    .map((candidate) => {
      const [ref, ...descriptor] = candidate.trim().split(/\s+/);
      if (!ref) return '';
      const absolute = proxiedRef(ref, base);
      if (!absolute) return candidate.trim();
      return [absolute, ...descriptor].join(' ');
    })
    .filter(Boolean)
    .join(', ');
}
