// What a minion waits on (#544): its place in the land line and that landing's phase, a heavy slot, or
// the idle restart. One shape for every kind, read from what's already on disk or in the server: the
// land line's ticket files (tools/deploy-queue.sh), citadel-heavy's slot and waiter files, and the ship
// line's "deploying" stage. CI runs (#546, src/ci-wait.ts) fill the same record: a PR's run, and a landing's CI gate;
// a test run's file counts (#545, tools/progress-reporter.ts) fill in done and total.
import { readTail } from './wait-tail.ts';
import { median as statsMedian } from './stats.ts';
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat as statFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './db.ts';
import type { Ship } from './branch.ts';
import type { CiRuns } from './ci-wait.ts';
import type { LandSeen } from './ci-health.ts';

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
  /** When it ended, ms: a CI run's pass or fail, shown a while after; its time stops there. */
  ended?: number;
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
  const stat = read(`/proc/${pid}/stat`);
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

/** `orders`: its landing follows queue/.order (deploy-queue.sh's 5th ticket line, #1002); one from an older branch doesn't. */
export interface LandTicket {
  seq: number;
  proc: string;
  got: number;
  label: string;
  phase: string;
  mtime: number;
  orders?: boolean;
  tests?: TestCounts | null;
}

/** The waiting tickets' numbers in the order people set on the Releases page (#1002): queue/.order, as deploy-queue.sh reads it. */
const orderFrom = (text: string | null) =>
  (text ?? '')
    .split('\n')
    .filter((l) => /^\d{10}$/.test(l))
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
  return queueFrom(orderFrom(read(join(q, '.order'))), tickets, orderAt, alive);
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
  return queueFrom(orderFrom(order), tickets, orderAt, alive);
}

