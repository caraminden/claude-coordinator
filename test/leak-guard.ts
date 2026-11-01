// npm test's global setup: fail the run if it leaves processes behind, such as a fake claude whose
// turn outlived its test (#271). It names and kills this user's processes that started during the run
// and still name a path in the temp folder.
import { tmpdir } from 'node:os';
import { procsUnder } from './helpers.ts';

const scratch = () => procsUnder([tmpdir()]);
let before = new Set<number>();

export async function globalSetup() {
  before = new Set(scratch().keys());
}

export async function globalTeardown() {
  let left: [number, string][] = [];
  // A process a test has just stopped may take a moment to go.
  for (let i = 0; i < 40; i++) {
    left = [...scratch()].filter(([pid]) => !before.has(pid));
    if (!left.length) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const [pid] of left) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  // node --test fails the run on a throw here but prints nothing, so say what it is first.
  const msg = `The tests left ${left.length} process(es) running (now killed). Stop what a test starts before deleting its folder (test/helpers.ts stopProcs, stopTurns):\n${left.map(([pid, cmd]) => `  ${pid} ${cmd.slice(0, 300)}`).join('\n')}`;
  console.error(`\n${msg}`);
  throw new Error(msg);
}
