// Citadel's service worker (public/sw.js, scope /) keeps out of contraptions under /apps/, which bring
// their own worker (the brief's section 3): it answers no request of theirs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('the service worker answers Citadel\'s page loads but no /apps/ request', () => {
  const listeners: Record<string, (e: any) => void> = {};
  const self = { addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] = fn) };
  new Function('self', 'fetch', readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8'))(self, () => new Promise(() => {}));
  const answered = (url: string, mode = 'navigate') => {
    let called = false;
    listeners.fetch({ request: { url, mode }, respondWith: () => (called = true) });
    return called;
  };
  assert.equal(answered('https://citadel.example/'), true);
  assert.equal(answered('https://citadel.example/project/2'), true);
  assert.equal(answered('https://citadel.example/apps/mandate/'), false);
  assert.equal(answered('https://citadel.example/apps/peek-auras/link?x=1'), false);
  assert.equal(answered('https://citadel.example/apps/mandate/app.js', 'no-cors'), false);
});

test("a notification click opens the thread in Citadel's window, not a focused contraption's (#274)", async () => {
  const listeners: Record<string, (e: any) => void> = {};
  const win = (url: string, focused: boolean) => ({ url, focused, sent: [] as unknown[], postMessage(m: unknown) { this.sent.push(m); }, focus: async () => {} });
  const mandate = win('https://citadel.example/apps/mandate/', true);
  const citadel = win('https://citadel.example/c/#/p/2', false);
  let opened = '';
  const self = {
    addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] = fn),
    location: { origin: 'https://citadel.example' },
    clients: { matchAll: async () => [mandate, citadel], openWindow: async (url: string) => { opened = url; } },
  };
  new Function('self', 'fetch', readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8'))(self, () => new Promise(() => {}));
  let done: Promise<unknown> = Promise.resolve();
  listeners.notificationclick({ notification: { close() {}, data: { url: '/c/#/p/2/t/9' } }, waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
  assert.deepEqual(citadel.sent, [{ type: 'open', url: 'https://citadel.example/c/#/p/2/t/9' }]);
  assert.deepEqual(mandate.sent, []);
  assert.equal(opened, '');
});

test("a notification click goes to a window on Citadel's own page, never a preview or the backup page, else opens one", async () => {
  const win = (url: string, focused: boolean) => ({ url, focused, sent: [] as unknown[], postMessage(m: unknown) { this.sent.push(m); }, focus: async () => {} });
  const click = async (windows: ReturnType<typeof win>[]) => {
    const listeners: Record<string, (e: any) => void> = {};
    let opened = '';
    const self = {
      addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] = fn),
      location: { origin: 'https://citadel.example' },
      clients: { matchAll: async () => windows, openWindow: async (url: string) => { opened = url; } },
    };
    new Function('self', 'fetch', readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8'))(self, () => new Promise(() => {}));
    let done: Promise<unknown> = Promise.resolve();
    listeners.notificationclick({ notification: { close() {}, data: { url: '/c/#/p/2/t/9' } }, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    return opened;
  };
  const preview = win('https://citadel.example/preview/3/c/#/p/2', true);
  const backup = win('https://citadel.example/backup', false);
  assert.equal(await click([preview, backup]), 'https://citadel.example/c/#/p/2/t/9');
  assert.deepEqual([preview.sent, backup.sent], [[], []]);
  const citadel = win('https://citadel.example/c/#/p/2', false);
  assert.equal(await click([preview, backup, citadel]), '');
  assert.deepEqual(citadel.sent, [{ type: 'open', url: 'https://citadel.example/c/#/p/2/t/9' }]);
  assert.deepEqual(preview.sent, []);
});

test("a page load that meets Caddy's 502 gets a page that says Citadel is restarting and retries, but not a preview's own (#493)", async () => {
  const load = async (url: string, status: number) => {
    const listeners: Record<string, (e: any) => void> = {};
    const self = { addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] = fn) };
    const upstream = new Response(`upstream ${status}`, { status });
    new Function('self', 'fetch', readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8'))(self, async () => upstream);
    let answer: Promise<Response> | undefined;
    listeners.fetch({ request: { url, mode: 'navigate' }, respondWith: (p: Promise<Response>) => (answer = p) });
    const res = await answer!;
    return { status: res.status, body: await res.text() };
  };
  for (const status of [502, 503, 504]) {
    const { body } = await load('https://citadel.example/c/', status);
    assert.match(body, /is restarting/);
    assert.match(body, /http-equiv="refresh" content="3"/);
  }
  assert.deepEqual(await load('https://citadel.example/c/', 200), { status: 200, body: 'upstream 200' });
  assert.deepEqual(await load('https://citadel.example/c/', 500), { status: 500, body: 'upstream 500' });
  assert.deepEqual(await load('https://citadel.example/preview/3/c/', 502), { status: 502, body: 'upstream 502' });
});

test('a push shows its notification under its tag; a silent one (an all-clear) replaces it without ringing again (#532)', async () => {
  const listeners: Record<string, (e: any) => void> = {};
  const shown: [string, any][] = [];
  const self = {
    addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] = fn),
    location: { origin: 'https://citadel.example' },
    registration: { showNotification: async (title: string, opts: any) => void shown.push([title, opts]) },
  };
  new Function('self', 'fetch', readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8'))(self, () => new Promise(() => {}));
  for (const msg of [{ title: 'Citadel down', tag: 'citadel-watchdog' }, { title: 'Citadel back up', tag: 'citadel-watchdog', silent: true }]) {
    let done: Promise<unknown> = Promise.resolve();
    listeners.push({ data: { json: () => msg }, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  }
  assert.deepEqual(shown.map(([t, o]) => [t, o.tag, o.renotify, o.silent]), [['Citadel down', 'citadel-watchdog', true, false], ['Citadel back up', 'citadel-watchdog', false, true]]);
});
