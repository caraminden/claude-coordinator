// Restart anywhere (#1290, R6 of the code-review research #1265): a restart at any saved step of a minion's turn leaves
// it running, waiting on a named timer, or idle with nothing owed, and loses no message a person or minion sent it.
//
// How it works. Each flow in FLOWS runs once, uncut, on a real Runner and the fake claude. A restart (a deploy's SIGTERM)
// can only land between two event-loop tasks, never inside one, so at the start of every task the harness looks at
// whether the one before it wrote to the database; if it did, the store is copied there (a "cut"). After the flow, each
// cut gets a fresh Runner on its copy, as a server started on that database would, and recover(). Its turns died with
// the old server (reattach finds nothing: the crash case; a turn its unit kept alive is test/auto-resume's) and its
// turns don't run (startTurn only records what it was handed). Then, for that cut:
// - Owed: if the uncut run started a turn later in the same step (nothing outside the runner asked for it), the restarted
//   runner starts one too or waits on a named timer (the usage-limit resume, the network probe, the cold-mail sweep).
// - Held: every message sent before the cut and not yet handed to a turn is in the turn it starts or its one queue
//   record (#1378, `minion-queue:<id>`: queued, held mail, a taken batch or a steer), unless a stop dropped it on purpose.
// - Ended: a cut after the turn's good result line is saved is not resumed: its reply is in (2A1).
// - Idle: with nothing started or waiting, no `running` status, nothing queued, no held mail that nothing will release,
//   no taken batch or owed resume, and no turn: or saving: record left that nothing acts on.
// A failure names the flow, the cut, its step and what the task before it wrote, so it can be found again by hand.
//
// A flow with `outbox` runs the one outbox (src/outbox.ts, ADR 0021) beside each runner, as server.ts does: a wake it
// set counts as sent, a restarted server boots its own outbox, and a delivery row it will (re)send, or one its timer
// waits on, carries the wake. A row left `sending` with no turn to accept it is a problem.
//
// To cover a new flow, add one entry to FLOWS: a name, an optional setup (accounts, say), and steps. Each step does one
// thing from outside the runner (a message, a turn's end, a timer firing) and waits for the runner to go quiet.
// It also cuts after every single write, a hard crash's points (power, the OOM killer), since #1364 closed the gaps only a
// crash (not a restart) could reach; RESTART_ANYWHERE_LOOSE=1 cuts at task boundaries alone. RESTART_ANYWHERE_ONLY=<flow name> runs one flow; RESTART_ANYWHERE_DEBUG=1 prints each flow's cuts and what it sent.
// On the server the write worker drains its queue before a restart exits (src/db-writer.ts), so a restart lands between
// tasks; only a hard crash can stop between two writes of one task, so writes that must land together share a commit
// (Store.setSettings).
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gzipSync } from 'node:zlib';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { VALUE_WRITES, WRITES } from '../src/db-writer.ts';
import { Outbox } from '../src/outbox.ts';
import { RESUME_PROMPT } from '../src/prompts.ts';
import { Runner } from '../src/runner.ts';
import { chainedStep, LiveWaiters, TimedWakes } from '../src/wake.ts';
import { releaseFake, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// The copies are many and small: on tmpfs a copy and a reopen take ~25 ms, on a busy disk ~125 ms.
const root = mkdtempSync(join(existsSync('/dev/shm') ? '/dev/shm' : tmpdir(), 'restart-anywhere-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

const { fake, prompts, setRelease, setReply, turnsRun } = releaseFake(root);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Two hours from now, in Claude's words.
const LIMIT = `You've hit your 5-hour limit · resets ${new Date(Date.now() + 2 * 60 * 60 * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }).replace(' ', '').toLowerCase()} (America/Los_Angeles)`;

type Msg = { text: string };
/** What a flow's steps see: the runner now serving (a step may restart it), its store and minion. */
type Ctx = {
  runner: Runner; store: Store; id: number; say: (author: string, text: string) => void;
  /** A message another minion relays (send's `from`), as a minion's ask to its Taskmaster. */
  relay: (text: string) => void;
  mail: (from: string, text: string) => void; hold: (author: string, text: string) => void; wake: (note: string, inMs: number) => void; stop: () => void;
  /** Chain the minion on another's work (create_ticket's start_after), its brief held in a `chain` row; meetChain is the check finding that work in. */
  chain: (brief: string) => void; meetChain: () => void;
  quiet: (what: string, also?: () => boolean) => Promise<void>; restart: () => Runner;
};
type Flow = {
  name: string;
  /** Runs the one outbox beside each runner (wake_at on it), as server.ts does. */
  outbox?: boolean;
  /** Hooks both the flow's runner and every restarted one get (a person's Claude accounts, say). */
  setup?: (store: Store, projectId: number) => (r: Runner) => void;
  steps: { name: string; run: (c: Ctx) => Promise<void> }[];
};

/** The outbox's kinds beside a runner, as server.ts registers them: wake_at, and LiveWaiters' (a chain's start sends its brief on the runner). */
function kinds(store: Store, r: Runner, outbox: Outbox) {
  const wakes = new TimedWakes(store, outbox);
  const waiters = new LiveWaiters(store, root, null, () => {}, outbox);
  waiters.sendBrief = (c, why, repeat) => chainedStep(c, why, { store, runner: r }, repeat);
  return { wakes, waiters };
}

const FLOWS: Flow[] = [
  {
    name: 'a plain turn with a message queued behind it',
    steps: [
      { name: 'Cara asks for a turn', run: async (c) => {
        setRelease(null);
        c.say('Cara', 'build it');
        await until('the turn to start', () => c.runner.isRunning(c.id));
      } },
      { name: 'Josh queues a message behind it', run: async (c) => {
        c.say('Josh', 'also add a test');
        await sleep(50);
      } },
      { name: 'the turn ends and the queued message runs', run: async (c) => {
        const before = turnsRun();
        setRelease('ok');
        await c.quiet('the queued turn', () => turnsRun() === before + 2);
      } },
    ],
  },
  {
    name: 'a usage-limit wait and its resume',
    steps: [
      { name: 'the turn hits the usage limit', run: async (c) => {
        setRelease(LIMIT);
        c.say('Cara', 'go');
        await c.quiet('the limit wait', () => !!c.runner.limitWait(c.id));
      } },
      { name: 'a message is held for the resume', run: async (c) => {
        c.say('Cara', 'held through the wait');
        await sleep(30);
      } },
      { name: 'the limit resets and the resume restores the session, then runs', run: async (c) => {
        // A stored session file this login's folder lacks: the resume restores it off the event loop first (A2's gap).
        c.store.putClaudeState({ path: `projects/ra/${c.id}.jsonl`, project_id: c.store.getTicket(c.id)!.project_id, ticket_id: c.id, size: 2, mtime: Date.now(), data: gzipSync('{}') });
        setRelease('ok');
        c.store.setSetting('limit-resumes', c.store.getSetting<any[]>('limit-resumes')!.map((w) => ({ ...w, at: Date.now() })));
        const before = turnsRun();
        (c.runner as any).limitResumeNext();
        await c.quiet('the resume', () => turnsRun() === before + 1 && !c.runner.limitWait(c.id));
      } },
    ],
  },
  {
    name: 'a switch to the other Claude account',
    setup: (store, projectId) => {
      const pat = store.createUser({ name: 'Pat', login: 'pat1290' });
      store.addMember(projectId, pat.id);
      const labels = [{ n: 1, label: 'one@x' }, { n: 2, label: 'two@x' }];
      const s = { inUse: 1, limited: new Map<number, number>() };
      return (r) => {
        r.personOf = (author) => (author === 'Pat' ? pat.id : null);
        r.placeFor = () => (s.inUse === 1 ? { host: true } : { host: true, account: 2, configDir: join(root, 'acct-2'), env: { CLAUDE_CONFIG_DIR: join(root, 'acct-2'), FAKE_RESULT: 'ok' } });
        r.claudeAccounts = () => ({ inUse: s.inUse, accounts: labels });
        r.onLimit = (_p, n, until) => {
          s.limited.set(n, until);
          const next = labels.find((a) => !s.limited.has(a.n)) ?? null;
          if (next) s.inUse = next.n;
          return { next, resetAt: Math.min(...s.limited.values()), limits: labels.filter((a) => s.limited.has(a.n)).map((a) => ({ ...a, until: s.limited.get(a.n)! })) };
        };
        r.onCleared = () => {};
      };
    },
    steps: [
      { name: 'the turn hits its account\'s limit and carries on with the next account', run: async (c) => {
        setRelease(LIMIT);
        const before = turnsRun();
        c.say('Pat', 'go');
        await c.quiet('the turn on account 2', () => turnsRun() === before + 2);
      } },
    ],
  },
  {
    name: 'held mail released',
    steps: [
      { name: 'a relay is held as mail for the cold session', run: async (c) => {
        c.mail('Taskmaster', 'held: build 3 merged');
        await sleep(30);
      } },
      { name: 'the cold sweep releases it into a turn', run: async (c) => {
        setRelease('ok');
        const before = turnsRun();
        c.runner.coldSweep();
        await c.quiet('the mail\'s turn', () => turnsRun() === before + 1);
      } },
    ],
  },
  {
    name: 'mail held for a parked minion, and its unpark',
    steps: [
      { name: 'the minion is parked and Josh leaves it a message', run: async (c) => {
        c.store.updateTicket(c.id, { state: 'parked' });
        c.hold('Josh', 'for when you are back');
        await sleep(30);
      } },
      { name: 'Cara unparks it and the turn reads the message', run: async (c) => {
        setRelease('ok');
        const before = turnsRun();
        c.runner.unpark(c.id, 'Cara', 'Cara');
        await c.quiet('the unparked turn', () => turnsRun() === before + 1);
      } },
    ],
  },
  {
    name: 'a stop drops the queue but keeps held mail',
    steps: [
      { name: 'Cara asks for a turn, and a message and some mail wait behind it', run: async (c) => {
        setRelease(null);
        c.say('Cara', 'build it');
        await until('the turn to start', () => c.runner.isRunning(c.id));
        c.say('Josh', 'dropped by the stop');
        c.mail('Taskmaster', 'held: kept through the stop');
        await sleep(50);
      } },
      { name: 'Cara stops the turn', run: async (c) => {
        c.stop();
        setRelease('ok');
        await c.quiet('the stopped turn to end');
      } },
      { name: 'Cara carries on, and the mail rides along', run: async (c) => {
        const before = turnsRun();
        c.say('Cara', 'carry on');
        await c.quiet('the next turn', () => turnsRun() === before + 1);
      } },
    ],
  },
  {
    name: 'a turn cut off by a restart, and its resume',
    steps: [
      { name: 'Cara asks for a turn', run: async (c) => {
        setRelease(null);
        c.say('Cara', 'build it');
        c.say('Josh', 'and the readme');
        await until('the turn to start', () => c.runner.isRunning(c.id));
      } },
      { name: 'the server dies mid-turn, and the next one resumes it', run: async (c) => {
        await crash(c.runner, c.id);
        setRelease('ok');
        const before = turnsRun();
        const next = c.restart();
        next.recover();
        await c.quiet('the resume', () => turnsRun() === before + 1);
      } },
    ],
  },
  {
    name: 'a wake_at comes due on an idle minion',
    outbox: true,
    steps: [
      { name: 'the minion sets a wake', run: async (c) => {
        setRelease('ok');
        c.wake('wake: check the deploy', 600);
        await sleep(30);
      } },
      { name: 'it comes due and its turn runs', run: async (c) => {
        const before = turnsRun();
        await c.quiet('the wake\'s turn', () => turnsRun() === before + 1);
      } },
    ],
  },
  {
    name: 'a wake_at due mid-turn waits behind the turn',
    outbox: true,
    steps: [
      { name: 'Cara asks for a turn', run: async (c) => {
        setRelease(null);
        c.say('Cara', 'build it');
        await until('the turn to start', () => c.runner.isRunning(c.id));
      } },
      { name: 'a wake comes due while it runs', run: async (c) => {
        c.wake('wake: mid-turn', 100);
        // timing-ok: waits for the wake's 100 ms due time to pass while the turn runs (an elapsed-time requirement)
        await sleep(300);
      } },
      { name: 'the turn ends and the wake\'s turn runs', run: async (c) => {
        const before = turnsRun();
        setRelease('ok');
        await c.quiet('the wake\'s turn', () => turnsRun() === before + 2);
      } },
    ],
  },
  {
    name: 'a chained minion\'s brief starts it once its leader\'s work is in',
    outbox: true,
    steps: [
      { name: 'the Taskmaster chains the minion on another\'s work', run: async (c) => {
        setRelease('ok');
        c.chain('build part two');
        await sleep(30);
      } },
      { name: 'the leader\'s work ships and the brief starts the minion', run: async (c) => {
        const before = turnsRun();
        c.meetChain();
        await c.quiet('the brief\'s turn', () => turnsRun() === before + 1);
      } },
    ],
  },
  // Seam review R3, R4, R6 (#1283, #1452): what a turn sets at its start or mid-turn and reads later survives a cut.
  {
    name: 'a Taskmaster turn a minion\'s relay started, cut off and resumed',
    steps: [
      { name: 'a minion relays an ask', run: async (c) => {
        setRelease(null);
        c.relay('please start part two');
        await until('the turn to start', () => c.runner.isRunning(c.id));
      } },
      { name: 'the server dies mid-turn, and the next one resumes it', run: async (c) => {
        await crash(c.runner, c.id);
        setRelease('ok');
        const before = turnsRun();
        const next = c.restart();
        next.recover();
        await c.quiet('the resume', () => turnsRun() === before + 1);
      } },
    ],
  },
  {
    name: 'a minion held on start_after answers a message, cut off and resumed',
    setup: () => (r) => {
      r.heldFor = () => '#9 ships';
    },
    steps: [
      { name: 'the minion is held on another\'s work', run: async (c) => {
        c.store.updateTicket(c.id, { state: 'parked', note: 'waits on #9' });
      } },
      { name: 'Cara asks the held minion something', run: async (c) => {
        setRelease(null);
        c.say('Cara', 'a question while you wait');
        await until('the turn to start', () => c.runner.isRunning(c.id));
      } },
      { name: 'the turn sets its own state', run: async (c) => {
        c.store.updateTicket(c.id, { state: 'ready', note: 'answered' });
      } },
      { name: 'the server dies mid-turn, and the next one resumes it', run: async (c) => {
        await crash(c.runner, c.id);
        setRelease('ok');
        const before = turnsRun();
        const next = c.restart();
        next.recover();
        await c.quiet('the resume', () => turnsRun() === before + 1);
        const t = c.store.getTicket(c.id)!;
        assert.deepEqual([t.state, t.note], ['parked', 'waits on #9'], 'still parked once the resumed turn ends');
      } },
    ],
  },
  {
    name: 'a reply with a status trailer',
    steps: [
      { name: 'the turn replies with a trailer and ends', run: async (c) => {
        setReply('done <!-- status: {"state":"ready","note":"read me","replies":["Ship it"]} -->');
        setRelease('ok');
        const before = turnsRun();
        c.say('Cara', 'go');
        await c.quiet('the turn', () => turnsRun() === before + 1);
      } },
    ],
  },
];

/** The server dies mid-turn and its turn goes with it, as in auto-resume.test.ts. */
async function crash(r: Runner, id: number) {
  const dir: string = (r as any).turns.get(id).dir;
  await until('the turn\'s pid.json', () => existsSync(join(dir, 'pid.json')));
  r.detachAll();
  clearTimeout((r as any).limitTimer);
  const { wrapper, claude } = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8'));
  for (const pid of [wrapper, -claude]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  await until('the killed wrapper to go', () => !existsSync(`/proc/${wrapper}`) || !readFileSync(`/proc/${wrapper}/cmdline`, 'utf8').includes(dir));
}

function makeRunner(store: Store, hooks?: (r: Runner) => void) {
  const r = new Runner(store, () => {}, () => ({}), fake);
  r.resumeGapMs = 1;
  r.pollMs = 10;
  r.limitDelayMs = 0;
  r.limitGapMs = 0;
  r.limitProvenGapMs = 0;
  hooks?.(r);
  return r;
}

/** A point a restart could land on: the store's copy there, and what the uncut run had done by then. */
type Cut = { n: number; dir: string; step: number; what: string; mem: Mem };
/** What the uncut runner held in memory for the minion's turn at a cut (R3, R4, R6). */
type Mem = { from?: number; parkedAs?: { state: string | null; note: string | null }; status?: object };
type Logged = { kind: 'sent' | 'start' | 'dropped'; texts: string[]; at: number; step: number };

/**
 * Copies the store at every event-loop task boundary after a task that wrote to it. A restart lands between tasks
 * (the server's SIGTERM handler is itself one), so a cut inside a task would test a state no restart can leave.
 */
class Recorder {
  cuts: Cut[] = [];
  log: Logged[] = [];
  step = 0;
  error: unknown = null;
  /** The uncut runner's per-turn memory, taken with each cut. */
  probe: () => Mem = () => ({});
  private changes: () => number;
  private last: number;
  private settings = new Map<string, string>();
  private lastEvent = 0;
  private status = '';
  private micro = new Set<number>();
  private hook = createHook({
    init: (id, type) => void (['PROMISE', 'TickObject', 'Microtask'].includes(type) && this.micro.add(id)),
    before: (id) => void (!this.micro.has(id) && this.boundary()),
    destroy: (id) => void this.micro.delete(id),
  });

  private store: Store;
  private id: number;
  private dir: string;

  constructor(store: Store, id: number, dir: string) {
    this.store = store;
    this.id = id;
    this.dir = dir;
    const q = store.db.prepare('SELECT total_changes() AS n');
    this.changes = () => Number((q.get() as { n: number }).n);
    this.last = this.changes();
    this.describe(); // the starting point, so the first cut's label says only what changed
    if (!process.env.RESTART_ANYWHERE_LOOSE) {
      const s = store as any;
      for (const name of [...WRITES, ...VALUE_WRITES, 'putClaudeState'].filter((n) => typeof s[n] === 'function')) {
        const write = s[name].bind(store);
        s[name] = (...args: unknown[]) => {
          const out = write(...args);
          this.boundary();
          return out;
        };
      }
    }
  }

  start() {
    this.hook.enable();
  }

  stop() {
    this.boundary();
    this.hook.disable();
  }

  boundary() {
    try {
      const n = this.changes();
      if (n === this.last) return;
      this.last = n;
      const dir = join(this.dir, `cut-${this.cuts.length}`);
      mkdirSync(dir);
      this.store.db.exec(`VACUUM main INTO '${join(dir, 'test.db')}'; VACUUM state INTO '${join(dir, 'state.db')}'`);
      this.cuts.push({ n: this.cuts.length, dir, step: this.step, what: this.describe(), mem: structuredClone(this.probe()) });
    } catch (err) {
      // An async hook that throws ends the process: kept, and the flow fails on it.
      this.error ??= err;
    }
  }

  /** What changed since the last cut: settings keys, the minion's status, and the events added. */
  private describe(): string {
    const parts: string[] = [];
    const now = new Map((this.store.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    const set = [...now].filter(([k, v]) => this.settings.get(k) !== v).map(([k]) => k);
    const gone = [...this.settings.keys()].filter((k) => !now.has(k));
    if (set.length) parts.push(`set ${set.join(', ')}`);
    if (gone.length) parts.push(`deleted ${gone.join(', ')}`);
    this.settings = now;
    const t = this.store.getTicket(this.id);
    const status = `${t?.status}${t?.state ? `/${t.state}` : ''}`;
    if (this.status && status !== this.status) parts.push(`status ${this.status} → ${status}`);
    this.status = status;
    const events = this.store.db.prepare('SELECT id, kind, data FROM events WHERE id > ? ORDER BY id').all(this.lastEvent) as { id: number; kind: string; data: string }[];
    for (const e of events) {
      const text = String(JSON.parse(e.data)?.text ?? '').replace(/\s+/g, ' ');
      if (['note', 'user_message', 'error'].includes(e.kind)) parts.push(`${e.kind} "${text.length > 50 ? `${text.slice(0, 50)}…` : text}"`);
      else parts.push(e.kind);
    }
    if (events.length) this.lastEvent = Number(events.at(-1)!.id);
    return parts.join('; ') || 'other rows';
  }

  /** Messages sent before cut `n` and not yet handed to a turn that started, nor dropped by a stop (a wake's note is inside the text it sends). */
  held(n: number): string[] {
    const handed = this.log.filter((l) => l.kind !== 'sent' && l.at <= n).flatMap((l) => l.texts);
    return this.log.filter((l) => l.kind === 'sent' && l.at <= n).flatMap((l) => l.texts).filter((t) => !handed.some((h) => h.includes(t)));
  }

  /** The turn the uncut run started after cut `n` in the same step, which a restart there still owes. */
  owed(n: number): Logged | undefined {
    return this.log.find((l) => l.kind === 'start' && l.at > n && l.step === this.cuts[n].step);
  }
}

/** Run `flow` uncut, copying the store at every cut; returns the recorder and the hooks restarted runners get. */
async function record(flow: Flow) {
  const dir = join(root, flow.name.replace(/\W+/g, '-'));
  mkdirSync(dir);
  setReply(null);
  const store = new Store(join(dir, 'test.db'));
  const project = store.createProject('Test', null);
  const hooks = flow.setup?.(store, project.id);
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle' });
  const leader = store.createTicket({ project_id: project.id, title: 'L', permission_mode: 'default', created_by: 'Cara' }); // a chain's (made before the recorder watches)
  const rec = new Recorder(store, t.id, dir);
  const watch = (r: Runner) => {
    const start = (r as any).startTurn.bind(r);
    (r as any).startTurn = (p: unknown, ticket: { id: number }, batch: Msg[], ...rest: unknown[]) => {
      const out = start(p, ticket, batch, ...rest);
      // Handed over once its turn is saved (startTurn writes turn: before it returns); a turn that didn't start hands nothing.
      if (ticket.id === t.id && r.isRunning(t.id)) rec.log.push({ kind: 'start', texts: batch.map((m) => m.text), at: rec.cuts.length, step: rec.step });
      return out;
    };
    return r;
  };
  const outboxes: Outbox[] = [];
  let wakes: TimedWakes | null = null;
  let waiters: LiveWaiters | null = null;
  const withOutbox = (r: Runner) => {
    if (!flow.outbox) return r;
    outboxes.at(-1)?.stop();
    const outbox = new Outbox(store, r, { author: 'Citadel' });
    r.onTurnStart = (ticketId, ids) => outbox.turnStarted(ticketId, ids);
    ({ wakes, waiters } = kinds(store, r, outbox));
    outboxes.push(outbox);
    void outbox.boot();
    return r;
  };
  const runners = [withOutbox(watch(makeRunner(store, hooks)))];
  const ctx: Ctx = {
    runner: runners[0], store, id: t.id,
    say: (author, text) => {
      rec.log.push({ kind: 'sent', texts: [text], at: rec.cuts.length, step: rec.step });
      ctx.runner.send(t.id, author, text);
    },
    relay: (text) => {
      rec.log.push({ kind: 'sent', texts: [text], at: rec.cuts.length, step: rec.step });
      ctx.runner.send(t.id, 'Minion', text, [], { from: leader.id });
    },
    wake: (note, inMs) => {
      rec.log.push({ kind: 'sent', texts: [note], at: rec.cuts.length, step: rec.step });
      wakes!.add(t.id, Date.now() + inMs, note, 'Minion');
    },
    chain: (brief) => {
      rec.log.push({ kind: 'sent', texts: [brief], at: rec.cuts.length, step: rec.step });
      waiters!.chain({ ticket: t.id, after: leader.id, when: 'merged', message: brief, from: 'Taskmaster', base: null });
    },
    meetChain: () => {
      const [row] = store.listDeliveries({ kind: 'chain', to: t.id, states: ['waiting'] });
      assert.ok(outboxes.at(-1)!.meet(row.id, { why: `#${leader.number}'s work has shipped` }));
    },
    mail: (from, text) => {
      rec.log.push({ kind: 'sent', texts: [text], at: rec.cuts.length, step: rec.step });
      ctx.runner.relays.mail(t.id, from, text, undefined, true); // held for a cold session
    },
    hold: (author, text) => {
      rec.log.push({ kind: 'sent', texts: [text], at: rec.cuts.length, step: rec.step });
      ctx.runner.send(t.id, author, text, [], { hold: true }); // held for a parked minion
    },
    stop: () => {
      // A stop drops what was queued on purpose: those messages are owed to nobody.
      rec.log.push({ kind: 'dropped', texts: ctx.runner.queue.msgs(t.id).map((m) => m.text), at: rec.cuts.length, step: rec.step });
      ctx.runner.stop(t.id);
    },
    quiet: async (what, also = () => true) => {
      await until(what, () => !ctx.runner.isRunning(t.id) && !(ctx.runner as any).lanes.busy(t.id) && also(), 15_000);
      await sleep(30); // anything it set off on its way out
    },
    restart: () => {
      ctx.runner = withOutbox(watch(makeRunner(store, hooks)));
      runners.push(ctx.runner);
      return ctx.runner;
    },
  };
  rec.probe = () => {
    const r = ctx.runner as any;
    return { from: r.turnFrom.get(t.id), parkedAs: r.parkedAs.get(t.id), status: r.statuses.get(t.id) };
  };
  rec.start();
  try {
    for (const [i, step] of flow.steps.entries()) {
      rec.step = i;
      await step.run(ctx);
    }
  } finally {
    rec.stop();
    for (const o of outboxes) o.stop();
    for (const r of runners) {
      r.detachAll();
      clearTimeout((r as any).limitTimer);
    }
  }
  if (rec.error) throw rec.error;
  // Each held message the flow sent reached a turn in the end: otherwise the flow, not a restart, lost it.
  assert.deepEqual(rec.held(rec.cuts.length), [], `${flow.name}: the uncut run left messages unsent`);
  store.db.close();
  return { rec, hooks, id: t.id };
}

/** A server started on cut `cut`'s copy: what it does for the minion, and what that breaks. */
async function restartAt(flow: Flow, rec: Recorder, cut: Cut, id: number, hooks?: (r: Runner) => void): Promise<string[]> {
  const store = new Store(join(cut.dir, 'test.db'));
  const r = makeRunner(store, hooks);
  const started: Msg[][] = [];
  (r as any).startTurn = (_p: unknown, ticket: { id: number }, batch: (Msg & { id?: number })[]) => {
    if (ticket.id !== id) return;
    started.push(batch);
    r.onTurnStart(id, batch.flatMap((m) => (m.id == null ? [] : [m.id]))); // as the real one does once the turn is saved
  };
  (r as any).reattach = () => false; // its turn died with the old server
  const outbox = flow.outbox ? new Outbox(store, r, { author: 'Citadel' }) : null;
  if (outbox) {
    r.onTurnStart = (ticketId, ids) => outbox.turnStarted(ticketId, ids);
    kinds(store, r, outbox);
  }
  const problems: string[] = [];
  const saved = store.getSetting<{ keepalive?: true; result?: { error: boolean } }>(`turn:${id}`);
  const owedBefore = !!r.queue.get(id).owed;
  try {
    r.recover();
    void outbox?.boot();
    // Settled: a turn started, or its lane stayed free past recover's spaced starts.
    const t0 = Date.now();
    for (let free = 0; !started.length && free < 3;) {
      await sleep(5);
      free = (r as any).lanes.busy(id) || Date.now() - t0 < 20 ? 0 : free + 1;
      if (Date.now() - t0 > 5_000) {
        problems.push('it never settled: its lane stayed busy for 5 s');
        break;
      }
    }
    const t = store.getTicket(id)!;
    // Per-turn values the old server held (#1452): a cut-off turn's resume still has them, and a held minion stays parked.
    const { from, parkedAs, status } = cut.mem;
    if (saved && !saved.keepalive && from !== undefined && r.relayedBy(id) !== from) problems.push(`its turn answered #${from}'s relay, but now answers ${r.relayedBy(id) ?? 'no one'}'s`);
    if (saved && !saved.keepalive && status && started.length && !isDeepStrictEqual((r as any).statuses.get(id), status)) problems.push(`its reply's status trailer ${JSON.stringify(status)} is lost`);
    // shortcut: from its turn record's delete to the put-back, a finished turn's end is one task, so only a hard crash
    // (not a restart) lands there, and it leaves the turn's own state; checked where a turn record or owed resume holds it.
    const parkedNow = (r as any).parkedAs.get(id) ?? { state: t.state, note: t.note };
    if (parkedAs && (saved || owedBefore) && !isDeepStrictEqual(parkedNow, parkedAs)) problems.push(`it was parked as ${JSON.stringify(parkedAs)}, but is now ${JSON.stringify(parkedNow)} with nothing to put that back`);
    // A cut after its result line (2A1): its reply is in, so it ends there and is not told to carry on.
    if (saved?.result && !saved.result.error && started.some((b) => b[0]?.text === RESUME_PROMPT)) problems.push('its reply was in, but it was resumed');
    const limit = r.limitWait(id);
    const net = r.netWait(id);
    const q = r.queue.get(id);
    const queue = q.msgs ?? [];
    const mail = q.held ?? [];
    // The outbox's rows still to send: its timer waits on them, or a delivery is queued on the minion's lane.
    const rows = store.listDeliveries({ to: id, states: ['waiting', 'held', 'sending'] });
    const armed = outbox && ((outbox as any).timer || (outbox as any).busy.size);
    // A sending row is rechecked on its due: sent again (marked) unless the runner still holds it. One not yet met waits on its
    // event (a chain on its leader's work: the check, a dismissal or a deploy meets it), not on a time.
    const onEvent = (d: (typeof rows)[number]) => d.state !== 'sending' && d.met_at == null && d.when_kind !== 'at';
    for (const d of rows) if (d.due == null && !onEvent(d)) problems.push(`delivery #${d.id} is left ${d.state} with no time to look at it again`);
    const outboxWait = rows.length && armed ? 'the outbox timer' : null;
    const waiting = limit ? 'the usage-limit resume' : net ? 'the network probe' : mail.length && q.coldAt ? 'the cold-mail sweep' : mail.length && r.parked(t) ? 'its unpark' : outboxWait;
    // A saved wait is only a wait if its timer is armed (the cold sweep and an unpark come from outside the runner).
    if (limit && !(r as any).limitTimer) problems.push('its usage-limit wait is saved, but no timer is armed to resume it');
    if (net && !(r as any).netTimer) problems.push('its network wait is saved, but no probe is armed');
    // The one invariant (#1378): every message sent is in a turn that started, in the minion's queue record, or in an outbox row still to send
    // (armed, or a chain's brief waiting on its leader's work).
    const carried = [...started.flat(), ...queue, ...mail, ...(q.taken ?? []), ...(q.steered ?? []).map((s) => s.msg)].map((m) => m.text);
    carried.push(...rows.filter((d) => armed || onEvent(d)).map((d) => String(d.payload.note ?? d.payload.message)));
    for (const text of rec.held(cut.n)) if (!carried.some((c) => c.includes(text))) problems.push(`lost "${text}": no turn, queue record or outbox row has it`);
    if (!started.length && !waiting) {
      const owed = rec.owed(cut.n);
      if (owed) problems.push(`owed a turn (the uncut run started one next, with ${JSON.stringify(owed.texts.map((x) => x.slice(0, 40)))}) but it sits idle`);
      if (t.status === 'running') problems.push('its status says running, with no turn');
      if (queue.length) problems.push(`${queue.length} message(s) queued with nothing to run them`);
      if (mail.length) problems.push('held mail with no cold time and not parked: nothing will release it');
      if (q.taken?.length) problems.push(`a taken batch (${q.taken.length} message(s)) with no turn to finish it`);
      if (q.owed) problems.push('a resume is owed but nothing will start it');
      for (const key of [`turn:${id}`, `saving:${id}`]) if (store.getSetting(key) !== null) problems.push(`${key} is left with nothing acting on it`);
    }
  } finally {
    outbox?.stop();
    r.detachAll();
    clearTimeout((r as any).limitTimer);
    await sleep(0);
    store.db.close();
    rmSync(cut.dir, { recursive: true, force: true });
  }
  return problems.map((p) => `${flow.name}, cut ${cut.n + 1} of ${rec.cuts.length} (step "${flow.steps[cut.step].name}", after: ${cut.what}): ${p}`);
}

for (const flow of FLOWS) {
  test(`a restart at any saved step of "${flow.name}" strands nothing`, { skip: !!process.env.RESTART_ANYWHERE_ONLY && process.env.RESTART_ANYWHERE_ONLY !== flow.name }, async () => {
    const { rec, hooks, id } = await record(flow);
    assert.ok(rec.cuts.length > 1, 'the flow wrote at more than one step');
    const problems: string[] = [];
    if (process.env.RESTART_ANYWHERE_DEBUG) console.log(rec.cuts.map((c) => `${c.n} [${c.step}] ${c.what}`).join('\n'), JSON.stringify(rec.log));
    for (const cut of rec.cuts) problems.push(...(await restartAt(flow, rec, cut, id, hooks)));
    assert.deepEqual(problems, []);
  });
}
