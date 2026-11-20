import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { bootServer, jsonLines, stopProcs, stopTurns, until, ok, type Booted } from './helpers.ts';

// The memory curator (#1111) through the real server: a run proposes with propose_memory's route, the card waits in its
// chat, a member applies the ticked changes on the Memory page's routes, the run is told, and Put back undoes it.
const root = mkdtempSync(join(tmpdir(), 'memory-curator-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});

const fakeClaude = join(root, 'claude-fake');
writeFileSync(fakeClaude, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', (prompt) => {
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ prompt: JSON.parse(prompt), token: process.env.COORDINATOR_TOKEN }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
chmodSync(fakeClaude, 0o755);

let base = '';
const cookies: Record<string, string> = {};
let ticket: any;
let project: any;
let dir = '';

let srv: Booted;
const call = async (who: string, path: string, opts: { method?: string; body?: unknown } = {}) =>
  ok(await srv.as(who === 'minion' ? { token: turns().filter((t) => t.token.startsWith(`${ticket.id}.`)).at(-1).token } : { cookie: cookies[who] })(path, opts.body || undefined, opts.method ?? 'GET'));
const turns = () => jsonLines(join(root, 'turns.jsonl'));
const idle = () => until('the turn to end', async () => (await call('Cara', `/api/tickets/${ticket.id}`)).ticket.status !== 'running');
const events = async (kind: string) => (await call('Cara', `/api/tickets/${ticket.id}/events?after=0`)).filter((e: any) => e.kind === kind).map((e: any) => JSON.parse(e.data));
const propose = (changes: unknown) => call('minion', `/api/tickets/${ticket.id}/memory-proposal`, { method: 'POST', body: { changes } });
const proposals = () => call('Cara', `/api/projects/${project.id}/memory-proposals`);
const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);
const B = '---\nname: B\ndescription: second\n---\nbeta\n';

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  base = srv.base;
  cookies.Cara = srv.cookie;
  procs.push(srv.proc);
  project = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'P' } });
  // The minion first: a repo_dir that isn't a git repo can't give it a worktree, and the routes read repo_dir per request.
  ticket = await call('Cara', `/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'tidy the memory' } });
  await until('the first turn', () => turns().length >= 1);
  await idle();
  const repo = join(root, 'repo');
  const store = new Store(join(srv.data, 'coordinator.db'));
  store.db.prepare('UPDATE projects SET repo_dir = ? WHERE id = ?').run(repo, project.id);
  const [folder] = (await call('Cara', `/api/projects/${project.id}/memory-files`)).folders;
  assert.ok(folder, 'the server login has a memory folder for the scheme');
  dir = join(root, 'claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.md'), '---\nname: A\ndescription: first\n---\nalpha\n');
  writeFileSync(join(dir, 'b.md'), B);
  writeFileSync(join(dir, 'c.md'), '---\nname: C\ndescription: unindexed\n---\ngamma\n');
  writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — first\n- [B](b.md) — second\n');
});

test('a run proposes; the card waits for the Memory page, nothing is written, and the card has no Approve', async () => {
  await assert.rejects(propose([]), /400 Nothing to propose/);
  await assert.rejects(propose([{ action: 'delete', file: 'zz.md', reason: 'r' }]), /400 Change 1: there is no note zz.md/);
  await assert.rejects(call('Cara', `/api/tickets/${ticket.id}/memory-proposal`, { method: 'POST', body: { changes: [] } }), /403/);
  const before = ['a.md', 'b.md', 'c.md', 'MEMORY.md'].map(read);
  const r = await propose([
    { action: 'edit', file: 'a.md', text: 'alpha and beta', reason: 'b merged in' },
    { action: 'delete', file: 'b.md', reason: 'merged into a.md' },
    { action: 'index', file: 'c.md', line: '- [C](c.md) — unindexed', reason: 'not in the index' },
  ]);
  assert.equal(r.counts, '1 edit, 1 delete, 1 index line');
  assert.match(r.href, /\?e=\d+$/);
  assert.deepEqual(['a.md', 'b.md', 'c.md', 'MEMORY.md'].map(read), before, 'proposing writes nothing');
  const [card] = await events('plan');
  assert.equal(card.status, 'pending');
  assert.deepEqual(card.memory, { proposal: r.proposal, project: project.id, counts: r.counts });
  await assert.rejects(call('Cara', `/api/tickets/${ticket.id}/verdict`, { method: 'POST', body: { planId: card.id, verdict: 'approve' } }), /409 Review the memory tidy on the Memory page/);
  const { open } = await proposals();
  assert.equal(open.id, r.proposal);
  assert.deepEqual(open.changes.map((c: any) => [c.file, c.drifted]), [['a.md', false], ['b.md', false], ['c.md', false]]);
  assert.deepEqual(open.changes[2].diff, [{ op: '+', text: '- [C](c.md) — unindexed' }]);
});

test('applying the ticked changes leaves the unticked delete, tells the run, and Put back undoes it', async () => {
  const { open } = await proposals();
  const out = await call('Cara', `/api/projects/${project.id}/memory-proposals/${open.id}/decide`, { method: 'POST', body: { apply: [1, 3] } });
  assert.deepEqual(out.changes.map((c: any) => c.outcome), ['applied', 'turned down', 'applied']);
  assert.equal(read('a.md'), 'alpha and beta\n');
  assert.equal(read('b.md'), B);
  assert.equal(read('MEMORY.md'), '- [A](a.md) — first\n- [B](b.md) — second\n- [C](c.md) — unindexed\n');
  assert.equal((await events('plan'))[0].status, 'approved');
  assert.match((await events('user_message')).at(-1).text, /^Cara applied 2 of your memory changes \(1 edit, 1 index line\)\. Nothing more to do: close yourself/);
  await assert.rejects(call('Cara', `/api/projects/${project.id}/memory-proposals/${open.id}/decide`, { method: 'POST', body: { apply: [] } }), /409 Cara already decided/);
  const after = await proposals();
  assert.equal(after.open, null);
  assert.equal(after.kept[0].counts, '1 edit, 1 index line');
  await call('Cara', `/api/projects/${project.id}/memory-proposals/${open.id}/restore`, { method: 'POST' });
  assert.equal(read('a.md'), '---\nname: A\ndescription: first\n---\nalpha\n');
  assert.equal(read('MEMORY.md'), '- [A](a.md) — first\n- [B](b.md) — second\n');
  await assert.rejects(call('Cara', `/api/projects/${project.id}/memory-proposals/${open.id}/restore`, { method: 'POST' }), /409 Cara already put it back/);
  await idle();
});

test('a newer proposal supersedes the open one, and turning it all down changes nothing', async () => {
  const first = await propose([{ action: 'flag', file: 'b.md', reason: 'live state: make it a pointer' }]);
  const second = await propose([{ action: 'delete', file: 'b.md', reason: 'stale' }]);
  const cards = await events('plan');
  assert.equal(cards.find((c: any) => c.memory?.proposal === first.proposal).status, 'superseded');
  await assert.rejects(call('Cara', `/api/projects/${project.id}/memory-proposals/${first.proposal}/decide`, { method: 'POST', body: { apply: [] } }), /409 A newer tidy replaced this one/);
  await idle();
  await call('Cara', `/api/projects/${project.id}/memory-proposals/${second.proposal}/decide`, { method: 'POST', body: { apply: [] } });
  assert.equal(read('b.md'), B);
  assert.equal((await events('plan')).find((c: any) => c.memory?.proposal === second.proposal).status, 'rejected');
  assert.match((await events('user_message')).at(-1).text, /^Cara turned the memory tidy down; nothing changed/);
  await idle();
});
