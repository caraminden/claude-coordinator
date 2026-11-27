// Claims (#921): the pipeline lane and any other single-holder duty, as rows any Taskmaster reads and takes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { Claims, claimName } from '../src/claims.ts';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { agentToken, bootServer, mintedAgentToken, tempRoot, until, zoneLabel, type Booted } from './helpers.ts';
import { agentEnv, mcpAgent } from './mcp-agent.ts';

/** Claims on a bare database with schemes 1 and 2 (its rows reference projects). */
function bare() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE projects (id INTEGER PRIMARY KEY); INSERT INTO projects (id) VALUES (1), (2);');
  return new Claims(db);
}

test('a claim has one holder; the same holder retakes it, another is told who has it', () => {
  const claims = bare();
  const first = claims.take(1, 'pipeline-lane', 580, 'Josh', 'land.sh retry', 1000);
  assert.equal(first.held, undefined);
  assert.equal(first.claim.holder, 580);
  const other = claims.take(1, 'pipeline-lane', 600, 'Cara', '', 2000);
  assert.equal(other.held?.holder, 580, 'a second holder is refused and shown the first');
  const again = claims.take(1, 'pipeline-lane', 580, 'Josh', 'still on it', 3000);
  assert.equal(again.held, undefined);
  assert.equal(again.claim.note, 'still on it');
  assert.equal(again.claim.since, 1000, 'retaking keeps the original since');
  // Schemes don't share claims.
  assert.equal(claims.take(2, 'pipeline-lane', 700, 'Cara').held, undefined);
  assert.deepEqual(
    claims.list(1).map((c) => c.holder),
    [580],
  );
});

test('release frees a claim whoever holds it; a dismissed holder frees all of its', () => {
  const claims = bare();
  claims.take(1, 'pipeline-lane', 580, 'Josh');
  claims.take(1, 'release-train', 580, 'Josh');
  claims.take(1, 'db-migrations', 600, 'Cara');
  assert.equal(claims.release(1, 'db-migrations')?.holder, 600);
  assert.equal(claims.release(1, 'db-migrations'), undefined, 'releasing a free claim is a no-op');
  assert.deepEqual(
    claims.releaseHeldBy(580).map((p) => p.from.name),
    ['pipeline-lane', 'release-train'],
  );
  assert.deepEqual(claims.list(1), []);
});

// #1334: the queue is rows, not the note's text.
test('a claim passes to the first in its queue on release or dismissal, and is free once nobody waits', () => {
  const claims = bare();
  claims.take(1, 'pipeline-lane', 580, 'Josh', 'part B', 1000);
  // An old claim has an empty queue and nothing else changes.
  assert.deepEqual(claims.queue(1, 'pipeline-lane'), []);
  claims.setQueue(1, 'pipeline-lane', [601, 580, 602, 601], 'Cara', 1500);
  assert.deepEqual(claims.waiting(1, 'pipeline-lane'), [601, 602], 'the holder and repeats are left out');
  claims.setQueue(1, 'pipeline-lane', [602, 601, 603], 'Josh', 1600);
  assert.deepEqual(
    claims.queue(1, 'pipeline-lane').map((r) => [r.ticket, r.added_by]),
    [
      [602, 'Cara'],
      [601, 'Cara'],
      [603, 'Josh'],
    ],
    'a reorder keeps who queued each',
  );

  // Release: 602 holds it from now with a clear note; 580 is this run's first done step.
  const r = claims.passOn(1, 'pipeline-lane', 'released', 5000)!;
  assert.equal(r.from.holder, 580);
  assert.deepEqual([r.to!.holder, r.to!.since, r.to!.note], [602, 5000, '']);
  assert.deepEqual(
    claims.queue(1, 'pipeline-lane').map((q) => [q.ticket, q.done_at]),
    [
      [580, 5000],
      [601, null],
      [603, null],
    ],
  );

  // A waiting minion that is dismissed leaves the line; a dismissed holder passes it on.
  assert.deepEqual(claims.releaseHeldBy(601, 'dismissed', 6000), [], 'it held nothing');
  assert.deepEqual(claims.waiting(1, 'pipeline-lane'), [603]);
  const d = claims.releaseHeldBy(602, 'dismissed', 7000);
  assert.deepEqual(
    d.map((p) => [p.from.holder, p.to?.holder]),
    [[602, 603]],
  );
  assert.deepEqual(
    claims.queue(1, 'pipeline-lane').map((q) => q.ticket),
    [580, 602],
  );

  // Nobody waiting: free, and the run's rows go, so a new run starts at 0 done.
  assert.equal(claims.passOn(1, 'pipeline-lane', 'live', 9000)!.to, undefined);
  assert.equal(claims.get(1, 'pipeline-lane'), undefined);
  assert.deepEqual(claims.queue(1, 'pipeline-lane'), []);
  assert.equal(claims.passOn(1, 'pipeline-lane', 'released'), undefined, 'a free claim has nothing to pass');
  // Another scheme's claim of the same name is its own.
  claims.take(2, 'pipeline-lane', 700, 'Cara');
  claims.setQueue(2, 'pipeline-lane', [701], 'Cara');
  assert.deepEqual(claims.waiting(1, 'pipeline-lane'), []);
  assert.equal(claims.release(2, 'pipeline-lane')?.holder, 700);
  assert.equal(claims.get(2, 'pipeline-lane')?.holder, 701);
});

