// #1778: the ship line when two things happen at once, or the server stops half way: two moves, two hand-offs, two ships
// taking a number, a restart at each step of a ship's report. Nothing sleeps or races for real: each interleaving is made,
// by a write the database's worker holds, a kill after a named step, or a command that does its work at a known point.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { writeOffThread, type Writer } from '../src/db-writer.ts';
import { HttpError } from '../src/http.ts';
import { LandHandoffs, Landings, type HandoffDeps } from '../src/land.ts';
import { LandsInFlight } from '../src/release-readers.ts';
import { Releases, type TargetView } from '../src/releases.ts';
import { moveShip, seqsFor, shipFirst } from '../src/ship-line.ts';
import { placedKey, readState } from '../src/ship-line-state.ts';
import { git, gitAt } from './git.ts';
import { addReview, agentToken, bootServer } from './helpers.ts';
import { until } from './wait.ts';

const root = mkdtempSync(join(tmpdir(), 'ship-line-races-'));
const writers: Writer[] = [];
after(async () => {
  for (const w of writers) await w.stop();
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});
const PATH = process.env.PATH!;
const HELD = 600_000; // a write the database's worker holds past the end of any test
const CARA = { name: 'Cara', taskmaster: false };
const JOSH = { name: 'Josh', taskmaster: false };
const TM = { name: 'Delve Taskmaster', taskmaster: true };

// ---- two moves at once

const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
const me = `${process.pid} ${stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]}`;
let made = 0;
/** A scheme whose ship line holds #1 (shipping) and #2 on, waiting; `held`: the database's worker writes nothing. */
function line(waiting: number, held = false) {
  const dir = join(root, `line-${++made}`),
    repo = join(dir, 'repo'),
    q = join(repo, '.git', 'land-queue');
  mkdirSync(join(repo, 'tools'), { recursive: true });
  const store = new Store(join(dir, 'a.db'));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'tools', 'land.sh'), '#!/usr/bin/env bash\nqueue_order() {\n  :\n}\n');
  git(repo, 'add', '-A');
  gitAt(Date.now(), repo, 'commit', '-q', '-m', 'init');
  const p = store.createProject('Delve', 'https://github.com/o/x');
  store.setProjectRepoDir(p.id, repo);
  mkdirSync(q);
  const ids = new Map<number, number>();
  const join1 = (seq: number) => {
    const t = store.createTicket({ project_id: p.id, title: `Change ${seq}`, permission_mode: 'default', created_by: 'cara' });
    store.setTicketDir(t.id, dir, `ticket/${seq}-c`);
    addReview(store, t.id);
    ids.set(seq, t.id);
    const holds = seq === 1;
    writeFileSync(join(q, String(seq).padStart(10, '0')), [me, holds ? '1795067420' : '0', `ticket/${seq}-c`, holds ? 'waiting for CI' : 'waiting', '-', '-', '-', 'order', ''].join('\n'));
  };
  for (let seq = 1; seq <= waiting + 1; seq++) join1(seq);
  const found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', numbering: { name: 'Build {n}', number: 'run' } };
  const lands = new LandsInFlight({ store, finder: { list: () => [found] } as never, landings: { handoffs: () => [...ids.values()], get: () => ({ output: 'queue: next in line\n', code: null }) }, now: () => 1000 });
  const reader = {
    read: () => {
      const vs = [{ target: { id: found.id, projectId: p.id, name: 'Windows', kind: 'ci', link: null }, current: null, next: null, line: [], recent: [] }] as unknown as TargetView[];
      lands.attach(vs);
      return vs;
    },
  };
  const releases = new Releases({ store, readers: [reader as never], testCopies: () => new Map(), broadcast: () => {} });
  releases.poll();
  if (held) writers.push(writeOffThread(store, { delayMs: HELD, readWaitMs: 1 })!);
  const app = { store, releases, waits: undefined };
  const entries = () => {
    releases.poll();
    return releases.view(() => true)[0].targets.flatMap((t) => t.line);
  };
  const waitingNow = () => entries().filter((e) => !e.holds);
  return {
    app,
    p,
    q,
    ids,
    join: join1,
    leave: (seq: number) => rmSync(join(q, String(seq).padStart(10, '0'))),
    entries,
    order: () => waitingNow().map((e) => e.seq),
    pins: () => {
      const { placed } = readState(store, p.id);
      return new Map(waitingNow().flatMap((e) => (placed[placedKey(e)] && !placed[placedKey(e)].taskmaster ? [[e.seq, placed[placedKey(e)].by] as const] : [])));
    },
    history: () => readState(store, p.id).history.map((h) => h.text),
    file: () => (existsSync(join(q, '.order')) ? readFileSync(join(q, '.order'), 'utf8') : null),
  };
}
const refusal = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    assert.ok(e instanceof HttpError, String(e));
    return e.message;
  }
};

