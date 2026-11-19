import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { readSiteCookie } from './src/cookies.js';
import { handleProxy } from './src/proxy.js';
import { renderErrorPage, renderHome, renderSearch, renderSearchFailed } from './src/pages.js';
import { fallbackTarget, isDocumentRequest } from './src/root-fallback.js';
import { searchWeb } from './src/search.js';
import { SITE_PARAM, normalizeInputUrl, proxyPathFor } from './src/url.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');

// public/ is also the static asset directory for the Workers build, so files
// keep the same URL (/assets/styles.css) on both runtimes.
app.use(express.static(path.join(root, 'public'), { maxAge: '1h' }));

app.get('/', (_req, res) => {
  res.type('html').send(renderHome());
});

app.get('/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.redirect('/');

  let results = [];
  try {
    results = await searchWeb(query);
  } catch (error) {
    console.error('[proxylab] search failed:', error.message);
  }

  if (!results.length) return res.type('html').send(renderSearchFailed(query));
  res.type('html').send(renderSearch(query, results));
});

app.get('/namu', (req, res) => {
  const raw = String(req.query.q || '').trim().replace(/^\/?w\//, '');
  if (!raw) return res.redirect('/');
  // 나무위키 문서 주소는 https://namu.wiki/w/<문서명> 이다.
  res.redirect(302, proxyPathFor(`https://namu.wiki/w/${encodeURIComponent(raw)}`));
});

app.get('/open', (req, res) => {
  const target = normalizeInputUrl(req.query.url);
  if (!target) return res.redirect('/');
  res.redirect(302, proxyPathFor(target));
});

const rawBody = express.raw({ type: () => true, limit: '25mb' });

// The proxy itself: /_p/<base64url origin><the target's own path and query>
app.use('/_p', rawBody, async (req, res, next) => {
  try {
    await handleProxy(req, res);
  } catch (error) {
    next(error);
  }
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());

/** Routes that belong to ProxyLab itself, never to a proxied site. */
const OWN_PATHS = [/^\/$/, /^\/(search|namu|open)(\/|$)/, /^\/_p\//, /^\/assets\//, /^\/favicon\.ico$/, /^\/cdn-cgi\//];

/**
 * A proxied page's scripts also ask for root-relative paths (`/api/...`), and
 * those hit our origin, not the target's. Send them back to the site that page
 * belongs to (see src/root-fallback.js for how that is decided).
 */
app.use(rawBody, async (req, res, next) => {
  if (OWN_PATHS.some((pattern) => pattern.test(req.path))) return next();

  const [, query] = String(req.originalUrl || req.url).split('?');
  const target = fallbackTarget({
    referer: req.get('referer'),
    site: readSiteCookie(req.headers.cookie),
    // A copied address keeps the site in ?_pl= once the /_p/ prefix is gone.
    token: typeof req.query[SITE_PARAM] === 'string' ? req.query[SITE_PARAM] : null,
    pathname: req.path,
    search: query ? `?${query}` : '',
  });
  if (!target) return next();

  // A document has to live under /_p/, or its own relative links resolve wrong.
  if (req.method === 'GET' && isDocumentRequest({ secFetchDest: req.get('sec-fetch-dest'), accept: req.get('accept') })) {
    return res.redirect(302, proxyPathFor(target));
  }

  try {
    await handleProxy(req, res, target);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error('[proxylab]', error);
  if (res.headersSent) return res.end();
  res.status(500).type('html').send(renderErrorPage(500, '요청을 처리하지 못했습니다.'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`ProxyLab listening on http://0.0.0.0:${port}`);
});
