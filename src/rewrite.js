import * as cheerio from 'cheerio';

import { CLIENT_SCRIPT } from './client-script.js';
import { rewriteCss, rewriteSrcset } from './css.js';
import { CSP_EQUIVS, URL_ATTRS, isEmbedGuard, proxiedRefreshContent, proxyTarget } from './rewrite-plan.js';
import { resolveUrl } from './url.js';

/**
 * Rewrite one HTML document so that it can be served from our own origin.
 * `finalUrl` must be the URL after redirects, so relative paths resolve right.
 * The rules live in rewrite-plan.js; this file is only the cheerio walk.
 */
export function rewriteHtml(html, finalUrl) {
  const $ = cheerio.load(html);

  // A <base href> changes what every relative URL means; honour it, then drop it.
  const baseHref = $('base[href]').first().attr('href');
  const base = (baseHref && resolveUrl(finalUrl, baseHref)) || finalUrl;
  $('base').remove();

  // Scripts/links carrying SRI hashes fail once the bytes come from us.
  $('[integrity]').removeAttr('integrity');

  // We attribute a page's own root-relative requests by the Referer it sends,
  // which only works while the browser keeps sending the full URL. The meta
  // name is matched case-insensitively: sites write "referrer" and "Referrer".
  $('meta[name]').each((_, el) => {
    const name = String($(el).attr('name') || '').toLowerCase();
    if (name === 'referrer') $(el).remove();
  });
  $('[referrerpolicy]').removeAttr('referrerpolicy');

  $('head').prepend(CLIENT_SCRIPT);

  // A guard that refuses to let the site's own frame run here (see
  // isEmbedGuard) is removed before the URL pass rewrites its src.
  $('script[src]').each((_, el) => {
    const $el = $(el);
    if (isEmbedGuard(resolveUrl(base, $el.attr('src')))) $el.remove();
  });

  $('meta[http-equiv]').each((_, el) => {
    const $el = $(el);
    const equiv = String($el.attr('http-equiv') || '').toLowerCase();
    if (CSP_EQUIVS.has(equiv)) {
      $el.remove();
      return;
    }
    if (equiv !== 'refresh') return;
    const content = $el.attr('content');
    const rewritten = proxiedRefreshContent(content, base);
    if (rewritten) $el.attr('content', rewritten);
  });

  for (const { tag, attr } of URL_ATTRS) {
    $(`${tag}[${attr}]`).each((_, el) => {
      const $el = $(el);
      const proxied = proxyTarget($el.attr(attr), base);
      if (proxied) $el.attr(attr, proxied);
    });
  }

  $('[srcset]').each((_, el) => {
    const $el = $(el);
    $el.attr('srcset', rewriteSrcset(String($el.attr('srcset') || ''), base));
  });

  $('[style]').each((_, el) => {
    const $el = $(el);
    $el.attr('style', rewriteCss(String($el.attr('style') || ''), base));
  });

  $('style').each((_, el) => {
    const $el = $(el);
    $el.text(rewriteCss($el.text(), base));
  });

  return $.html();
}