test('two people move ships at once, before either move is written down: both hold, and the Taskmaster already sees both pins', () => {
  const s = line(4, true);
  moveShip(s.app, s.p.id, 5, [5, 2, 3, 4], CARA);
  // Josh's page still shows the line from before Cara's move.
  moveShip(s.app, s.p.id, 4, [4, 2, 3, 5], JOSH);
  assert.deepEqual(s.order(), [4, 5, 2, 3], 'the last mover is in front, and the first keeps its place behind it');
  assert.deepEqual([...s.pins()].sort(), [
    [4, 'Josh'],
    [5, 'Cara'],
  ]);
  assert.equal(s.history().length, 2, 'neither move is lost from the history');
  assert.match(refusal(() => moveShip(s.app, s.p.id, 5, seqsFor(s.entries(), 5, 2), TM))!, /placed by Cara/);
  assert.match(refusal(() => moveShip(s.app, s.p.id, 3, seqsFor(s.entries(), 3), TM))!, /past .*which (Cara|Josh) placed/);
  assert.equal(shipFirst(s.app, s.p.id, s.ids.get(3)!, TM, 'fixes a red test'), 'refused');
  assert.deepEqual(s.order(), [4, 5, 2, 3]);
});

test('two moves of one ship at once: the last one places it, and it is pinned once', () => {
  const s = line(3, true);
  moveShip(s.app, s.p.id, 4, [4, 2, 3], CARA);
  moveShip(s.app, s.p.id, 4, [2, 4, 3], JOSH);
  assert.deepEqual(s.order(), [2, 4, 3]);
  assert.deepEqual([...s.pins()], [[4, 'Josh']]);
});

test('a ship that takes the lock between the page showing it and its move is not moved, and nothing else is', () => {
  const s = line(3);
  moveShip(s.app, s.p.id, 4, [4, 2, 3], CARA);
  const was = s.file();
  const f = join(s.q, '0000000004');
  writeFileSync(f, readFileSync(f, 'utf8').replace('\n0\n', '\n1795067421\n'));
  assert.equal(
    refusal(() => moveShip(s.app, s.p.id, 4, [2, 4, 3], JOSH)),
    'That change is no longer waiting in line to ship',
  );
  assert.equal(s.file(), was);
  assert.equal(s.history().length, 1);
});

