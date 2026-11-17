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
import { agentToken, bootServer, stopProcs, stopTurns } from './helpers.ts';

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
  assert.deepEqual(claims.releaseHeldBy(580).map((c) => c.name), ['pipeline-lane', 'release-train']);
  assert.deepEqual(claims.list(1), []);
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
async function call(path: string, opts: { method?: string; body?: unknown; as?: number } = {}) {
  const auth: Record<string, string> = opts.as === undefined ? { Cookie: cookie } : { Authorization: `Bearer ${agentToken(join(root, 'data'), opts.as)}` };
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { ...auth, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}
before(async () => {
  const srv = await bootServer({ root, stdout: true });
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
});
