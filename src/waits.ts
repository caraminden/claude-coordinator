// What a minion waits on (#544): its place in the land line and that landing's phase, a heavy slot, or
// the idle restart. One shape for every kind, read from what's already on disk or in the server: the
// land line's ticket files (tools/deploy-queue.sh), citadel-heavy's slot and waiter files, and the ship
// line's "deploying" stage. CI runs (#546, src/ci-wait.ts) fill the same record: a PR's run, and a landing's CI gate;
// a test run's file counts (#545, tools/progress-reporter.ts) fill in done and total.
import { readTail } from './wait-tail.ts';
import { median as statsMedian } from './stats.ts';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat as statFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './db.ts';
import type { Ship } from './branch.ts';
import type { CiRuns } from './ci-wait.ts';
import type { LandSeen } from './ci-health.ts';
import { frozenCgroup, frozenCached, frozenChip, frozenWords, noteFrozen, type Frozen } from './frozen-ships.ts';

export interface Wait {
  /** Its source: land (the land line and its landing), heavy (a heavy slot), ci (a PR's CI run), restart. */
  kind: string;
  /** Where it is: a landing's stage (line, rebase, test, deploy, restart) or a lone wait's own (slot, run; CI's queued, jobs, passed, failed, cancelled). */
  stage: string;
  /** The stage's name as the page says it when it is finer than the track's: "Boot check", "CI · started early". */
  label?: string;
  /** The row's badge, as short as it gets: "line · 2nd". */
  chip: string;
  /** The readout's detail: "2nd in line, behind #513 (testing)". */
  text: string;
  /** A shorter detail for the one-line readout and the list row, when the text runs long: "CI: the full suite" (#630). */
  brief?: string;
  /** When this stage began, ms. */
  since: number;
  /** About how long it takes, s: the median of its last five, or an estimate; null when nothing is known. */
  usual: number | null;
  done?: number;
  total?: number;
  /** A landing's ship train: its front ("front", with how many ride), a rider, or a waiter's train as it reads ("Releasing next"). */
  train?: { role: 'front' | 'rider' | 'waiting'; label: string; size?: number; front?: string; members?: string[] };
  /** A landing's CI test files failed so far (POST /api/ci-tests, #1368). */
  failed?: string[];
  /** Its process is in a frozen cgroup (#1881): the line says so in place of "waiting". */
  frozen?: Frozen;
  /** When it ended, ms: a CI run's pass or fail, shown a while after; its time stops there. */
  ended?: number;
  /** A waiting ship's early test (#1905): the run land.sh started on its stacked train while the ship ahead is tested. */
  early?: EarlyTest;
}

/** Where a waiting ship's early test stands: running, passed (and waiting for the ship ahead), failed, or thrown away. */
export interface EarlyTest {
  state: 'running' | 'passed' | 'failed' | 'dropped';
  /** The short words for a row: "Testing early · 12/40 files". */
  brief: string;
  /** The whole sentence for a readout. */
  text: string;
  done?: number;
  total?: number;
  failed?: string[];
}

/** A landing's stages, in order: a wait at one of these shows the track. */
export const TRACK = ['line', 'rebase', 'test', 'deploy', 'restart', 'live'];
const TYPICAL_LANDING = 300; // tools/deploy-queue.sh's QUEUE_TYPICAL, until landings have been timed

/** The median in whole seconds (an even list's middle pair is rounded); null when empty. */
export const median = (xs: number[]): number | null => {
  const m = statsMedian(xs);
  return m === null ? null : Math.round(m);
};

export const ordinal = (n: number) => (n === 1 ? 'next' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
const read = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const stat = (f: string) => {
  try {
    return statSync(f);
  } catch {
    return null;
  }
};
const mtime = (f: string) => stat(f)?.mtimeMs ?? null;
/** A process's /proc stat line: kernel memory, no disk, so it stays on the thread (#1980). */
const procStat = (pid: string) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
};
const files = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
// The same reads off the server's thread, for the poll that runs every 2 s (#1807): a blocking call waited up to 0.7 s on a busy disk.
const readA = async (f: string) => {
  try {
    return await readFile(f, 'utf8');
  } catch {
    return null;
  }
};
const statA = async (f: string) => {
  try {
    return await statFile(f);
  } catch {
    return null;
  }
};
const mtimeA = async (f: string) => (await statA(f))?.mtimeMs ?? null;
const filesA = async (dir: string) => {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
};

/** A line ticket's minion by its label: a branch, or "<scheme> #N" (a ship from another scheme's line). */
export function labelTicket(store: Store, label: string) {
  let t = label.includes('/') && label !== 'tools/deploy.sh' ? store.ticketByBranch(label) : undefined;
  const m = !t && label.match(/^(.+?) #(\d+)(?: \(.*\))?$/);
  if (m) {
    const p = store.listProjects().find((x) => x.name === m[1]);
    t = p && store.getTicketByNumber(p.id, Number(m[2]));
  }
  return t;
}

/** "<pid> <start time>" as tools/deploy-queue.sh's queue_proc writes it, when that process still runs. */
export function procAlive(pidStart: string): boolean {
  const [pid, start] = pidStart.split(' ');
  if (!/^\d+$/.test(pid ?? '')) return false;
  const stat = procStat(pid);
  if (!stat) return false;
  const f = stat.slice(stat.lastIndexOf(') ') + 2).split(' '); // the command's name may hold spaces
  return !/^[ZXx]$/.test(f[0]) && f[19] === start;
}

/** A test run's files done, of how many, and the newest one running (tools/progress-reporter.ts). */
/** `failed`: files failed so far; `rerun`: the counts are the failed files' reruns, each alone. */
export interface TestCounts {
  done: number;
  total: number;
  file: string;
  failed?: string[];
  rerun?: boolean;
}

/** The counts in a progress file written since `since` (ms): an older one is a run before this one. */
export function readTestCounts(f: string, since: number): TestCounts | null {
  return countsFrom(mtime(f), read(f), since);
}
async function readTestCountsA(f: string, since: number): Promise<TestCounts | null> {
  return countsFrom(await mtimeA(f), await readA(f), since);
}
function countsFrom(at: number | null, text: string | null, since: number): TestCounts | null {
  if (at == null || at < since || text == null) return null;
  // The 4th line: files failed so far, tab-separated; the 5th: rerun while run-tests.sh reruns them alone (#1368).
  const [done, total, file = '', failed = '', phase = ''] = text.split('\n');
  return testCounts(done, total, file, failed.split('\t').filter(Boolean), phase || 'suite');
}

/** Counts as they came (a progress file's lines, or a CI job's POST /api/ci-tests): whole numbers, done of a total. */
export function testCounts(done: unknown, total: unknown, file: unknown = '', failed: unknown = [], phase: unknown = 'suite'): TestCounts | null {
  const ok = (n: unknown) => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) || (typeof n === 'string' && /^\d{1,9}$/.test(n));
  if (!ok(done) || !ok(total) || typeof file !== 'string') return null;
  if (!Array.isArray(failed) || failed.some((f) => typeof f !== 'string') || (phase !== 'suite' && phase !== 'rerun')) return null;
  const d = Number(done),
    t = Number(total);
  if (!(t > 0 && d <= t)) return null;
  const c: TestCounts = { done: d, total: t, file: file.slice(0, 200) };
  if (failed.length) c.failed = failed.slice(0, 20).map((f: string) => f.slice(0, 200));
  if (phase === 'rerun') c.rerun = true;
  return c;
}

