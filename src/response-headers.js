/**
 * Upstream response headers that must not reach the browser.
 *
 * The proxy serves the target's bytes from OUR origin, so headers that police
 * or describe the target's own origin would fight with ours: CSP would block
 * this proxy's rewriting, HSTS would pin our host, the target's CORS policy
 * would apply to a cross-origin caller that is not the target, and so on.
 *
 * Both runtimes filter with this module, so the list stays in one place.
 */
export const DROP_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'content-encoding',
  'content-length',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  // Kept: the browser must send this page's full URL as Referer, because that is
  // how a page's own root-relative requests are attributed (src/root-fallback.js).
  'referrer-policy',
  'set-cookie',
  'strict-transport-security',
  'transfer-encoding',
  'x-content-type-options',
  'x-frame-options',
]);

/**
 * True when an upstream header must be dropped.
 *
 * The whole `Access-Control-*` family goes: the target's CORS policy describes
 * access to the target, not to this proxy. Passing it through would hand a
 * proxied site's `Access-Control-Allow-Origin: *` to our own responses and mix
 * two unrelated policies on one reply.
 */
export function isDroppedHeader(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.startsWith('access-control-')) return true;
  return DROP_RESPONSE_HEADERS.has(lower);
}
