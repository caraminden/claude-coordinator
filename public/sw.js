// Lets browsers offer "Install app". It caches nothing: every request goes to the network as usual,
// so chat data is never stale and a deploy's new app.js loads like it would without a worker.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title>' +
    '<body style="font:16px system-ui;padding:2rem;text-align:center">Claude Coordinator can\'t be reached right now. ' +
    '<a href="">Try again</a></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )));
});
