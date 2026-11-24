import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { agentToken, bootServer, jsonLines, stopProcs, stopTurns, until, ok, type Booted } from './helpers.ts';

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
writeFileSync(
  fakeClaude,
  `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', (prompt) => {
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ prompt: JSON.parse(prompt), token: process.env.COORDINATOR_TOKEN }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`,
);
chmodSync(fakeClaude, 0o755);

let base = '';
const cookies: Record<string, string> = {};
let ticket: any;
let project: any;
let dir = '';

let srv: Booted;
const call = async (who: string, path: string, opts: { method?: string; body?: unknown } = {}) => ok(await srv.as(who === 'minion' ? { token: agentToken(srv.data, ticket.id) } : { cookie: cookies[who] })(path, opts.body || undefined, opts.method ?? 'GET'));
const turns = () => jsonLines(join(root, 'turns.jsonl'));
const idle = () => until('the turn to end', async () => (await call('Cara', `/api/tickets/${ticket.id}`)).ticket.status !== 'running');
const events = async (kind: string) => (await call('Cara', `/api/tickets/${ticket.id}/events?after=0`)).filter((e: any) => e.kind === kind).map((e: any) => JSON.parse(e.data));
const propose = (changes: unknown) => call('minion', `/api/tickets/${ticket.id}/memory-proposal`, { method: 'POST', body: { changes } });
// An answer wakes the run: wait for that turn to have run and ended, so its new token is the one read next.
const answered = async (act: () => Promise<unknown>) => {
  const n = turns().length;
  const out = await act();
  await until("the answer's turn", () => turns().length > n);
  await idle();
  return out;
};
const applyMine = () => call('minion', `/api/tickets/${ticket.id}/memory-proposal/apply`, { method: 'POST', body: {} });
const verdict = (who: string, planId: string, v: string) => call(who, `/api/tickets/${ticket.id}/verdict`, { method: 'POST', body: { planId, verdict: v } });
const cardOf = async (proposal: number) => (await events('plan')).find((c: any) => c.memory?.proposal === proposal);
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

test('a run proposes; the card waits, nothing is written, and the run cannot apply it before an approval', async () => {
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
  await assert.rejects(applyMine(), /409 Not approved/);
  assert.deepEqual(['a.md', 'b.md', 'c.md', 'MEMORY.md'].map(read), before, 'an unapproved tidy is never applied');
  const { open } = await proposals();
  assert.equal(open.id, r.proposal);
  assert.deepEqual(
    open.changes.map((c: any) => [c.file, c.drifted]),
    [
      ['a.md', false],
      ['b.md', false],
      ['c.md', false],
    ],
  );
  assert.deepEqual(open.changes[2].diff, [{ op: '+', text: '- [C](c.md) — unindexed' }]);
});

test('applying the ticked changes leaves the unticked delete, tells the run, and Put back undoes it', async () => {
  const { open } = await proposals();
  const out: any = await answered(() => call('Cara', `/api/projects/${project.id}/memory-proposals/${open.id}/decide`, { method: 'POST', body: { apply: [1, 3] } }));
  assert.deepEqual(
    out.changes.map((c: any) => c.outcome),
    ['applied', 'turned down', 'applied'],
  );
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
  const second = (await answered(() => propose([{ action: 'delete', file: 'b.md', reason: 'stale' }]))) as any; // its supersede wakes the run
  const cards = await events('plan');
  assert.equal(cards.find((c: any) => c.memory?.proposal === first.proposal).status, 'superseded');
  await assert.rejects(call('Cara', `/api/projects/${project.id}/memory-proposals/${first.proposal}/decide`, { method: 'POST', body: { apply: [] } }), /409 A newer tidy replaced this one/);
  await answered(() => call('Cara', `/api/projects/${project.id}/memory-proposals/${second.proposal}/decide`, { method: 'POST', body: { apply: [] } }));
  assert.equal(read('b.md'), B);
  assert.equal((await events('plan')).find((c: any) => c.memory?.proposal === second.proposal).status, 'rejected');
  assert.match((await events('user_message')).at(-1).text, /^Cara turned the memory tidy down; nothing changed/);
  await idle();
});