test('the time estimate is the median of recent holders, hidden below three', () => {
  const claims = bare();
  const hold = (holder: number, since: number, until: number) => {
    claims.take(1, 'pipeline-lane', holder, 'Cara', '', since);
    claims.passOn(1, 'pipeline-lane', 'live', until);
  };
  hold(1, 0, 100);
  hold(2, 200, 500);
  assert.equal(claims.estimate(1, 'pipeline-lane'), null, 'two holders is too little history');
  hold(3, 600, 1600);
  assert.deepEqual(claims.estimate(1, 'pipeline-lane'), { median: 300, of: 3 });
  hold(4, 2000, 2200);
  assert.deepEqual(claims.estimate(1, 'pipeline-lane'), { median: 250, of: 4 });
  assert.equal(claims.estimate(2, 'pipeline-lane'), null, 'each scheme has its own history');
});

test('claim names are hyphenated lowercase slugs', () => {
  assert.equal(claimName(' Pipeline-Lane '), 'pipeline-lane');
  for (const bad of ['', 'pipeline lane', 'lane;drop', '-lane', 'a'.repeat(41)]) assert.throws(() => claimName(bad), /lowercase words/);
});

test('a holder whose work shipped passes its claim on as shipped when dismissed, which the estimate counts', async () => {
  const scratch = tempRoot('claims-runner-');
  const dir = scratch.dir;
  try {
    const store = new Store(join(dir, 'test.db'));
    const runner = new Runner(
      store,
      () => {},
      () => ({}),
      '/bin/false',
    );
    const p = store.createProject('Shipped', null).id;
    const mk = (title: string) => store.createTicket({ project_id: p, title, permission_mode: 'default', created_by: 'Cara' });
    const [a, b, c, other] = [mk('A'), mk('B'), mk('C, chained'), mk('Not a holder')];
    const how = () =>
      new DatabaseSync(join(dir, 'test.db'), { readOnly: true })
        .prepare('SELECT holder, how FROM claim_spans ORDER BY rowid')
        .all()
        .map((r) => [r.holder, r.how]);
    store.claims.take(p, 'pipeline-lane', a.id, 'Cara');
    runner.holderShipped(a.id, 'c1');
    runner.holderShipped(other.id, 'c1');
    assert.deepEqual(
      store.claims.shippedClaims().map((c) => [c.holder, c.landed]),
      [[a.id, 'c1']],
      'only a holder is marked',
    );
    await runner.close(a.id, 'Shipped and live, so the server dismissed this minion.');
    store.claims.take(p, 'pipeline-lane', b.id, 'Cara');
    // C waits in the queue and on a start_after chain: the claim line waits with its brief, so the chain's start is its one wake.
    store.claims.setQueue(p, 'pipeline-lane', [c.id], 'Cara');
    runner.heldFor = (id) => (id === c.id ? "#2 B's work is live" : null);
    await runner.close(b.id, 'Cara dismissed this minion.');
    assert.equal(store.claims.get(p, 'pipeline-lane')?.holder, c.id);
    assert.match(JSON.stringify(store.getSetting<{ held?: string }>(`minion-queue:${c.id}`)?.held ?? null), /You hold the pipeline-lane claim now/);
    assert.equal(runner.isRunning(c.id), false, 'no turn of its own');
    assert.deepEqual(how(), [
      [a.id, 'live'],
      [b.id, 'dismissed'],
    ]);
    assert.deepEqual(store.claims.shippedClaims(), [], 'the mark goes with the claim');
  } finally {
    await scratch.teardown();
  }
});

