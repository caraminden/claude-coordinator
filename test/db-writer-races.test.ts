// #1778: the write worker (src/db-writer.ts) under concurrent writes, a worker that dies with a queue, and a crash between
// two saved records. Nothing here sleeps: a stalled disk is a write the worker holds (`delayMs`, longer than any test),
// a crash is a SIGKILL the child sends itself at a known point, and a failing write is a trigger that refuses it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { writeOffThread, type Writer } from '../src/db-writer.ts';
import { Store } from '../src/db.ts';
import { writes } from '../src/http.ts';
import { atWholeStep } from '../src/reader.ts';
import { until } from './wait.ts';

const root = mkdtempSync(join(tmpdir(), 'db-writer-races-'));
const writers: Writer[] = [];
// The worker is unref'd, as the server's is: awaiting its answer alone would let the process end first.
const awake = setInterval(() => {}, 1000);
after(async () => {
  for (const w of writers) await w.stop();
  clearInterval(awake);
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});

const HELD = 600_000; // a write held "for ever": the test ends, or kills the worker, long before
let n = 0;
/** `prep` runs on the store before the worker starts. */
function open(opts: { delayMs?: number; drainMs?: number } = {}, prep?: (store: Store) => void) {
  const dir = join(root, String(++n));
  mkdirSync(dir);
  const store = new Store(join(dir, 'coordinator.db'));
  prep?.(store);
  const w = writeOffThread(store, { readWaitMs: 1, ...opts })!;
  writers.push(w);
  return { store, w };
}
const minion = (store: Store) => {
  const p = store.createProject(`p${n}`, null);
  return store.createTicket({ project_id: p.id, title: 'a minion', permission_mode: 'default', created_by: 'cara' });
};
/** What the file holds, read by a connection of its own. */
const onDisk = (path: string): Record<string, unknown> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'race-%' ORDER BY key").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  } finally {
    db.close();
  }
};
const outcome = (p: unknown) =>
  (p as Promise<void>).then(
    () => 'written',
    (e: Error) => e.message,
  );
/** A trigger that refuses a write, as a full disk or a broken row would: `when` is a WHEN clause. */
const refuse = (store: Store, name: string, on: string, when = '1') => store.db.exec(`CREATE TRIGGER ${name} BEFORE ${on} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`);

// Every kind of write the server mixes: sent to the worker, run here after the queue, run here in a transaction that
// commits or rolls back, and one whose argument can't be copied to the worker. The model applies each as it is called.
function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
test('whatever writes many requests mix, each reads what was written last, and the file ends as they were called', async () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { store, w } = open({ delayMs: seed % 2 });
    const rnd = mulberry(seed);
    const pick = (k: number) => Math.floor(rnd() * k);
    const model: Record<string, unknown> = {};
    const key = () => `race-${pick(4)}`;
    const log: string[] = [];
    let v = 0;
    const ops: ((k: string) => void)[] = [
      (k) => void (store.setSetting(k, ++v), (model[k] = v)),
      (k) => void (store.deleteSetting(k), delete model[k]),
      (k) => {
        const gone = key();
        store.setSettings({ [k]: ++v }, gone === k ? [] : [gone]);
        model[k] = v;
        if (gone !== k) delete model[gone];
      },
      // Direct SQL, as a rare path on the server's thread writes.
      (k) => {
        store.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(++v));
        model[k] = v;
      },
      // A function can't be copied to the worker: JSON drops it, and what is left is written here, after the queue.
      (k) => void (store.setSetting(k, { at: ++v, f: () => 0 }), (model[k] = { at: v })),
      (k) => {
        const keep = rnd() < 0.5,
          to = ++v;
        store.db.exec('BEGIN');
        store.setSetting(k, to);
        store.db.exec(keep ? 'COMMIT' : 'ROLLBACK');
        if (keep) model[k] = to;
      },
      // A get-then-set, as merge goes and turn nonces do.
      (k) => {
        const was = store.getSetting<unknown>(k);
        store.setSetting(k, [JSON.stringify(was)?.length ?? 0, ++v]);
        model[k] = [JSON.stringify(model[k] ?? null).length, v];
      },
    ];
    const request = async () => {
      for (let i = 0; i < 25; i++) {
        const k = key(),
          op = pick(ops.length);
        log.push(`${op} ${k}`);
        ops[op](k);
        const read = key();
        // A read here waits 1 ms at most, so most reads go on past queued writes: they must still see them.
        if (op !== 3 && op !== 5) assert.deepEqual(store.getSetting(read), model[read] ?? null, `seed ${seed}, ${read} after ${log.slice(-6).join(', ')}`);
        for (let hops = pick(3); hops > 0; hops--) await null; // another request's step runs between
      }
    };
    await Promise.all([request(), request(), request()]);
    assert.ok(w.drain());
    assert.deepEqual(onDisk(store.path), Object.fromEntries(Object.entries(model).sort(([a], [b]) => (a < b ? -1 : 1))), `seed ${seed}`);
  }
});