// #1803 (Cara, 2026-11-24: "We should make it something a minion can do with approval"): Approve on the card, the run applies.
test("approved on the card, the run applies the whole tidy through the page's path and is told to", async () => {
  writeFileSync(join(dir, 'd.md'), '---\nname: D\ndescription: dup\n---\ndelta\n');
  const r = await propose([
    { action: 'edit', file: 'c.md', text: 'gamma, tidied', line: '- [C](c.md) — tidied', reason: 'shorter' },
    { action: 'delete', file: 'd.md', reason: 'duplicate of c.md' },
    { action: 'flag', file: 'a.md', reason: 'check it' },
  ]);
  await idle();
  const card = await cardOf(r.proposal);
  await answered(() => verdict('Cara', card.id, 'approve'));
  assert.equal(read('c.md'), '---\nname: C\ndescription: unindexed\n---\ngamma\n', 'Approve itself writes nothing: the run applies');
  assert.match((await events('user_message')).at(-1).text, /^Approved: Cara approved your memory tidy .* Call apply_memory now: it applies every change, deletes too/);
  assert.equal((await proposals()).open.approved_by, 'Cara', 'the page shows it approved on the card');
  const out = await applyMine();
  assert.match(out.line, /^Applied 2 of the 2 changes Cara approved \(1 edit, 1 delete\)\.$/);
  assert.deepEqual(
    out.changes.map((c: any) => c.outcome),
    ['applied', 'applied', 'noted'],
  );
  assert.equal(read('c.md'), 'gamma, tidied\n');
  assert.equal(read('d.md'), null, 'Approve all deletes too (Cara, 2026-11-24: "Include deletes")');
  assert.match(read('MEMORY.md')!, /- \[C\]\(c\.md\) — tidied/);
  const after = await proposals();
  assert.equal(after.open, null);
  assert.equal(after.kept[0].id, r.proposal);
  assert.equal(after.kept[0].decided_by, 'Cara', 'the page shows it applied, decided by the approver');
  await assert.rejects(applyMine(), /409 Cara already applied this tidy/, 'never applied twice');
  await call('Cara', `/api/projects/${project.id}/memory-proposals/${r.proposal}/restore`, { method: 'POST' });
  assert.equal(read('c.md'), '---\nname: C\ndescription: unindexed\n---\ngamma\n');
  assert.equal(read('d.md'), '---\nname: D\ndescription: dup\n---\ndelta\n', 'Put back brings a delete back');
  rmSync(join(dir, 'd.md'));
});

test("a non-member's answer applies nothing, and Reject turns it down at once", async () => {
  const made = await call('Cara', '/api/people', { method: 'POST', body: { name: 'Olive' } });
  const res = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
  cookies.Olive = res.headers.get('set-cookie')!.split(';')[0];
  const r = await propose([{ action: 'edit', file: 'c.md', text: 'olive was here', reason: 'r' }]);
  await idle();
  const card = await cardOf(r.proposal);
  await assert.rejects(verdict('Olive', card.id, 'approve'), /404/);
  await assert.rejects(applyMine(), /409 Not approved/);
  assert.equal((await cardOf(r.proposal)).status, 'pending');
  assert.notEqual(read('c.md'), 'olive was here\n');
  await answered(() => verdict('Cara', card.id, 'revise'));
  assert.equal((await cardOf(r.proposal)).status, 'rejected');
  assert.equal((await proposals()).open, null);
  await assert.rejects(applyMine(), /409 Cara already turned down this tidy/);
  assert.notEqual(read('c.md'), 'olive was here\n');
  await idle();
});

test('ticked on the page, then approved on the card: applied once', async () => {
  const was = read('c.md');
  const r = await propose([
    { action: 'edit', file: 'c.md', text: 'once', reason: 'r' },
    { action: 'index', file: 'b.md', line: '- [B](b.md) — again', reason: 'r' },
  ]);
  await idle();
  const card = await cardOf(r.proposal);
  await answered(() => call('Cara', `/api/projects/${project.id}/memory-proposals/${r.proposal}/decide`, { method: 'POST', body: { apply: [1] } }));
  await assert.rejects(verdict('Cara', card.id, 'approve'), /409 Cara already approved this memory tidy/);
  await assert.rejects(applyMine(), /409 Cara already applied this tidy/);
  assert.equal(read('c.md'), 'once\n');
  assert.doesNotMatch(read('MEMORY.md')!, /again/, 'the unticked change stays unapplied');
  const kept = (await proposals()).kept.find((k: any) => k.id === r.proposal);
  assert.equal(kept.counts, '1 edit');
  await call('Cara', `/api/projects/${project.id}/memory-proposals/${r.proposal}/restore`, { method: 'POST' });
  assert.equal(read('c.md'), was);
  await idle();
});

test('approved on the card, then ticked on the page before the run applies: the run finds it applied', async () => {
  const r = await propose([
    { action: 'edit', file: 'c.md', text: 'page first', reason: 'r' },
    { action: 'index', file: 'b.md', line: '- [B](b.md) — again', reason: 'r' },
  ]);
  await idle();
  await answered(async () => verdict('Cara', (await cardOf(r.proposal)).id, 'approve'));
  await answered(() => call('Cara', `/api/projects/${project.id}/memory-proposals/${r.proposal}/decide`, { method: 'POST', body: { apply: [1] } }));
  await assert.rejects(applyMine(), /409 Cara already applied this tidy/);
  assert.equal(read('c.md'), 'page first\n');
  assert.doesNotMatch(read('MEMORY.md')!, /again/);
  await idle();
});

test('approved on the card, then turned down on the page: the card says so and the run applies nothing', async () => {
  const r = await propose([{ action: 'edit', file: 'c.md', text: 'never', reason: 'r' }]);
  await idle();
  await answered(async () => verdict('Cara', (await cardOf(r.proposal)).id, 'approve'));
  await answered(() => call('Cara', `/api/projects/${project.id}/memory-proposals/${r.proposal}/decide`, { method: 'POST', body: { apply: [] } }));
  assert.equal((await cardOf(r.proposal)).status, 'rejected', 'the card no longer says approved');
  await assert.rejects(applyMine(), /409 Cara already turned down this tidy/);
  assert.doesNotMatch(read('c.md')!, /never/);
  await idle();
});
