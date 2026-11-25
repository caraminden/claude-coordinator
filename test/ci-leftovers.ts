// What a CI job leaves running when nothing inside it got to clean up (#1900): a job that was cancelled, killed or stopped at
// its limit. GitHub's runner kills what carries its tracking id once, at the job's end; a turn's supervisor runs in a user
// unit with an environment of its own, so it never did, and about 200 processes had piled up on the desktop's runner user.
//   node test/ci-leftovers.ts start   a job's early step: gives the job a temp folder of its own, kept per runner, and stops
//                                     what earlier jobs left (tests.yml, flake-proof.yml, citadel-heavy.yml)
//   node test/ci-leftovers.ts end     its last step, however the job went: stops what this job left
// Two to four jobs run at once as this one user, and a live job's processes are never touched. Only these count:
//   1. this runner's own: naming (or with TMPDIR in) its temp folder, or naming its RUNNER_TEMP. A runner runs one job at a
//      time, so at the start they are a finished job's, and at the end this one's.
//   2. any runner's: an orphan (its parent is init or the user's systemd) naming a scratch folder (/tmp/<name>-XXXXXX) and
//      started before every live job (Runner.Worker), so no live job started it.
// and what they started; never a live job's own process tree. Outside a job it does nothing.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readProcs, stopAll, type Proc } from './leak-file.ts';

export interface Job {
  /** The runner's temp folder for its jobs, and the runner's own RUNNER_TEMP. */
  own: string[];
  /** Where rule 2's scratch folders are. */
  tmp?: string;
  /** The command name of a live job's process. */
  worker?: string;
  self?: number;
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
const read = (pid: number, what: string) => {
  try {
    return readFileSync(`/proc/${pid}/${what}`, 'utf8');
  } catch {
    return '';
  }
};
const comm = (pid: number) => read(pid, 'comm').trim();
/** Clock ticks since boot. */
const started = (pid: number) => {
  const stat = read(pid, 'stat');
  return stat ? Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]) : Infinity;
};

/** The leftover processes, as the header says; none when this process is in no job. */
export function ciLeftovers({ own, tmp = '/tmp', worker = 'Runner.Worker', self = process.pid }: Job): Proc[] {
  const all = readProcs();
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const ancestors = (pid: number) => {
    const out: number[] = [];
    for (let cur = byPid.get(pid)?.ppid; cur !== undefined && cur > 1 && out.length < 64; cur = byPid.get(cur)?.ppid) out.push(cur);
    return out;
  };
  const workers = new Set(all.filter((p) => comm(p.pid) === worker).map((p) => p.pid));
  const mine = ancestors(self);
  const job = mine.find((pid) => workers.has(pid));
  if (!job) return [];
  // Never: this process and what it runs under, a live job and what it runs under, and what another live job runs.
  const keep = new Set([self, ...mine, ...workers, ...[...workers].flatMap(ancestors)]);
  for (const p of all) if (ancestors(p.pid).some((a) => a !== job && workers.has(a))) keep.add(p.pid);

  const oldest = Math.min(...[...workers].map(started));
  const scratch = (a: string) => a.startsWith(`${tmp}/`) && /^[\w.-]+-[A-Za-z0-9]{6}$/.test(a.slice(tmp.length + 1).split('/')[0]);
  const orphan = (p: Proc) => p.ppid === 1 || comm(p.ppid) === 'systemd';
  const tmpdirOf = (pid: number) =>
    read(pid, 'environ')
      .split('\0')
      .find((v) => v.startsWith('TMPDIR='))
      ?.slice(7) ?? '';
  const matched = new Set(
    all
      .filter((p) => !keep.has(p.pid))
      .filter((p) => own.some((d) => p.args.some((a) => inside(a, d)) || inside(tmpdirOf(p.pid), d)) || (orphan(p) && p.args.some(scratch) && started(p.pid) < oldest))
      .map((p) => p.pid),
  );
  return all.filter((p) => !keep.has(p.pid) && (matched.has(p.pid) || ancestors(p.pid).some((a) => matched.has(a))));
}

/** Stop them, and print each. Returns those that would not go. */
export function sweep(job: Job, say = console.log): number[] {
  const seen = new Map<number, string>();
  const left = stopAll(() => {
    const found = ciLeftovers(job);
    for (const p of found) seen.set(p.pid, p.args.join(' '));
    return found.map((p) => p.pid);
  });
  say(`${seen.size} leftover process(es) stopped${left.length ? `, ${left.length} would not go: ${left.join(' ')}` : ''}`);
  for (const [pid, cmd] of seen) say(`  ${pid} ${cmd.slice(0, 200)}`);
  return left;
}

/** Short, as a test's sockets have 108 characters for their whole path. */
export const jobTmp = (runnerTemp: string) => `/tmp/j-${createHash('sha256').update(runnerTemp).digest('hex').slice(0, 6)}`;

function main(mode: string) {
  const { RUNNER_TEMP, GITHUB_ENV } = process.env;
  if (!RUNNER_TEMP || !GITHUB_ENV) return console.log('not in a CI job: nothing to do');
  const dir = jobTmp(RUNNER_TEMP);
  sweep({ own: [dir, RUNNER_TEMP] });
  // Emptied, not removed: the job's last steps still have it as TMPDIR.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const e of readdirSync(dir)) {
    try {
      rmSync(join(dir, e), { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.log(`could not remove ${e}: ${(err as Error).message}`);
    }
  }
  if (mode === 'start') appendFileSync(GITHUB_ENV, `TMPDIR=${dir}\n`);
}

if (import.meta.main) main(process.argv[2] ?? '');