// #1985: the lane sat idle while a holder stayed open after its change was live.
test("a claim passes on once its holder's ship is live, the holder still open", async () => {
  const scratch = tempRoot('claims-live-');
  try {
    const store = new Store(join(scratch.dir, 'test.db'));
    const runner = new Runner(
      store,
      () => {},
      () => ({}),
      '/bin/false',
    );
    const p = store.createProject('Lane', null).id;
    const mk = (title: string) => store.createTicket({ project_id: p, title, permission_mode: 'default', created_by: 'Cara' });
    const [a, b, c] = [mk('A'), mk('B'), mk('C')];
    const holder = () => store.claims.get(p, 'pipeline-lane')?.holder;
    const live = new Set<string>();
    const sweep = () => runner.holdersLive(async (_id, commit) => live.has(commit));
    // The next holders are held, so their line is mail and no turn starts.
    runner.heldFor = () => 'a chain';
    store.claims.take(p, 'pipeline-lane', a.id, 'Cara');
    store.claims.setQueue(p, 'pipeline-lane', [b.id, c.id], 'Cara');

    await sweep();
    assert.equal(holder(), a.id, 'nothing shipped');
    runner.holderShipped(a.id, 'a1');
    await sweep();
    assert.equal(holder(), a.id, 'shipped, not live');
    live.add('a1');
    await sweep();
    assert.equal(holder(), b.id);
    assert.notEqual(store.getTicket(a.id)!.status, 'closed', 'its holder stays open');
    assert.equal(store.claims.queue(p, 'pipeline-lane')[0].how, 'live');
    assert.match(JSON.stringify(store.eventsOfKinds(a.id, ['note'])), new RegExp(`passed to #${b.number}`));
    assert.equal(JSON.stringify(store.getSetting(`minion-queue:${b.id}`)).split('You hold the pipeline-lane claim now').length - 1, 1, 'the new holder hears it once');
    await sweep();
    assert.equal(holder(), b.id, 'a live seen twice passes it on once');

    // Back in line: the ship it already had live says nothing about its next time with the claim.
    store.claims.setQueue(p, 'pipeline-lane', [a.id, c.id], 'Cara');
    store.claims.release(p, 'pipeline-lane');
    await sweep();
    assert.equal(holder(), a.id, 'an old ship of its own does not count');

    // A claim that moves while the commit is being looked up stays where it went.
    runner.holderShipped(a.id, 'a1');
    await runner.holdersLive(async () => {
      store.claims.release(p, 'pipeline-lane');
      return true;
    });
    assert.equal(holder(), c.id);
    // Nobody waits: it is free.
    runner.holderShipped(c.id, 'a1');
    await sweep();
    assert.equal(holder(), undefined);
  } finally {
    await scratch.teardown();
  }
});

