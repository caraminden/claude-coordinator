import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ensureGradleInit, GRADLE_INIT, GRADLE_INIT_SCRIPT, trimCache } from '../src/build-cache.ts';

const root = mkdtempSync(join(tmpdir(), 'build-cache-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a trim drops the oldest entries until under the cap, never the lock or gc marker (#1153)', async () => {
  const dir = join(root, 'cache');
  mkdirSync(dir);
  // Five 100-byte entries, used at t=1..5 s; Gradle's own files are old and must stay.
  for (let i = 1; i <= 5; i++) {
    writeFileSync(join(dir, `e${i}`), Buffer.alloc(100));
    utimesSync(join(dir, `e${i}`), i, i);
  }
  for (const f of ['cache.lock', 'gc.properties']) {
    writeFileSync(join(dir, f), Buffer.alloc(100));
    utimesSync(join(dir, f), 0, 0);
  }
  assert.deepEqual(await trimCache(dir, 250), { removed: 3, freed: 300, left: 200 });
  assert.deepEqual(readdirSync(dir).sort(), ['cache.lock', 'e4', 'e5', 'gc.properties']);
  assert.deepEqual(await trimCache(dir, 250), { removed: 0, freed: 0, left: 200 });
  assert.deepEqual(await trimCache(join(root, 'none'), 1), { removed: 0, freed: 0, left: 0 });
});

test('a trim leaves an entry Gradle may still be writing, and never follows a symlink out of the cache', async () => {
  const dir = join(root, 'fresh');
  const outside = join(root, 'outside');
  mkdirSync(dir);
  mkdirSync(outside);
  writeFileSync(join(dir, 'just-written'), Buffer.alloc(100));
  writeFileSync(join(outside, 'precious'), Buffer.alloc(100));
  utimesSync(join(outside, 'precious'), 1, 1);
  symlinkSync(join(outside, 'precious'), join(dir, 'link'));
  assert.deepEqual(await trimCache(dir, 0), { removed: 0, freed: 0, left: 100 });
  assert.ok(existsSync(join(dir, 'just-written')));
  assert.ok(existsSync(join(outside, 'precious')));
});

test('the init script is written once and rewritten when it differs', () => {
  const home = join(root, 'home');
  assert.equal(ensureGradleInit(home), true);
  assert.equal(readFileSync(join(home, GRADLE_INIT), 'utf8'), GRADLE_INIT_SCRIPT);
  assert.equal(ensureGradleInit(home), false);
  writeFileSync(join(home, GRADLE_INIT), 'old');
  assert.equal(ensureGradleInit(home), true);
  assert.equal(readFileSync(join(home, GRADLE_INIT), 'utf8'), GRADLE_INIT_SCRIPT);
});

test('citadel-build-cache clear gradle empties the entries and keeps the lock', () => {
  const dir = join(root, 'g');
  mkdirSync(dir);
  for (const f of ['abc', 'gc.properties', 'g.lock']) writeFileSync(join(dir, f), 'x');
  const out = execFileSync(join(import.meta.dirname, '..', 'tools', 'citadel-build-cache'), ['clear', 'gradle'], { cwd: root, env: { ...process.env, CITADEL_GRADLE_CACHE: dir }, encoding: 'utf8' });
  assert.match(out, /gradle: cleared/);
  assert.deepEqual(readdirSync(dir), ['g.lock']);
  assert.ok(existsSync(dir));
});

test('citadel-build-cache clear sccache refuses a folder that is not an sccache cache', () => {
  const home = join(root, 'not-a-cache');
  mkdirSync(home);
  writeFileSync(join(home, 'keep'), 'x');
  assert.throws(() => execFileSync(join(import.meta.dirname, '..', 'tools', 'citadel-build-cache'), ['clear', 'sccache'], { cwd: root, env: { ...process.env, SCCACHE_DIR: home }, stdio: 'pipe' }));
  assert.ok(existsSync(join(home, 'keep')));
});
