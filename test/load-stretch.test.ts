import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadStretch, MAX_STRETCH } from '../src/load-stretch.ts';

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
  for (const f of ['deploy.sh', 'land.sh', 'land.local.sh']) {
    const limits = [...read(f).matchAll(/DEPLOY_BOOT_TIMEOUT:-(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(limits.length && limits.every((l) => l > own), `${f}: ${limits} s, for a check that gives up by itself at ${own} s`);
  }
});
