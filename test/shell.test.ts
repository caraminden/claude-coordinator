// The app shell kept on the device (#1144): public/sw.js as the server fills it in (src/shell.ts), its off switch first.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SHELL_OFF_FILE, shellFiles, shellWorker } from '../src/shell.ts';
import { bootServer } from './helpers.ts';

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://citadel.example';

/** A fake browser for one worker: its caches, open windows and the network (each URL's body and version). */
function browser(network: Record<string, { version: string; body?: string; status?: number }> = {}) {
  const stores = new Map<string, Map<string, Response>>();
  const navigated: string[] = [];
  const fetched: string[] = [];
  const windows = [`${ORIGIN}/c/#/p/2/t/9`, `${ORIGIN}/apps/mandate/`].map((url) => ({ url, navigate: async (to: string) => void navigated.push(to) }));
  const caches = {
    keys: async () => [...stores.keys()],
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return { put: async (url: string, res: Response) => void store.set(url, res), match: async (url: string) => store.get(url)?.clone() };
    },
    delete: async (name: string) => stores.delete(name),
  };
  const fetch = async (req: string | { url: string }) => {
    const url = new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname;
    fetched.push(url);
    const hit = network[url];
    if (!hit) throw new TypeError('Failed to fetch');
    return new Response(hit.body ?? `network ${url}`, { status: hit.status ?? 200, headers: { 'X-Front-Version': hit.version, 'X-Front-Hash': hit.body ?? `network ${url}` } });
  };
  return { stores, navigated, fetched, caches, fetch, windows };
}

