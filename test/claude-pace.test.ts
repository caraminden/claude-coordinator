import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';
import { until } from './wait.ts';

// tools/claude-pace (#1748): a nested `claude` a turn's script starts paces itself on the box's memory level. Laid out
// as a turn's pin/bin: heavy/claude links to ../claude-pace, and the real claude is further down PATH.
const root = mkdtempSync(join(tmpdir(), 'claude-pace-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const bin = join(root, 'bin');
mkdirSync(join(bin, 'heavy'), { recursive: true });
symlinkSync(join(import.meta.dirname, '..', 'tools', 'claude-pace'), join(bin, 'claude-pace'));
symlinkSync('../claude-pace', join(bin, 'heavy', 'claude'));
const real = join(root, 'real');
mkdirSync(real);
writeFileSync(join(real, 'claude'), '#!/bin/sh\necho "real claude $*"\n');
chmodSync(join(real, 'claude'), 0o755);
const PATH = `${join(bin, 'heavy')}:${bin}:${real}:${process.env.PATH}`;

let n = 0;
/** A heavy folder of its own with a level file; `level` swaps it whole, as the server's rename does. */
function box(text: string | null) {
  const dir = join(root, `heavy-${n++}`);
  mkdirSync(dir);
  const file = join(dir, 'memory-level');
  const level = (t: string) => { writeFileSync(`${file}.tmp`, t); renameSync(`${file}.tmp`, file); };
  if (text !== null) level(text);
  const env = (more: Record<string, string> = {}) => scriptEnv({ PATH, CLAUDECODE: '1', CITADEL_HEAVY_DIR: dir, CITADEL_HEAVY_WHO: 'Delve #4', CITADEL_PACE_POLL: '0.1', CITADEL_PACE_SPACING: '600', CITADEL_PACE_HOLD: '600', ...more });
  return { dir, file, level, env };
}
const runNow = (env: NodeJS.ProcessEnv) => spawnSync('claude', ['-p', 'hi'], { env, encoding: 'utf8', timeout: 20_000 });
function start(env: NodeJS.ProcessEnv) {
  const child = spawn('claude', ['-p', 'hi'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout!.on('data', (b) => (out += b));
  child.stderr!.on('data', (b) => (err += b));
  return { out: () => out, err: () => err, done: new Promise<number | null>((r) => child.on('close', r)) };
}
const waits = (dir: string) => readdirSync(dir).filter((f) => /^wait-\d+-\d+$/.test(f));

test('at ok, or with no level file, a nested claude starts at once', () => {
  for (const text of ['ok\n\n', null]) {
    const b = box(text);
    const r = runNow(b.env());
    assert.equal(r.stdout, 'real claude -p hi\n');
    assert.equal(r.stderr, '');
  }
});

test('outside a Claude session, a stale level file, or no heavy folder: it starts at once even when tight', () => {
  const b = box('tight\n2.0 GB free\n');
  assert.equal(runNow(b.env({ CLAUDECODE: '' })).stdout, 'real claude -p hi\n', 'not nested: a person or the server');
  assert.equal(runNow(b.env({ CITADEL_HEAVY_DIR: join(root, 'nowhere') })).stdout, 'real claude -p hi\n');
  const old = Date.now() / 1000 - 120;
  utimesSync(b.file, old, old);
  assert.equal(runNow(b.env()).stdout, 'real claude -p hi\n', 'a stopped server never holds anyone');
});

test('easing: one nested session a turn per spacing; the next waits, shown as waiting, and the running one carries on', async () => {
  const b = box('easing\n5.0 GB free\n');
  assert.equal(runNow(b.env()).stdout, 'real claude -p hi\n', 'the first goes at once');
  assert.equal(runNow(b.env({ CITADEL_HEAVY_WHO: 'Peek #2' })).stdout, 'real claude -p hi\n', "another turn's first goes too");
  const second = start(b.env());
  await until('the second to say it waits', () => /Citadel is easing off memory \(5\.0 GB free\), so this turn starts one nested session every 600 s/.test(second.err()));
  await until('its wait file', () => waits(b.dir).length === 1);
  const [who, what, , reason] = readFileSync(join(b.dir, waits(b.dir)[0]), 'utf8').split('\n');
  assert.deepEqual([who, what, reason], ['Delve #4', 'a nested Claude session', 'ease']);
  assert.equal(second.out(), '');
  b.level('ok\n\n');
  assert.equal(await second.done, 0);
  assert.equal(second.out(), 'real claude -p hi\n');
  assert.deepEqual(waits(b.dir), [], 'the wait file goes with it');
});

test('easing: once the spacing has passed the next one goes', async () => {
  const b = box('easing\n5.0 GB free\n');
  const env = b.env({ CITADEL_PACE_SPACING: '1' });
  assert.equal(runNow(env).stdout, 'real claude -p hi\n');
  const next = start(env);
  assert.equal(await next.done, 0);
  assert.equal(next.out(), 'real claude -p hi\n');
});

test('tight: every nested session holds, and after the hold one goes as at easing', async () => {
  const b = box('tight\n2.0 GB free (tight under 3.0 GB)\n');
  const held = start(b.env());
  await until('it to say it holds', () => /memory is tight \(2\.0 GB free \(tight under 3\.0 GB\)\), so this nested session waits until it eases, at most 10 min/.test(held.err()));
  await until('its wait file', () => waits(b.dir).length === 1);
  assert.equal(held.out(), '');
  b.level('easing\n5.0 GB free\n');
  assert.equal(await held.done, 0, 'easing lets the first one through');

  const c = box('tight\n2.0 GB free\n');
  const bounded = start(c.env({ CITADEL_PACE_HOLD: '1' }));
  assert.equal(await bounded.done, 0, 'still tight, but past the hold');
  assert.equal(bounded.out(), 'real claude -p hi\n');
  assert.ok(!existsSync(join(c.dir, 'wait')) && waits(c.dir).length === 0);
});