// #1902 ships two pieces back to back and keeps the lane between them.
test('a kept claim stays through its next live, once', () => {
  const claims = bare();
  const at = () => claims.get(1, 'pipeline-lane')!;
  claims.take(1, 'pipeline-lane', 580, 'Josh', 'two pieces', 1000, true);
  claims.setQueue(1, 'pipeline-lane', [601], 'Josh');
  claims.shipped(580, 'one');
  claims.shipped(580, 'one');
  assert.equal(at().landed, 'one', 'a ship reported twice (a restart mid-ship) is one ship');
  assert.equal(claims.holderLive(at(), ['one']), undefined);
  assert.deepEqual([at().holder, at().keep, at().landed], [580, 0, ''], 'the first piece is live: it keeps the claim, and the keep is used');
  claims.shipped(580, 'two');
  assert.equal(claims.holderLive(at(), [])?.to, undefined);
  assert.equal(claims.holderLive(at(), ['two'])?.to?.holder, 601, 'the second passes it on');

  // Both pieces live at once (one train): nothing is left to keep it for.
  claims.setQueue(1, 'pipeline-lane', [602], 'Josh');
  claims.take(1, 'pipeline-lane', 601, 'Josh', '', 2000, true);
  claims.shipped(601, 'three');
  claims.shipped(601, 'four');
  const both = at();
  assert.equal(claims.holderLive(both, ['three']), undefined);
  assert.equal(claims.holderLive(at(), ['four'])?.to?.holder, 602);
  claims.take(1, 'pipeline-lane', 602, 'Josh', '', 3000, true);
  claims.shipped(602, 'five');
  claims.shipped(602, 'six');
  claims.setQueue(1, 'pipeline-lane', [603], 'Josh');
  assert.equal(claims.holderLive(at(), ['five', 'six'])?.to?.holder, 603);
  assert.equal(at().keep, 0, "the next holder doesn't inherit it");

  // Kept, then taken back; a retake that doesn't say leaves it as it was.
  claims.take(1, 'pipeline-lane', 603, 'Josh', '', 4000, true);
  claims.take(1, 'pipeline-lane', 603, 'Josh', 'a note', 4000);
  assert.equal(at().keep, 1);
  claims.take(1, 'pipeline-lane', 603, 'Josh', '', 4000, false);
  claims.shipped(603, 'seven');
  claims.holderLive(at(), ['seven']);
  assert.equal(claims.get(1, 'pipeline-lane'), undefined);
});

