// Lets browsers offer "Install app" and shows push notifications. It caches nothing: every request
// goes to the network as usual, so chat data is never stale and a deploy's new app.js loads like it
// would without a worker.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  // Contraptions under /apps/ bring their own worker, if any (src/apps.ts); this one keeps out of them.
  const path = new URL(event.request.url).pathname;
  if (path.startsWith('/apps/')) return;
  // Nor the backup chat (src/backup.html), which must load however broken the app's own files are.
  if (path === '/backup' || path.startsWith('/backup/')) return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title>' +
    '<body style="font:16px system-ui;padding:2rem;text-align:center">%APP_NAME% can\'t be reached right now. ' +
    '<a href="">Try again</a></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )));
});

// A question card, a failed turn, or a thread that is ready or blocked (src/push.ts). One
// notification per thread: a newer one replaces the last, and still alerts.
self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data?.json() ?? {};
  } catch {}
  event.waitUntil(self.registration.showNotification(msg.title || '%APP_NAME%', {
    body: msg.body || '',
    tag: msg.tag,
    renotify: !!msg.tag,
    icon: '/icon-192.png',
    data: { url: msg.url || '/c/' },
  }));
});

// Open the thread: in a window the app already has (focused, and told where to go), else a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/c/', self.location.origin).href;
  event.waitUntil((async () => {
    // Citadel's own page only (the url's, /c/): a contraption's window (its own installed app since #274)
    // can't show a thread, a preview's runs on a database copy, and the backup page has no listener.
    const page = new URL(url).pathname;
    const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter((w) => new URL(w.url).pathname === page);
    const win = windows.find((w) => w.focused) ?? windows[0];
    if (!win) return self.clients.openWindow(url);
    win.postMessage({ type: 'open', url });
    // Browsers only let a notification click bring a window forward; elsewhere this throws.
    await win.focus().catch(() => {});
  })());
});

// The browser replaced this device's subscription (keys expire); register the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const key = event.oldSubscription?.options?.applicationServerKey;
    const sub = event.newSubscription ?? (key && await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    if (!sub) return;
    await fetch('/api/push/subscription', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
  })());
});
