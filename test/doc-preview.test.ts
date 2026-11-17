// A choices card's preview (#821): each version of a page is shot once, kept on disk, shot one at a
// time, and a page that fails isn't shot again on every card render.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DocPreviews } from '../src/doc-preview.ts';

const root = mkdtempSync(join(tmpdir(), 'doc-preview-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a version is shot once and kept on disk; an edited page gets a new shot', async () => {
  const dir = join(root, 'kept');
  const shots: string[] = [];
  const previews = new DocPreviews(dir, async (url) => (shots.push(url), Buffer.from(`img of ${url}`)));
  const k1 = DocPreviews.key('/w/page.html', 10, 1000);
  assert.equal(String(await previews.get(k1, () => 'http://x/page')), 'img of http://x/page');
  assert.equal(String(await previews.get(k1, () => 'http://x/page')), 'img of http://x/page');
  assert.deepEqual(shots, ['http://x/page']);
  assert.ok(existsSync(join(dir, `${k1}.jpg`)));
  // A restart keeps it: a new instance reads the file instead of shooting.
  const again = new DocPreviews(dir, async () => assert.fail('shot again after a restart'));
  assert.equal(String(await again.get(k1, () => 'http://x/page')), 'img of http://x/page');
  const k2 = DocPreviews.key('/w/page.html', 10, 2000);
  assert.notEqual(k1, k2);
  await previews.get(k2, () => 'http://x/page2');
  assert.deepEqual(shots, ['http://x/page', 'http://x/page2']);
});

test('requests for the same version share one shot, and shots run one at a time', async () => {
  let running = 0;
  let most = 0;
  const shots: string[] = [];
  const previews = new DocPreviews(join(root, 'queue'), async (url) => {
    shots.push(url);
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return Buffer.from(url);
  });
  const [a, b] = ['/a.html', '/b.html'].map((p) => DocPreviews.key(p, 1, 1));
  const got = await Promise.all([previews.get(a, () => 'A'), previews.get(a, () => 'A'), previews.get(b, () => 'B')]);
  assert.deepEqual(got.map(String), ['A', 'A', 'B']);
  assert.deepEqual(shots, ['A', 'B']);
  assert.equal(most, 1);
});

test('a page that fails gives null, is not shot again, and does not stop the next', async () => {
  let tries = 0;
  const dir = join(root, 'fail');
  const previews = new DocPreviews(dir, async (url) => {
    if (url === 'bad') {
      tries++;
      throw new Error('net::ERR_FAILED');
    }
    return Buffer.from('ok');
  });
  const bad = DocPreviews.key('/bad.html', 1, 1);
  assert.equal(await previews.get(bad, () => 'bad'), null);
  assert.equal(await previews.get(bad, () => 'bad'), null);
  assert.equal(tries, 1);
  assert.equal(String(await previews.get(DocPreviews.key('/good.html', 1, 1), () => 'good')), 'ok');
  assert.deepEqual(readdirSync(dir).length, 1);
});
