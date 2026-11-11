// The global setup of npm test and of tools/run-tests.sh's full run: fail the run if it leaves processes behind, such as a fake claude whose
// turn outlived its test (#271). It names and kills this user's processes that started during the run
// and name a test's scratch folder that is gone: on a shared /tmp, another run's live work still has its own.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { procsUnder } from './helpers.ts';

const tmp = tmpdir();
const scratch = () => procsUnder([tmp]);
/** A command line names a path under the temp folder whose top folder has been deleted. */
const orphaned = (cmd: string) => cmd.split(' ').some((a) => a.startsWith(`${tmp}/`) && !existsSync(join(tmp, a.slice(tmp.length + 1).split('/')[0])));
let before = new Set<number>();

export async function globalSetup() {
  before = new Set(scratch().keys());
}

// Nothing awaited: under --test-force-exit (tools/run-tests.sh) node exits at this function's first await, before
// anything is killed or thrown, and takes a throw for green unless the exit code is set too.
export function globalTeardown() {
  let left: [number, string][] = [];
  // A process a test has just stopped may take a moment to go.
  for (let i = 0; i < 40; i++) {
    left = [...scratch()].filter(([pid, cmd]) => !before.has(pid) && orphaned(cmd));
    if (!left.length) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  for (const [pid] of left) {
    try {
      process.kill(-pid, 'SIGKILL'); // a fake claude may lead a group with children of its own
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  // node --test fails the run on a throw here but prints nothing, so say what it is first.
  const msg = `The tests left ${left.length} process(es) running (now killed). Stop what a test starts before deleting its folder (test/helpers.ts stopProcs, stopTurns):\n${left.map(([pid, cmd]) => `  ${pid} ${cmd.slice(0, 300)}`).join('\n')}`;
  console.error(`\n${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
