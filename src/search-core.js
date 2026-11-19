/**
 * Search is one job with two parsers: Node reads Bing's result HTML with
 * cheerio, the Worker streams it through HTMLRewriter. Everything around the
 * parse — endpoint, headers, retries, link unwrapping, result normalisation —
 * lives here once.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** The shape of a Bing result page, shared so both parsers walk the same nodes. */
export const RESULT_SELECTORS = {
  item: 'li.b_algo',
  link: 'li.b_algo h2 a[href]',
  snippet: 'li.b_algo .b_caption p, li.b_algo .b_algoSlug, li.b_algo .b_lineclamp2',
};

/**
 * Bing wraps result links in its own /ck/a click tracker with the real address
 * base64'd into `u`. Unwrap it so results point at the site itself.
 */
export function unwrapBingLink(href) {
  try {
    const url = new URL(href);
    if (!/(^|\.)bing\.com$/.test(url.hostname) || !url.pathname.startsWith('/ck/a')) return href;
    const encoded = url.searchParams.get('u');
    if (!encoded || !encoded.startsWith('a1')) return href;
    const decoded = atob(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'));
    return /^https?:\/\//i.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

export async function fetchSearchPage(query, limit) {
  const endpoint = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const response = await fetch(endpoint, {
    headers: { 'user-agent': UA, 'accept-language': 'ko,en;q=0.8', accept: 'text/html' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`search failed: HTTP ${response.status}`);
  return response;
}

/**
 * `parse` turns one fetched result page into results; that is the only part the
 * two runtimes do differently.
 */
export async function searchWithRetries(query, limit, parse) {
  // Bing occasionally answers automated clients with an empty result page.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const results = await parse(await fetchSearchPage(query, limit), limit);
    if (results.length) return results;
    await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
  }
  return [];
}

/** Collects titles, hrefs and snippets in document order, then normalises them. */
export function createCollector(limit = 12) {
  const found = [];
  let current = null;

  return {
    begin() {
      current = { title: '', url: '', host: '', snippet: '' };
      found.push(current);
    },
    link(href) {
      if (current) current.url = unwrapBingLink(href || '');
    },
    title(text) {
      if (current) current.title += text;
    },
    snippet(text) {
      if (current) current.snippet += text;
    },
    results() {
      const results = [];
      for (const item of found) {
        if (results.length >= limit) break;
        if (!/^https?:\/\//i.test(item.url)) continue;
        try {
          item.host = new URL(item.url).hostname.replace(/^www\./, '');
        } catch {
          continue;
        }
        results.push({ ...item, title: item.title.trim() || item.url, snippet: item.snippet.trim() });
      }
      return results;
    },
  };
}
