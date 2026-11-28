// The line for the lock (#502), the cases both ship scripts run: Citadel's tools/deploy-queue.sh in land-queue.test.ts
// and the kit template's copy of it inside its land.sh in scheme-setup-land.test.ts, one table for the twin rule's "a test
// on each side" (Cara, 2026-11-22, "Keep both, port by rule"). The two sides run at different layers: Citadel's calls
// queue_lock from a stand-in landing, the template's runs its whole land.sh. So each side hands in how a party in line
// starts (its argv), when it holds the lock, what it served, and its own words; a case only one script has stays in
// that side's file.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { until } from './wait.ts';

// A party's own gate (its work waits for that file; none: the line's shared one), how long it holds the lock past it,
// and its environment.
export type PartyOpts = { gate?: string; hold?: number; env?: Record<string, string> };
export type Line = {
  // The lock file, the tickets' folder, and a scratch folder for gates and pid files.
  lock: string;
  queue: string;
  dir: string;
  // Party i (from 1): the arguments to bash, where it runs and its environment.
  argv: (i: number, o?: PartyOpts) => { args: string[]; cwd?: string; env: NodeJS.ProcessEnv };
  // Party i has the lock and is doing its work.
  holds: (i: number) => boolean;
  // The parties that got all the way through, in order.
  served: () => number[];
  tickets: () => string[];
  issued: () => number;
  // The shared gate; every party's work waits for it unless it was given its own.
  gate: string;
};
export type QueueSide = {
  name: string;
  line: (parties: number) => Line;
  // The lock as the waiters name it, and party i as the line names it.
  lock: string;
  label: (i: number) => string;
  // The holder's phase while it does its work, as a pattern.
  holding: string;
  // What the head of the line says of a lock held outside the line, as a pattern.
  outside: string;
  // A short stall limit, and how the giving up says it.
  stall: Record<string, string>;
  stalled: string;
  // "nothing landed" (and deployed, for Citadel), and how it names a head that won't take the free lock.
  nothing: string;
  notTaking: (pid: number) => string;
  // The template keeps the shell's own "Permission denied" out of its refusal; Citadel's prints it first.
  quietOpen: boolean;
  // The knob for a fake cgroup root, and a waiting ticket as the script writes one.
  cgroup: string;
  ticket: (pid: number, start: string, label: string) => string;
};

type Party = { child: ChildProcess; exit: Promise<number | null>; stderr: () => string };
function party({ args, cwd, env }: ReturnType<Line['argv']>): Party {
  const child = spawn('bash', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += d));
  // A party that never ends fails its test by name instead of hanging the whole run (#560).
  const exit = new Promise<number | null>((ok, no) => {
    const late = setTimeout(() => no(new Error(`still in line after 60 s:\n${stderr}`)), 60_000);
    child.on('close', (code) => {
      clearTimeout(late);
      ok(code);
    });
  });
  exit.catch(() => {}); // for a test that had already failed on something else
  return { child, exit, stderr: () => stderr };
}

const isZombie = (pid: number) => {
  try {
    return /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
};
const startTime = (pid: number) =>
  readFileSync(`/proc/${pid}/stat`, 'utf8')
    .replace(/^.*\) /s, '')
    .split(' ')[19];
const lockHeld = (lock: string) => spawnSync('flock', ['-n', lock, 'true']).status !== 0;
const took = (l: Line) => readFileSync(join(l.queue, '.took'), 'utf8').trim().split('\n').map(Number);

