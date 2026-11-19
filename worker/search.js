import { RESULT_SELECTORS, createCollector, searchWithRetries } from '../src/search-core.js';

/**
 * The Worker half of search: HTMLRewriter streams the same result items the
 * cheerio parser reads, and search-core.js handles retries and normalisation.
 */
export async function searchWeb(query, limit = 12) {
  return searchWithRetries(query, limit, parseResults);
}

async function parseResults(response, limit) {
  const collector = createCollector(limit);

  const rewriter = new HTMLRewriter()
    .on(RESULT_SELECTORS.item, {
      element() {
        collector.begin();
      },
    })
    .on(RESULT_SELECTORS.link, {
      element(element) {
        collector.link(element.getAttribute('href'));
      },
      text(chunk) {
        collector.title(chunk.text);
      },
    })
    .on(RESULT_SELECTORS.snippet, {
      text(chunk) {
        collector.snippet(chunk.text);
      },
    });

  await rewriter.transform(response).text();
  return collector.results();
}
