import { proxyPathFor } from './url.js';

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function layout({ title, body }) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
${body}
</body>
</html>`;
}

const SAMPLE_TARGET = 'https://comic.naver.com/index';

/** Used by the proxy itself and the app-level error handler. */
export function renderErrorPage(status, message) {
  return layout({
    title: `${status} — ProxyLab`,
    body: `
<main class="home">
  <h1 class="wordmark">Proxy<span>Lab</span></h1>
  <section class="card notice">
    <h2>${status}</h2>
    <p class="notice-body">${escapeHtml(message)}</p>
    <p class="sample-label"><a href="/">← 프록시 홈으로</a></p>
  </section>
</main>`,
  });
}

export function renderHome() {
  return layout({
    title: 'ProxyLab — 프록시로 웹 열기',
    body: `
<main class="home">
  <h1 class="wordmark">Proxy<span>Lab</span></h1>
  <p class="tagline">검색하고, 어떤 주소든 프록시를 통해 열어보세요.</p>

  <form class="searchbar" action="/search" method="get" role="search">
    <input type="search" name="q" placeholder="검색어를 입력하세요" autocomplete="off" autofocus required>
    <button type="submit">검색</button>
  </form>

  <form class="openbar" action="/namu" method="get">
    <span class="prefix">나무위키</span>
    <input type="text" name="q" placeholder="문서 이름 (예: 대한민국)" autocomplete="off">
    <button type="submit">열기</button>
  </form>

  <form class="openbar" action="/open" method="get">
    <span class="prefix">주소</span>
    <input type="text" name="url" placeholder="또는 주소를 직접 입력 (예: comic.naver.com)" autocomplete="off">
    <button type="submit">열기</button>
  </form>

  <section class="card">
    <h2>이 프록시가 하는 일</h2>
    <ol class="steps">
      <li>브라우저는 <code>/_p/&lt;base64 오리진&gt;/원래/경로</code> 를 요청합니다.</li>
      <li>서버가 base64 부분을 풀어 그 주소를 대신 받아옵니다.</li>
      <li>받은 HTML의 <code>href</code>·<code>src</code>·<code>url()</code> 을 모두 이 형태로 바꿔서 내려줍니다.</li>
      <li>경로를 그대로 붙여두기 때문에, 페이지 안 스크립트가 <code>./x.js</code> 같은 상대 경로를 써도 프록시 안에서 제자리를 찾습니다.</li>
      <li>사이트가 준 <code>Set-Cookie</code> 는 서버가 보관했다가 다음 요청에 붙여 보냅니다.</li>
    </ol>
    <p class="sample">예: <code>${escapeHtml(proxyPathFor(SAMPLE_TARGET))}</code></p>
    <p class="sample-label">← <code>${escapeHtml(SAMPLE_TARGET)}</code> 의 오리진만 인코딩하고 경로는 그대로 둔 값</p>
  </section>

  <p class="foot">학습용 프로토타입 · 페이지 스크립트가 만드는 링크와 루트 상대 요청도 Referer로 원래 사이트에 귀속해 처리합니다</p>
</main>`,
  });
}

export function renderSearch(query, results) {
  const q = escapeHtml(query);
  const list = `<ol class="results">${results
    .map(
      (r) => `<li>
      <a class="result-title" href="${proxyPathFor(r.url)}">${escapeHtml(r.title)}</a>
      <span class="result-host">${escapeHtml(r.host)}</span>
      ${r.snippet ? `<p class="result-snippet">${escapeHtml(r.snippet)}</p>` : ''}
    </li>`,
    )
    .join('')}</ol>`;

  return layout({
    title: `${query} — ProxyLab`,
    body: `
<main class="page">
  <header class="topbar">
    <a class="wordmark small" href="/">Proxy<span>Lab</span></a>
    <form class="searchbar compact" action="/search" method="get" role="search">
      <input type="search" name="q" value="${q}" autocomplete="off" required>
      <button type="submit">검색</button>
    </form>
  </header>
  <p class="result-count">“${q}” 검색 결과 ${results.length}개 · 클릭하면 프록시를 통해 열립니다</p>
  <p class="namu-hint"><a href="/namu?q=${encodeURIComponent(query)}">나무위키에서 “${q}” 문서 찾기 →</a></p>
  ${list}
</main>`,
  });
}

/**
 * Shown when the search backend gave us nothing. The earlier version quietly
 * 302'd to Bing, which looked like the app had simply lost the query.
 */
export function renderSearchFailed(query) {
  const q = escapeHtml(query);
  return layout({
    title: `${query} — 검색 결과 없음 — ProxyLab`,
    body: `
<main class="page">
  <header class="topbar">
    <a class="wordmark small" href="/">Proxy<span>Lab</span></a>
    <form class="searchbar compact" action="/search" method="get" role="search">
      <input type="search" name="q" value="${q}" autocomplete="off" required>
      <button type="submit">검색</button>
    </form>
  </header>
  <section class="card notice">
    <h2>검색 결과를 가져오지 못했습니다</h2>
    <p class="notice-body">
      “${q}” 에 대한 결과를 검색 엔진이 돌려주지 않았습니다. 검색 엔진이 자동화된
      요청을 막았을 때 생기는 일입니다. 잠시 후 다시 시도하거나, 아래 링크로
      검색 엔진 화면을 프록시로 직접 열어보세요.
    </p>
    <p class="sample">
      <a href="${proxyPathFor(`https://www.bing.com/search?q=${encodeURIComponent(query)}`)}">
        Bing에서 “${q}” 열기 →
      </a>
    </p>
  </section>
</main>`,
  });
}
