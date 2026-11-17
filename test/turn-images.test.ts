import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const { loadImages, MAX_IMAGES, MAX_IMAGE_BYTES } = await import('../src/turn-images.ts');
const { parseTurn, userLine } = await import('../src/contraption-turns.ts');

const root = mkdtempSync(join(tmpdir(), 'turn-images-'));
const data = join(root, 'data');
const outside = join(root, 'outside');
mkdirSync(data);
mkdirSync(outside);
const png = (path: string, size: string) => assert.equal(spawnSync('magick', ['-size', size, 'xc:red', path]).status, 0);
png(join(data, 'big.png'), '3000x2000');
png(join(data, 'small.png'), '100x50');
png(join(outside, 'secret.png'), '10x10');
symlinkSync(join(outside, 'secret.png'), join(data, 'link.png'));
symlinkSync(outside, join(data, 'linkdir'));
writeFileSync(join(data, 'notes.txt'), 'not an image');

const refused = async (paths: unknown, status: number, re: RegExp) => {
  await assert.rejects(loadImages(paths, data), (e: any) => e.status === status && re.test(e.message));
};

test('downscales to 1568 on the long side as JPEG', async () => {
  const [big, small] = await loadImages([join(data, 'big.png'), 'small.png'], data);
  assert.equal(big.media_type, 'image/jpeg');
  const dim = (b64: string) => spawnSync('magick', ['jpeg:-', '-format', '%w %h', 'info:'], { input: Buffer.from(b64, 'base64') }).stdout.toString();
  assert.equal(dim(big.data), '1568 1045');
  assert.equal(dim(small.data), '100 50'); // never upscaled
});

test('paths outside the data folder are refused, symlinks resolved first', async () => {
  await refused([join(outside, 'secret.png')], 400, /outside/);
  await refused(['../outside/secret.png'], 400, /outside/);
  await refused(['link.png'], 400, /outside/);
  await refused(['linkdir/secret.png'], 400, /outside/);
  await refused(['/etc/passwd'], 400, /outside/);
});

test('bad shapes and missing files are 400', async () => {
  await refused('small.png', 400, /list/);
  await refused([5], 400, /path/);
  await refused(['nope.png'], 400, /nope\.png/);
  await refused(['notes.txt'], 400, /image/);
});

test('count cap is a 413 naming the count', async () => {
  await refused(Array(MAX_IMAGES + 1).fill('small.png'), 413, /count/i);
});

test('total size cap is a 413 naming the size', async () => {
  assert.ok(MAX_IMAGE_BYTES > 0);
  await assert.rejects(loadImages(['big.png', 'big.png'], data, { maxBytes: 100 }), (e: any) => e.status === 413 && /total size/i.test(e.message));
});

test('images ride as image blocks before the text in the first user message', () => {
  const line = JSON.parse(userLine('hi', undefined, [{ media_type: 'image/jpeg', data: 'AAAA' }]));
  assert.deepEqual(line.message.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    { type: 'text', text: 'hi' },
  ]);
});

test('parseTurn carries images, and takes them with blind', () => {
  const c = { default_model: null };
  const t = parseTurn({ person: 1, session: 's', prompt: 'p', blind: true, images: ['a.png'] }, c);
  assert.deepEqual(t.images, ['a.png']);
  assert.deepEqual(parseTurn({ person: 1, session: 's', prompt: 'p' }, c).images, []);
  assert.throws(() => parseTurn({ person: 1, session: 's', prompt: 'p', images: 'a.png' }, c), /images/);
});