const countsText = (c: TestCounts) => `${c.done} of ${c.total} ${c.rerun ? 'failed files rerun alone' : 'files'}${c.file ? ` · ${c.file}` : ''}`;

/**
 * `orders`: its landing follows queue/.order (deploy-queue.sh's 5th ticket line, #1002); one from an older branch doesn't.
 * `holds`: a Regenerate ship that holds the line (#1827: deploy-queue.sh's 6th line "hold", the kit's 9th): the first waiter, whatever .order says,
 * except a ship a person placed (.order's "#pin" line) stays ahead of it (Cara, 2026-11-24, "Person's drag wins").
 */
export interface LandTicket {
  seq: number;
  proc: string;
  got: number;
  label: string;
  phase: string;
  mtime: number;
  orders?: boolean;
  holds?: boolean;
  tests?: TestCounts | null;
  /** Its process sits in a frozen cgroup (#1881). */
  frozen?: Frozen;
}

/** The waiting tickets' numbers in the order people set on the Releases page (#1002): queue/.order, as deploy-queue.sh reads it. */
const orderFrom = (text: string | null) =>
  (text ?? '')
    .split('\n')
    .filter((l) => /^\d{10}$/.test(l))
    .map(Number);
/** The ships a person placed (#1827, "Person's drag wins"): .order's "#pin <seq> ..." line. A holding ship goes behind the last of them still waiting. */
const pinsFrom = (text: string | null) =>
  (text ?? '')
    .split('\n')
    .filter((l) => l.startsWith('#pin '))
    .flatMap((l) => l.slice(5).split(' '))
    .filter((n) => /^\d+$/.test(n))
    .map(Number);
const tookFrom = (text: string | null) =>
  (text ?? '')
    .split('\n')
    .filter((l) => /^\d+$/.test(l))
    .map(Number);

/**
 * The land line in order, its gone processes left out, and the last landings' lengths in s: the holder first, then the
 * waiters .order names in its order, then the rest in arrival order, a waiter from before .order keeping everyone who
 * arrived after it behind it (tools/deploy-queue.sh's queue_lock). The holder running
 * the tests gets tools/run-tests.sh's counts: land.sh's run logs to land-test.log, deploy.sh's to test.log.
 */
export function readLandLine(stateDir: string, alive = procAlive): { line: LandTicket[]; took: number[] } {
  const q = join(stateDir, 'queue');
  const line = readQueue(q, 4, alive);
  for (const t of line) for (const log of testsLogs(t)) if ((t.tests = readTestCounts(join(stateDir, `${log}.progress`), t.mtime))) break;
  return { line, took: tookFrom(read(join(q, '.took'))) };
}

/** readLandLine with every file read off the server's thread (#1807). */
export async function readLandLineA(stateDir: string, alive = procAlive): Promise<{ line: LandTicket[]; took: number[] }> {
  const q = join(stateDir, 'queue');
  const [line, took] = await Promise.all([readQueueA(q, 4, alive), readA(join(q, '.took'))]);
  await Promise.all(
    line.map(async (t) => {
      for (const log of testsLogs(t)) if ((t.tests = await readTestCountsA(join(stateDir, `${log}.progress`), t.mtime))) break;
    }),
  );
  return { line, took: tookFrom(took) };
}

/** The progress files that may hold the holder's test counts, best first. run-tests.sh's reruns name no run in their phase; the full run's file went when it ended, so the one written since is theirs (#1368). */
function testsLogs(t: LandTicket): string[] {
  if (t.got <= 0) return [];
  if (/^running the tests/.test(t.phase)) return ['land-test'];
  if (/^deploying: running the tests/.test(t.phase)) return ['test'];
  return /^rerunning \d+ failed test file/.test(t.phase) ? ['land-test', 'test'] : [];
}

/**
 * A queue folder's tickets in line order, its gone processes left out: deploy-queue.sh's queue/ (the "order" line is
 * its 5th, `orderAt` 4) or the kit land template's <.git>/land-queue (its 8th, #1007). Both read .order the same way. The
 * core's tickets in deploy-queue.sh's queue/ (Citadel shipping on the core, #1323) keep theirs on the 8th line too.
 */
export function readQueue(q: string, orderAt: number, alive = procAlive): LandTicket[] {
  const tickets = files(q)
    .filter((n) => /^\d+$/.test(n))
    .sort()
    .map((name) => ({ name, text: read(join(q, name)), at: mtime(join(q, name)) }));
  const order = read(join(q, '.order'));
  const line = queueFrom(orderFrom(order), tickets, orderAt, alive, pinsFrom(order));
  for (const t of line) {
    const f = frozenCached(parseInt(t.proc));
    if (f) t.frozen = noteFrozen(t.label, f.cg);
  }
  return line;
}

/** readQueue with every file read off the server's thread (#1807). */
export async function readQueueA(q: string, orderAt: number, alive = procAlive): Promise<LandTicket[]> {
  const [order, names] = await Promise.all([readA(join(q, '.order')), filesA(q)]);
  const tickets = await Promise.all(
    names
      .filter((n) => /^\d+$/.test(n))
      .sort()
      .map(async (name) => ({ name, text: await readA(join(q, name)), at: await mtimeA(join(q, name)) })),
  );
  const line = queueFrom(orderFrom(order), tickets, orderAt, alive, pinsFrom(order));
  await Promise.all(
    line.map(async (t) => {
      const f = await frozenCgroup(parseInt(t.proc));
      if (f) t.frozen = noteFrozen(t.label, f.cg);
    }),
  );
  return line;
}

function queueFrom(order: number[], tickets: { name: string; text: string | null; at: number | null }[], orderAt: number, alive: (proc: string) => boolean, pins: number[] = []): LandTicket[] {
  const line: LandTicket[] = [];
  let lastPin = -1; // a holding ship goes right behind the last waiter a person placed, else first among the waiters
  // A waiter from before .order waits for every lower ticket, so nobody who arrived after it goes ahead (The Trans Agenda #76).
  const rank = (t: LandTicket) => (t.got > 0 ? -1 : t.holds ? lastPin + 0.5 : !t.orders ? order.length + 1 : order.includes(t.seq) ? order.indexOf(t.seq) : order.length);
  for (const { name, text, at } of tickets) {
    if (text == null || at == null) continue;
    const l = text.split('\n');
    const [proc = '', got = '0', label = '', phase = ''] = l;
    if (!alive(proc)) continue;
    line.push({ seq: Number(name), proc, got: Number(got) || 0, label, phase, mtime: at, orders: l[orderAt] === 'order' || l[7] === 'order', ...((l[5] === 'hold' || l[8] === 'hold') && { holds: true }) });
  }
  for (const t of line) if (t.got === 0 && t.orders && pins.includes(t.seq)) lastPin = Math.max(lastPin, order.indexOf(t.seq));
  const old = line.filter((t) => t.got === 0 && !t.orders).map((t) => t.seq);
  const before = (t: LandTicket) => (t.got > 0 ? -1 : old.filter((s) => s < t.seq).length);
  return line.sort((a, b) => before(a) - before(b) || rank(a) - rank(b) || a.seq - b.seq);
}

