/**
 * A proxied site's service worker is a second proxy on OUR origin.
 *
 * Registration is per origin, not per site: a worker a proxied page registers
 * gets scope "/" of the proxy, and only one registration can exist there. So the
 * last site to register decides what every proxied page receives. That is how
 * naver's comic portal broke — its worker answered the portal's own document
 * with a cached shell, the document we served (client script and all) was never
 * parsed, the address bar kept /_p/<token>/, the app matched no route, and the
 * page stopped after its server-rendered header. The root-relative `/api/...`
 * calls then went to our origin and 404'd, so the body stayed empty. Two sites
 * open in two tabs kept overwriting each other's worker the same way.
 *
 * A page cannot unregister the worker that is intercepting it, and the sites ask
 * for these paths themselves, so each of those paths is answered with a worker
 * whose only job is to remove itself: install, take over, unregister, reload the
 * pages it controls. The next visit is served by the proxy again. New
 * registrations are refused in the client script (src/client-script.js).
 */
export const SERVICE_WORKER_PATHS = [
  '/service-worker.js',
  '/sw.js',
  '/serviceworker.js',
  '/firebase-messaging-sw.js',
];

export const KILL_SWITCH_SCRIPT = `
// pl-kill-switch
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.unregister();
      const pages = await self.clients.matchAll({ type: 'window' });
      pages.forEach((page) => page.navigate(page.url));
    })()
  );
});
`;

/** The script served in place of whatever the site asked for. */
export function killSwitchWorker() {
  return new Response(KILL_SWITCH_SCRIPT, {
    status: 200,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      // A worker served from a subpath may only control that subpath otherwise.
      'service-worker-allowed': '/',
    },
  });
}
