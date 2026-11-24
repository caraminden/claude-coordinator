// Lets browsers offer "Install app", shows push notifications, and keeps the app shell on the device (#1144): Citadel's
// own static files, cached under the front end's version, so the installed app opens with no network. Never API answers
// (what a person may see is decided per request), never contraptions under /apps/ (they bring their own worker), never
// the backup chat at /backup (it must load however broken the app's own files are) or a preview.
//
// The server fills SHELL in when it serves this file (src/shell.ts): { version, urls, hashes }. A ship changes the version, so
// browsers see a new worker, which keeps the new files and drops the old ones. With the server's off switch on, SHELL
// stays null: this worker then drops every kept file, reloads the windows it served from them, and caches nothing.
const SHELL = null; // filled in by the server (src/shell.ts)
const CACHE = SHELL && `shell-${SHELL.version}`;
const KEPT = new Set(SHELL?.urls ?? []);

self.addEventListener('install', (event) => {
  self.skipWaiting();
  if (SHELL) event.waitUntil(keep());
});

/**
 * Keep every shell file, all of this version or none: a ship landing mid-install fails it, and the next try gets the newer
 * worker. A file whose content hash (X-Front-Hash) is the one an older version's cache already holds is copied from it,
 * not fetched again (#1331); the rest come from the network and must be of this very version and hash. Nothing is put
 * in the new cache until every file is in hand, so a tab never sees half old, half new.
 */
async function keep() {
  const olds = await Promise.all((await caches.keys()).filter((k) => k.startsWith('shell-') && k !== CACHE).map((k) => caches.open(k)));
  const answers = await Promise.all(
    SHELL.urls.map(async (url) => {
      const want = SHELL.hashes[url];
      for (const old of olds) {
        const hit = await old.match(url);
        if (hit && want && hit.headers.get('X-Front-Hash') === want) return [url, hit];
      }
      const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok || res.headers.get('X-Front-Version') !== SHELL.version || res.headers.get('X-Front-Hash') !== want) throw new Error(`${url} is not front end ${SHELL.version}`);
      return [url, res];
    }),
  );
  const cache = await caches.open(CACHE);
  await Promise.all(answers.map(([url, res]) => cache.put(url, res)));
}

self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      const old = (await caches.keys()).filter((k) => k.startsWith('shell-') && k !== CACHE);
      await Promise.all(old.map((k) => caches.delete(k)));
      await self.clients.claim();
      // The off switch: windows opened from kept files load again from the network.
      if (!SHELL && old.length) {
        for (const w of await self.clients.matchAll({ type: 'window' })) if (new URL(w.url).pathname.startsWith('/c/')) w.navigate(w.url).catch(() => {});
      }
    })(),
  ),
);

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const path = url.pathname;
  // Contraptions under /apps/ bring their own worker, if any (src/apps.ts); this one keeps out of them.
  if (path.startsWith('/apps/')) return;
  // Nor the backup chat (src/backup.html), which must load however broken the app's own files are.
  if (path === '/backup' || path.startsWith('/backup/')) return;
  const page = event.request.mode === 'navigate';
  const key = page ? (path === '/c/' || path === '/c/index.html') && '/c/' : path;
  if (CACHE && event.request.method === 'GET' && url.origin === self.location.origin && KEPT.has(key)) {
    // A kept file at once; a missing one (evicted, or not kept yet) from the network as usual.
    return event.respondWith(
      caches
        .open(CACHE)
        .then((c) => c.match(key))
        .then((hit) => hit ?? (page ? load(event.request, path) : fetch(event.request))),
    );
  }
  if (page) event.respondWith(load(event.request, path));
});

/** A page load from the network: a restart's or a lost connection's own page when that is all there is. */
const load = (request, path) =>
  fetch(request).then(
    // Caddy's bare 502 when nothing serves the port: a restart that outlasted systemd's socket, or a failed one (#493).
    // Not a preview's: its own 502 and 503 pages say why it stopped (src/previews.ts).
    (res) => ([502, 503, 504].includes(res.status) && !path.startsWith('/preview/') ? restarting() : res),
    () =>
      new Response('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title>' + '<body style="font:16px system-ui;padding:2rem;text-align:center">%APP_NAME% can\'t be reached right now. ' + '<a href="">Try again</a></body>', {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
  );

/** A page that says the server is restarting and reloads itself every 3 s until the app loads instead. */
const restarting = () =>
  new Response(
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">' +
      '<meta http-equiv="refresh" content="3">' +
      '<title>Restarting…</title><body style="font:16px system-ui;padding:2rem;text-align:center">' +
      '<p>%APP_NAME% is restarting. Trying again…</p><p><a href="">Try now</a></p></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '3' } },
  );

// A question card, a failed turn, or a thread that is ready or blocked (src/push.ts). One
// notification per thread: a newer one replaces the last, and still alerts unless it's silent (an all-clear).
self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data?.json() ?? {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(msg.title || '%APP_NAME%', {
      body: msg.body || '',
      tag: msg.tag,
      renotify: !!msg.tag && !msg.silent,
      silent: !!msg.silent,
      icon: '/icon-192.png',
      data: { url: msg.url || '/c/' },
    }),
  );
});

// Open the thread: in a window the app already has (focused, and told where to go), else a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/c/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      // Citadel's own page only (the url's, /c/): a contraption's window (its own installed app since #274)
      // can't show a thread, a preview's runs on a database copy, and the backup page has no listener.
      const page = new URL(url).pathname;
      const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((w) => new URL(w.url).pathname === page);
      const win = windows.find((w) => w.focused) ?? windows[0];
      if (!win) return self.clients.openWindow(url);
      win.postMessage({ type: 'open', url });
      // Browsers only let a notification click bring a window forward; elsewhere this throws.
      await win.focus().catch(() => {});
    })(),
  );
});

// The browser replaced this device's subscription (keys expire); register the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription?.options?.applicationServerKey;
      const sub = event.newSubscription ?? (key && (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })));
      if (!sub) return;
      await fetch('/api/push/subscription', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    })(),
  );
});
