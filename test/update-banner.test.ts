import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
// @ts-ignore: a plain JS module with its types beside it
import { checkUpdate, mountUpdate } from '../public/ui/update.js';

// public/ui/update.js (#837): the banner's check, with Capacitor's App plugin, fetch and the page's base faked.
const g = globalThis as any;
const realFetch = g.fetch;
afterEach(() => {
  delete g.Capacitor;
  delete g.document;
  g.fetch = realFetch;
});

function phone(build: string | null, feed: unknown, ok = true) {
  g.document = { baseURI: 'https://twi.example/apps/twireader/' };
  if (build === null) delete g.Capacitor;
  else g.Capacitor = { isNativePlatform: () => true, Plugins: { App: { getInfo: async () => ({ build }) } } };
  const asked: string[] = [];
  g.fetch = async (url: URL) => {
    asked.push(String(url));
    return { ok, json: async () => feed };
  };
  return asked;
}

test('a newer build in the feed is an update, its APK resolved against the feed', async () => {
  const asked = phone('3', { versionCode: 5, apk: 'twireader-5.apk', versionName: '1.0', commit: 'abc' });
  assert.deepEqual(await checkUpdate(), { versionCode: 5, versionName: '1.0', url: 'https://twi.example/apps/twireader/android/twireader-5.apk' });
  assert.deepEqual(asked, ['https://twi.example/apps/twireader/android/latest.json']);
});

test('the same or an older build, a bad feed, a failed fetch or a browser (no native App plugin) show nothing', async () => {
  phone('5', { versionCode: 5, apk: 'a.apk' });
  assert.equal(await checkUpdate(), null);
  phone('6', { versionCode: 5, apk: 'a.apk' });
  assert.equal(await checkUpdate(), null);
  phone('1', { versionCode: '9', apk: 'a.apk' });
  assert.equal(await checkUpdate(), null);
  phone('1', { versionCode: 9 });
  assert.equal(await checkUpdate(), null);
  phone('1', null, false);
  assert.equal(await checkUpdate(), null);
  const asked = phone(null, { versionCode: 9, apk: 'a.apk' });
  assert.equal(await checkUpdate(), null);
  assert.deepEqual(asked, [], 'a browser never fetches the feed');
});

test("an app on Citadel's shared Android shell asks natively, so the banner steps aside without reading the feed", async () => {
  const asked = phone('3', { versionCode: 5, apk: 'twireader-5.apk' });
  g.Capacitor.isPluginAvailable = (name: string) => name === 'CitadelShell';
  assert.equal(await mountUpdate({} as any), null);
  assert.deepEqual(asked, []);
});
