import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { App } from '../src/http.ts';
import { bootServer, jsonLines, until, stopProcs, stopTurns, ok, type Booted } from './helpers.ts';
import { fake } from './typed.ts';

// A turn's question cards merge (Cara, 2026-11-18: "Merge a turn's cards", cap "Raise cap to 8", Taskmasters too):
// a plain card asked while the turn's earlier plain card is unanswered joins it. The stand-in `claude -p` holds its
// turn open until a file named for the turn appears, so a card is asked while a turn runs.
const root = mkdtempSync(join(tmpdir(), 'question-merge-'));
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
const { appendFileSync, existsSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', (prompt) => {
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ prompt: JSON.parse(prompt), token: process.env.COORDINATOR_TOKEN }) + '\\n');
  const n = require('node:fs').readFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, 'utf8').trim().split('\\n').length;
  const timer = setInterval(() => {
    if (!existsSync(${JSON.stringify(root)} + '/go-' + n)) return;
    clearInterval(timer);
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
    process.exit(0);
  }, 50);
});
`,
);
chmodSync(fakeClaude, 0o755);

let base = '';
let cookie = '';
let srv: Booted;
// The parts of the API's answers these tests read.
type Event = { kind: string; data: string };
type Card = { id: string; href: string; merged?: boolean; status: number; ticket: { status: string } };
const call = async <T = Card>(path: string, opts: { method?: string; body?: unknown; token?: string; fail?: boolean } = {}): Promise<T> => {
  const r = await (opts.token ? srv.as({ token: opts.token }) : srv.call)(path, opts.body || undefined, opts.method ?? 'GET');
  return opts.fail ? { status: r.status, ...r.data } : ok(r);
};

const turns = () => jsonLines(join(root, 'turns.jsonl'));
let ticket: { id: number };
const live = () =>
  turns()
    .filter((t) => t.token.startsWith(`${ticket.id}.`))
    .at(-1).token;
const end = async () => {
  const n = turns().length;
  writeFileSync(join(root, `go-${n}`), '');
  // Ended: idle, or a queued message's turn already began.
  await until('the turn to end', async () => turns().length > n || (await call(`/api/tickets/${ticket.id}`)).ticket.status !== 'running');
};
const q = (text: string, n = 1) => Array.from({ length: n }, (_, i) => ({ question: `${text}${i}?`, options: [{ label: 'A', recommended: true }, { label: 'B' }] }));
const ask = (questions: unknown[], extra: object = {}) => call(`/api/tickets/${ticket.id}/questions`, { method: 'POST', token: live(), body: { questions, ...extra } });

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
  const project = await call<{ id: number }>('/api/projects', { method: 'POST', body: { name: 'P' } });
  ticket = await call<{ id: number }>(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'ask me things' } });
  await until('the first turn', () => turns().length >= 1);
});

test('two asks in one turn make one card, answered in one message; other kinds, answered cards and later turns stay separate', async () => {
  const first = await ask(q('a', 2));
  const second = await ask(q('b'));
  assert.equal(second.id, first.id);
  assert.equal(second.href, first.href);
  assert.equal(second.merged, true);
  const stored = (await call<Event[]>(`/api/tickets/${ticket.id}/events?after=0`)).filter((e) => e.kind === 'question').map((e) => JSON.parse(e.data));
  assert.deepEqual(
    stored.filter((c: { id: string; questions: unknown[] }) => c.id === first.id).map((c) => c.questions.length),
    [3],
  );
  assert.equal((await call<Event[]>(`/api/tickets/${ticket.id}/events?after=0`)).filter((e) => e.kind === 'question_more').length, 1);
  // A doc-less merge card, a to, and when_ci_passes never join it.
  const merge = await ask(q('m'), { kind: 'merge' });
  assert.notEqual(merge.id, first.id);
  const mine = await ask(q('t'), { to: 'Cara' });
  assert.notEqual(mine.id, first.id);
  // Answering it takes all three questions in one message.
  const short = await call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: first.id, answers: [{ selected: ['A'] }] }, fail: true });
  assert.equal(short.status, 400);
  await call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: first.id, answers: [{ selected: ['A'] }, { selected: ['B'] }, { selected: ['A'], other: 'because' }] } });
  // The minion gets every question and pick in the one message.
  const said = (await call<Event[]>(`/api/tickets/${ticket.id}/events?after=0`)).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data));
  const reply = said.find((m: { answer?: { questionId: string }; text: string }) => m.answer?.questionId === first.id);
  for (const t of ['1. a0?', '2. a1?', '3. b0?', 'Added: because']) assert.ok(reply.text.includes(t), `${t} in ${reply.text}`);
  // Answered: a new ask is a new card.
  const after = await ask(q('c'));
  assert.notEqual(after.id, first.id);
  assert.equal(after.merged, undefined);
  await end();
  // A later turn never joins an earlier turn's open card.
  await until("the answer's own turn", () => turns().length >= 2); // it waited for the first turn to end
  const next = await ask(q('d'));
  assert.notEqual(next.id, after.id);
  await end();
});

test('a card holds 8 questions; the ninth starts a new card', async () => {
  await until('idle', async () => (await call(`/api/tickets/${ticket.id}`)).ticket.status !== 'running');
  const n = turns().length;
  await call(`/api/tickets/${ticket.id}/messages`, { method: 'POST', body: { text: 'more' } });
  await until('the turn', () => turns().length > n);
  // Two of the eight take several picks (TransitionTracker's merged card, #1579).
  const multi = (qs: ReturnType<typeof q>, at: number) => qs.map((x, i) => (i === at ? { ...x, multiSelect: true } : x));
  const a = await ask(multi(q('x', 4), 1));
  const b = await ask(multi(q('y', 4), 2));
  assert.equal(b.id, a.id);
  const c = await ask(q('z'));
  assert.notEqual(c.id, a.id);
  // All eight answers go through the route and reach the asking turn in one message.
  const picks = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ selected: i === 1 || i === 6 ? ['A', 'B'] : ['B'] }));
  await call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: a.id, answers: picks } });
  const said = (await call<Event[]>(`/api/tickets/${ticket.id}/events?after=0`)).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data));
  const text = said.find((m: { answer?: { questionId: string }; text: string }) => m.answer?.questionId === a.id).text;
  for (const t of ['1. x0?', '8. y3?', '→ A; B']) assert.ok(text.includes(t), `${t} in ${text}`);
  await end();
});

test("a Taskmaster's for-everyone cards merge with the same asker's, never another Taskmaster's, and the Overlord's chat hears question_more", async () => {
  const { Store } = await import('../src/db.ts');
  const { mergeCard, postCard } = await import('../src/ci-armed.ts');
  const store = new Store(join(root, 'merge.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const p = store.createProject('Shared', null, cara.id);
  store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Taskmaster' });
  store.splitScheme(p.id, josh.id);
  const lord = store.getOverlord(p.id)!;
  const [a, b] = [store.coordinatorFor(p.id, cara.id)!, store.coordinatorFor(p.id, josh.id)!];
  // A stand-in app: every thread is mid-turn; emit stores the event as the runner does (the Overlord's marked everyone).
  const app = fake<App>({
    store,
    notify() {},
    runner: fake<App['runner']>({ turnStartedAt: () => 0, broadcastTicket() {}, emit: (id: number, kind: string, d: object) => store.addEvent(id, kind, id === lord.id && kind === 'question' ? { ...d, everyone: true } : d) }),
  });
  const card = (asker: { id: number }, text: string) => ({ questions: q(text), mergeable: true as const, asker: asker.id });
  const first = postCard(app, lord, card(a, 'a'));
  const merged = mergeCard(app, lord, a, card(a, 'b'));
  assert.equal(merged?.id, first.id);
  assert.equal(mergeCard(app, lord, b, card(b, 'c')), null, "another Taskmaster's card never joins it");
  const kinds = store.eventsOfKinds(lord.id, ['question', 'question_more']);
  assert.deepEqual(
    kinds.map((e) => e.kind),
    ['question', 'question_more'],
  );
  assert.equal(JSON.parse(kinds[0].data).questions.length, 2);
  assert.equal(JSON.parse(kinds[0].data).everyone, true, 'the card keeps its everyone mark');
  // Mine lets question_more through to every member's page, as it does the card's results.
  const { inMine } = await import('../public/mine.js');
  assert.equal(inMine({ kind: 'question_more', data: '{}' }), true);
  store.db.close();
});
