// #1255 (cd4d37cd): wrapperInProc matches `<node> <pin>/turn-wrapper.mjs <dir>` exactly. A process whose argv merely ends in
// the turn's dir and mentions turn-wrapper elsewhere (a podman exec, conmon) is not the wrapper.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { wrapperInProc } from '../src/runner.ts';
import { until } from './wait.ts';

const root = mkdtempSync(join(tmpdir(), 'wrapper-argv-'));
const kids: ChildProcess[] = [];
after(() => {
  kids.forEach((k) => k.kill('SIGKILL'));
  rmSync(root, { recursive: true, force: true });
});

const pin = join(root, 'pin');
mkdirSync(pin);
writeFileSync(join(pin, 'turn-wrapper.mjs'), 'setTimeout(() => {}, 60000);\n');

/** A real process with exactly this argv after node (so /proc/<pid>/cmdline is what a wrapper's or an exec's is). */
async function proc(...args: string[]) {
  const k = spawn(process.execPath, args, { stdio: 'ignore' });
  kids.push(k);
  await until('its cmdline', () => readFileSync(`/proc/${k.pid}/cmdline`, 'utf8').includes(args.at(-1)!));
}

test("a process whose argv ends in the turn's dir but isn't `<script>/turn-wrapper <dir>` is not the wrapper; the real shape is", async () => {
  const dir = join(root, 'turn-a');
  mkdirSync(dir);
  await proc(join(pin, 'turn-wrapper.mjs'), '--flag', dir);
  assert.equal(wrapperInProc(dir), false, 'a flag between the script and the dir is not the wrapper');
  await proc(join(pin, 'turn-wrapper.mjs'), dir);
  assert.equal(wrapperInProc(dir), true, 'node <pin>/turn-wrapper.mjs <dir> is');
});