test('a database from before #1985 gains its columns, its claim as it was but counted as handed off', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY); INSERT INTO projects (id) VALUES (1);
    CREATE TABLE claims (project_id INTEGER NOT NULL, name TEXT NOT NULL, holder INTEGER NOT NULL, taken_by TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', since INTEGER NOT NULL, PRIMARY KEY (project_id, name));
    INSERT INTO claims VALUES (1, 'pipeline-lane', 580, 'Josh', 'part B', 1000);`);
  const claims = new Claims(db);
  assert.deepEqual({ ...claims.get(1, 'pipeline-lane') }, { project_id: 1, name: 'pipeline-lane', holder: 580, taken_by: 'Josh', note: 'part B', since: 1000, landed: '', keep: 0, handed: 1, beside: 0, beside_since: 0, beside_handed: 0, beside_landed: '' });
  new Claims(db);
  assert.equal(claims.take(1, 'another', 580, 'Josh').claim.handed, 0, 'a new claim there starts as not handed off');
  claims.release(1, 'another');
  claims.shipped(580, 'one');
  assert.equal(claims.holderLive(claims.get(1, 'pipeline-lane')!, ['one'])?.from.holder, 580, 'held from before: its next live passes it on');
});

// Josh, 2026-11-25, "Ship together if no shared files" (#1985).
test('one beside the holder: its live ends its turn; the holder going first makes it the holder with what it shipped', () => {
  const claims = bare();
  const lane = () => claims.get(1, 'pipeline-lane')!;
  claims.take(1, 'pipeline-lane', 580, 'Josh', '', 1000);
  claims.setQueue(1, 'pipeline-lane', [601, 602, 603], 'Cara', 1000);
  assert.equal(claims.setBeside(lane(), 700, 1100), false, 'only one that waits');
  assert.equal(claims.setBeside(lane(), 602, 1100), true);
  assert.equal(claims.setBeside(lane(), 603, 1100), false, 'one at a time');
  // Its ship goes live first.
  claims.shipped(602, 'b1');
  assert.deepEqual([lane().landed, lane().beside_landed], ['', 'b1'], "kept apart from the holder's");
  assert.equal(claims.besideLive(lane(), ['other'], 1200), false);
  assert.equal(claims.besideLive(lane(), ['b1'], 1200), true);
  assert.deepEqual([lane().holder, lane().beside, lane().beside_landed, claims.waiting(1, 'pipeline-lane')], [580, 0, '', [601, 603]]);
  // The holder goes first: the one beside it is next, ahead of the line, and its own live passes it on.
  claims.setBeside(lane(), 603, 1300);
  claims.handedOff(603);
  claims.shipped(603, 'c1');
  claims.shipped(580, 'a1');
  assert.equal(claims.holderLive(lane(), ['a1'], 1400)!.to!.holder, 603);
  assert.deepEqual([lane().landed, lane().handed, lane().beside, lane().beside_handed, lane().beside_landed], ['c1', 1, 0, 0, '']);
  assert.equal(claims.holderLive(lane(), ['c1'], 1500)!.to!.holder, 601);
  assert.equal(lane().landed, '');
});

test('one beside the holder loses that place with its place in the queue', () => {
  const claims = bare();
  const lane = () => claims.get(1, 'pipeline-lane')!;
  claims.take(1, 'pipeline-lane', 580, 'Josh');
  claims.setQueue(1, 'pipeline-lane', [601, 602], 'Cara');
  claims.setBeside(lane(), 602);
  claims.shipped(602, 'b1');
  claims.setQueue(1, 'pipeline-lane', [602, 601], 'Cara');
  assert.deepEqual([lane().beside, lane().beside_landed], [602, 'b1'], 'a new order keeps it');
  claims.setQueue(1, 'pipeline-lane', [601], 'Cara');
  assert.deepEqual([lane().beside, lane().beside_landed], [0, '']);
  claims.setBeside(lane(), 601);
  claims.releaseHeldBy(601);
  assert.equal(lane().beside, 0);
  assert.equal(claims.release(1, 'pipeline-lane')?.holder, 580);
  assert.equal(claims.get(1, 'pipeline-lane'), undefined);
});

// The wiring: a server that comes up on a commit a holder shipped passes its claim on.
test('a server that comes up on the shipped commit passes the claim on, its holder open', async () => {
  const scratch = tempRoot('claims-boot-');
  const boot = await bootServer({ root: scratch.dir });
  try {
    const repo = join(import.meta.dirname, '..');
    const { data: p } = await boot.call('/api/projects', { name: 'Boot lane', repo_dir: repo });
    const mk = async (message: string) => (await boot.call(`/api/projects/${p.id}/tickets`, { message, properties: { type: 'chore' } })).data;
    const [a, b] = [await mk('one'), await mk('two')];
    const url = `/api/projects/${p.id}/claims`;
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal((await boot.call(url, { name: 'pipeline-lane', queue: [a.number, b.number] })).status, 201);
    const db = new DatabaseSync(join(scratch.dir, 'data', 'coordinator.db'), { timeout: 30_000 });
    db.prepare('UPDATE claims SET landed = ?').run(head);
    db.close();
    boot.proc.kill('SIGHUP');
    await until('the claim to pass on', async () => (await boot.call(url)).data.claims[0]?.holder_number === b.number);
    assert.notEqual((await boot.call(`/api/tickets/${a.id}`)).data.ticket.status, 'closed');
  } finally {
    await boot.stop();
    await scratch.teardown();
  }
});

const tmp = tempRoot('claims-api-');
const root = tmp.dir;
after(() => tmp.teardown());
let base = '';
let cookie = '';
let srv: Booted;
const call = (path: string, opts: { method?: string; body?: unknown; as?: number } = {}) => (opts.as === undefined ? srv.call : srv.as({ token: agentToken(join(root, 'data'), opts.as) }))(path, opts.body || undefined, opts.method ?? 'GET');
before(async () => {
  srv = await bootServer({ root, stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  tmp.track(srv.proc);
});

test('the Taskmaster claims the lane for a minion; minions only read; dismissing the holder frees it', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Lanes' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const tm = page.coordinator.id;
  const mk = async (message: string) => (await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message, properties: { type: 'chore' } } })).data;
  const a = await mk('fix land.sh');
  const b = await mk('fix deploy.sh');
  const url = `/api/projects/${p.id}/claims`;

  const took = await call(url, { method: 'POST', body: { name: 'pipeline-lane', minion: a.number, note: 'land retry' }, as: tm });
  assert.equal(took.status, 201, JSON.stringify(took.data));
  assert.equal(took.data.claim.holder_number, a.number);
  const busy = await call(url, { method: 'POST', body: { name: 'pipeline-lane', minion: b.number }, as: tm });
  assert.equal(busy.status, 409);
  assert.match(busy.data.error, new RegExp(`held by #${a.number}`));

  // A minion reads the claims but can't take one. Its first turn's token replaces the one read before it (#2199: a 401 under load).
  await mintedAgentToken(join(root, 'data'), b.id);
  assert.equal((await call(url, { as: b.id })).data.claims[0].name, 'pipeline-lane');
  assert.equal((await call(url, { method: 'POST', body: { name: 'pipeline-lane' }, as: b.id })).status, 403);

  // Its holder's dismissal frees it, and the Taskmaster hears so as held mail.
  // Its first turn (CLAUDE_BIN is /bin/false) has to end before it can be dismissed.
  let dismissed = await call(`/api/tickets/${a.id}/status`, { method: 'POST', body: { status: 'closed' } });
  await until(
    'its first turn to end so it can be dismissed',
    async () => {
      if (dismissed.status !== 409) return true;
      dismissed = await call(`/api/tickets/${a.id}/status`, { method: 'POST', body: { status: 'closed' } });
      return dismissed.status !== 409;
    },
    10_000,
  );
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.data));
  assert.deepEqual((await call(url, { as: tm })).data.claims, []);
  const { data: tmEvents } = await call(`/api/tickets/${tm}/events?after=0`);
  assert.ok(JSON.stringify(tmEvents).includes('pipeline-lane is free'), 'the Taskmaster is told the lane is free');

  // A Taskmaster's release tool frees one (people have no button); the Taskmaster's own claim holds it itself.
  await call(url, { method: 'POST', body: { name: 'release-train' }, as: tm });
  assert.equal((await call(url)).data.claims[0].holder, tm);
  const freed = await call(`${url}/release-train`, { method: 'DELETE', as: tm });
  assert.equal(freed.status, 200);
  assert.equal(freed.data.released.name, 'release-train');

  // A one-person scheme has no other Taskmasters, so its takes and releases leave no digest lines (R3: it stays as it was).
  const digest = new DatabaseSync(join(root, 'data', 'coordinator.db'), { readOnly: true, timeout: 30_000 });
  const lines = (digest.prepare('SELECT text FROM taskmaster_digest WHERE project_id = ? ORDER BY id').all(p.id) as { text: string }[]).map((r) => r.text);
  digest.close();
  assert.deepEqual(lines, []);
});

