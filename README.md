# ProxyLab

URL 재작성 방식의 웹 프록시. **같은 규칙을 두 런타임에서** 실행한다: 로컬용 Express 서버와,
Cloudflare Worker 배포판. 프록시가 "어떻게 동작하는가"를 코드로 읽을 수 있게 만든 학습용
프로토타입이고, 실제 서비스용 프록시가 아니다.

## 동작 방식

브라우저는 대상 사이트의 주소를 직접 부르지 않는다. 모든 요청이 우리 오리진의 한 경로로 온다:

```
https://pm.pstatic.net/resources/js/main.js
  -> /_p/aHR0cHM6Ly9wbS5wc3RhdGljLm5ldA/resources/js/main.js
```

토큰에는 **오리진만** 들어가고 대상의 경로는 그대로 뒤에 붙는다. 그래서 프록시된 JS가
`./nlog2.js` 같은 상대 경로로 자기 모듈을 불러도 `/_p/<같은 토큰>/resources/js/nlog2.js` 로
해석되어 제자리를 찾는다.

1. 서버가 base64url 토큰을 풀어 대상 URL을 만든다.
2. 그 URL을 대신 받아온다 (Referer/Origin/Sec-Fetch-*, 쿠키는 서버가 보정).
3. 받은 HTML의 `href`·`src`·`url()`·`srcset`·`meta refresh` 를 모두 `/_p/` 형태로 바꾼다.
4. 사이트가 준 `Set-Cookie` 는 서버가 jar에 보관하고 다음 요청에 붙여 보낸다.
5. 페이지 안 스크립트가 만드는 링크·fetch/XHR 요청은 주입된 클라이언트 스크립트가 잡는다.

## 실행

```bash
npm install
npm start            # Express, http://localhost:3000
```

```bash
npm run build:worker # esbuild -> dist/worker.js
npm run dev:worker   # wrangler dev, http://localhost:8787
```

## 어디가 "서버 로직"인가

| 파일 | 런타임 | 역할 |
| --- | --- | --- |
| `server.js` | Node | Express 라우팅(홈/검색/열기), 정적 파일, 루트 상대경로 폴백 |
| `src/proxy.js` | Node | 프록시 본체: 대상 해석 → 업스트림 요청 → 리다이렉트/쿠키/콘텐츠 분기 |
| `worker/index.js` | Cloudflare | 같은 일을 fetch 핸들러로. D1 jar, HTMLRewriter, `env.ASSETS` |
| `src/upstream.js` | 공용 | 업스트림 헤더(Referer 역변환·Origin·Sec-Fetch), 봇 차단 판정 |
| `src/cookies.js` | 공용 | RFC 6265 도메인/경로 매칭, Set-Cookie 파싱, jar 조회 |
| `worker/jar.js` | Cloudflare | jar를 D1에 저장/조회 (Worker는 요청 간 메모리가 없음) |
| `src/url.js` | 공용 | `/_p/` 토큰 인코딩/디코딩, URL 해석, SSRF(사설 IP) 차단 |
| `src/rewrite.js` | Node | cheerio로 HTML 리라이트 |
| `worker/html.js` | Cloudflare | 같은 규칙을 HTMLRewriter 스트리밍으로 |
| `src/rewrite-plan.js` | 공용 | 리라이트 규칙 테이블, CSP 제거, 임베드 가드 제거 목록 |
| `src/root-fallback.js` | 공용 | Referer/`_pl` 토큰/`pl_site` 쿠키로 루트 상대 요청의 사이트 추정 |
| `src/pages.js`, `src/css.js` | 공용 | 자체 UI HTML, CSS `url()` 리라이트 |
| `src/search*.js`, `worker/search.js` | 양쪽 | Bing 결과 파싱(Node: cheerio / Worker: HTMLRewriter) |
| `src/client-script.js` | **브라우저** | 프록시된 페이지에 주입되는 스크립트 (fetch/XHR/링크 가로채기) |

## 알려진 한계

- WebSocket/EventSource/Worker 요청은 아직 프록시하지 않는다.
- `location.href = '...'` 대입은 unforgeable이라 훅할 수 없다(해당 경로로 프록시를 벗어날 수 있음).
- `location.ancestorOrigins` 도 unforgeable이라, 그 값을 읽어 임베드를 막는 스크립트는
  `src/rewrite-plan.js` 의 `EMBED_GUARDS` 목록으로 서버에서 제거한다.
- `innerHTML`/`srcdoc`/`document.write` 로 삽입되는 HTML은 클라이언트 훅이 보지 못한다.
- SSRF 가드는 리터럴 호스트만 검사한다(DNS 리바인딩까지 막지는 않음).

## 배포 메모

`deploy.json` 은 Cloudflare Worker 정적 자산 배포용 매니페스트다. Worker 런타임은 쿠키 jar를
D1에 두므로 `wrangler.jsonc` 의 `database_id` 를 본인 것으로 바꾸고 `npx wrangler d1 create` 로
테이블을 준비해야 한다(테이블은 첫 요청 시 `worker/jar.js` 가 만든다).

학습용 코드다. 공개 인스턴스로 운영할 때는 요청 속도 제한과 이용 약관을 먼저 갖춰야 한다.
