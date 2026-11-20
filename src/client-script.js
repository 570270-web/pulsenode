import { SITE_PARAM } from './url.js';

/**
 * The script every proxied document gets, inline.
 *
 * Inline on purpose: a `<script src="/assets/...">` would itself be rewritten
 * into /_p/<origin>/assets/... by the URL pass and 404 on the target site.
 *
 * The server rewrites the links it can see in the HTML. This covers the ones it
 * cannot: anchors a page's own scripts build after load, absolute URLs that
 * point straight at the real site, scripts the page injects into itself (a
 * cross-origin JSONP), and the /_p/ prefix in the address bar, which single-page
 * apps read as part of their own route.
 *
 * Written without template literals or `${}`, since it lives inside one. Note
 * that a backslash in the emitted JavaScript has to be written twice here.
 */
const CODE = `
(() => {
  // pl-client
  var match = /^\\/_p\\/([^/]+)/.exec(location.pathname);
  if (!match) return;
  var token = match[1];
  var prefix = '/_p/' + token;
  // The query parameter that carries the token once the prefix is gone.
  var siteParam = ${JSON.stringify(SITE_PARAM)};

  var decode = (value) => {
    try {
      var base64 = value.replace(/-/g, '+').replace(/_/g, '/');
      return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    } catch (error) {
      return null;
    }
  };
  var encode = (value) => btoa(value).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');

  var siteOrigin = decode(token);
  if (!siteOrigin) return;

  /*
   * The proxy's origin is shared by every site it serves, and a service worker
   * is registered per origin, not per site: one scope for all of them. A site's
   * worker then answers other sites' pages — naver's answered its own portal
   * with a cached shell, so this script never ran there and the page stayed
   * empty. Registrations are refused here, and the worker scripts themselves are
   * served as a kill switch (src/service-worker.js), which also clears one that
   * is already installed.
   */
  if (navigator.serviceWorker) {
    try {
      navigator.serviceWorker.register = function () {
        return Promise.reject(new Error('Service workers are disabled inside this proxy.'));
      };
    } catch (error) {
      // Not assignable here; the kill-switch worker still removes the old one.
    }
    try {
      navigator.serviceWorker.getRegistrations().then(
        function (registrations) {
          registrations.forEach(function (registration) {
            registration.unregister();
          });
        },
        function () {}
      );
    } catch (error) {
      // A browser without getRegistrations keeps whatever is installed.
    }
  }

  /*
   * Show the site's own path in the address bar.
   *
   * A single-page app matches location.pathname against its route table. With
   * our prefix in the way nothing matched, so naver's comic app treated
   * /_p/<token>/webtoon/list as an unknown route and replaced the address with
   * its default /index. Removing the prefix here, before any page script runs,
   * lets the app route itself; the token stays in this closure, so links and
   * scripts are still sent through /_p/.
   *
   * The token is not thrown away: it moves into the query string as
   * ?_pl=<token>. Without it the address names no site at all, so a copy pasted
   * into another browser (no /_p/ path, no pl_site cookie) was a 404. A document
   * request that arrives with only the parameter gets sent back into /_p/ by the
   * server (src/root-fallback.js).
   *
   * The site's own root is left alone: a document at /_p/<token>/ is the last
   * place where the token is still visible, and stripping it to "/" would make
   * a reload land on ProxyLab's home page instead. A reload of a stripped path
   * goes to the server's fallback, which sends it back to the right site.
   */
  var rest = location.pathname.slice(prefix.length);
  if (rest && rest !== '/' && window === window.top) {
    try {
      var shown = new URL(location.href);
      shown.pathname = rest;
      shown.searchParams.delete(siteParam);
      shown.searchParams.append(siteParam, token);
      history.replaceState(history.state, '', shown.pathname + shown.search + shown.hash);
    } catch (error) {
      // Not replaceable here (an odd frame); keep the URL as it is.
    }
  }

  /*
   * A nested document stays where it was loaded.
   *
   * The strip above is for the page the visitor is *on*; a frame's address is
   * not visible, and its URL is the base every relative URL in that document
   * resolves against. A site that expects its frame to be cross-origin can call
   * history.replaceState on it — in a browser that call throws, here the frame
   * is same-origin with its parent, so it succeeds. crazygames does exactly
   * that: the game frame's URL became the portal's own path, Unity's
   * "Build/x.data.br" then resolved against /kr/game/ instead of the game's own
   * directory, and the game never started. Keeping the frame on the URL it was
   * loaded from keeps those relative URLs inside the proxy.
   */
  if (window !== window.top) {
    var pinned = (fn) =>
      function (state, title, url) {
        // Same state, same document: only the address the site asked for is dropped.
        return arguments.length > 2 ? fn.call(this, state, title, null) : fn.call(this, state, title);
      };
    try {
      history.replaceState = pinned(history.replaceState);
      history.pushState = pinned(history.pushState);
    } catch (error) {
      // Not patchable here; the frame keeps whatever the browser gives it.
    }
  }

  // A query string without our own ?_pl= marker. The site's own parameters keep
  // their order.
  var withoutSiteParam = (search) => {
    var query = search || '';
    try {
      var params = new URLSearchParams(query);
      if (params.has(siteParam)) {
        params.delete(siteParam);
        var left = params.toString();
        query = left ? '?' + left : '';
      }
    } catch (error) {
      // A browser without URLSearchParams keeps the query as it is.
    }
    return query;
  };

  // The URL this document would have had on the real site. Our own ?_pl= marker
  // is not part of it.
  var documentUrl = () => {
    var path = location.pathname.indexOf(prefix) === 0 ? location.pathname.slice(prefix.length) : location.pathname;
    return siteOrigin + path + withoutSiteParam(location.search);
  };

  // The site origin one of our addresses stands for: either the /_p/<token>
  // prefix or the ?_pl=<token> marker the address bar keeps.
  var siteOriginOf = (href) => {
    var url;
    try {
      url = new URL(href);
    } catch (error) {
      return null;
    }
    if (url.origin !== location.origin) return url.origin;
    if (url.pathname.indexOf(prefix) === 0) return decode(token);
    var fromParam = url.searchParams.get(siteParam);
    return fromParam ? decode(fromParam) : null;
  };

  /*
   * A frame a site opens is often the site's own game, and the game asks the
   * browser who framed it before it starts. itch.io's embed script is the case
   * this proxy hit: a referrer or ancestor origin that is not one of its own
   * domains makes it navigate the frame to itch.io/embed-hotlink, so the game
   * loaded but never ran.
   *
   * Both values normally name OUR origin — our frames are same-origin with their
   * parent — which is the one address the site cannot recognise. Translating it
   * back into the site's own address space is the same correction the proxy
   * already makes on the Referer header it sends upstream (src/upstream.js).
   */
  var ancestorOrigin = (value) => {
    if (value !== location.origin) return value;
    try {
      if (window.parent && window.parent !== window) {
        var fromParent = siteOriginOf(window.parent.location.href);
        if (fromParent) return fromParent;
      }
    } catch (error) {
      // A cross-origin parent: this document's own site is the next best answer.
    }
    return siteOrigin;
  };

  var referrerDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'referrer');
  if (referrerDescriptor && referrerDescriptor.get) {
    try {
      Object.defineProperty(Document.prototype, 'referrer', {
        configurable: true,
        enumerable: referrerDescriptor.enumerable,
        get: function () {
          var raw = referrerDescriptor.get.call(this);
          var origin = raw ? siteOriginOf(raw) : null;
          if (!origin) return raw;
          var url = new URL(raw);
          return origin + url.pathname + withoutSiteParam(url.search);
        },
        set: referrerDescriptor.set,
      });
    } catch (error) {
      // Not redefinable here; the browser's own value stays.
    }
  }

  // ancestorOrigins is a DOMStringList of plain origins, with the same problem:
  // the nearest ancestor is us. A plain array is enough for the index reads
  // these checks make, with item()/contains() kept for the DOMStringList API.
  var ancestorDescriptor = Object.getOwnPropertyDescriptor(Location.prototype, 'ancestorOrigins');
  if (ancestorDescriptor && ancestorDescriptor.get) {
    try {
      Object.defineProperty(Location.prototype, 'ancestorOrigins', {
        configurable: true,
        enumerable: ancestorDescriptor.enumerable,
        get: function () {
          var raw = ancestorDescriptor.get.call(this);
          var origins = [];
          for (var i = 0; i < raw.length; i += 1) origins.push(ancestorOrigin(raw[i]));
          origins.item = (index) => origins[index] || null;
          origins.contains = (value) => origins.indexOf(value) !== -1;
          return origins;
        },
        set: ancestorDescriptor.set,
      });
    } catch (error) {
      // Not redefinable here; the browser's own list stays.
    }
  }

  /*
   * A message from one of our own frames still says it came from us.
   *
   * crazygames decides whether a gameframe message is genuine by comparing the
   * event origin's host with games.crazygames.com (its isMessageFromGameframe).
   * Every frame here is served from THIS origin, so that check failed and the
   * like, dislike, share and fullscreen events the game sends were dropped.
   *
   * The sender is one of our frames and therefore readable, so the site it
   * stands for is the truthful answer. Only a message whose raw origin is ours
   * is touched: a real third-party frame keeps its own origin.
   */
  var messageOriginDescriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'origin');
  if (messageOriginDescriptor && messageOriginDescriptor.get) {
    try {
      Object.defineProperty(MessageEvent.prototype, 'origin', {
        configurable: true,
        enumerable: messageOriginDescriptor.enumerable,
        get: function () {
          var raw = messageOriginDescriptor.get.call(this);
          if (raw !== location.origin) return raw;
          var sender = null;
          try {
            sender = this.source;
          } catch (error) {
            return raw;
          }
          if (!sender) return raw;
          try {
            return siteOriginOf(sender.location.href) || raw;
          } catch (error) {
            // A cross-origin sender: its own origin is the right answer anyway.
            return raw;
          }
        },
        set: messageOriginDescriptor.set,
      });
    } catch (error) {
      // Not redefinable here; the browser's own value stays.
    }
  }

  // The site this document's parent frame stands for, or null when there is no
  // parent of ours. A frame that answers its portal names the PORTAL's origin as
  // the target, not its own.
  var parentSiteOrigin = function () {
    try {
      if (window.parent && window.parent !== window) return siteOriginOf(window.parent.location.href);
    } catch (error) {
      // A cross-origin parent: only this document's own site can be named.
    }
    return null;
  };

  /*
   * The mirror image: a page that names the site's own address as targetOrigin.
   *
   * The browser will not deliver a message to a window whose origin is neither
   * a wildcard nor the one named, and inside the proxy that named address is us. Only
   * the two addresses a document here can legitimately mean are translated —
   * the site it is served for and the one its parent frame stands for.
   */
  var postMessageOriginal = window.postMessage;
  if (postMessageOriginal) {
    window.postMessage = function (message, targetOrigin) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof targetOrigin === 'string' && targetOrigin !== '*' && targetOrigin !== location.origin) {
        var named = null;
        try {
          named = new URL(targetOrigin).origin;
        } catch (error) {
          named = null;
        }
        if (named && (named === siteOrigin || named === parentSiteOrigin())) args[1] = location.origin;
      }
      return postMessageOriginal.apply(this, args);
    };
  }

  // Same shape the server produces: /_p/<base64url origin><target path>.
  var proxied = (url) => '/_p/' + encode(url.origin) + url.pathname + url.search + url.hash;

  /** A URL a script asks for -> the same URL through this proxy. */
  var proxiedSrc = (value) => {
    var raw = String(value || '');
    if (!raw || raw.startsWith('/_p/')) return raw;

    var target;
    try {
      target = new URL(raw, documentUrl());
    } catch (error) {
      return raw;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return raw;
    // Already ours: /_p/..., /assets/... or a same-origin path.
    if (target.origin === location.origin) return raw;
    return proxied(target);
  };

  /*
   * A page also builds URLs it never wrote in its HTML: a JSONP script, the
   * login/payment frame a checkout inserts, an image from another CDN. Those
   * requests leave the proxy and reach the other site with our Referer, so it
   * refuses to answer (naver returns an empty loginStatus and the header stays
   * hidden). Sending them through /_p/ makes the request look like it came from
   * that site.
   *
   * Two hooks cover the two ways a URL gets onto an element:
   *   element.src = url         -> the property setters below
   *   element.setAttribute(...) -> the attribute hook below
   * The list below is every element that loads a document, script or image —
   * the same set of loaders Ultraviolet and Scramjet watch, because a page does
   * not build its DOM through one API.
   */
  var LOADING = [
    [window.HTMLScriptElement, 'src'],
    [window.HTMLIFrameElement, 'src'],
    [window.HTMLImageElement, 'src'],
    [window.HTMLSourceElement, 'src'],
    [window.HTMLMediaElement, 'src'],
    [window.HTMLObjectElement, 'data'],
  ];

  LOADING.forEach((entry) => {
    var ctor = entry[0];
    var property = entry[1];
    if (!ctor) return;
    var descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, property);
    if (!descriptor || !descriptor.set) return;
    Object.defineProperty(ctor.prototype, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: function () {
        return descriptor.get.call(this);
      },
      set: function (value) {
        descriptor.set.call(this, proxiedSrc(value));
      },
    });
  });

  var setAttributeOriginal = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    // Only an element's src is a URL this proxy owes a rewrite; every other name
    // and element goes straight through. The property setters above write with
    // the native setter, so they do not land here a second time.
    if (String(name).toLowerCase() === 'src') {
      return setAttributeOriginal.call(this, name, proxiedSrc(value));
    }
    return setAttributeOriginal.apply(this, arguments);
  };

  /*
   * Tags are only half of it: a page also fetches at runtime. A game frame is
   * the clearest case — Unity's WebGL loader streams Build.data, Build.wasm and
   * Build.framework.js with XMLHttpRequest/fetch, and a proxied game frame that
   * loads but never starts is what that looks like. Those requests name the
   * site's own absolute URL (or a path relative to it), so they left the proxy
   * with our Referer and no cookies, and the answer was refused by CORS anyway
   * because it came from another origin.
   *
   * Sending them through /_p/ keeps them same-origin, which is exactly what the
   * page expects to be talking to.
   */
  var fetchOriginal = window.fetch;
  if (fetchOriginal) {
    window.fetch = function (input, init) {
      if (typeof input === 'string' || (typeof URL !== 'undefined' && input instanceof URL)) {
        return fetchOriginal.call(this, proxiedSrc(input), init);
      }
      // A Request already carries its method, headers, body and mode; only the
      // URL moves. Rebuilding it through the constructor keeps all of that.
      if (input && typeof input.url === 'string') {
        var moved = proxiedSrc(input.url);
        if (moved !== input.url) {
          try {
            return fetchOriginal.call(this, new Request(moved, input), init);
          } catch (error) {
            // An already-used body, or an init the constructor refuses: let the
            // native fetch report it against the untouched request.
          }
        }
      }
      return fetchOriginal.apply(this, arguments);
    };
  }

  // XMLHttpRequest is a separate path to the same network. Only open() names a
  // URL; send() carries the body and stays untouched.
  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (url) args[1] = proxiedSrc(url);
    return xhrOpen.apply(this, args);
  };

  // A popup is a page too: window.open touches no element at all, so a login or
  // payment window opened this way would otherwise leave the proxy.
  var openOriginal = window.open;
  window.open = function (url) {
    var args = Array.prototype.slice.call(arguments);
    if (url) args[0] = proxiedSrc(url);
    return openOriginal.apply(window, args);
  };

  document.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      var link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link || link.hasAttribute('download')) return;

      var href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('/_p/')) return;
      if (/^(javascript|mailto|tel|sms|data|blob|about):/i.test(href)) return;

      var target;
      try {
        target = new URL(href, documentUrl());
      } catch (error) {
        return;
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return;
      if (target.href === location.href) return;

      event.preventDefault();
      var next = proxied(target);
      if (link.target && link.target !== '_self') window.open(next, link.target);
      else location.assign(next);
    },
    true
  );
})();
`;

export const CLIENT_SCRIPT = `<script>${CODE}</script>`;