// Any mix of people, the Taskmaster, ships joining and ships leaving: the rules every one of them keeps.
test('whatever people and the Taskmaster do to a line at once, no ship is lost, and no Taskmaster move takes a ship past one a person placed', () => {
  for (const seed of [1, 2, 3, 4]) {
    let x = seed * 2654435761;
    const pick = (k: number) => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) % k;
    };
    const s = line(5);
    let last = 6,
      moves = 0,
      refusals = 0;
    for (let i = 0; i < 24; i++) {
      const was = s.order(),
        pins = s.pins(),
        file = s.file();
      const what = pick(8);
      const at = `seed ${seed} step ${i}`;
      if (what === 0 || was.length < 3) {
        s.join(++last);
        assert.deepEqual(s.order(), [...was, last], `${at}: a new ship joins at the back`);
        continue;
      }
      const moved = was[pick(was.length)];
      if (what === 1) {
        s.leave(moved);
        assert.deepEqual(
          s.order(),
          was.filter((n) => n !== moved),
          `${at}: a ship that leaves moves nobody else`,
        );
        continue;
      }
      const rest = was.filter((n) => n !== moved),
        to = pick(was.length);
      const asked = [...rest.slice(0, to), moved, ...rest.slice(to)];
      const by = what < 5 ? TM : what === 5 ? CARA : JOSH;
      const no = refusal(() => moveShip(s.app, s.p.id, moved, asked, by));
      const now = s.order();
      assert.deepEqual([...now].sort(), [...was].sort(), `${at}: the same ships`);
      if (by.taskmaster) {
        for (const pin of pins.keys()) for (const n of was.filter((o) => o !== pin)) assert.equal(now.indexOf(n) < now.indexOf(pin), was.indexOf(n) < was.indexOf(pin), `${at}: the Taskmaster took #${n} past #${pin}, which ${pins.get(pin)} placed`);
        assert.deepEqual(s.pins(), pins, `${at}: the Taskmaster's move takes no pin`);
      } else {
        assert.equal(no, null, `${at}: a person's move is never refused`);
        assert.equal(s.pins().get(moved), by.name, at);
      }
      if (no === null) {
        moves++;
        assert.deepEqual(now, asked, `${at}: it went where it was asked`);
      } else {
        refusals++;
        assert.deepEqual(now, was, `${at}: refused, so nothing moved`);
        assert.equal(s.file(), file, at);
      }
    }
    assert.ok(moves > 4 && refusals > 0, `seed ${seed} made ${moves} moves and ${refusals} refusals: too few to prove anything`);
  }
});

// ---- the queue's own files (tools/deploy-queue.sh)