test('a write that fails in the middle of the queue fails alone: the ones around it land, and its value is not read back', async () => {
  const { store, w } = open({}, (s) => refuse(s, 'no_bad', 'INSERT ON settings', "NEW.key = 'race-bad'"));
  const got = [store.setSetting('race-a', 1), store.setSetting('race-bad', 2), store.setSetting('race-c', 3)].map(outcome);
  assert.deepEqual(await Promise.all(got), ['written', 'refused by the test', 'written']);
  assert.ok(w.drain());
  assert.equal(store.getSetting('race-bad'), null, 'a reader sees the file again, not the value that was refused');
  assert.deepEqual(onDisk(store.path), { 'race-a': 1, 'race-c': 3 });
});

test('a write that fails inside its own transaction leaves none of it, and the next write is not caught in it', async () => {
  const { store, w } = open({}, (s) => refuse(s, 'no_bad', 'INSERT ON settings', "NEW.key = 'race-bad'"));
  const got = [store.setSettings({ 'race-first': 1, 'race-bad': 2 }), store.setSetting('race-next', 3)].map(outcome);
  assert.deepEqual(await Promise.all(got), ['refused by the test', 'written']);
  assert.ok(w.drain());
  assert.deepEqual(onDisk(store.path), { 'race-next': 3 }, 'committed on its own: a connection of its own sees it');
});

