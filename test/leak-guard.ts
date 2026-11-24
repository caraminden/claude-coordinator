// The global setup of npm test and of tools/run-tests.sh's full run: each test file counts what it leaves behind
// (test/leak-file.ts, #1763), and the run fails if it leaves processes behind, such as a fake claude whose
// turn outlived its test (#271). It names and kills this user's processes that started during the run
// and name a test's scratch folder that is gone, and are the run's own (descended from it, or orphaned by it): on a shared /tmp,
// another run's or build's live work is left alone (#1223).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { IMPORT_FLAG, PARENT_ENV, procsUnder } from './leak-file.ts';

const tmp = tmpdir();
const scratch = () => procsUnder([tmp]);
/** A command line names a path under the temp folder whose top folder has been deleted. */
const orphaned = (cmd: string) => cmd.split(' ').some((a) => a.startsWith(`${tmp}/`) && !existsSync(join(tmp, a.slice(tmp.length + 1).split('/')[0])));
/** [ppid, comm] of a live process, or undefined when it is gone. */
function parentOf(pid: number): [number, string] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const open = stat.indexOf('(');
    const close = stat.lastIndexOf(')');
    return [Number(stat.slice(close + 2).split(' ')[1]), stat.slice(open + 1, close)];
  } catch {}
}
const ENV = 'CITADEL_LEAK_RUN';
let runId = '';
/** Whether the process's environment holds this run's id. Unreadable counts as no. */
function carriesId(pid: number, id: string): boolean {
  if (!id) return false;
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`${ENV}=${id}`);
  } catch {
    return false;
  }
}
/**
 * Whether a process is this run's own: a descendant of `root` (the runner), or one whose parent has gone and left it to init or
 * systemd (a detached fake claude outliving its server, #271). Another run's or build's live process has a parent of its own
 * outside this run and is left alone, even if its command line names a temp folder this run can't see. A leftover with no parent
 * counts only if its environment carries this run's id (globalSetup puts one in process.env, so everything the run spawns
 * inherits it): two runs on one box each own only their own orphans.
 */
export function ownedByRun(pid: number, root = process.pid, id = runId): boolean {
  let cur = pid;
  for (let i = 0; i < 64; i++) {
    const p = parentOf(cur);
    if (!p) return false;
    const [ppid] = p;
    if (ppid === root) return true;
    if (ppid <= 1) return cur === pid && carriesId(pid, id); // reparented to init: ours only if it is the leftover itself and has our id
    if (cur === pid) {
      const parent = parentOf(ppid);
      if (parent && /^(systemd|init)$/.test(parent[1])) return carriesId(pid, id);
    }
    cur = ppid;
  }
  return false;
}
let before = new Set<number>();
let sharedScratch = '';

export async function globalSetup() {
  runId = randomUUID();
  process.env[ENV] = runId;
  // #1623: a run started from a minion's turn or a land holds the scheme's real shared folder, and every land.sh, run-tests.sh
  // or deploy.sh a test starts would write its retro-log lines (`shipped through main's red · ticket/1-x …`) into the live
  // log. Every test process inherits this scratch folder instead; a test that wants a folder of its own sets it itself.
  if (process.env.COORDINATOR_SHARED_DIR) process.env.COORDINATOR_SHARED_DIR = sharedScratch = mkdtempSync(join(tmp, 'test-shared-'));
  before = new Set(scratch().keys());
  // Each test file counts what it leaves behind (#1763, test/leak-file.ts): node --test starts every file with this
  // environment, so the file's process loads the counter first and knows itself by its parent, this runner.
  process.env[PARENT_ENV] = String(process.pid);
  if (!process.env.NODE_OPTIONS?.includes(IMPORT_FLAG)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${IMPORT_FLAG}`.trim();
}

// Nothing awaited: under --test-force-exit (tools/run-tests.sh) node exits at this function's first await, before
// anything is killed or thrown, and takes a throw for green unless the exit code is set too.
export function globalTeardown() {
  if (sharedScratch) rmSync(sharedScratch, { recursive: true, force: true });
  let left: [number, string][] = [];
  // A process a test has just stopped may take a moment to go.
  for (let i = 0; i < 40; i++) {
    left = [...scratch()].filter(([pid, cmd]) => !before.has(pid) && orphaned(cmd) && ownedByRun(pid));
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
