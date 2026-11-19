import * as cheerio from 'cheerio';

import { RESULT_SELECTORS, createCollector, searchWithRetries } from './search-core.js';

/**
 * Server-side search on Node. The Worker does the same walk with HTMLRewriter
 * in worker/search.js; endpoint, retries and result shaping come from
 * search-core.js.
 */
export async function searchWeb(query, limit = 12) {
  return searchWithRetries(query, limit, parseResults);
}

async function parseResults(response, limit) {
  const $ = cheerio.load(await response.text());
  const collector = createCollector(limit);

  // Bing sometimes drops the li.b_algo class; fall back to the list's shape.
  const items = $(RESULT_SELECTORS.item).length ? $(RESULT_SELECTORS.item) : $('#b_results > li:has(h2 a[href])');

  items.each((_, el) => {
    const $el = $(el);
    const anchor = $el.find('h2 a[href]').first();
    const href = anchor.attr('href');
    if (!href) return;

    collector.begin();
    collector.link(href);
    collector.title(anchor.text());
    collector.snippet($el.find('.b_caption p, .b_algoSlug, .b_lineclamp2, .b_lineclamp3').first().text());
  });

  return collector.results();
}
