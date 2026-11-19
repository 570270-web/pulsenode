import { CLIENT_SCRIPT } from '../src/client-script.js';
import { rewriteCss, rewriteSrcset } from '../src/css.js';
import { CSP_EQUIVS, URL_ATTRS, isEmbedGuard, proxiedRefreshContent, proxyTarget } from '../src/rewrite-plan.js';
import { resolveUrl } from '../src/url.js';

/**
 * Cloudflare Workers ship HTMLRewriter, a streaming parser. It applies the same
 * rules as src/rewrite.js (which walks cheerio on Node); the rules themselves
 * come from src/rewrite-plan.js.
 */
export async function rewriteHtml(html, finalUrl) {
  // A <base href> changes what every relative URL means; honour it, then drop it.
  let base = finalUrl;

  const rewriter = new HTMLRewriter()
    .on('base[href]', {
      element(element) {
        const absolute = resolveUrl(finalUrl, element.getAttribute('href'));
        if (absolute) base = absolute;
        element.remove();
      },
    })
    .on('meta[http-equiv]', {
      element(element) {
        const equiv = String(element.getAttribute('http-equiv') || '').toLowerCase();
        if (CSP_EQUIVS.has(equiv)) {
          element.remove();
          return;
        }
        if (equiv !== 'refresh') return;
        const rewritten = proxiedRefreshContent(element.getAttribute('content'), base);
        if (rewritten) element.setAttribute('content', rewritten);
      },
    })
    // Scripts/links carrying SRI hashes fail once the bytes come from us.
    .on('[integrity]', {
      element(element) {
        element.removeAttribute('integrity');
      },
    })
    // Requests from this page are attributed by their Referer, which the browser
    // would otherwise shorten according to the site's own policy. Selectors match
    // attribute values case-sensitively, so the name is checked here.
    .on('meta[name]', {
      element(element) {
        if (/^referrer$/i.test(element.getAttribute('name') || '')) element.remove();
      },
    })
    .on('[referrerpolicy]', {
      element(element) {
        element.removeAttribute('referrerpolicy');
      },
    })
    .on('head', {
      element(element) {
        element.prepend(CLIENT_SCRIPT, { html: true });
      },
    })
    // A guard that refuses to let the site's own frame run here (see
    // isEmbedGuard) is removed before the URL pass rewrites its src.
    .on('script[src]', {
      element(element) {
        if (isEmbedGuard(resolveUrl(base, element.getAttribute('src')))) element.remove();
      },
    })
    .on('[style]', {
      element(element) {
        const style = element.getAttribute('style');
        if (style) element.setAttribute('style', rewriteCss(style, base));
      },
    })
    .on('[srcset]', {
      element(element) {
        const srcset = element.getAttribute('srcset');
        if (srcset) element.setAttribute('srcset', rewriteSrcset(srcset, base));
      },
    })
    .on('style', {
      text(chunk) {
        return rewriteCss(chunk.text, base);
      },
    });

  for (const { tag, attr } of URL_ATTRS) {
    rewriter.on(`${tag}[${attr}]`, {
      element(element) {
        const proxied = proxyTarget(element.getAttribute(attr), base);
        if (proxied) element.setAttribute(attr, proxied);
      },
    });
  }

  // HTMLRewriter only rewrites documents it recognises as HTML.
  const source = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  return rewriter.transform(source).text();
}