// A worker can die with no 'exit' code of its own run (out of memory ends it as terminate() does).
test('a worker that dies with a queue: every queued write is told, and the server reads and writes the file as it is', async () => {
  const { store, w } = open({ delayMs: HELD }, (s) => s.setSetting('race-k', 'before'));
  const queued = ['a', 'b', 'c'].map((v) => outcome(store.setSetting('race-k', v)));
  const response = writes.landed!(true)!; // a response waiting for them
  assert.equal(store.getSetting('race-k'), 'c', 'queued: still the newest, as the caller wrote it');
  const dead = w.stop();
  // Written after the worker died, before the server has heard.
  const late = outcome(store.setSetting('race-late', 1));
  await dead;
  assert.deepEqual(await Promise.all([...queued, late]), Array(4).fill('the DB write worker stopped'), 'none is left waiting, none claims to be written');
  await response;
  assert.equal(w.queued(), 0);
  assert.equal(store.getSetting('race-k'), 'before', 'what the file holds: none of the lost writes');
  assert.equal(store.getSetting('race-late'), null);
  assert.equal(store.setSetting('race-k', 'after'), undefined, 'run here');
  assert.deepEqual(onDisk(store.path), { 'race-k': 'after' });
  const { top } = store.healthCount('db-writer-stopped', 0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(top, [{ detail: 'exit code 1, 4 queued writes lost', n: 1 }], 'and the health page says how many');
});

test('chat lines queued when the worker dies are lost whole, and the next line takes an id nobody has', async () => {
  const { store, w } = open({ delayMs: HELD });
  const t = minion(store);
  const a = store.addEvent(t.id, 'note', { text: 'a' });
  const b = store.addEvent(t.id, 'note', { text: 'b' });
  await w.stop();
  const c = store.addEvent(t.id, 'note', { text: 'c' });
  assert.ok(c.id > b.id && b.id > a.id, `an open tab has seen ${a.id} and ${b.id}, so c is past both: ${c.id}`);
  assert.deepEqual(
    store.listEvents(t.id).map((e) => e.id),
    [c.id],
  );
});

// Red on main when written (#1778): the gone mark is set only by the worker's own 'exit' handler, which these deaths skip.
// Its fix takes the skip off. Handoff: the shared folder's handoffs/db-writer-dead-worker-mark.md.
const GONE_MARK = 'found by #1778: a dead write worker is never marked gone';
test("once the worker is gone no reader thread answers on its own: the server writes in place, where a step can't be told from the next", { skip: GONE_MARK }, async () => {
  const { store, w } = open();
  const t = minion(store);
  await until('the step closes', () => w.shared[3] >= w.shared[4]);
  await w.stop();
  const reader = new Store(store.path, { reader: true });
  store.updateTicket(t.id, { title: 'half a step' });
  assert.equal(atWholeStep(reader.db, w.shared), null);
});

/** Run `body` in a process of its own (`store` and `w` are there), which kills itself as a crash would; its database. */
function crash(name: string, body: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  const path = join(dir, 'coordinator.db'),
    src = join(import.meta.dirname, '..', 'src');
  writeFileSync(
    join(dir, 'crash.ts'),
    `import { DatabaseSync } from 'node:sqlite';
     import { Store } from ${JSON.stringify(join(src, 'db.ts'))};
     import { writeOffThread } from ${JSON.stringify(join(src, 'db-writer.ts'))};
     const path = ${JSON.stringify(path)};
     const store = new Store(path);
     const w = writeOffThread(store);
     const die = () => process.kill(process.pid, 'SIGKILL');
     ${body}
     `,
  );
  const r = spawnSync(process.execPath, [join(dir, 'crash.ts')], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.signal, 'SIGKILL', r.stderr);
  return path;
}
/** The next server opens the file: whole, with its own worker. */
function reopen(path: string) {
  const store = new Store(path);
  const w = writeOffThread(store)!;
  writers.push(w);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  return { store, w };
}

test('a crash between two writes leaves the first and none of the second, and the next server goes on from there', () => {
  // Another connection holds the write lock, so the worker is stopped at the second write, whatever the box does.
  const path = crash(
    'between',
    `store.setSetting('race-1', 'saved');
     w.drain();
     const lock = new DatabaseSync(path);
     lock.exec('BEGIN IMMEDIATE');
     store.setSetting('race-2', 'lost');
     store.setSetting('race-3', 'lost');
     if (store.getSetting('race-3') !== 'lost') throw new Error('not read back');
     die();`,
  );
  assert.deepEqual(onDisk(path), { 'race-1': 'saved' });
  const { store, w } = reopen(path);
  assert.deepEqual([store.getSetting('race-1'), store.getSetting('race-2')], ['saved', null]);
  store.setSetting('race-2', 'again');
  assert.ok(w.drain());
  assert.deepEqual(onDisk(path), { 'race-1': 'saved', 'race-2': 'again' });
});

test("a crash inside a write's transaction leaves none of its records", () => {
  // The worker is inside setSettings' transaction, its first record written: the trigger never returns until the kill.
  const path = crash(
    'inside',
    `store.setSetting('race-0', 'saved');
     store.db.exec("CREATE TABLE gate (x)");
     store.db.exec("CREATE TRIGGER hold AFTER INSERT ON settings WHEN NEW.key = 'race-2' BEGIN INSERT INTO gate WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c WHERE x < 0; END");
     store.setSettings({ 'race-1': 1, 'race-2': 2, 'race-3': 3 });
     // The worker has the write lock once another connection can't have it: then it is inside the transaction.
     const other = new DatabaseSync(path, { timeout: 0 });
     for (;;) {
       try { other.exec('BEGIN IMMEDIATE'); other.exec('ROLLBACK'); } catch { break; }
     }
     die();`,
  );
  assert.deepEqual(onDisk(path), { 'race-0': 'saved' });
  const { store } = reopen(path);
  assert.equal(store.getSetting('race-1'), null);
});

test('a crash with a new minion half made leaves no minion and no chat line of it', () => {
  const path = crash(
    'minion',
    `const p = store.createProject('p', null);
     const t = store.createTicket({ project_id: p.id, title: 'kept', permission_mode: 'default', created_by: 'cara' });
     w.drain();
     store.db.exec('BEGIN');
     const half = store.createTicket({ project_id: p.id, title: 'half', permission_mode: 'default', created_by: 'cara' });
     store.setSetting('race-asker', half.id);
     die();`,
  );
  const { store } = reopen(path);
  const [p] = store.listProjects();
  assert.deepEqual(
    store.listTickets(p.id).map((t) => t.title),
    ['kept'],
  );
  assert.equal(store.getSetting('race-asker'), null);
  // Its number was never anyone's, so the next minion takes it.
  const next = store.createTicket({ project_id: p.id, title: 'next', permission_mode: 'default', created_by: 'cara' });
  assert.equal(next.number, store.listTickets(p.id).find((t) => t.title === 'kept')!.number! + 1);
});

// Methods that save several records as one thing. The last record is refused (a full disk, a crash there): the ones before
// it are not kept, or the next start finds half of it. `ready` makes the row set, `act` is the write, `see` what it changed.
const num = (name: string) => ({ project_id: 1, name, value: 1, unit: 's', workflow: 'w', run_id: 1, run_attempt: 1, sha: 'a', ref: 'main', created_at: 1 });
const slow = (id: number) => ({ at: 5, person: 'cara', device: 'desk', tab: 't', kind: 'request', what: `GET /${id}`, page: '', project_id: null, total_ms: 1, server_ms: null, network_ms: 0, tab_ms: 0 });
// The two skipped are red on main (#1778): handoffs/half-saved-records.md in the shared folder; its fix takes the skips off.
const HALF_SAVED = 'found by #1778: saved in several commits';
const manyRecords: { what: string; refuse: [on: string, when?: string]; ready: (s: Store) => void; act: (s: Store) => unknown; see: (s: Store) => unknown; skip?: string }[] = [
  {
    what: "a scheme's instructions and their history",
    refuse: ['INSERT ON instruction_history'],
    ready: (s) => s.createProject('p', null),
    act: (s) => s.setProjectInstructions(1, 'new', 'cara'),
    see: (s) => s.getProject(1)!.instructions,
  },
  {
    what: 'the Citadel-wide instructions and their history',
    refuse: ['INSERT ON app_instruction_history'],
    ready: () => {},
    act: (s) => s.setAppInstructions('new', 'cara'),
    see: (s) => s.appInstructions(),
  },
  {
    what: 'a removed person, the schemes handed on and their computer',
    refuse: ['DELETE ON users'],
    ready: (s) => {
      const gone = s.createUser({ name: 'Gone', login: 'gone' }),
        heir = s.createUser({ name: 'Heir', login: 'heir' });
      assert.deepEqual([gone.id, heir.id], [1, 2]);
      s.createProject('p', null);
      s.db.exec('UPDATE projects SET owner_id = 1');
      s.createMachine('box', 'hash', 'gone', 1);
      s.setMachineProjects(1, [1]);
    },
    act: (s) => s.deleteUser(1, 2),
    see: (s) =>
      ['SELECT owner_id FROM projects', 'SELECT owner_id FROM machines', 'SELECT * FROM machine_projects', 'SELECT id FROM users'].map((q) =>
        s.db
          .prepare(q)
          .all()
          .map((r) => ({ ...r })),
      ),
  },
  {
    what: 'the schemes a computer is lent to',
    refuse: ['INSERT ON machine_projects', 'NEW.project_id = 3'],
    ready: (s) => {
      for (const name of ['a', 'b', 'c']) s.createProject(name, null);
      s.createMachine('box', 'hash', 'cara');
      s.setMachineProjects(1, [1]);
    },
    act: (s) => s.setMachineProjects(1, [2, 3]),
    see: (s) =>
      s.db
        .prepare('SELECT project_id FROM machine_projects')
        .all()
        .map((r) => r.project_id),
  },
  {
    what: "a CI run's numbers",
    refuse: ['INSERT ON ci_numbers', "NEW.name = 'last'"],
    ready: (s) => s.createProject('p', null),
    act: (s) => s.putCiNumbers([num('first'), num('last')]),
    see: (s) => s.db.prepare('SELECT name FROM ci_numbers').all(),
  },
  {
    what: "a page's slow moments",
    refuse: ['INSERT ON slow_moments', "NEW.what = 'GET /2'"],
    ready: () => {},
    act: (s) => s.addSlowMoments([slow(1), slow(2)]),
    see: (s) => s.db.prepare('SELECT what FROM slow_moments').all(),
  },
  {
    what: "a page's saved entries",
    refuse: ['INSERT ON artifact_data', "NEW.key = 'last'"],
    ready: (s) => {
      s.createProject('p', null);
      s.writeArtifactData(1, 'a.html', [{ key: 'old', value: '"kept"' }], 'cara');
    },
    act: (s) =>
      s.writeArtifactData(
        1,
        'a.html',
        [
          { key: 'old', value: null },
          { key: 'first', value: '1' },
          { key: 'last', value: '2' },
        ],
        'cara',
      ),
    see: (s) =>
      s.db
        .prepare('SELECT key FROM artifact_data')
        .all()
        .map((r) => r.key),
  },
  {
    what: "a schedule's slot and its place in the history",
    skip: HALF_SAVED,
    refuse: ['UPDATE ON schedules'],
    ready: (s) => {
      s.createProject('p', null);
      s.schedules.create({ project_id: 1, name: 'Nightly', cron: '0 3 * * *', brief: 'b', type: 'chore', created_by: 'cara' }, 1_000);
    },
    act: (s) => s.schedules.ran(1, { skip: 'nothing moved' }, 2_000),
    see: (s) => s.schedules.runs(1).map((r) => r.skip),
  },
  {
    what: 'a minion and its chat, deleted',
    skip: HALF_SAVED,
    refuse: ['DELETE ON tickets'],
    ready: (s) => {
      const p = s.createProject('p', null);
      const t = s.createTicket({ project_id: p.id, title: 'a minion', permission_mode: 'default', created_by: 'cara' });
      s.addEvent(t.id, 'note', { text: 'kept' });
    },
    act: (s) => s.deleteTicket(1),
    see: (s) => s.listEvents(1).length,
  },
];
for (const c of manyRecords)
  test(`all or nothing: ${c.what}`, { skip: c.skip ?? false }, async () => {
    const { store, w } = open({}, (s) => {
      c.ready(s);
      refuse(s, 'last_record', ...c.refuse);
    });
    const was = c.see(store);
    let failed: unknown = null;
    try {
      await c.act(store);
    } catch (e) {
      failed = e;
    }
    assert.match(String(failed), /refused by the test/, 'the refused write says so');
    assert.ok(w.drain());
    const disk = new Store(store.path, { reader: true });
    assert.deepEqual(c.see(disk), was, 'none of it was kept');
    assert.equal((void store.setSetting('race-next', 1), store.db.isTransaction), false, 'no transaction left open');
    assert.ok(w.drain());
    assert.deepEqual(onDisk(store.path), { 'race-next': 1 });
  });
