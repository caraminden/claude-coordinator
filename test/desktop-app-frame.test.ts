// The desktop app's right-click in an app's frame (desktop/app-frame.cjs, #1691).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { appFrame } = createRequire(import.meta.url)('../desktop/app-frame.cjs');
type F = { url: string; parent: F | null };
const page: F = { url: 'https://citadel.zip/c/#p/2', parent: null };
const app: F = { url: 'https://citadel.zip/apps/trip-presenter/slides', parent: page };

test("a right-click in an app's frame names that frame, on Citadel's host or the app's own (APPS_DOMAIN, live)", () => {
  assert.equal(appFrame(app), app);
  const own: F = { url: 'https://trip-presenter.citadel.zip/apps/trip-presenter/', parent: page };
  assert.equal(appFrame(own), own);
});

test("a frame inside the app counts as the app, so Reload this app reloads the app's frame", () => {
  const inner: F = { url: 'https://www.youtube.com/embed/x', parent: { url: 'https://citadel.zip/apps/trip-presenter/embed', parent: app } };
  assert.equal(appFrame(inner), app);
});

test("Citadel's own page, a frame at another path or no frame is not an app", () => {
  assert.equal(appFrame(page), null);
  assert.equal(appFrame({ url: 'https://citadel.zip/c/shared/page.html', parent: page }), null);
  assert.equal(appFrame({ url: 'https://citadel.zip/files/2/report.html', parent: page }), null);
  assert.equal(appFrame({ url: 'about:blank', parent: page }), null);
  assert.equal(appFrame(null), null);
});

// desktop/build.sh copies a fixed list of files into the app: one main.cjs requires but the list misses would crash the
// published app at start, while a checkout run (the Windows rig copies the whole folder) works (#1691).
test('every file the desktop app requires or preloads is one build.sh copies into the app', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../desktop/', import.meta.url);
  const list = readFileSync(new URL('build.sh', dir), 'utf8')
    .match(/cp "\$here"\/\{([^}]+)\} "\$work\/Citadel\/resources\/app\/"/)?.[1]
    .split(',');
  assert.ok(list, "build.sh's copy line is where this test looks for it");
  const needed = readdirSync(dir)
    .filter((f) => f.endsWith('.cjs'))
    .flatMap((f) => [...readFileSync(new URL(f, dir), 'utf8').matchAll(/require\('\.\/([^']+)'\)|'(preload\.cjs)'/g)].map((m) => m[1] ?? m[2]));
  assert.ok(needed.includes('route.cjs'), 'the scan finds main.cjs requires');
  assert.deepEqual(
    needed.filter((f) => !list.includes(f)),
    [],
  );
});
