import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUnits, problemKeys, summary } from '../src/unit-drift.ts';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'unit-drift-'));
  const deploy = join(root, 'deploy'),
    inst = join(root, 'inst');
  mkdirSync(join(deploy, 'a.service.d'), { recursive: true });
  mkdirSync(join(deploy, 'desktop'));
  mkdirSync(inst, { recursive: true });
  for (const [f, t] of [
    ['a.service', 'A'],
    ['b.slice', 'B'],
    ['c.timer', 'C'],
    ['a.service.d/w.conf', 'W'],
    ['notes.md', 'x'],
    ['desktop/z.service', 'Z'],
  ])
    writeFileSync(join(deploy, f), t);
  return { deploy, inst, root };
}

test('installed, different and missing, with the fish command; symlinks and copies count; other files and folders are ignored', () => {
  const { deploy, inst, root } = setup();
  symlinkSync(join(deploy, 'a.service'), join(inst, 'a.service'));
  writeFileSync(join(inst, 'b.slice'), 'old');
  const rows = checkUnits(deploy, inst, root);
  assert.deepEqual(
    rows.map((r) => [r.name, r.state]),
    [
      ['a.service', 'installed'],
      ['a.service.d/w.conf', 'missing'],
      ['b.slice', 'different'],
      ['c.timer', 'missing'],
    ],
  );
  assert.equal(rows[0].fix, null);
  assert.match(rows[1].fix!, /^mkdir -p ~?.*a\.service\.d; ln -sf .*w\.conf .*; systemctl --user daemon-reload$/);
  assert.match(rows[3].fix!, /enable --now c\.timer$/);
  assert.deepEqual(problemKeys(rows), ['a.service.d/w.conf:missing', 'b.slice:different', 'c.timer:missing']);
  assert.equal(summary(rows), 'Units: 1 installed, 1 missing (a.service.d/w.conf, c.timer)'.replace('1 missing (a.service.d/w.conf, c.timer)', '2 missing (a.service.d/w.conf, c.timer), 1 different (b.slice)'));
});

test('a unit marked not installed on purpose stops showing', () => {
  const { deploy, inst, root } = setup();
  writeFileSync(join(deploy, 'not-installed.txt'), '# why\nc.timer  # kept out\na.service\n');
  assert.deepEqual(
    checkUnits(deploy, inst, root).map((r) => r.name),
    ['b.slice'],
  );
});

test('the real deploy/ lists the watchdog and both slices as units', () => {
  const names = checkUnits(join(import.meta.dirname, '..', 'deploy'), join(tmpdir(), 'nowhere-units')).map((r) => r.name);
  for (const n of ['citadel-watchdog.timer', 'citadel-watchdog.service', 'citadel.slice', 'citadel-turns.slice']) assert.ok(names.includes(n), n);
});