/** Load a worker script into a fake browser; returns how to fire its events. */
function worker(script: string, b: ReturnType<typeof browser>) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
    skipWaiting: () => {},
    location: { origin: ORIGIN },
    clients: { claim: async () => {}, matchAll: async () => b.windows },
  };
  new Function('self', 'fetch', 'caches', script)(self, b.fetch, b.caches);
  const lifecycle = async (type: 'install' | 'activate') => {
    let done: Promise<unknown> = Promise.resolve();
    listeners[type]({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  /** A request through the worker: its answer's body, or null when the worker left it to the browser. */
  const request = async (path: string, mode = 'no-cors', method = 'GET') => {
    let answer = null as Promise<Response> | null;
    listeners.fetch({ request: { url: ORIGIN + path, mode, method }, respondWith: (p: Promise<Response>) => (answer = p) });
    return answer ? (await answer).text() : null;
  };
  return { lifecycle, request };
}

const NAMES = ['index.html', 'app.js', 'style.css', 'ui/chat.js', 'icon.svg', 'sw.js', 'manifest.webmanifest', 'machine-agent.mjs', 'ui/chat.d.ts'];
/** What the server sends the worker for a version: each name's hash (here the body `net` serves under that version). */
const H = (version: string) => new Map(NAMES.map((n) => [n, `${version} /c/${n === 'index.html' ? '' : n}`]));
const net = (version: string) => Object.fromEntries(['/c/', '/c/app.js', '/c/icon.svg', '/c/style.css', '/c/ui/chat.js'].map((u) => [u, { version, body: `${version} ${u}` }]));

test('the off switch: the worker the server serves then drops every kept file, reloads the windows they served, and keeps nothing', async () => {
  const b = browser(net('v1'));
  const on = worker(shellWorker(SOURCE, 'v1', H('v1'), false), b);
  await on.lifecycle('install');
  await on.lifecycle('activate');
  assert.equal(await on.request('/c/', 'navigate'), 'v1 /c/');
  assert.deepEqual(b.navigated, []);

  const off = shellWorker(SOURCE, 'v1', H('v1'), true);
  assert.equal(off, SOURCE, 'the off worker is public/sw.js as it stands, with nothing to keep');
  const w = worker(off, b);
  await w.lifecycle('install');
  await w.lifecycle('activate');
  assert.deepEqual([...b.stores.keys()], []);
  assert.deepEqual(b.navigated, [`${ORIGIN}/c/#/p/2/t/9`], "Citadel's window reloads; a contraption's doesn't");
  b.fetched.length = 0;
  assert.equal(await w.request('/c/', 'navigate'), 'v1 /c/');
  assert.equal(await w.request('/c/app.js'), null, 'files go to the network as before #1144');
  assert.deepEqual(b.fetched, ['/c/']);
  // A device that never kept anything isn't reloaded by it.
  const fresh = browser();
  const w2 = worker(off, fresh);
  await w2.lifecycle('activate');
  assert.deepEqual(fresh.navigated, []);
});

test('the server fills in the worker: its version and the page plus its scripts, styles and icons, nothing else', () => {
  assert.deepEqual(shellFiles(NAMES), ['app.js', 'icon.svg', 'style.css', 'ui/chat.js']);
  const filled = shellWorker(SOURCE, 'abc123', H('abc123'), false);
  const shell = JSON.parse(/const SHELL = (\{.*\});/.exec(filled)![1]);
  assert.deepEqual(shell, {
    version: 'abc123',
    urls: ['/c/', '/c/app.js', '/c/icon.svg', '/c/style.css', '/c/ui/chat.js'],
    hashes: { '/c/': 'abc123 /c/', '/c/app.js': 'abc123 /c/app.js', '/c/icon.svg': 'abc123 /c/icon.svg', '/c/style.css': 'abc123 /c/style.css', '/c/ui/chat.js': 'abc123 /c/ui/chat.js' },
  });
  assert.throws(() => shellWorker('const SHELL = {};', 'v', NAMES, false), /lost its line/);
});

test("a worker keeps its version's files and opens the app from them with no network; anything else is left to the network", async () => {
  const b = browser(net('v1'));
  const w = worker(shellWorker(SOURCE, 'v1', H('v1'), false), b);
  await w.lifecycle('install');
  await w.lifecycle('activate');
  const offline = worker(shellWorker(SOURCE, 'v1', H('v1'), false), {
    ...b,
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal(await offline.request('/c/', 'navigate'), 'v1 /c/');
  assert.equal(await offline.request('/c/index.html', 'navigate'), 'v1 /c/');
  assert.equal(await offline.request('/c/app.js'), 'v1 /c/app.js');
  assert.equal(await offline.request('/c/icon.svg?v=1234abcd'), 'v1 /c/icon.svg', 'an icon under its versioned URL');
  // Never API answers, a contraption's or a preview's files, the backup chat, or a write.
  assert.equal(await offline.request('/c/api/me'), null);
  assert.equal(await offline.request('/c/api/tickets/9/events'), null);
  assert.equal(await offline.request('/apps/mandate/app.js'), null);
  assert.equal(await offline.request('/apps/mandate/', 'navigate'), null);
  assert.equal(await offline.request('/backup', 'navigate'), null);
  assert.equal(await offline.request('/preview/3/c/app.js'), null);
  assert.equal(await offline.request('/c/app.js', 'no-cors', 'POST'), null);
  // A page the worker doesn't keep loads from the network, with the offline page when there is none.
  assert.match((await offline.request('/c/share', 'navigate'))!, /can't be reached/);
});

test('a ship: the new worker keeps only files of its own version, all or none, and drops the old version once it takes over', async () => {
  const b = browser(net('v1'));
  const v1 = worker(shellWorker(SOURCE, 'v1', H('v1'), false), b);
  await v1.lifecycle('install');
  await v1.lifecycle('activate');
  // The server moved on again while v2 installed: one file is v3's, so v2 keeps nothing and v1 stays in charge.
  const mixed = { ...net('v2'), '/c/app.js': { version: 'v3', body: 'v2 /c/app.js' } };
  const b2 = { ...b, fetch: browser(mixed).fetch };
  await assert.rejects(worker(shellWorker(SOURCE, 'v2', H('v2'), false), b2).lifecycle('install'), /\/c\/app\.js is not front end v2/);
  assert.deepEqual([...b.stores.keys()], ['shell-v1']);
  // A clean install of v2 replaces v1's files when it activates, and the windows open stay as they are (the page reloads itself).
  const b3 = { ...b, fetch: browser(net('v2')).fetch };
  const v2 = worker(shellWorker(SOURCE, 'v2', H('v2'), false), b3);
  await v2.lifecycle('install');
  assert.deepEqual([...b.stores.keys()].sort(), ['shell-v1', 'shell-v2']);
  await v2.lifecycle('activate');
  assert.deepEqual([...b.stores.keys()], ['shell-v2']);
  assert.equal(await v2.request('/c/app.js'), 'v2 /c/app.js');
  assert.deepEqual(b.navigated, []);
  // A kept file that went missing (the browser evicted it) comes from the network.
  b.stores.get('shell-v2')!.delete('/c/style.css');
  assert.equal(await v2.request('/c/style.css'), 'v2 /c/style.css');
});

test('a ship fetches only the files whose content changed; the rest are copied from the old cache, still all or none (#1331)', async () => {
  const b = browser(net('v1'));
  const v1 = worker(shellWorker(SOURCE, 'v1', H('v1'), false), b);
  await v1.lifecycle('install');
  await v1.lifecycle('activate');
  // v2 changes app.js (and so the page, which names the version) only.
  const same = (u: string) => ({ version: 'v2', body: `v1 ${u}` });
  const n2 = { ...net('v2'), '/c/icon.svg': same('/c/icon.svg'), '/c/style.css': same('/c/style.css'), '/c/ui/chat.js': same('/c/ui/chat.js') };
  const hashes = new Map(H('v2'));
  for (const n of ['icon.svg', 'style.css', 'ui/chat.js']) hashes.set(n, `v1 /c/${n}`);
  const b2 = browser(n2);
  const v2 = worker(shellWorker(SOURCE, 'v2', hashes, false), { ...b, fetch: b2.fetch });
  await v2.lifecycle('install');
  assert.deepEqual(b2.fetched.sort(), ['/c/', '/c/app.js'], 'two fetched, not five');
  await v2.lifecycle('activate');
  assert.equal(await v2.request('/c/app.js'), 'v2 /c/app.js');
  assert.equal(await v2.request('/c/style.css'), 'v1 /c/style.css');
  assert.deepEqual([...b.stores.keys()], ['shell-v2']);
  // A ship landing mid-install: the one changed file is already v3's, so v2 keeps nothing (not even the copies) and v1's cache stays whole.
  const b3 = browser(net('v1'));
  const w1 = worker(shellWorker(SOURCE, 'v1', H('v1'), false), b3);
  await w1.lifecycle('install');
  await w1.lifecycle('activate');
  const raced = browser({ ...n2, '/c/app.js': { version: 'v3', body: 'v3 /c/app.js' } });
  await assert.rejects(worker(shellWorker(SOURCE, 'v2', hashes, false), { ...b3, fetch: raced.fetch }).lifecycle('install'), /\/c\/app\.js is not front end v2/);
  assert.deepEqual([...b3.stores.keys()], ['shell-v1']);
  assert.equal(await w1.request('/c/app.js'), 'v1 /c/app.js');
  assert.equal(await w1.request('/c/style.css'), 'v1 /c/style.css');
});

let srv: Awaited<ReturnType<typeof bootServer>> | null = null;
after(() => srv?.stop());

test('the server serves the filled-in worker and tells the page and each file its version; the off switch file swaps the worker without a restart', async () => {
  srv = await bootServer();
  const page = await fetch(`${srv.base}/c/`);
  const version = page.headers.get('x-front-version')!;
  assert.match(version, /^[0-9a-f]{12}$/);
  assert.match(await page.text(), new RegExp(`<meta name="citadel-version" content="${version}">`));
  assert.equal((await fetch(`${srv.base}/c/app.js`)).headers.get('x-front-version'), version);
  const on = await (await fetch(`${srv.base}/sw.js`)).text();
  const shell = JSON.parse(/const SHELL = (\{.*\});/.exec(on)![1]);
  assert.equal(shell.version, version);
  // Each kept file's hash is the one the server sends with it.
  for (const url of shell.urls) assert.equal((await fetch(srv.base + url)).headers.get('x-front-hash'), shell.hashes[url], url);
  assert.ok(shell.urls.includes('/c/') && shell.urls.includes('/c/app.js') && shell.urls.includes('/c/ui/chat.js'));
  assert.ok(!shell.urls.some((u: string) => /api|sw\.js|\.mjs$|manifest/.test(u)));
  // Every file it keeps is one the server has.
  for (const url of shell.urls) assert.equal((await fetch(srv.base + url)).status, 200, url);

  writeFileSync(join(srv.data, SHELL_OFF_FILE), '');
  const off = await (await fetch(`${srv.base}/sw.js`)).text();
  assert.match(off, /const SHELL = null;/);
  rmSync(join(srv.data, SHELL_OFF_FILE));
  assert.equal(await (await fetch(`${srv.base}/sw.js`)).text(), on);
});