// #1985: one let in beside the holder that never handed off has to be told the claim is its own now.
test('one beside the holder is told when it becomes the holder, unless it handed off already', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Beside' } });
  const tm = (await call(`/api/projects/${p.id}`)).data.coordinator.id;
  const mk = async (message: string) => (await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message, properties: { type: 'chore' } } })).data;
  const [a, b, c] = [await mk('one'), await mk('two'), await mk('three')];
  const url = `/api/projects/${p.id}/claims`;
  const said = async (id: number) => JSON.stringify((await call(`/api/tickets/${id}/events?after=0`)).data).split('You hold the pipeline-lane claim now').length - 1;
  const beside = (id: number, handed: number) => {
    const db = new DatabaseSync(join(root, 'data', 'coordinator.db'), { timeout: 30_000 });
    db.prepare('UPDATE claims SET beside = ?, beside_handed = ? WHERE project_id = ?').run(id, handed, p.id);
    db.close();
  };
  assert.equal((await call(url, { method: 'POST', body: { name: 'pipeline-lane', queue: [a.number, b.number, c.number] } })).status, 201);
  beside(c.id, 0);
  await call(`${url}/pipeline-lane`, { method: 'DELETE', as: tm });
  assert.equal((await call(url)).data.claims[0].holder, c.id, 'the one beside goes first');
  assert.equal(await said(c.id), 1);
  beside(b.id, 1);
  await call(`${url}/pipeline-lane`, { method: 'DELETE', as: tm });
  assert.equal((await call(url)).data.claims[0].holder, b.id);
  assert.equal(await said(b.id), 0, 'its ship is running: a note only');
});