export function queueCases(side: QueueSide) {
  const { lock, label } = side;
  const setup = (parties: number) => {
    const l = side.line(parties);
    const started: Party[] = [];
    const start = (i: number, o?: PartyOpts) => started[started.push(party(l.argv(i, o))) - 1];
    const open = (gate = l.gate) => writeFileSync(gate, '');
    // A failed check must not leave parties waiting on a gate, which hangs the file.
    const stop = () => {
      open();
      for (const p of started) {
        p.child.kill('SIGCONT');
        p.child.kill('SIGKILL');
      }
    };
    return { l, start, open, stop };
  };

  test(`${side.name}: a waiter that is killed leaves the line, and the one behind it goes next`, async () => {
    const { l, start, open, stop } = setup(3);
    try {
      const a = start(1);
      await until('a to hold the lock', () => l.holds(1));
      const b = start(2);
      await until("b's ticket", () => l.issued() === 2);
      const c = start(3);
      await until('c to see its place', () => /3rd in line/.test(c.stderr()));
      const [ta, , tc] = l.tickets();
      assert.ok(tc, 'three tickets in line');
      b.child.kill('SIGKILL');
      await b.exit;
      // Not counted right after the kill: c may already have removed it by then.
      await until('c to move up past the dead ticket', () => /2nd in line/.test(c.stderr()));
      assert.deepEqual(l.tickets(), [ta, tc], "the waiter behind it removed the killed waiter's ticket");
      open();
      assert.equal(await a.exit, 0, a.stderr());
      assert.equal(await c.exit, 0, c.stderr());
      assert.deepEqual(l.served(), [1, 3]);
    } finally {
      stop();
    }
  });

  // A zombie: b's parent starts it, then becomes a sleep that never waits on it, so once b is killed its
  // /proc entry stays, start time and all, until the parent goes.
  test(`${side.name}: a killed waiter whose parent never reaps it leaves the line too`, async () => {
    const { l, start, open, stop } = setup(3);
    const pidFile = join(l.dir, 'b.pid');
    let parent: ChildProcess | undefined;
    try {
      const a = start(1);
      await until('a to hold the lock', () => l.holds(1));
      const { args, cwd, env } = l.argv(2);
      parent = spawn('bash', ['-c', 'bash "$@" & echo $! >"$PIDFILE"; exec sleep 600', 'zombie', ...args], { cwd, stdio: 'ignore', env: { ...env, PIDFILE: pidFile } });
      await until("b's ticket", () => l.issued() === 2);
      const c = start(3);
      await until('c to see its place', () => /3rd in line/.test(c.stderr()));
      const [ta, , tc] = l.tickets();
      assert.ok(tc, 'three tickets in line');
      const b = Number(readFileSync(pidFile, 'utf8'));
      process.kill(b, 'SIGKILL');
      await until('b to be a zombie', () => isZombie(b));
      await until('c to move up past the zombie', () => /2nd in line/.test(c.stderr()));
      assert.deepEqual(l.tickets(), [ta, tc], "the zombie's ticket was removed");
      assert.ok(isZombie(b), 'b was still a zombie when c moved up');
      open();
      assert.equal(await a.exit, 0, a.stderr());
      assert.equal(await c.exit, 0, c.stderr());
      assert.deepEqual(l.served(), [1, 3]);
    } finally {
      stop();
      parent?.kill('SIGKILL');
    }
  });

  test(`${side.name}: a holder that is killed leaves the line too, and its lock goes with it`, async () => {
    const { l, start, open, stop } = setup(2);
    try {
      const a = start(1);
      await until('a to hold the lock', () => l.holds(1));
      const b = start(2);
      await until('b to wait', () => /2nd in line/.test(b.stderr()));
      assert.ok(!l.holds(2), 'b waits while a holds the lock');
      a.child.kill('SIGKILL'); // the template's check runs on without the lock, until the gate opens below
      await until('b to get the lock', () => new RegExp(`got the ${lock}`).test(b.stderr()));
      open();
      assert.equal(await b.exit, 0, b.stderr());
      assert.deepEqual(l.served(), [2]);
    } finally {
      stop();
    }
  });

  test(`${side.name}: the head of the line waits for a lock held outside it, and the estimate comes from past landings`, async () => {
    const { l, start, open, stop } = setup(2);
    mkdirSync(l.queue, { recursive: true });
    writeFileSync(join(l.queue, '.took'), '100\n140\n');
    const outside = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 600', l.lock], { stdio: 'ignore' }); // one process, so killing it frees the lock
    try {
      open();
      await until('the lock to be held', () => lockHeld(l.lock));
      const a = start(1, { hold: 1.2 });
      await until('a to say it waits', () => new RegExp(`next in line for the ${lock} \\(ahead: ${side.outside}`).test(a.stderr()));
      const b = start(2);
      await until('b to say its place', () => new RegExp(`2nd in line for the ${lock}, about 2 min \\(ahead: ${label(1)}, waiting\\)`).test(b.stderr()));
      assert.deepEqual(l.served(), []);
      outside.kill('SIGKILL');
      assert.equal(await a.exit, 0, a.stderr());
      assert.equal(await b.exit, 0, b.stderr());
      assert.deepEqual(l.served(), [1, 2]);
      // Each noted how long it held the lock; a held it for a second or two.
      const t = took(l);
      assert.equal(t.length, 4, 'each noted how long it held the lock');
      assert.ok(t[2] >= 1 && t[2] <= 30, `a's time: ${t[2]}`);
    } finally {
      outside.kill('SIGKILL');
      stop();
    }
  });

  // The pipeline failure drill's F3 (#553): a SIGSTOP stops a waiter (state T). It holds nothing, yet everyone behind it
  // waited on it with the lock free, and gave up. A frozen cgroup is below.
  test(`${side.name}: a waiter that is stopped (SIGSTOP) is passed over: the one behind it takes the lock, and it goes when it wakes`, async () => {
    const { l, start, open, stop } = setup(3);
    const gate = { a: join(l.dir, 'gate-a'), c: join(l.dir, 'gate-c') };
    open(); // b's work
    try {
      // a first: started together, b can take the first ticket under load and never be 2nd (#564).
      const a = start(1, { gate: gate.a });
      await until('a to hold the lock', () => l.holds(1));
      const b = start(2);
      await until('b to say its place', () => /2nd in line/.test(b.stderr()));
      process.kill(b.child.pid!, 'SIGSTOP');
      const c = start(3, { gate: gate.c });
      await until('c to say its place', () => new RegExp(`in line for the ${lock}`).test(c.stderr()));
      open(gate.a);
      assert.equal(await a.exit, 0, a.stderr());
      await until('c to take the lock past the stopped b', () => l.holds(3));
      assert.match(c.stderr(), new RegExp(`got the ${lock}`));
      assert.ok(!l.holds(2), 'the stopped b took nothing');
      // Awake again while the one that passed it has the lock: that is a party in line, not something outside it, and
      // like any holder it is ahead of every waiter (#1002, #1007).
      process.kill(b.child.pid!, 'SIGCONT');
      await until('b to say what it waits for now', () => new RegExp(`2nd in line for the ${lock}, about \\d+ min \\(ahead: ${label(3)}, ${side.holding}\\)`).test(b.stderr()));
      assert.doesNotMatch(b.stderr(), /outside the line|older than the line/);
      open(gate.c);
      assert.equal(await c.exit, 0, c.stderr());
      assert.equal(await b.exit, 0, b.stderr());
      assert.deepEqual(l.served(), [1, 3, 2]);
    } finally {
      for (const g of Object.values(gate)) writeFileSync(g, '');
      stop();
    }
  });

  // A waiter frozen with `systemctl freeze` (the cgroup freezer, #585) shows state S, not T. Its cgroup's cgroup.events
  // says "frozen 1": that counts as stopped too. A fake cgroup root stands in for /sys/fs/cgroup, so nothing real is frozen.
  test(`${side.name}: a waiter whose cgroup is frozen (state S) is passed over like a stopped one: the one behind it takes the free lock`, async () => {
    const { l, start, open, stop } = setup(1);
    const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      const pid = sleeper.pid!;
      await until('the frozen one to be in state S, as a frozen cgroup leaves it', () => /\) S /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')));
      const cg = readFileSync(`/proc/${pid}/cgroup`, 'utf8').match(/^0::(.*)$/m)![1];
      const fake = join(l.dir, 'cgroup');
      mkdirSync(join(fake, cg), { recursive: true });
      writeFileSync(join(fake, cg, 'cgroup.events'), 'populated 1\nfrozen 1\n');
      mkdirSync(l.queue, { recursive: true });
      writeFileSync(join(l.queue, '0000000001'), side.ticket(pid, startTime(pid), 'frozen'));
      writeFileSync(join(l.queue, '.seq'), '1\n');
      open();
      const a = start(1, { env: { ...side.stall, [side.cgroup]: fake } });
      assert.equal(await a.exit, 0, a.stderr());
      assert.deepEqual(l.served(), [1]);
      assert.deepEqual(l.tickets(), ['0000000001'], 'the frozen one keeps its place, to go when it thaws');
    } finally {
      sleeper.kill('SIGKILL');
      stop();
    }
  });

  test(`${side.name}: giving up names the process at the head of the line, its state and whether the lock is held or free`, async () => {
    const { l, start, open, stop } = setup(3);
    let stuck: ChildProcess | undefined;
    try {
      const a = start(1);
      await until('a to hold the lock', () => l.holds(1));
      process.kill(a.child.pid!, 'SIGSTOP'); // the holder itself is stopped: nobody can pass it
      const b = start(2, { env: side.stall });
      assert.equal(await b.exit, 1, b.stderr());
      assert.match(b.stderr(), new RegExp(`nothing has moved for ${side.stalled} \\(ahead: ${label(1)}, ${side.holding}; pid ${a.child.pid}, stopped; the lock is held\\), so this gave up`));
      a.child.kill('SIGKILL');
      open(); // the template's check subshell outlives it, holding its stderr open until the check ends
      await a.exit;
      // First in line, awake, and not taking the free lock.
      stuck = spawn('sleep', ['60'], { stdio: 'ignore' });
      const pid = stuck.pid!;
      await until('the stuck process to run', () => existsSync(`/proc/${pid}/stat`));
      const seq = Number(readFileSync(join(l.queue, '.seq'), 'utf8')) + 1;
      writeFileSync(join(l.queue, String(seq).padStart(10, '0')), side.ticket(pid, startTime(pid), 'stuck'));
      writeFileSync(join(l.queue, '.seq'), `${seq}\n`);
      const c = start(3, { env: side.stall });
      assert.equal(await c.exit, 1, c.stderr());
      assert.match(c.stderr(), new RegExp(`nothing has moved for ${side.stalled} \\(ahead: stuck, waiting; pid ${pid}, state S; the lock is free\\), so this gave up and ${side.nothing}\\. A person needs to look at ${side.notTaking(pid)} before anyone tries again`));
    } finally {
      stuck?.kill('SIGKILL');
      stop();
    }
  });

  // The drill's F12b (#577): a lock file that can't be opened printed "flock: 9: Bad file descriptor" about once a second
  // for the whole stall, then blamed a holder.
  test(`${side.name}: a lock that can't be opened gives up at once and says so, not a flock error a second`, async () => {
    const { l, start, stop } = setup(1);
    try {
      writeFileSync(l.lock, '', { mode: 0o444 });
      const a = start(1, { env: side.stall });
      assert.equal(await a.exit, 1, a.stderr());
      assert.match(a.stderr(), new RegExp(`queue: can't open the ${lock} \\S+/${basename(l.lock).replace('.', '\\.')} for writing, so ${side.nothing}: a person needs to look at it`));
      assert.doesNotMatch(a.stderr(), side.quietOpen ? /Bad file descriptor|Permission denied|nothing has moved/ : /Bad file descriptor|nothing has moved/);
      assert.deepEqual(l.tickets(), []);
      assert.deepEqual(l.served(), []);
    } finally {
      stop();
    }
  });

  // F12c: junk in .seq made a landing go live and still exit 1, and every later one too, or gave the next landing
  // ticket 1 again in place of the holder's, and nothing named .seq.
  test(`${side.name}: a .seq that holds no number is named, and the next ticket still goes behind the ones in line`, async () => {
    const { l, start, open, stop } = setup(2);
    try {
      const a = start(1);
      await until('a to hold the lock', () => l.holds(1));
      writeFileSync(join(l.queue, '.seq'), 'junk\n');
      const b = start(2);
      await until('b to wait', () => /2nd in line/.test(b.stderr()));
      assert.match(b.stderr(), new RegExp(`queue: \\S+/${basename(l.queue)}/\\.seq held no ticket number \\("junk"\\); numbering goes on from the newest ticket, 1`));
      assert.deepEqual(l.tickets(), ['0000000001', '0000000002']);
      open();
      assert.equal(await a.exit, 0, a.stderr());
      assert.equal(await b.exit, 0, b.stderr());
      assert.deepEqual(l.served(), [1, 2]);
      assert.equal(l.issued(), 2);
      assert.deepEqual(
        readdirSync(l.queue).filter((f) => f.includes('.tmp')),
        [],
        'no half-written tickets left',
      );
    } finally {
      stop();
    }
  });
}
