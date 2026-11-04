import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installProblems } from '../src/pwa-check.ts';

/** A contraption serving these paths (others 404). */
const app = (files: Record<string, string | object>) => async (path: string) =>
  path in files ? new Response(typeof files[path] === 'string' ? files[path] as string : JSON.stringify(files[path])) : new Response('no', { status: 404 });
const page = (link: string) => `<!doctype html><head><meta charset="utf-8">${link}<title>x</title></head>`;
const good = { id: '/apps/toc/', start_url: '/apps/toc/', scope: '/apps/toc/', name: 'ToC' };

test('a contraption with its own id and scope under /apps/<name>/ installs as its own app', async () => {
  assert.deepEqual(await installProblems('toc', app({ '/apps/toc/': page('<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">'), '/apps/toc/manifest.webmanifest': good })), []);
  // Theory of Crafting's shape: the manifest in a subfolder, relative paths resolved against it.
  assert.deepEqual(await installProblems('toc', app({ '/apps/toc/': page("<link crossorigin=use-credentials href='web/m.json' rel=manifest>"), '/apps/toc/web/m.json': { id: '/apps/toc/', start_url: '../', scope: '../' } })), []);
  // A <base href> moves what the link is relative to.
  assert.deepEqual(await installProblems('toc', app({ '/apps/toc/': page('<base href="/apps/toc/web/"><link rel="manifest" href="m.json">'), '/apps/toc/web/m.json': good })), []);
  assert.match((await installProblems('toc', app({ '/apps/toc/': page('<base href="/"><link rel="manifest" href="manifest.webmanifest">') })))[0], /points outside/);
  // No id: it is start_url, which is the app's.
  assert.deepEqual(await installProblems('toc', app({ '/apps/toc/': page('<link rel="manifest" href="m.json">'), '/apps/toc/m.json': { start_url: './', scope: './' } })), []);
});

test("a root-absolute manifest link, which loads Citadel's manifest, is a problem", async () => {
  const [p] = await installProblems('toc', app({ '/apps/toc/': page('<link rel="manifest" href="/manifest.webmanifest">') }));
  assert.match(p, /points outside \/apps\/toc\/.*make it relative/);
});

test("an id or scope that isn't the app's own is a problem, as is a start_url outside the scope", async () => {
  const withManifest = (m: object) => installProblems('toc', app({ '/apps/toc/': page('<link rel="manifest" href="m.json">'), '/apps/toc/m.json': m }));
  // Citadel's id "/": Chrome takes it for Citadel.
  assert.match((await withManifest({ ...good, id: '/' })).join('\n'), /id resolves to \/, not under \/apps\/toc\//);
  // A relative id resolves against the origin, not the manifest: "./" is "/" too.
  assert.match((await withManifest({ ...good, id: './' })).join('\n'), /id resolves to \/,/);
  assert.match((await withManifest({ ...good, scope: '/' })).join('\n'), /scope resolves to \/, not under/);
  assert.match((await withManifest({ ...good, scope: '/apps/toc/x/' })).join('\n'), /start_url \/apps\/toc\/ is outside its scope/);
  // No id and a start_url off the app (or another origin, which falls back to the page): id and scope follow.
  assert.equal((await withManifest({ start_url: '/' })).length, 2);
  assert.deepEqual(await withManifest({ start_url: 'https://elsewhere.example/', scope: './' }), []);
});

test('no manifest link, a page or manifest that fails, or a manifest that is not JSON, is said plainly', async () => {
  assert.match((await installProblems('toc', app({ '/apps/toc/': page('') })))[0], /no <link rel="manifest">/);
  assert.match((await installProblems('toc', app({})))[0], /\/apps\/toc\/ answered 404/);
  assert.match((await installProblems('toc', app({ '/apps/toc/': page('<link rel="manifest" href="m.json">') })))[0], /m\.json answered 404/);
  assert.match((await installProblems('toc', app({ '/apps/toc/': page('<link rel="manifest" href="m.json">'), '/apps/toc/m.json': '{nope' })))[0], /isn't JSON/);
});