// #1334, in a scheme that isn't Citadel's: the queue passes the claim on by itself.
test('a queued claim passes to the next minion with one chat line when its holder is dismissed or it is released', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Queues' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const tm = page.coordinator.id;
  const mk = async (message: string) => (await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message, properties: { type: 'chore' } } })).data;
  const [a, b, c] = [await mk('part one'), await mk('part two'), await mk('part three')];
  const url = `/api/projects/${p.id}/claims`;
  const said = async (id: number) => JSON.stringify((await call(`/api/tickets/${id}/events?after=0`)).data).split('You hold the pipeline-lane claim now').length - 1;

  // A queue alone on a free claim, from a person: the first in line holds it and is told once.
  const took = await call(url, { method: 'POST', body: { name: 'pipeline-lane', queue: [a.number, b.number] } });
  assert.equal(took.status, 201, JSON.stringify(took.data));
  assert.equal(took.data.claim.holder_number, a.number);
  assert.equal(await said(a.id), 1, 'the first holder hears it');
  assert.deepEqual(
    took.data.claim.queue.map((q: { number: number }) => q.number),
    [b.number],
  );
  assert.deepEqual([took.data.claim.done, took.data.claim.total, took.data.claim.estimate], [0, 2, null], 'no history: no estimate');
  // The page reorders the line; a minion can't.
  assert.equal((await call(`${url}/pipeline-lane/queue`, { method: 'PUT', body: { queue: [c.number, b.number] } })).status, 200);
  assert.equal((await call(`${url}/pipeline-lane/queue`, { method: 'PUT', body: { queue: [] }, as: b.id })).status, 403);
  assert.deepEqual(
    (await call(url)).data.claims[0].queue.map((q: { number: number }) => q.number),
    [c.number, b.number],
  );

  // Dismissing the holder passes it to the first in line, who hears it once; the Taskmaster gets held mail.
  let dismissed = await call(`/api/tickets/${a.id}/status`, { method: 'POST', body: { status: 'closed' } });
  await until(
    'its first turn to end so it can be dismissed',
    async () => {
      if (dismissed.status !== 409) return true;
      dismissed = await call(`/api/tickets/${a.id}/status`, { method: 'POST', body: { status: 'closed' } });
      return dismissed.status !== 409;
    },
    10_000,
  );
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.data));
  const now = (await call(url)).data.claims[0];
  assert.equal(now.holder_number, c.number);
  assert.deepEqual(
    now.queue.map((q: { number: number; state: string }) => [q.number, q.state]),
    [
      [a.number, 'done'],
      [b.number, now.queue[1].state],
    ],
  );
  assert.equal(now.queue[0].how, 'dismissed', 'dismissed before it shipped');
  assert.deepEqual([now.done, now.total], [1, 3]);
  assert.equal(await said(c.id), 1, 'the new holder gets one line');
  assert.equal(await said(b.id), 0);
  assert.ok(JSON.stringify((await call(`/api/tickets/${tm}/events?after=0`)).data).includes(`pipeline-lane passed to #${c.number}`));

  // A release passes it on too; a second click from a page that saw the old holder is refused, not a second pass.
  // People can't release (the page has no button); the Taskmaster's tool can.
  assert.equal((await call(`${url}/pipeline-lane?holder=${c.number}`, { method: 'DELETE' })).status, 403);
  const rel = await call(`${url}/pipeline-lane?holder=${c.number}`, { method: 'DELETE', as: tm });
  assert.equal(rel.data.claim.holder_number, b.number);
  const again = await call(`${url}/pipeline-lane?holder=${c.number}`, { method: 'DELETE', as: tm });
  assert.equal(again.status, 409, JSON.stringify(again.data));
  assert.equal((await call(url)).data.claims[0].holder_number, b.number);
  assert.equal(await said(b.id), 1);
  assert.equal((await call(`${url}/pipeline-lane`, { method: 'DELETE', as: tm })).data.claim, undefined);
  assert.deepEqual((await call(url)).data.claims, []);
});