/**
 * A waiter that arrived after one from before .order, which waits for every lower ticket. It stays unranked: a land
 * script that ranks .order's waiters ahead of the rest (each copy from before #1020) would count it ahead of that one,
 * while one from after #1020 counts it behind, and the two would take the lock together or wait on each other.
 */
export const behindOld = (line: LandTicket[], t: LandTicket) => line.some((o) => o.got === 0 && !o.orders && o.seq < t.seq);

/**
 * Write a queue's .order (#1002, #1007): `seqs` first, the waiters it leaves out behind them in the line's order (or,
 * given `moved`, only that one moves, to where `seqs` puts it: moveIn); a
 * holder, a ticket no longer waiting or one from an older branch is left out (an older one waits for every lower
 * ticket, so ranking it ahead of one could deadlock), and so is one behind such a one (behindOld). `note` says who moved
 * what, for the waiters' output. Returns the order written. `at` as a function reads the line: it is read again when
 * deploy-queue.sh rewrote .order meanwhile (a ship back in line for its retry), so that ship keeps its place (#2132).
 */
export function writeOrder(q: string, at: LandTicket[] | (() => LandTicket[]), seqs: number[], note: string | ((order: number[]) => string), moved?: number, pins: number[] = []): number[] {
  const f = join(q, '.order'),
    tmp = `${f}.tmp${process.pid}`;
  for (let tries = 1; ; tries++) {
    const was = read(f) ?? '',
      line = typeof at === 'function' ? at() : at;
    const waiting = line.filter((t) => t.got === 0 && t.orders && !behindOld(line, t)).map((t) => t.seq);
    const order = moved != null && waiting.includes(moved) ? moveIn(waiting, seqs, moved) : [...new Set([...seqs.filter((n) => waiting.includes(n)), ...waiting])];
    if (!order.length) throw new Error('Nothing is waiting in line to reorder');
    // By a rename, as the queue scripts write their tickets, so a waiter never reads half of it.
    writeFileSync(tmp, `# ${(typeof note === 'string' ? note : note(order)).replace(/[\x00-\x1f]+/g, ' ')}\n${order.map((n) => String(n).padStart(10, '0')).join('\n')}\n${pins.length ? `#pin ${pins.join(' ')}\n` : ''}`);
    // Renamed under the lock deploy-queue.sh's queue_front rewrites .order under, and only over what was read above.
    try {
      execFileSync('flock', ['-w', '2', join(q, '.order.lock'), 'sh', '-c', '[ "$(cat "$2" 2>/dev/null)" = "$(printf %s "$3")" ] || exit 75; mv -f "$1" "$2"', 'sh', tmp, f, was]);
      return order;
    } catch (e) {
      if ((e as { status?: number }).status !== 75 || tries === 3) throw new Error("Couldn't write the line's order, so nothing moved: try again", { cause: e });
    }
  }
}

/**
 * `moved` placed in the whole line as `seqs` (a target's part of it, #1007) places it, the rest kept where they were:
 * at the front when it's first there, else just ahead of the one it now goes before (or behind the one it goes after,
 * or where it was when neither still waits).
 */
export function moveIn(line: number[], seqs: number[], moved: number): number[] {
  const rest = line.filter((n) => n !== moved),
    at = seqs.indexOf(moved);
  const after = seqs.slice(at + 1).find((n) => rest.includes(n));
  const before = seqs
    .slice(0, Math.max(at, 0))
    .reverse()
    .find((n) => rest.includes(n));
  const i = at <= 0 ? 0 : after != null ? rest.indexOf(after) : before != null ? rest.indexOf(before) + 1 : line.indexOf(moved);
  return [...rest.slice(0, i), moved, ...rest.slice(i)];
}

/**
 * A landing's phase (queue_phase's words in land.sh and deploy.sh) as its stage, badge word, detail and `label`: the
 * name the Releases page shows for it. `key` still groups the usual times, so a start or boot check counts in the
 * rebase's span as before. Only a rebase reads "Rebase" (#1566): every other phase land.sh writes has its own words.
 */
export function landPhase(phase: string): { stage: string; word: string; key: string; text: string; label: string } {
  const p = phase.replace(/ since \d\d:\d\d$/, '');
  // CI gave no answer and perigee is too busy for the suite (#1254): it asks CI again until one of them is free.
  if (/^waiting for CI or a quiet perigee/.test(p)) return { stage: 'test', word: 'CI', key: 'ci', text: p, label: 'CI' };
  if (/^waiting for CI's reruns alone/.test(p)) return { stage: 'test', word: 'CI', key: 'ci', text: "CI's full run ended red: waiting for its reruns of the failed files alone", label: 'CI' };
  if (/^waiting for CI/.test(p)) return { stage: 'test', word: 'CI', key: 'ci', text: 'waiting for CI on the rebased commit', label: 'CI' };
  // land.sh runs the suite itself only when CI couldn't answer (its CI FALLBACK, #523).
  if (/^running the tests/.test(p)) return { stage: 'test', word: 'tests', key: 'tests', text: 'CI fell back: running the full suite on perigee', label: 'Tests on perigee' };
  // tools/run-tests.sh's reruns of the failed files, each alone (#553), on perigee: land.sh's run or deploy.sh's.
  if (/^rerunning \d+ failed test files?$/.test(p)) return { stage: 'test', word: 'reruns', key: 'reruns', text: 'rerunning the failed test files alone on perigee', label: 'Reruns' };
  // The red train's bisect: its trial runs (#1366) and its search.
  if (/^(finding the ship that turned the train red|testing the train again without its likely causes)/.test(p))
    return { stage: 'test', word: 'bisect', key: 'bisect', text: p === 'finding the ship that turned the train red' ? 'the train went red in CI: finding the ship that turned it red' : 'the train went red in CI: testing it again without its likely causes', label: 'Bisect' };
  // Its long steps' own phases (#1864), a ", 5 min so far" on them once one takes a while.
  if (/^running the red tests alone/.test(p)) return { stage: 'test', word: 'bisect', key: 'bisect', text: `the train went red in CI: ${p}`, label: 'Bisect' };
  if (/^running the guard tests/.test(p)) return { stage: 'test', word: 'check', key: 'check', text: p, label: 'Check' };
  // The kit core's own phases (Citadel on the core, #1323): its check, CI on a batch, and a member waiting on its head's deploy.
  if (/^(running the check|waiting to run the check|running the guards|running land_preflight)/.test(p)) return { stage: 'test', word: 'check', key: 'check', text: p, label: 'Check' };
  if (/^(CI is red|CI passed|checked \S+: CI runs on its batch's top)/.test(p)) return { stage: 'test', word: 'CI', key: 'ci', text: p, label: 'CI' };
  if (/^running land_fallback/.test(p)) return { stage: 'test', word: 'tests', key: 'tests', text: 'CI gave no answer: running the full suite on perigee', label: 'Tests on perigee' };
  if (/^waiting for its batch's deploy/.test(p)) return { stage: 'deploy', word: 'deploy', key: 'deploy', text: p, label: 'Deploy' };
  if (/^deploying/.test(p)) return { stage: 'deploy', word: 'deploy', key: 'deploy', text: p.replace(/^deploying(: )?/, '') || 'deploying', label: 'Deploy' };
  // Before the rebase: the boot check main's refusing deploys earn before a CI run is spent (#1012), and the moment after the lock.
  if (/^boot check before CI/.test(p)) return { stage: 'rebase', word: 'boot check', key: 'rebase', text: "boot check before CI: deploy has been refusing, so main's own check runs first", label: 'Boot check' };
  if (/^(rebasing|merging main)/.test(p)) return { stage: 'rebase', word: 'rebase', key: 'rebase', text: 'rebasing onto main', label: 'Rebase' };
  return { stage: 'rebase', word: 'starting', key: 'rebase', text: 'starting', label: 'Starting' };
}

/** A waiter's phase while main fails its boot check (#1564): it holds, up to 8 h, and never rides a train. "held: main is broken (12 min)". */
export const heldOf = (phase: string): string | null => (/^held: main is broken/.test(phase) ? phase.replace(/ since \d\d:\d\d$/, '') : null);

/** land.sh's `<cc-deploy>/early` (#1366): the next ship's stacked early run. `top` is the commit the run tests. */
export interface EarlyFile {
  top: string;
  /** The next ship's branch, the one whose train was stacked. */
  next: string;
  /** When it was pushed, s. */
  at: number;
  /** The branch whose train is being tested, ahead of it. */
  head: string;
}
export const parseEarly = (text: string | null): EarlyFile | null => {
  const [top, next, at, head] = (text ?? '').trim().split(/\s+/);
  return top && next && head && /^\d+$/.test(at ?? '') ? { top, next, at: Number(at), head } : null;
};
/** Early tests are off for every landing while `<cc-deploy>/early-off` exists (land.sh's early_next). */
export const readEarly = (stateDir: string): EarlyFile | null => (stat(join(stateDir, 'early-off')) ? null : parseEarly(read(join(stateDir, 'early'))));
export const readEarlyA = async (stateDir: string): Promise<EarlyFile | null> => ((await statA(join(stateDir, 'early-off'))) ? null : parseEarly(await readA(join(stateDir, 'early'))));

/** A waiting ship's early test as people read it, from its run's CI state (null: not found yet) and the ship ahead's name. */
export function earlyTest(ci: { stage: string; text: string; done?: number; total?: number; failed?: string[] } | null | undefined, ahead: string): EarlyTest {
  if (ci?.stage === 'passed' || ci?.stage === 'skipped') return { state: 'passed', brief: `Passed early · waits for ${ahead}`, text: `Early test passed: its train's CI already went green on GitHub while ${ahead} ahead of it ships, so it waits for ${ahead}` };
  if (ci?.stage === 'failed' || ci?.stage === 'cancelled') return { state: 'failed', brief: 'Early test failed', text: `Early test failed (${ci.text}): it tests again when its turn comes`, ...(ci.failed?.length && { failed: ci.failed }) };
  const c = ci?.total ? { done: ci.done, total: ci.total } : {};
  const files = ci?.total ? ` · ${ci.done}/${ci.total} files` : '',
    bad = ci?.failed?.length ? ` · ${ci.failed.length} failed` : '';
  const where = ci ? ci.text : 'its run is starting on GitHub';
  return { state: 'running', brief: `Testing early${files}${bad}`, text: `Testing early, while ${ahead} ahead of it ships: ${where}${ci?.failed?.length ? `; failed so far: ${ci.failed.join(', ')}` : ''}`, ...c, ...(ci?.failed?.length && { failed: ci.failed }) };
}

/** A waiting ship's wait with its early test on it: the chip, the row's words and the readout all say it. */
export function earlyWait(w: Wait, e: EarlyTest): Wait {
  const count = e.state === 'running' && e.total ? ` ${e.done}/${e.total}` : '';
  const word = e.state === 'running' ? `early${count}` : e.state === 'passed' ? 'passed early' : e.state === 'failed' ? 'early failed' : 'early dropped';
  return { ...w, early: e, chip: `${w.chip} · ${word}`, text: `${w.text}. ${e.text}`, brief: w.brief ? `${e.brief} · ${w.brief}` : e.brief };
}

/** A waiter's phase while it is off a red train on a guess (#1918, land.sh's train_verdict): whose train, and the failing tests. */
export const pulledOf = (phase: string): { front: string; tests: string } | null => {
  const m = /^pulled off (\S+)'s ship train on a guess, red in (.+?)(?: since \d\d:\d\d)?$/.exec(phase);
  return m && { front: m[1], tests: m[2] };
};

/** The Releases page's words for a holder's CI after an early run counted for it (land.sh's early_gate). */
export const EARLY_CI = { word: 'CI · early', label: 'CI · started early', text: "CI started early, during the train ahead's deploy: waiting for that run's result" };

// The one-line readout's words for a landing's test phases (#630): the stage and its count say the rest, and the
// suite's file counts fill its piece of the track.
const BRIEF: Record<string, string> = { ci: 'CI: waiting for a run or runner', tests: 'full suite on perigee', reruns: 'failed files rerun alone on perigee', bisect: 'bisecting the red train' };
const HEAD_WORD: Record<string, string> = { rebase: 'rebasing', check: 'running the check', ci: 'waiting for CI', tests: 'testing', reruns: 'rerunning failed tests', bisect: 'bisecting', deploy: 'deploying' };

/** A rider's queue phase (tools/land.sh's queue_phase while it rides): the branch of the front it rides with. A rider sent back reads "waiting" again. */
export const ridingOf = (phase: string): string | null => /^riding in (.+)'s ship train$/.exec(phase.replace(/ since \d\d:\d\d$/, ''))?.[1] ?? null;

/** Ships in one train: the front and up to LAND_TRAIN_MAX (6) behind it (tools/land.sh). Only used to say which later train a waiter is likely in. */
export const TRAIN_SHIPS = 7;

/** A waiter's train as people read it: the one forming is "Releasing next", the ones after say how many are ahead. */
export const trainLabel = (g: number) => (g === 0 ? 'Releasing next' : `Train ${g + 2}, after ${g + 1} ahead`);

/** Each land-line ticket's wait, by its label (a branch, or "tools/deploy.sh"). `name` turns a label into "#513". */
export function landWaits(line: LandTicket[], took: number[], now: number, usual: (key: string) => number | null, name: (label: string) => string, early: (label: string) => boolean = () => false): Map<string, Wait> {
  const out = new Map<string, Wait>();
  const typical = median(took) ?? TYPICAL_LANDING;
  const holder = line.find((t) => t.got > 0);
  // A train is its front (the holder) and the waiters whose phase says they ride with it; a rider of a front that is gone is a plain waiter.
  const riders = line.filter((t) => t.got === 0 && holder && ridingOf(t.phase) === holder.label);
  const members = holder ? [holder, ...riders].map((t) => name(t.label)) : [];
  const train = (role: 'front' | 'rider') => ({ role, label: 'Releasing now', size: members.length, members, front: holder ? name(holder.label) : undefined });
  let forming = 0; // waiters past the train, in line order: they fill the next trains
  line.forEach((t, i) => {
    if (t.got > 0) {
      const ph = landPhase(t.phase),
        c = t.tests,
        e = ph.key === 'ci' && early(t.label);
      const size = riders.length ? `Train of ${members.length} (${members.join(', ')}) · ` : '';
      const brief = e ? 'waiting for that run' : (BRIEF[ph.key] ?? (riders.length ? ph.text : undefined));
      out.set(t.label, {
        kind: 'land',
        stage: ph.stage,
        since: t.mtime,
        usual: usual(`land:${ph.key}`),
        label: e ? EARLY_CI.label : ph.label,
        chip: `ship · ${c ? `${c.done}/${c.total}` : e ? EARLY_CI.word : ph.word}`,
        text: `${size}${c ? `${ph.text}: ${countsText(c)}` : e ? EARLY_CI.text : ph.text}`,
        ...(brief && { brief: riders.length ? `train of ${members.length} · ${brief}` : brief }),
        ...(c && { done: c.done, total: c.total }),
        ...(c?.failed && { failed: c.failed }),
        ...(riders.length && { train: train('front') }),
      });
      return;
    }
    if (holder && riders.includes(t)) {
      const hp = landPhase(holder.phase);
      out.set(t.label, {
        kind: 'land',
        stage: hp.stage,
        label: hp.label,
        since: holder.mtime,
        usual: usual(`land:${hp.key}`),
        chip: 'ship · riding',
        text: `riding in ${name(holder.label)}'s train (${members.join(', ')}): ${hp.text}`,
        brief: `riding in ${name(holder.label)}'s train`,
        train: train('rider'),
      });
      return;
    }
    // A ship held while main fails its boot check (#1564): not next in line, in no train, so it fills no train's count.
    const held = heldOf(t.phase);
    if (held) {
      out.set(t.label, { kind: 'land', stage: 'line', label: 'Held', chip: 'line · held', text: `${held}: it waits until main passes its boot check again, and rides no train`, brief: held, since: t.mtime, usual: null, train: { role: 'waiting', label: 'Held' } });
      return;
    }
    // Pulled off a red train on a guess: it waits for the verdict on the train without it, and fills no train's count.
    const off = pulledOf(t.phase);
    if (off) {
      const text = `pulled off ${name(off.front)}'s train on a guess (${off.tests} failed): the train runs again without it, then it goes back in line`;
      out.set(t.label, { kind: 'land', stage: 'line', label: 'Pulled', chip: 'line · pulled', text, brief: `pulled off ${name(off.front)}'s train on a guess`, since: t.mtime, usual: null, train: { role: 'waiting', label: 'Pulled' } });
      return;
    }
    const ahead = line.slice(0, i).filter((a) => !riders.includes(a) && !heldOf(a.phase) && !pulledOf(a.phase));
    const place = ordinal(ahead.length + 1);
    const label = trainLabel(Math.floor(forming++ / TRAIN_SHIPS));
    let text: string,
      usualS: number | null = null;
    if (!ahead.length) {
      text = 'next in line, waiting for a queued restart or an older ship to let go of the lock';
    } else {
      const head = ahead[0],
        word = head.got > 0 ? HEAD_WORD[landPhase(head.phase).key] : 'waiting';
      text = `${place} in line, behind ${name(head.label)} (${word})${ahead.length > 1 ? ` and ${ahead.length - 1} more` : ''}`;
      // From when it joined: what was left of the holder's landing then, and a whole one for each other waiter
      // ahead. Fixed while the line stands, so a holder running long turns the bar amber.
      const joined = t.mtime / 1000;
      usualS = Math.round(ahead.reduce((s, a) => s + (a === holder ? Math.max(0, typical - Math.max(0, joined - a.got)) : typical), 0));
    }
    const shortLabel = label.replace(/^Releasing next$/, 'next train').replace(/^Train (\d+).*/, 'train $1');
    out.set(t.label, { kind: 'land', stage: 'line', chip: `line · ${shortLabel}`, text: `${label}: ${text}`, brief: label, since: t.mtime, usual: usualS, train: { role: 'waiting', label } });
  });
  for (const t of line) overlayFrozen(out.get(t.label), t.frozen);
  return out;
}

/** A frozen process's wait says so, in place of waiting or running (#1881): since when, and the command that thaws it; what it was doing follows. */
function overlayFrozen(w: Wait | undefined, f: Frozen | undefined) {
  if (!w || !f) return;
  w.frozen = f;
  w.chip = frozenChip(f);
  w.brief = w.chip;
  w.text = `${frozenWords(f)}. It was: ${w.text}`;
}

export interface HeavyJob {
  who: string;
  what: string;
  since: number;
  reason?: string;
  slot?: number;
  tests?: TestCounts | null;
  pid?: number;
  /** Its process sits in a frozen cgroup (#1881). */
  frozen?: Frozen;
}

/**
 * The inodes holding a flock(1) lock, from the kernel's list (/proc/locks: "1: FLOCK  ADVISORY  WRITE <pid> <maj>:<min>:<inode> 0 EOF");
 * a waiter's line ("1: -> FLOCK …") holds nothing. Null when there's no list to read. Read in the server, so the `waits` job
 * starts no process (#1562; it ran `flock -n` per held slot every 2 s). Only the inode is matched: btrfs names a
 * different device here than stat does, and a stale .who on a slot whose inode another filesystem has locked is all a clash costs.
 */
export function flockedInodes(text: string | null): Set<number> | null {
  if (text == null) return null;
  return new Set([...text.matchAll(/^\d+:\s+FLOCK\s+\S+\s+\S+\s+\S+\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/gm)].map((m) => Number(m[1])));
}

/** Whether a heavy slot's lock is held: a holder killed past its trap leaves its .who behind, but not the lock. */
export const heldIn = (locked: Set<number> | null, ino: number | undefined) => !locked || (ino !== undefined && locked.has(ino)); // no lock list at all: trust the file; no lock file: nobody holds its lock

/** heldIn for one look at the heavy folder, off the server's thread (#1807): the lock list is read once, and only if a slot has a .who. */
export function heldSlotsA(): (file: string) => Promise<boolean> {
  let locked: Promise<Set<number> | null> | undefined;
  return async (file) => heldIn(await (locked ??= readA('/proc/locks').then((t) => flockedInodes(t))), (await statA(file))?.ino);
}

const STALE_WAITER_MS = 60_000; // citadel-heavy freshens a waiter's file at least every 20 s

export type HeavyJobs = { holders: HeavyJob[]; waiters: HeavyJob[] };

/**
 * citadel-heavy's holders (slot-N.who: "who: what (since HH:MM, pid N)", while slot-N's lock is held) and
 * waiters (wait-<pid>-<random>: who, what, since s, reason; freshened while it waits). A holder running a Node test
 * suite gets its counts from slot-N.progress, which citadel-heavy has tools/citadel-node write.
 * Every file is read off the server's thread (#1807); `held` may answer later.
 */
export async function readHeavyA(dir: string, now = Date.now(), held: (slotFile: string) => boolean | Promise<boolean> = heldSlotsA()): Promise<HeavyJobs> {
  const holders: HeavyJob[] = [],
    waiters: HeavyJob[] = [];
  await Promise.all(
    (await filesA(dir)).map(async (name) => {
      const f = join(dir, name),
        m = name.match(/^slot-(\d+)\.who$/);
      if (m) {
        const [text, at] = await Promise.all([readA(f), mtimeA(f)]);
        const w = holderOf(text?.trim());
        if (w && at != null && (await held(join(dir, `slot-${m[1]}`)))) holders.push({ who: w[1], what: w[2], since: at, slot: Number(m[1]) + 1, pid: Number(w[3]), tests: await readTestCountsA(join(dir, `slot-${m[1]}.progress`), at) });
      } else if (/^wait-\d+-\d+$/.test(name) && now - ((await mtimeA(f)) ?? 0) < STALE_WAITER_MS) {
        const w = waiterOf(await readA(f));
        if (w) waiters.push({ ...w, pid: Number(name.split('-')[1]) });
      }
    }),
  );
  await Promise.all(
    [...holders, ...waiters].map(async (j) => {
      const f = j.pid ? await frozenCgroup(j.pid, 'citadel-heavy') : null;
      if (f) j.frozen = noteFrozen(j.who, f.cg);
    }),
  );
  holders.sort((a, b) => a.slot! - b.slot!); // reads finish in any order
  return { holders, waiters: waiters.sort((a, b) => a.since - b.since) };
}

/**
 * The heavy folder as the server's thread sees it (btrfs can hold a readdir for seconds): the last answer of a read made
 * off the thread, at most a refresh old. A failed read keeps the last answer; nothing here throws.
 */
export class HeavySnapshot {
  private last: HeavyJobs = { holders: [], waiters: [] };
  private reading: Promise<void> | null = null;
  private dir: string;
  private held?: (slotFile: string) => boolean | Promise<boolean>;
  constructor(dir: string, held?: (slotFile: string) => boolean | Promise<boolean>) {
    this.dir = dir;
    this.held = held;
  }
  get() {
    return this.last;
  }
  /** One read at a time: a call while one is under way waits for that one. */
  refresh(): Promise<void> {
    return (this.reading ??= readHeavyA(this.dir, Date.now(), this.held)
      .then((r) => {
        this.last = r;
      })
      .catch(() => {})
      .finally(() => {
        this.reading = null;
      }));
  }
}

const holderOf = (text: string | null | undefined) => text?.match(/^(.*?): (.*) \(since \d\d:\d\d, pid (\d+)\)$/);
function waiterOf(text: string | null): HeavyJob | null {
  const [who, what, since, reason] = (text ?? '').split('\n');
  return who && Number(since) ? { who, what, since: Number(since) * 1000, reason } : null;
}

/** Each heavy job's wait, by its who ("Citadel #544 (cara)"). */
export function heavyWaits({ holders, waiters }: HeavyJobs, usual: (key: string) => number | null, name: (who: string) => string): Map<string, Wait> {
  const out = new Map<string, Wait>();
  for (const h of holders) {
    const c = h.tests,
      text = `running in heavy slot ${h.slot}: ${h.what}`;
    out.set(h.who, {
      kind: 'heavy',
      stage: 'run',
      since: h.since,
      usual: usual(`heavy:run:${h.what}`),
      // Only a Node suite run through tools/citadel-node has counts; any other run shows elapsed against usual alone.
      chip: c ? `tests ${c.done}/${c.total}` : 'heavy run',
      text: c ? `${text}: ${countsText(c)}` : text,
      ...(c && { done: c.done, total: c.total }),
    });
  }
  // A nested Claude session tools/claude-pace holds while the box eases off memory (#1748): not in the heavy line.
  for (const w of waiters) {
    if (w.reason !== 'ease' || out.has(w.who)) continue;
    out.set(w.who, { kind: 'heavy', stage: 'slot', chip: 'session · easing off memory', text: 'a nested Claude session waits while Citadel eases off memory: about one starts a minute per turn, and the ones running carry on', since: w.since, usual: null });
  }
  waiters
    .filter((w) => w.reason !== 'ease')
    .forEach((w, i) => {
      const place = ordinal(i + 1);
      const busy = holders.map((h) => name(h.who)).join(', ');
      const text =
        w.reason === 'load'
          ? 'a heavy slot is free, but the box is busy: it starts when the load eases, or within 5 min'
          : w.reason === 'memory'
            ? 'a heavy slot is free, but memory is short: it starts when room frees up, or within 5 min, with fewer workers'
            : `${place} in line for a heavy slot${busy ? `, all held (${busy})` : ''}`;
      out.set(w.who, { kind: 'heavy', stage: 'slot', chip: w.reason === 'load' ? 'slot · busy box' : w.reason === 'memory' ? 'slot · short on memory' : `slot · ${place}`, text, since: w.since, usual: usual('heavy:slot') });
    });
  for (const j of [...holders, ...waiters]) overlayFrozen(out.get(j.who), j.frozen);
  return out;
}

type CiView = NonNullable<ReturnType<CiRuns['view']>>;

/** A landing waiting for CI, with the run's jobs and steps; its usual stays the landing's own. */
export function landCi(w: Wait, ci: CiView): Wait {
  // A rider's own CI run (if an old one lingers) is not its train's: it reads as the front's, riding.
  if (w.train?.role === 'rider') return w;
  const short = `CI ${ci.short.replace(/^step /, '')}`;
  const text = ci.stage === 'queued' ? `waiting for CI: ${ci.text}; if none starts it soon, the suite runs on perigee` : `waiting for CI: ${ci.text}`;
  // The line keeps one counter, the landing's stage (Cara: "are the tests on step 3/6 or 10/13?"): CI's steps fill its piece.
  const train = w.train?.role === 'front';
  return {
    ...w,
    chip: `ship · ${short}`,
    text: train ? `Train of ${w.train!.size} (${w.train!.members!.join(', ')}) · ${text}` : text,
    brief: `${train ? `train of ${w.train!.size} · ` : ''}CI: ${ci.step ?? ci.short}`,
    ...(ci.total ? { done: ci.done, total: ci.total } : {}),
    ...(ci.failed?.length ? { failed: ci.failed } : {}),
  };
}

/** A minion's PR waiting on its CI run. */
export function prCi(ci: CiView): Wait {
  const w: Wait = { kind: 'ci', stage: ci.stage, chip: `CI · ${ci.short}`, text: `${ci.what} · ${ci.text}`, since: ci.since, usual: ci.usual };
  if (ci.total) Object.assign(w, { done: ci.done, total: ci.total });
  if (ci.ended) w.ended = ci.ended;
  return w;
}

const USUALS = 'wait-usual'; // { [key]: the last five lengths in s }
// { [ticket id]: when its restart wait began, ms }: kept, as the restart it waits for restarts this server.
const RESTARTS = 'wait-restart-since';

export interface WaitDeps {
  store: Store;
  /** The deploy lock's state folder (<live checkout's git dir>/cc-deploy), or null outside one. */
  deployState: string | null;
  /** citadel-heavy's folder (CITADEL_HEAVY_DIR). */
  heavyDir: string;
  ship: (ticketId: number) => Ship | null;
  interruptible: () => number;
  /** Called with a minion whose wait changed, to re-send its row. */
  changed: (ticketId: number) => void;
  now?: () => number;
  alive?: (proc: string) => boolean;
  held?: (slotFile: string) => boolean;
  /** CI runs (#546): a landing's CI gate and a minion's PR; its repo's "owner/name" for the landing's. */
  ci?: CiRuns;
  ciSlug?: () => string | null;
  /** Every poll: the land line with each landing's phase and its gate run, for the land alarm (#561, CiHealth.land). */
  landLine?: (seen: LandSeen[], now: number) => void;
  /** Whether a minion's ship counted a CI run started early on its train (#1566, land-news's earlyCi). */
  early?: (ticketId: number) => boolean;
  /** Why the ship ahead (its minion) threw away the early run it stacked for `next`, from its landing's log (#1905); null when unknown. */
  earlyWhy?: (headTicketId: number, next: string) => string | null | Promise<string | null>;
}

/** The waits of every minion, polled from disk; a change re-sends that minion's row. */
export class Waits {
  private current = new Map<number, Wait & { key?: string }>();
  private restartSince: Map<number, number>;
  private shown = new Map<number, string>();
  /** Waiting ships with an early run stacked on them, by minion, and the ship ahead's branch (#1905). */
  private earlyNow = new Map<number, { head: string; next: string }>();
  /** Waiting ships whose early run was thrown away, by minion: what to say, until they leave the line or are stacked again. */
  private earlyDropped = new Map<number, string>();
  /** The read of the reason each dropped note waits on (#2111), by minion. */
  private earlyAsked = new Map<number, Promise<string | null>>();
  private d: WaitDeps;
  constructor(d: WaitDeps) {
    this.d = d;
    this.restartSince = new Map(Object.entries(d.store.getSetting<Record<string, number>>(RESTARTS) ?? {}).map(([k, v]) => [Number(k), v]));
  }

  private saveRestarts() {
    this.d.store.setSetting(RESTARTS, Object.fromEntries(this.restartSince));
  }

  private now = () => (this.d.now ?? Date.now)();

  usual = (key: string): number | null => median(this.d.store.getSetting<Record<string, number[]>>(USUALS)?.[key] ?? []);

  private record(key: string, seconds: number) {
    if (!(seconds > 0)) return;
    const all = this.d.store.getSetting<Record<string, number[]>>(USUALS) ?? {};
    all[key] = [...(all[key] ?? []), Math.round(seconds)].slice(-5);
    this.d.store.setSetting(USUALS, all);
  }

  /** A minion's wait, for its row (Runner.view). */
  wait = (ticketId: number): Wait | null => {
    const w = this.current.get(ticketId);
    const ci = this.d.ci?.view(ticketId);
    if (w) {
      const { key, ...rest } = w;
      if (key === 'land:ci' && ci) return landCi(rest, ci);
      const e = rest.train?.role === 'waiting' ? this.earlyOf(ticketId, ci) : null;
      return e ? earlyWait(rest, e) : rest;
    }
    // A PR's CI shows once the turn has ended (outside): while it runs, its steps say more.
    if (ci?.what && this.d.store.getTicket(ticketId)?.status !== 'running') return prCi(ci);
    return this.restart(ticketId);
  };

  /** A waiting ship's early test (#1905): its stacked run's progress, or why it was thrown away. null when none. */
  private earlyOf(ticketId: number, ci: ReturnType<CiRuns['view']> | undefined): EarlyTest | null {
    const gone = this.earlyDropped.get(ticketId);
    if (gone) return { state: 'dropped', brief: gone, text: gone };
    const e = this.earlyNow.get(ticketId);
    if (!e) return null;
    return earlyTest(ci?.early ? ci : null, this.name(e.head));
  }

  /** Merged and pulled but not running yet: the idle restart, and the turns it waits for. */
  private restart(ticketId: number): Wait | null {
    const stage = this.d.ship(ticketId)?.stage;
    const since = this.restartSince.get(ticketId);
    if (stage !== 'deploying') {
      if (since != null) {
        if (stage === 'live') this.record('restart', (this.now() - since) / 1000);
        this.restartSince.delete(ticketId);
        this.saveRestarts();
      }
      return null;
    }
    const at = since ?? this.now();
    if (since == null) {
      this.restartSince.set(ticketId, at);
      this.saveRestarts();
    }
    const n = this.d.interruptible();
    return {
      kind: 'restart',
      stage: 'restart',
      since: at,
      usual: this.usual('restart'),
      chip: n ? `restart · ${n} turn${n === 1 ? '' : 's'}` : 'restart',
      text: n ? `the restart waits for ${n} running turn${n === 1 ? '' : 's'} to end` : 'restarting',
    };
  }

  /** The land line as the last poll read it (src/releases.ts reads it too). */
  line: LandTicket[] = [];

  /**
   * Put the waiting landings in this order (#1002, the Releases page): `seqs` first, the ones it leaves out behind them in
   * the line's order (given `moved`, only it moves: moveIn); a holder, a ticket no longer waiting or one from an older branch
   * is left out. `note` says who moved what, for the waiters' output. Returns the order written.
   */
  setOrder(seqs: number[], note: string | ((order: number[]) => string), moved?: number, pins: number[] = []): number[] {
    if (!this.d.deployState) throw new Error('This server has no ship line');
    const line = () => {
      this.pollNow();
      return this.line;
    };
    const order = writeOrder(join(this.d.deployState, 'queue'), line, seqs, note, moved, pins);
    this.pollNow();
    return order;
  }

  /** The line's queue folder, read afresh by the Status page's ship line (#1168); null on a server without one. */
  get queue(): string | null {
    return this.d.deployState ? join(this.d.deployState, 'queue') : null;
  }

  /** Labels found to be a minion; a miss is looked up again next time, as its minion may not be there yet. */
  private byLabel = new Map<string, number>();
  ticketFor(label: string): number | null {
    if (!this.byLabel.has(label)) {
      const t = labelTicket(this.d.store, label);
      if (t) this.byLabel.set(label, t.id);
    }
    return this.byLabel.get(label) ?? null;
  }

  /** The newest `n` output lines of the heavy run this minion holds a slot for (#1681); none when it has no run. */
  async tail(ticketId: number, n: number): Promise<string[]> {
    const h = (await readHeavyA(this.d.heavyDir, this.now(), this.d.held)).holders.find((x) => this.ticketFor(x.who) === ticketId);
    return h ? readTail(join(this.d.heavyDir, `slot-${h.slot! - 1}.out`), n) : [];
  }

  private name = (label: string) => {
    const id = this.ticketFor(label);
    const t = id != null ? this.d.store.getTicket(id) : undefined;
    return t ? `#${t.number ?? t.id}` : label.replace(/ \(.*\)$/, '');
  };

  /** Read the land line and heavy folder with no blocking file call (#1807), then apply them. */
  async poll() {
    const gen = ++this.reads;
    const [land, heavy, early, offStat] = await Promise.all([
      this.d.deployState ? readLandLineA(this.d.deployState, this.d.alive) : null,
      readHeavyA(this.d.heavyDir, this.now(), this.d.held),
      this.d.deployState ? readEarlyA(this.d.deployState) : null,
      this.d.deployState ? statA(join(this.d.deployState, 'early-off')) : null,
    ]);
    if (gen === this.reads) this.apply(land, heavy, early, !!offStat); // a newer poll or setOrder read since: this snapshot is old
  }
  private reads = 0;

  /** poll for a person's own action (setOrder), which must have the line before it returns: it reads the land line in the thread and takes the heavy folder from the last poll. */
  private pollNow() {
    this.reads++;
    this.apply(this.d.deployState ? readLandLine(this.d.deployState, this.d.alive) : null, this.lastHeavy, this.d.deployState ? readEarly(this.d.deployState) : null, !!(this.d.deployState && stat(join(this.d.deployState, 'early-off'))));
  }

  /** Which waiting ships have an early run, and which just lost theirs (#1905): the file goes when land.sh throws the run away. */
  private trackEarly(line: LandTicket[], file: EarlyFile | null, off: boolean): Map<number, { branch: string; top: string; since: number }> {
    const waiting = new Set(line.filter((t) => t.got === 0 && !ridingOf(t.phase)).map((t) => t.label));
    const nextId = file && waiting.has(file.next) ? this.ticketFor(file.next) : null;
    const was = this.earlyNow;
    this.earlyNow = new Map();
    if (off) this.earlyDropped.clear();
    if (off) this.earlyAsked.clear();
    const watch = new Map<number, { branch: string; top: string; since: number }>();
    if (file && nextId != null) {
      this.earlyNow.set(nextId, { head: file.head, next: file.next });
      this.earlyDropped.delete(nextId);
      this.earlyAsked.delete(nextId);
      watch.set(nextId, { branch: file.next, top: file.top, since: file.at * 1000 });
    }
    for (const [id, e] of was) {
      if (off || this.earlyNow.has(id) || !waiting.has(e.next) || this.earlyDropped.has(id)) continue;
      // Still waiting and no early run any more: land.sh threw it away (early-off, being switched off now, shows nothing).
      const headId = this.ticketFor(e.head);
      const why = headId != null ? this.d.earlyWhy?.(headId, e.next) : null;
      const ahead = this.name(e.head);
      const say = (why: string | null | undefined) =>
        this.earlyDropped.set(id, !why ? `Early test dropped: ${ahead} ahead of it changed` : /went red/.test(why) ? `Early test dropped: ${ahead} ahead of it failed` : /built again/.test(why) ? `Early test dropped: ${ahead}'s train was built again, so the run no longer matches` : `Early test dropped: ${why}`);
      // The reason is in the head's log, read off the server's thread (#2111): the plain words show until it is in.
      if (why instanceof Promise) {
        say(null);
        // Only this drop's read fills it in: an older one that ends late belongs to a run dropped before.
        this.earlyAsked.set(id, why);
        void why.then((w) => void (w && this.earlyAsked.get(id) === why && this.earlyDropped.has(id) && say(w))).catch(() => {});
      } else say(why);
    }
    // A dropped note goes once its ship is no longer waiting in the line.
    for (const id of [...this.earlyDropped.keys()]) {
      const label = [...this.byLabel].find(([, v]) => v === id)?.[0];
      if (!label || !waiting.has(label)) this.earlyDropped.delete(id);
    }
    return watch;
  }

  /** The heavy folder as the last poll read it (off the thread); a person's own action reuses it rather than read the folder in the thread. */
  private lastHeavy: HeavyJobs = { holders: [], waiters: [] };
  private apply(land: { line: LandTicket[]; took: number[] } | null, heavy: HeavyJobs, early: EarlyFile | null = null, off = false) {
    this.lastHeavy = heavy;
    const now = this.now();
    const next = new Map<number, Wait & { key?: string }>();
    if (land) {
      const { line, took } = land;
      this.line = line;
      // Before ci.landings below lets go of a landing that left its CI wait, so its run's last stage is still there.
      this.d.landLine?.(
        line.map((t) => {
          const id = this.ticketFor(t.label);
          return { seq: t.seq, name: t.label === 'tools/deploy.sh' ? t.label : this.name(t.label), phase: t.got > 0 ? landPhase(t.phase).key : 'line', ci: id != null && !this.d.ci?.view(id)?.early ? (this.d.ci?.view(id)?.stage ?? null) : null, run: id != null ? (this.d.ci?.runOf(id) ?? null) : null };
        }),
        now,
      );
      for (const [label, w] of landWaits(line, took, now, this.usual, this.name, (l) => {
        const i = this.ticketFor(l);
        return i != null && !!this.d.early?.(i);
      })) {
        const id = this.ticketFor(label);
        const holder = line.find((t) => t.label === label && t.got > 0);
        if (id != null) next.set(id, { ...w, key: holder ? `land:${landPhase(holder.phase).key}` : undefined });
      }
    }
    for (const [who, w] of heavyWaits(heavy, this.usual, this.name)) {
      const id = this.ticketFor(who);
      // A heavy job runs inside its minion's turn; its files can outlive a killed job, so only a running minion shows one.
      if (id == null || next.has(id) || this.d.store.getTicket(id)?.status !== 'running') continue;
      const h = heavy.holders.find((x) => x.who === who);
      next.set(id, { ...w, key: w.stage === 'run' ? `heavy:run:${h?.what}` : 'heavy:slot' });
    }
    // A stage that moved on (or a slot or run that ended) adds its length to that stage's usual. A landing
    // that left the line before deploying stopped early (a conflict, a red test), and a heavy job whose
    // minion stopped was cut off: those don't count.
    for (const [id, old] of this.current) {
      const now2 = next.get(id);
      if (!old.key || (now2 && now2.stage === old.stage && now2.since === old.since)) continue;
      const movedOn = now2 ? TRACK.indexOf(now2.stage) > TRACK.indexOf(old.stage) || old.kind === 'heavy' : old.kind === 'heavy' ? this.d.store.getTicket(id)?.status === 'running' : old.stage === 'deploy';
      if (movedOn) this.record(old.key, (now - old.since) / 1000);
    }
    const ids = new Set([...this.current.keys(), ...next.keys()]);
    this.current = next;
    const gates = new Map<number, { branch: string; cwd: string | null; since: number }>();
    for (const [id, w] of next) {
      const t = w.key === 'land:ci' ? this.d.store.getTicket(id) : undefined;
      if (t?.branch) gates.set(id, { branch: t.branch, cwd: t.cwd, since: w.since });
    }
    this.d.ci?.landings(this.d.ciSlug?.() ?? null, gates);
    const stacked = land ? this.trackEarly(land.line, early, off) : new Map();
    this.d.ci?.early?.(this.d.ciSlug?.() ?? null, stacked);
    for (const id of ids) this.check(id);
  }

  /** Re-send a minion's row when what its wait says has changed. */
  check(ticketId: number) {
    const json = JSON.stringify(this.wait(ticketId));
    if (this.shown.get(ticketId) === json) return;
    this.shown.set(ticketId, json);
    this.d.changed(ticketId);
  }
}
