import { CLIENT_SCRIPT } from '../src/client-script.js';
import { rewriteCss, rewriteSrcset } from '../src/css.js';
import { CSP_EQUIVS, URL_ATTRS, isEmbedGuard, proxiedRefreshContent, proxyTarget } from '../src/rewrite-plan.js';
import { resolveUrl } from '../src/url.js';

/**
 * Cloudflare Workers ship HTMLRewriter, a streaming parser. It applies the same
 * rules as src/rewrite.js (which walks cheerio on Node); the rules themselves
 * come from src/rewrite-plan.js.
 */

const encoder = new TextEncoder();

/** The charset a content-type header declares, lowercased, or null. */
function headerCharset(headers) {
  const match = /charset\s*=\s*"?([\w-]+)/i.exec(headers.get('content-type') || '');
  return match ? match[1].toLowerCase() : null;
}

/**
 * Decode one chunk of a non-UTF-8 document into UTF-8 bytes as it arrives.
 *
 * The rewriter reads its input as UTF-8, so a euc-kr page has to be transcoded
 * on the way in. Doing it per chunk keeps the document out of memory: this runs
 * on the stream, not after a full `arrayBuffer()` + `text()` round trip.
 */
function transcode(body, charset) {
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    // An encoding this runtime does not know: read it as UTF-8, as before.
    decoder = new TextDecoder();
  }
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(encoder.encode(decoder.decode(chunk, { stream: true })));
      },
      flush(controller) {
        const tail = decoder.decode();
        if (tail) controller.enqueue(encoder.encode(tail));
      },
    }),
  );
}

/**
 * The rewriter for one document.
 *
 * `base` lives in this closure: the <base href> handler sets it before the URL
 * pass runs, so every later handler sees the right base. A fresh call per
 * document keeps two concurrent requests from sharing it.
 */
function rewriterFor(finalUrl) {
  let base = finalUrl;

  const rewriter = new HTMLRewriter()
    .on('base[href]', {
      element(element) {
        const absolute = resolveUrl(base, element.getAttribute('href'));
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

  return rewriter;
}

/** The body HTMLRewriter can read: UTF-8 bytes, whatever the site sent. */
function sourceFrom(response) {
  const charset = headerCharset(response.headers);
  const body = charset && charset !== 'utf-8' ? transcode(response.body, charset) : response.body;
  // HTMLRewriter only rewrites documents it recognises as HTML.
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/**
 * Rewrite an upstream document without ever holding it.
 *
 * The old path read the whole body with `arrayBuffer()`, decoded it, and handed
 * a string to the rewriter, which decoded the result again — 2 MB of markup cost
 * most of the free plan's 10 ms of CPU. Here the bytes go from the site through
 * the rewriter to the browser while the document is still downloading, so the
 * CPU is spent per chunk and the response starts arriving sooner.
 */
export function rewriteHtmlResponse(response, finalUrl) {
  return rewriterFor(finalUrl).transform(sourceFrom(response));
}

/**
 * The buffered form, for callers that have to read the body first (a bot wall
 * has to be recognised by its text, and a script labelled text/html has to be
 * sent on untouched).
 */
export async function rewriteHtml(html, finalUrl) {
  const source = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  return rewriterFor(finalUrl).transform(source).text();
}