test("the Taskmaster's claim, release and list_claims tools, and list_tickets showing claims", async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Tools' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const { data: m } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'fix land.sh', title: 'Fix land.sh', properties: { type: 'chore' } } });
  const mcp = mcpAgent(agentEnv(base, agentToken(join(root, 'data'), page.coordinator.id), { id: page.coordinator.id, project_id: p.id }, 'coordinator'), tmp.track);
  const tool = async (name: string, args: object = {}) => (await mcp.tool(name, args)).text;
  assert.equal(await tool('list_claims'), 'No claims: every duty is free.');
  assert.match(await tool('claim', { name: 'pipeline-lane', minion: m.number, note: 'land retry' }), new RegExp(`^Claimed: pipeline-lane: #${m.number} .*since .* ${RegExp.escape(zoneLabel(srv.zone))} \\(land retry\\)$`)); // the server's zone (#1536)
  assert.match(await tool('claim', { name: 'pipeline-lane' }), /^Error: pipeline-lane is held by #/);
  assert.match(await tool('claim', { name: 'pipeline-lane', minion: m.number, keep: true }), /, kept through its next live$/);
  assert.match(await tool('claim', { name: 'pipeline-lane', queue: [], keep: true }), /^Error: keep goes with minion/);
  assert.match(await tool('list_tickets'), new RegExp(`\\nClaims:\\npipeline-lane: #${m.number} `));
  assert.match(await tool('release', { name: 'pipeline-lane' }), /^Released: pipeline-lane/);
  assert.match(await tool('claim', { name: 'release-train' }), /^Claimed: release-train: the Taskmaster, taken by /, 'a Taskmaster holding it is named, not #null');
  assert.equal(await tool('release', { name: 'pipeline-lane' }), 'Nobody held pipeline-lane.');
  // The queue (#1334): set it on a held claim, and list_claims shows it in order.
  const { data: n } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'next', title: 'Next', properties: { type: 'chore' } } });
  assert.match(await tool('claim', { name: 'release-train', queue: [m.number, n.number] }), new RegExp(`^Queue set: release-train: the Taskmaster, .*; queue: #${m.number}( \\(working\\))?, #${n.number}( \\(working\\))?; 0 of 3 done$`));
  assert.match(await tool('list_claims'), new RegExp(`queue: #${m.number}.*, #${n.number}`));
  assert.match(await tool('release', { name: 'release-train' }), new RegExp(`\\nNow: release-train: #${m.number} `));
});
