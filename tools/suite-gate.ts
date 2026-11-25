// Loaded first in every test file of a full suite that has a window (tools/suite-runner.ts, #1871): the file waits here
// until the runner lets it in, which is at once unless other suites run on the machine. A file on the runner's late list
// (#1898) waits for the main wave to end whatever the gate says. The folder's files are the runner's.
// Node builtins only, and the variable is taken out again, so nothing a test starts waits here.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';

const dir = process.env.CITADEL_SUITE_GATE;
delete process.env.CITADEL_SUITE_GATE;
if (dir && isMainThread) {
  const open = join(dir, 'open');
  const run = join(dir, `${process.pid}.run`);
  const runner = process.ppid;
  try {
    const late = readFileSync(join(dir, 'late'), 'utf8').split('\n').includes(process.argv[1]);
    const wait = join(dir, `${process.pid}.${late ? 'late' : 'wait'}`);
    const letIn = () => existsSync(run) || (!late && existsSync(open));
    writeFileSync(letIn() ? run : wait, '');
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!letIn() && process.ppid === runner) Atomics.wait(cell, 0, 0, 50);
    if (process.ppid !== runner) process.exit(1); // the runner was killed: no file starts without it
    if (!existsSync(run)) renameSync(wait, run);
  } catch {
    // A gate that can't be read or written holds nothing back.
  }
}