const queueSh = resolve('tools/deploy-queue.sh');
/** A folder of commands that run `body` first, in place of the real one; `$REAL` is the real one. */
function command(dir: string, name: string, body: string) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const real = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\nREAL=${real}\n${body}\nexec "$REAL" "$@"\n`);
  chmodSync(join(bin, name), 0o755);
  return bin;
}
/** A ship in line: it says its ticket, holds the lock until `go`, and leaves. */
function ship(dir: string, label: string, env: Record<string, string> = {}) {
  const script = join(dir, 'ship.sh');
  if (!existsSync(script)) writeFileSync(script, `set -eu\nsource ${queueSh}\nqueue_lock "$1" "$2" || exit 1\necho "$2 $(basename "$DEPLOY_QUEUE_TICKET") in" >>"$1/log"\nuntil [ -e "$1/go" ]; do read -rt 0.05 <> <(:) || :; done\necho "$2 out" >>"$1/log"\nqueue_done ok\n`);
  const p = spawn('bash', [script, dir, label], { env: { PATH, HOME: dir, DEPLOY_QUEUE_POLL: '0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const done = new Promise<number | null>((ok) => p.on('close', ok));
  return { done, err: () => err };
}
const ended = (dir: string) => readFileSync(join(dir, 'log'), 'utf8').trim().split('\n');

test('two ships take a number at once: the second waits for the first to have its ticket, and they ship one at a time in that order', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(root, 'numbers-'));
  // The first ship stops half way, its number read and its ticket not written, until the second is at the same place.
  const bin = command(dir, 'cat', `case "$*" in */.seq) echo "$PPID" >>${dir}/reading; until [ -e ${dir}/number ]; do read -rt 0.05 <> <(:) || :; done ;; esac`);
  // The number's lock, when it is taken already, says so before it is waited for.
  command(dir, 'flock', `[ "$*" != 8 ] || "$REAL" -n 8 || echo x >>${dir}/held`);
  const readers = () => readFileSync(join(dir, 'reading'), 'utf8').trim().split('\n').length;
  const a = ship(dir, 'ticket/1-a', { PATH: `${bin}:${PATH}` });
  await until('the first to read the number', () => existsSync(join(dir, 'reading')));
  const b = ship(dir, 'ticket/2-b', { PATH: `${bin}:${PATH}` });
  try {
    await until('the second at the number', () => existsSync(join(dir, 'held')) || readers() > 1);
    assert.equal(readers(), 1, 'the second reads the number only once the first is done with it');
    writeFileSync(join(dir, 'number'), '');
    await until('both in line', () => readdirSync(join(dir, 'queue')).filter((f) => /^\d{10}$/.test(f)).length === 2);
  } finally {
    // Red or green, both go on and end.
    writeFileSync(join(dir, 'number'), '');
    writeFileSync(join(dir, 'go'), '');
    await Promise.all([a.done, b.done]);
  }
  assert.deepEqual([await a.done, await b.done], [0, 0], a.err() + b.err());
  assert.deepEqual(ended(dir), ['ticket/1-a 0000000001 in', 'ticket/1-a out', 'ticket/2-b 0000000002 in', 'ticket/2-b out']);
});

// Found by #1778: the retry rewrites .order from what it read, over whatever was written since.
test('a drag that lands while a ship goes back into line for its retry is kept', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(root, 'retry-')),
    q = join(dir, 'queue');
  mkdirSync(q);
  // #1 goes back into line for a retry in place; #2 and #3 wait. A person drags #3 ahead of #2 while #1 rewrites the order.
  for (const n of [2, 3]) writeFileSync(join(q, String(n).padStart(10, '0')), [me, '0', `ticket/${n}-c`, 'waiting', 'order', ''].join('\n'));
  writeFileSync(join(q, '0000000001'), [me, '0', 'ticket/1-c', 'retrying', 'order', ''].join('\n'));
  writeFileSync(join(q, '.order'), '# Cara moved #2 to ship next\n0000000002\n0000000003\n');
  // The drag is the server's own writeOrder, started as the script is about to replace .order; the script goes on once
  // that write is done, or is waiting for the script's lock.
  const waits = resolve(import.meta.dirname, '../src/waits.ts');
  writeFileSync(join(dir, 'drag.mjs'), `import { writeOrder } from '${waits}';\nwriteOrder('${q}', [2, 3].map((seq) => ({ seq, got: 0, orders: true })), [3, 2], 'Josh moved #3 to ship next');\n`);
  const bin = command(
    dir,
    'mv',
    `case "$*" in *.tmp*/.order) if [ ! -e ${dir}/dragged ]; then : >${dir}/dragged; { PATH=${dir}/server:$PATH ${process.execPath} ${dir}/drag.mjs; echo $? >${dir}/done; } </dev/null >${dir}/drag.log 2>&1 9>&- 8>&- & until [ -e ${dir}/done ] || [ -e ${dir}/waiting ]; do read -rt 0.05 <> <(:) || :; done; fi ;; esac`,
  );
  // The server's flock says so when the lock is taken, before it waits for it.
  command(join(dir, 'held'), 'flock', `"$REAL" -n "$3" true || : >${dir}/waiting`);
  renameSync(join(dir, 'held', 'bin'), join(dir, 'server'));
  const p = spawnSync('bash', ['-c', `source ${queueSh}\nqueue_lock ${dir} ticket/1-c`], { env: { PATH: `${bin}:${PATH}`, HOME: dir, QUEUE_KEEP: join(q, '0000000001'), DEPLOY_QUEUE_POLL: '0.1' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(p.status, 0, p.stderr);
  assert.ok(existsSync(join(dir, 'dragged')), 'the drag came between the read of the order and its write');
  await until('the drag written', () => existsSync(join(dir, 'done')));
  assert.equal(readFileSync(join(dir, 'done'), 'utf8').trim(), '0', readFileSync(join(dir, 'drag.log'), 'utf8'));
  assert.deepEqual(
    readFileSync(join(q, '.order'), 'utf8')
      .split('\n')
      .filter((l) => /^000000000[23]$/.test(l)),
    ['0000000003', '0000000002'],
  );
});

// ---- two hand-offs at once, and a restart mid-hand-off

const H = { summary: 'Usage bar.', risk: 'low' as const, reason: 'front end only' };
const LIVE = 'land: main is now at abc1234 "#9: usage bar"\ndeploy: live now: the server reloaded the front end (v2); open tabs reload when idle. No restart.\n';
const RESTART = 'land: main is now at def5678 "#9: server bit"\ndeploy: restart queued as citadel-restart: running turns carry on through it, and it reports here\ndeploy: not live yet after 75 s; the restart reports here\n';
const FAILED = "land: ticket/7-x won't rebase onto main cleanly, so nothing landed; conflicted files: a.txt\n";

/** A data folder and worktree, what the server did for minion 1's ship, and servers on it: `server(null)` runs until killed. */
function handoff(opts: { running?: boolean } = {}) {
  const dir = mkdtempSync(join(root, 'handoff-')),
    data = join(dir, 'data'),
    cwd = join(dir, 'wt');
  mkdirSync(join(cwd, 'tools'), { recursive: true });
  const ticket = { number: 7, title: 'Usage bar', status: 'idle', state: 'outside' as string | null, note: null as string | null };
  const did: string[] = [];
  /** A server: after its `cut`th report step is saved it is dead, as a kill leaves it: nothing more it does counts. */
  function server(cut = Infinity) {
    const landings = new Landings(data);
    let marks = 0,
      dead = false;
    const alive =
      <A extends unknown[], R>(fn: (...a: A) => R) =>
      (...a: A): R => {
        if (dead) throw new Error('killed');
        return fn(...a);
      };
    const deps: HandoffDeps = {
      landings: new Proxy(landings, {
        get: (l, k) => {
          const v = Reflect.get(l, k);
          if (typeof v !== 'function') return v;
          if (k !== 'markReported') return alive(v.bind(l));
          return alive(async (...a: Parameters<Landings['markReported']>) => {
            await l.markReported(...a);
            if (++marks === cut) dead = true;
            alive(() => {})();
          });
        },
      }),
      store: { getTicket: alive(() => ticket), updateTicket: alive((_id, f) => void Object.assign(ticket, f)) },
      runner: {
        emit: alive((_id, _kind, d: { text?: string }) => void did.push(`line: ${d.text}`)) as HandoffDeps['runner']['emit'],
        send: alive((_id, _from, text) => void did.push(`message: ${text.split('\n')[0]}`)),
        unpark: alive(() => true),
        relayMinion: alive((_a, _b, _c, text) => {
          did.push(`owner told: ${text.split('\n')[0]}`);
          return false;
        }),
        close: alive(async () => {
          ticket.status = 'closed';
          did.push('closed');
        }),
        closeAfterTurn: alive(() => {
          did.push('closes after its turn');
          return true;
        }),
        keptOpen: alive(() => null),
        isRunning: alive(() => !!opts.running),
        queued: alive(() => 0),
        deployPending: alive(() => void did.push('pending-deploy')),
        deployLive: alive(() => {
          did.push('live');
          return true;
        }),
        broadcastTicket: () => {},
      },
      from: 'Citadel',
      buildOwner: () => 2,
      runnersBack: alive(() => true),
      liveAlready: async () => false,
      wakeWhenLive: alive(async () => {
        did.push('wakes when live');
        return true;
      }),
      flakes: alive(() => void did.push('flakes')),
      learned: alive(() => void did.push('learned')),
      landed: alive(() => void did.push('landed')),
    };
    return { landings, handoffs: new LandHandoffs(deps), marks: () => marks };
  }
  const script = (body: string) => writeFileSync(join(cwd, 'tools', 'land.sh'), body);
  return { data, cwd, did, ticket, server, script, env: { PATH } };
}

const reports: { what: string; out: string; code: number; h?: object; args?: string[] }[] = [
  { what: 'a ship that is live', out: LIVE, code: 0 },
  { what: 'a ship that waits for a restart', out: RESTART, code: 0 },
  { what: 'a ship with more of its brief to do', out: LIVE, code: 0, h: { stay_open: true } },
  { what: 'a ship that conflicts', out: FAILED, code: 1 },
  { what: 'a ship CI gave no verdict on', out: 'land: CI gave no verdict\n', code: 75 },
];
for (const c of reports)
  test(`${c.what}: a restart after any step of its report does the rest, and none of it twice`, async () => {
    const run = async (cut: number) => {
      const s = handoff();
      s.script(`printf '%b' ${JSON.stringify(c.out)}\nexit ${c.code}\n`);
      const first = s.server(cut);
      assert.ok(first.landings.handOff(1, s.cwd, s.env, c.args ?? [], { ...H, ...c.h }));
      await until('land.sh ends', () => first.landings.get(1)?.code !== null);
      await first.handoffs.poll();
      const second = s.server();
      await second.handoffs.poll();
      assert.deepEqual(await second.landings.pending(), [], `cut after step ${cut}: reported in the end`);
      return { did: s.did, marks: first.marks() };
    };
    const whole = await run(Infinity);
    assert.ok(whole.marks >= 2 && whole.did.length >= 2, `${whole.marks} steps: ${whole.did.join(', ')}`);
    for (let cut = 1; cut <= whole.marks; cut++) assert.deepEqual((await run(cut)).did, whole.did, `cut after step ${cut} of ${whole.marks}`);
  });

test('two hand-offs for a minion at once: one ships, and the other is told one already runs', async () => {
  const s = handoff();
  s.script('echo ran >>ran\nuntil [ -e go ]; do read -rt 0.05 <> <(:) || :; done\n');
  const { landings } = s.server();
  assert.deepEqual([landings.handOff(1, s.cwd, s.env, [], { ...H, summary: 'first' }), landings.handOff(1, s.cwd, s.env, [], { ...H, summary: 'second' })], [true, false]);
  const next = s.server().landings;
  assert.equal(next.handOff(1, s.cwd, s.env, [], { ...H, summary: 'third' }), false, 'nor does the next server take one while it runs');
  writeFileSync(join(s.cwd, 'go'), '');
  await until('land.sh ends', () => next.get(1)?.code !== null);
  assert.equal(next.handOff(1, s.cwd, s.env, [], { ...H, summary: 'fourth' }), false, 'nor once it ended and is not yet reported');
  assert.equal((await next.readHandoff(1))!.summary, 'first');
  assert.equal(readFileSync(join(s.cwd, 'ran'), 'utf8'), 'ran\n');
});

test('two hand-offs through the route at once: one is taken, one refused, and land.sh runs once', { timeout: 120_000 }, async () => {
  const srv = await bootServer();
  try {
    const store = new Store(join(srv.data, 'coordinator.db'));
    const project = store.createProject('P', null);
    const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
    const cwd = join(srv.root, 'wt');
    mkdirSync(join(cwd, 'tools'), { recursive: true });
    // Each call's --check waits until both calls are at it, so both are past every refusal before either starts the ship.
    writeFileSync(
      join(cwd, 'tools', 'land.sh'),
      `if [ "$1" = --check ]; then echo c >>${srv.root}/checks; until [ "$(wc -l <${srv.root}/checks)" -ge 2 ]; do read -rt 0.05 <> <(:) || :; done; exit 0; fi\necho ran >>${srv.root}/ran\nuntil [ -e ${srv.root}/go ]; do read -rt 0.05 <> <(:) || :; done\nprintf '%b' ${JSON.stringify(LIVE)}\n`,
    );
    git(cwd, 'init', '-q');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'init');
    store.setTicketDir(minion.id, cwd, null);
    addReview(store, minion.id);
    const token = agentToken(srv.data, minion.id);
    const call = async (summary: string) => {
      const r = await fetch(`${srv.base}/api/tickets/${minion.id}/land/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary, risk: 'low', risk_reason: 'front end only' }) });
      return { status: r.status, body: (await r.json()) as { error: string } };
    };
    const both = await Promise.all([call('one'), call('two')]);
    const [yes, no] = both.sort((a, b) => a.status - b.status);
    assert.ok(yes.status < 300, JSON.stringify(yes));
    assert.equal(no.status, 409);
    assert.match(no.body.error, /already runs for this minion/);
    assert.equal(store.getTicket(minion.id)!.state, 'outside', "the refused call leaves the first one's state alone");
    writeFileSync(join(srv.root, 'go'), '');
    const lines = () => store.listEvents(minion.id).filter((e) => JSON.stringify(e).includes('Shipped abc1234'));
    await until('the shipped line', () => lines().length > 0);
    await until('the minion closes', () => store.getTicket(minion.id)!.status === 'closed');
    assert.equal(lines().length, 1);
    assert.equal(readFileSync(join(srv.root, 'ran'), 'utf8'), 'ran\n');
  } finally {
    await srv.stop();
  }
});
