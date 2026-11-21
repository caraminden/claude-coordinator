// Claims (#921): the pipeline lane and any other single-holder duty, as rows any Taskmaster reads and takes.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { Claims, claimName } from '../src/claims.ts';
import { agentToken, bootServer, stopProcs, stopTurns, type Booted } from './helpers.ts';

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
  assert.deepEqual(claims.list(1).map((c) => c.holder), [580]);
});

test('release frees a claim whoever holds it; a dismissed holder frees all of its', () => {
  const claims = bare();
  claims.take(1, 'pipeline-lane', 580, 'Josh');
  claims.take(1, 'release-train', 580, 'Josh');
  claims.take(1, 'db-migrations', 600, 'Cara');
  assert.equal(claims.release(1, 'db-migrations')?.holder, 600);
  assert.equal(claims.release(1, 'db-migrations'), undefined, 'releasing a free claim is a no-op');
  assert.deepEqual(claims.releaseHeldBy(580).map((p) => p.from.name), ['pipeline-lane', 'release-train']);
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
  assert.deepEqual(claims.queue(1, 'pipeline-lane').map((r) => [r.ticket, r.added_by]), [[602, 'Cara'], [601, 'Cara'], [603, 'Josh']], 'a reorder keeps who queued each');

  // Release: 602 holds it from now with a clear note; 580 is this run's first done step.
  const r = claims.passOn(1, 'pipeline-lane', 'released', 5000)!;
  assert.equal(r.from.holder, 580);
  assert.deepEqual([r.to!.holder, r.to!.since, r.to!.note], [602, 5000, '']);
  assert.deepEqual(claims.queue(1, 'pipeline-lane').map((q) => [q.ticket, q.done_at]), [[580, 5000], [601, null], [603, null]]);

  // A waiting minion that is dismissed leaves the line; a dismissed holder passes it on.
  assert.deepEqual(claims.releaseHeldBy(601, 'dismissed', 6000), [], 'it held nothing');
  assert.deepEqual(claims.waiting(1, 'pipeline-lane'), [603]);
  const d = claims.releaseHeldBy(602, 'dismissed', 7000);
  assert.deepEqual(d.map((p) => [p.from.holder, p.to?.holder]), [[602, 603]]);
  assert.deepEqual(claims.queue(1, 'pipeline-lane').map((q) => q.ticket), [580, 602]);

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

const root = mkdtempSync(join(tmpdir(), 'claims-api-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
let base = '';
let cookie = '';
let srv: Booted;
const call = (path: string, opts: { method?: string; body?: unknown; as?: number } = {}) =>
  (opts.as === undefined ? srv.call : srv.as({ token: agentToken(join(root, 'data'), opts.as) }))(path, opts.body || undefined, opts.method ?? 'GET');
before(async () => {
  srv = await bootServer({ root, stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
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

  // A minion reads the claims but can't take one.
  assert.equal((await call(url, { as: b.id })).data.claims[0].name, 'pipeline-lane');
  assert.equal((await call(url, { method: 'POST', body: { name: 'pipeline-lane' }, as: b.id })).status, 403);

  // Its holder's dismissal frees it, and the Taskmaster hears so as held mail.
  // Its first turn (CLAUDE_BIN is /bin/false) has to end before it can be dismissed.
  let dismissed = await call(`/api/tickets/${a.id}/status`, { method: 'POST', body: { status: 'closed' } });
  for (let i = 0; i < 100 && dismissed.status === 409; i++) {
    await new Promise((r) => setTimeout(r, 100));
    dismissed = await call(`/api/tickets/${a.id}/status`, { method: 'POST', body: { status: 'closed' } });
  }
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.data));
  assert.deepEqual((await call(url, { as: tm })).data.claims, []);
  const { data: tmEvents } = await call(`/api/tickets/${tm}/events?after=0`);
  assert.ok(JSON.stringify(tmEvents).includes('pipeline-lane is free'), 'the Taskmaster is told the lane is free');

  // A person releases one on the page; the Taskmaster's own claim holds it itself.
  await call(url, { method: 'POST', body: { name: 'release-train' }, as: tm });
  assert.equal((await call(url)).data.claims[0].holder, tm);
  const freed = await call(`${url}/release-train`, { method: 'DELETE' });
  assert.equal(freed.status, 200);
  assert.equal(freed.data.released.name, 'release-train');

  // A one-person scheme has no other Taskmasters, so its takes and releases leave no digest lines (R3: it stays as it was).
  const digest = new DatabaseSync(join(root, 'data', 'coordinator.db'));
  const lines = (digest.prepare('SELECT text FROM taskmaster_digest WHERE project_id = ? ORDER BY id').all(p.id) as { text: string }[]).map((r) => r.text);
  digest.close();
  assert.deepEqual(lines, []);
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

  // A queue alone on a free claim: the first in line holds it.
  const took = await call(url, { method: 'POST', body: { name: 'pipeline-lane', queue: [a.number, b.number] }, as: tm });
  assert.equal(took.status, 201, JSON.stringify(took.data));
  assert.equal(took.data.claim.holder_number, a.number);
  assert.deepEqual(took.data.claim.queue.map((q: any) => q.number), [b.number]);
  assert.deepEqual([took.data.claim.done, took.data.claim.total, took.data.claim.estimate], [0, 2, null], 'no history: no estimate');
  // The page reorders the line; a minion can't.
  assert.equal((await call(`${url}/pipeline-lane/queue`, { method: 'PUT', body: { queue: [c.number, b.number] } })).status, 200);
  assert.equal((await call(`${url}/pipeline-lane/queue`, { method: 'PUT', body: { queue: [] }, as: b.id })).status, 403);
  assert.deepEqual((await call(url)).data.claims[0].queue.map((q: any) => q.number), [c.number, b.number]);

  // Dismissing the holder passes it to the first in line, who hears it once; the Taskmaster gets held mail.
  let dismissed = await call(`/api/tickets/${a.id}/status`, { method: 'POST', body: { status: 'closed' } });
  for (let i = 0; i < 100 && dismissed.status === 409; i++) {
    await new Promise((r) => setTimeout(r, 100));
    dismissed = await call(`/api/tickets/${a.id}/status`, { method: 'POST', body: { status: 'closed' } });
  }
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.data));
  const now = (await call(url)).data.claims[0];
  assert.equal(now.holder_number, c.number);
  assert.deepEqual(now.queue.map((q: any) => [q.number, q.state]), [[a.number, 'done'], [b.number, now.queue[1].state]]);
  assert.deepEqual([now.done, now.total], [1, 3]);
  assert.equal(await said(c.id), 1, 'the new holder gets one line');
  assert.equal(await said(b.id), 0);
  assert.ok(JSON.stringify((await call(`/api/tickets/${tm}/events?after=0`)).data).includes(`pipeline-lane passed to #${c.number}`));

  // A release passes it on too; with nobody left in line the next release frees it.
  const rel = await call(`${url}/pipeline-lane`, { method: 'DELETE' });
  assert.equal(rel.data.claim.holder_number, b.number);
  assert.equal(await said(b.id), 1);
  assert.equal((await call(`${url}/pipeline-lane`, { method: 'DELETE' })).data.claim, undefined);
  assert.deepEqual((await call(url)).data.claims, []);
});

test('the Taskmaster\'s claim, release and list_claims tools, and list_tickets showing claims', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Tools' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const { data: m } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'fix land.sh', title: 'Fix land.sh', properties: { type: 'chore' } } });
  const mcp = spawn(process.execPath, [join(import.meta.dirname, '../src/mcp.ts')], {
    env: { ...process.env, MACHINES_URL: undefined, COORDINATOR_API: base, COORDINATOR_TOKEN: agentToken(join(root, 'data'), page.coordinator.id), COORDINATOR_PROJECT: String(p.id), COORDINATOR_ROLE: 'coordinator', COORDINATOR_TICKET: String(page.coordinator.id) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  procs.push(mcp);
  const replies = new Map<number, (r: any) => void>();
  createInterface({ input: mcp.stdout! }).on('line', (l) => { const r = JSON.parse(l); replies.get(r.id)?.(r); });
  let next = 1;
  const tool = (name: string, args: object = {}) => new Promise<string>((resolve) => {
    const id = next++;
    replies.set(id, (r) => resolve(r.result.content[0].text));
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  assert.equal(await tool('list_claims'), 'No claims: every duty is free.');
  assert.match(await tool('claim', { name: 'pipeline-lane', minion: m.number, note: 'land retry' }), new RegExp(`^Claimed: pipeline-lane: #${m.number} .*since .* P[SD]T \\(land retry\\)$`));
  assert.match(await tool('claim', { name: 'pipeline-lane' }), /^Error: pipeline-lane is held by #/);
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