function queueFrom(order: number[], tickets: { name: string; text: string | null; at: number | null }[], orderAt: number, alive: (proc: string) => boolean): LandTicket[] {
  const line: LandTicket[] = [];
  // A waiter from before .order waits for every lower ticket, so nobody who arrived after it goes ahead (The Trans Agenda #76).
  const rank = (t: LandTicket) => (t.got > 0 ? -1 : !t.orders ? order.length + 1 : order.includes(t.seq) ? order.indexOf(t.seq) : order.length);
  for (const { name, text, at } of tickets) {
    if (text == null || at == null) continue;
    const l = text.split('\n');
    const [proc = '', got = '0', label = '', phase = ''] = l;
    if (!alive(proc)) continue;
    line.push({ seq: Number(name), proc, got: Number(got) || 0, label, phase, mtime: at, orders: l[orderAt] === 'order' || l[7] === 'order' });
  }
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
 * what, for the waiters' output. Returns the order written.
 */
export function writeOrder(q: string, line: LandTicket[], seqs: number[], note: string | ((order: number[]) => string), moved?: number): number[] {
  const waiting = line.filter((t) => t.got === 0 && t.orders && !behindOld(line, t)).map((t) => t.seq);
  const order = moved != null && waiting.includes(moved) ? moveIn(waiting, seqs, moved) : [...new Set([...seqs.filter((n) => waiting.includes(n)), ...waiting])];
  if (!order.length) throw new Error('Nothing is waiting in line to reorder');
  const f = join(q, '.order'),
    tmp = `${f}.tmp${process.pid}`;
  // By a rename, as the queue scripts write their tickets, so a waiter never reads half of it.
  writeFileSync(tmp, `# ${(typeof note === 'string' ? note : note(order)).replace(/[\x00-\x1f]+/g, ' ')}\n${order.map((n) => String(n).padStart(10, '0')).join('\n')}\n`);
  renameSync(tmp, f);
  return order;
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

/** The Releases page's words for a holder's CI after an early run counted for it (land.sh's early_gate). */
export const EARLY_CI = { word: 'CI · early', label: 'CI · started early', text: "CI started early, during the train ahead's deploy: waiting for that run's result" };

// The one-line readout's words for a landing's test phases (#630): the stage and its count say the rest, and the
// suite's file counts fill its piece of the track.
const BRIEF: Record<string, string> = { ci: 'CI: starting', tests: 'full suite on perigee', reruns: 'failed files rerun alone on perigee', bisect: 'bisecting the red train' };
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
    const ahead = line.slice(0, i).filter((a) => !riders.includes(a) && !heldOf(a.phase));
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
  return out;
}

export interface HeavyJob {
  who: string;
  what: string;
  since: number;
  reason?: string;
  slot?: number;
  tests?: TestCounts | null;
}

/**
 * The inodes holding a flock(1) lock, from the kernel's list (/proc/locks: "1: FLOCK  ADVISORY  WRITE <pid> <maj>:<min>:<inode> 0 EOF");
 * a waiter's line ("1: -> FLOCK …") holds nothing. Null when there's no list to read. Read in the server, so the `waits` job
 * starts no process (#1562; it ran `flock -n` per held slot every 2 s). Only the inode is matched: btrfs names a
 * different device here than stat does, and a stale .who on a slot whose inode another filesystem has locked is all a clash costs.
 */
export function flockedInodes(text = read('/proc/locks')): Set<number> | null {
  if (text == null) return null;
  return new Set([...text.matchAll(/^\d+:\s+FLOCK\s+\S+\s+\S+\s+\S+\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/gm)].map((m) => Number(m[1])));
}

/** Whether a heavy slot's lock is held: a holder killed past its trap leaves its .who behind, but not the lock. */
export function slotHeld(file: string, locked = flockedInodes()): boolean {
  return heldIn(locked, stat(file)?.ino);
}
const heldIn = (locked: Set<number> | null, ino: number | undefined) => !locked || (ino !== undefined && locked.has(ino)); // no lock list at all: trust the file; no lock file: nobody holds its lock

/** heldSlots with the lock list and each slot's file read off the server's thread (#1807). */
export function heldSlotsA(): (file: string) => Promise<boolean> {
  let locked: Promise<Set<number> | null> | undefined;
  return async (file) => heldIn(await (locked ??= readA('/proc/locks').then((t) => flockedInodes(t))), (await statA(file))?.ino);
}

/** slotHeld for one look at the heavy folder: the lock list is read once, and only if a slot has a .who. */
export function heldSlots(): (file: string) => boolean {
  let locked: Set<number> | null | undefined;
  return (file) => slotHeld(file, locked === undefined ? (locked = flockedInodes()) : locked);
}

const STALE_WAITER_MS = 60_000; // citadel-heavy freshens a waiter's file at least every 20 s

/**
 * citadel-heavy's holders (slot-N.who: "who: what (since HH:MM, pid N)", while slot-N's lock is held) and
 * waiters (wait-<pid>-<random>: who, what, since s, reason; freshened while it waits). A holder running a Node test
 * suite gets its counts from slot-N.progress, which citadel-heavy has tools/citadel-node write.
 */
export function readHeavy(dir: string, now = Date.now(), held = heldSlots()): { holders: HeavyJob[]; waiters: HeavyJob[] } {
  const holders: HeavyJob[] = [],
    waiters: HeavyJob[] = [];
  for (const name of files(dir)) {
    const f = join(dir, name),
      m = name.match(/^slot-(\d+)\.who$/);
    if (m) {
      const w = holderOf(read(f)?.trim()),
        at = mtime(f);
      if (w && at != null && held(join(dir, `slot-${m[1]}`))) holders.push({ who: w[1], what: w[2], since: at, slot: Number(m[1]) + 1, tests: readTestCounts(join(dir, `slot-${m[1]}.progress`), at) });
    } else if (/^wait-\d+-\d+$/.test(name) && now - (mtime(f) ?? 0) < STALE_WAITER_MS) {
      const w = waiterOf(read(f));
      if (w) waiters.push(w);
    }
  }
  return { holders, waiters: waiters.sort((a, b) => a.since - b.since) };
}

/** readHeavy with every file read off the server's thread (#1807); `held` may answer later. */
export async function readHeavyA(dir: string, now = Date.now(), held: (slotFile: string) => boolean | Promise<boolean> = heldSlotsA()): Promise<{ holders: HeavyJob[]; waiters: HeavyJob[] }> {
  const holders: HeavyJob[] = [],
    waiters: HeavyJob[] = [];
  await Promise.all(
    (await filesA(dir)).map(async (name) => {
      const f = join(dir, name),
        m = name.match(/^slot-(\d+)\.who$/);
      if (m) {
        const [text, at] = await Promise.all([readA(f), mtimeA(f)]);
        const w = holderOf(text?.trim());
        if (w && at != null && (await held(join(dir, `slot-${m[1]}`)))) holders.push({ who: w[1], what: w[2], since: at, slot: Number(m[1]) + 1, tests: await readTestCountsA(join(dir, `slot-${m[1]}.progress`), at) });
      } else if (/^wait-\d+-\d+$/.test(name) && now - ((await mtimeA(f)) ?? 0) < STALE_WAITER_MS) {
        const w = waiterOf(await readA(f));
        if (w) waiters.push(w);
      }
    }),
  );
  holders.sort((a, b) => a.slot! - b.slot!); // reads finish in any order
  return { holders, waiters: waiters.sort((a, b) => a.since - b.since) };
}

const holderOf = (text: string | null | undefined) => text?.match(/^(.*?): (.*) \(since \d\d:\d\d, pid \d+\)$/);
function waiterOf(text: string | null): HeavyJob | null {
  const [who, what, since, reason] = (text ?? '').split('\n');
  return who && Number(since) ? { who, what, since: Number(since) * 1000, reason } : null;
}

/** Each heavy job's wait, by its who ("Citadel #544 (cara)"). */
export function heavyWaits({ holders, waiters }: ReturnType<typeof readHeavy>, usual: (key: string) => number | null, name: (who: string) => string): Map<string, Wait> {
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
}

/** The waits of every minion, polled from disk; a change re-sends that minion's row. */
export class Waits {
  private current = new Map<number, Wait & { key?: string }>();
  private restartSince: Map<number, number>;
  private shown = new Map<number, string>();
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
      return key === 'land:ci' && ci ? landCi(rest, ci) : rest;
    }
    // A PR's CI shows once the turn has ended (outside): while it runs, its steps say more.
    if (ci?.what && this.d.store.getTicket(ticketId)?.status !== 'running') return prCi(ci);
    return this.restart(ticketId);
  };

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
  setOrder(seqs: number[], note: string | ((order: number[]) => string), moved?: number): number[] {
    if (!this.d.deployState) throw new Error('This server has no ship line');
    this.pollNow();
    const order = writeOrder(join(this.d.deployState, 'queue'), this.line, seqs, note, moved);
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
    return h ? readTail(join(this.d.heavyDir, `slot-${h.slot - 1}.out`), n) : [];
  }

  private name = (label: string) => {
    const id = this.ticketFor(label);
    const t = id != null ? this.d.store.getTicket(id) : undefined;
    return t ? `#${t.number ?? t.id}` : label.replace(/ \(.*\)$/, '');
  };

  /** Read the land line and heavy folder with no blocking file call (#1807), then apply them. */
  async poll() {
    const gen = ++this.reads;
    const [land, heavy] = await Promise.all([this.d.deployState ? readLandLineA(this.d.deployState, this.d.alive) : null, readHeavyA(this.d.heavyDir, this.now(), this.d.held)]);
    if (gen === this.reads) this.apply(land, heavy); // a newer poll or setOrder read since: this snapshot is old
  }
  private reads = 0;

  /** poll for a person's own action (setOrder), which must have the line before it returns: it reads in the thread. */
  private pollNow() {
    this.reads++;
    this.apply(this.d.deployState ? readLandLine(this.d.deployState, this.d.alive) : null, readHeavy(this.d.heavyDir, this.now(), this.d.held));
  }

  private apply(land: { line: LandTicket[]; took: number[] } | null, heavy: ReturnType<typeof readHeavy>) {
    const now = this.now();
    const next = new Map<number, Wait & { key?: string }>();
    if (land) {
      const { line, took } = land;
      this.line = line;
      // Before ci.landings below lets go of a landing that left its CI wait, so its run's last stage is still there.
      this.d.landLine?.(
        line.map((t) => {
          const id = this.ticketFor(t.label);
          return { seq: t.seq, name: t.label === 'tools/deploy.sh' ? t.label : this.name(t.label), phase: t.got > 0 ? landPhase(t.phase).key : 'line', ci: id != null ? (this.d.ci?.view(id)?.stage ?? null) : null, run: id != null ? (this.d.ci?.runOf(id) ?? null) : null };
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
