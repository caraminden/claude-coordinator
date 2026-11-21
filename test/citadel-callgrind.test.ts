import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// tools/citadel-callgrind (#1397) against a fake install: a fake valgrind records how it was called and prints
// callgrind's summary, so the routing (dynamic binaries through the generic loader on a copy, others directly) and the
// "Ir <count>" line are checked without building valgrind.
const tool = join(import.meta.dirname, '..', 'tools', 'citadel-callgrind');
const dir = mkdtempSync(join(tmpdir(), 'citadel-callgrind-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const home = join(dir, 'home');
const vgBin = join(home, 'valgrind-3.27.1', 'bin');
const libs = join(home, 'libs', 'usr', 'lib');
const calls = join(dir, 'calls');
const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const run = (...args: string[]) =>
  spawnSync(tool, args, { encoding: 'utf8', env: { ...process.env, CITADEL_CALLGRIND_HOME: home, TMPDIR: dir } });

test('before setup it says to run setup', () => {
  const r = run('/bin/true');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not set up yet: run 'citadel-callgrind setup'/);
});

test('routes dynamic binaries through the generic loader and static ones directly', { skip: !has('readelf') || !has('objcopy') }, () => {
  mkdirSync(vgBin, { recursive: true });
  mkdirSync(libs, { recursive: true });
  for (const f of ['ld-linux-x86-64.so.2', 'libgcc_s.so.1', 'libstdc++.so.6']) writeFileSync(join(libs, f), '');
  writeFileSync(join(vgBin, 'valgrind'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${calls}'
for a; do case $a in --log-file=*) log=\${a#--log-file=};; esac; done
printf '==1== Events    : Ir\\n==1== Collected : 1234\\n' > "$log"
`);
  chmodSync(join(vgBin, 'valgrind'), 0o755);
  const script = join(dir, 'static-ish');
  writeFileSync(script, '#!/bin/sh\n');
  chmodSync(script, 0o755);

  const dyn = run('--dump-instr=yes', '/bin/true', 'arg1');
  assert.equal(dyn.status, 0, dyn.stderr);
  assert.match(dyn.stdout, /^Ir 1234$/m);
  const notDynamic = run('--tool=cachegrind', '--', script);
  assert.equal(notDynamic.status, 0, notDynamic.stderr);

  const [first, second] = readFileSync(calls, 'utf8').trim().split('\n');
  assert.match(first, /^--tool=callgrind --dump-instr=yes --callgrind-out-file=\S+\/callgrind\.out\.\d+ --log-file=\S+ \S+\/ld-linux-x86-64\.so\.2 --library-path \S+ \S+\/true arg1$/);
  assert.ok(!first.includes(' /bin/true'), 'runs a copy, not the original');
  assert.match(second, new RegExp(`^--tool=cachegrind --log-file=\\S+ ${script}$`));
});
