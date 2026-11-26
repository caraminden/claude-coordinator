import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadStretch, MAX_STRETCH, stepLimit, within } from '../src/load-stretch.ts';
import { landText } from './land-files.ts';

test('a quiet box keeps each limit as it is and adds nothing to the failure', () => {
  for (const load of [0, 3, 16]) {
    const s = loadStretch(load, 16);
    assert.equal(s.ms(10_000), 10_000);
    assert.equal(s.why, '');
  }
});

test('a busy box stretches a limit by load over cores, in whole seconds, and says so', () => {
  // The load of the refused ships of Nov 21 (#1514): 53 on 16 cores.
  const s = loadStretch(53, 16);
  assert.equal(s.ms(10_000), 34_000);
  assert.equal(s.ms(20_000), 67_000);
  assert.equal(s.why, ' (stretched 3.3x for load 53 on 16 cores)');
});

test('the stretch stops at its cap, so the 3-minute backstop still decides a hang', () => {
  const s = loadStretch(500, 16);
  assert.equal(s.by, MAX_STRETCH);
  assert.equal(s.ms(30_000), 30_000 * MAX_STRETCH);
});

test('every outside limit on the boot check is past its own backstop, armed again after each long step (#1865)', () => {
  const read = (f: string) => readFileSync(join(import.meta.dirname, '..', 'tools', f), 'utf8');
  const check = read('boot-check.ts');
  const own = (check.match(/^ *arm\(\);/gm)!.length * Number(/\}, ([\d_]+)\)\.unref/.exec(check)![1].replaceAll('_', ''))) / 1000;
  assert.ok(own >= 360, `${own} s read from boot-check.ts`);
  for (const f of ['deploy.sh', 'land.sh']) {
    const limits = [...(f === 'land.sh' ? landText() : read(f)).matchAll(/DEPLOY_BOOT_TIMEOUT:-(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(limits.length && limits.every((l) => l > own), `${f}: ${limits} s, for a check that gives up by itself at ${own} s`);
  }
});

test('a limit follows a load that rises after the step began, and keeps the busiest reading (#2009)', () => {
  let load = 0;
  const limit = stepLimit(() => load, 16);
  const ago = (ms: number) => Date.now() - ms;
  assert.equal(limit.over(20_000, ago(25_000)), true);
  load = 32;
  assert.equal(limit.over(20_000, ago(25_000)), false);
  load = 0;
  assert.equal(limit.over(20_000, ago(30_000)), false);
  assert.equal(limit.text(20_000), '40 s (stretched 2.0x for load 32 on 16 cores)');
  load = 5000;
  assert.equal(limit.over(20_000, ago(81_000)), true, 'the cap still ends a hang');
});

test('a step that hangs still fails while the load rises, and one that ends is returned or throws its own error', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const hung = new Promise<never>(() => {});
  let load = 0;
  const late = within(
    hung,
    1000,
    (l) => `hung ${l}`,
    stepLimit(() => (load++ ? 64 : 0), 16),
  );
  t.mock.timers.tick(4250);
  await assert.rejects(late, { message: `hung ${MAX_STRETCH} s (stretched 4.0x for load 64 on 16 cores)` });
  load = 0;
  const unread = within(
    hung,
    1000,
    String,
    stepLimit(() => {
      if (load++) throw new Error('no /proc/loadavg');
      return 0;
    }, 16),
  );
  t.mock.timers.tick(250);
  await assert.rejects(unread, /no \/proc\/loadavg/);
  assert.equal(await within(Promise.resolve(7), 1000, String), 7);
  await assert.rejects(within(Promise.reject(new Error('own')), 1000, String), /own/);
});
