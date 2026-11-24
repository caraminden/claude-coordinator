import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, jsonLines, withoutTurnNote, until, stopProcs, tempRoot, ok, type Booted } from './helpers.ts';

// Dismiss (#1593): a person takes an open question or plan card that is no longer relevant out of the waiting list; its
// minion is told, as it is told an answer. Only people can; a ship go keeps its own buttons.
const tmp = tempRoot('dismiss-card-');
const root = tmp.dir;
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await tmp.teardown(); // ends the detached turns before deleting their folders (#271)
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

let srv: Booted;
const call = async (path: string, opts: { method?: string; body?: unknown; token?: string } = {}) => ok(await (opts.token ? srv.as({ token: opts.token }) : srv.call)(path, opts.body || undefined, opts.method ?? 'GET'));
const turns = () => jsonLines(join(root, 'turns.jsonl'));
let ticket: any;
const live = () =>
  turns()
    .filter((t) => t.token.startsWith(`${ticket.id}.`))
    .at(-1).token;
const idle = () => until('the turn to end', async () => (await call(`/api/tickets/${ticket.id}`)).ticket.status !== 'running');
const events = async () => (await call(`/api/tickets/${ticket.id}/events?after=0`)) as any[];
const data = async (kind: string) => (await events()).filter((e) => e.kind === kind).map((e) => JSON.parse(e.data));
const dismiss = (cardId: string, token?: string) => call(`/api/tickets/${ticket.id}/dismiss`, { method: 'POST', token, body: { cardId } });
const ask = (question: string, extra: object = {}) => call(`/api/tickets/${ticket.id}/questions`, { method: 'POST', token: live(), body: { questions: [{ question, options: [{ label: 'A', recommended: true }, { label: 'B' }] }], ...extra } });
const lastPrompt = async (before: number) => withoutTurnNote((await until('the dismissal turn', () => turns().length > before && turns())).at(-1).prompt.message.content)[0].text;

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  procs.push(srv.proc);
  const project = await call('/api/projects', { method: 'POST', body: { name: 'P' } });
  ticket = await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'hi' } });
  await until('the first turn', () => turns().length >= 1);
  await idle();
});

test('a person dismisses an open question card: it settles as dismissed and the minion is told', async () => {
  const { id } = await ask('Which layout?');
  const other = await ask('Which colour?', { not_duplicate: true });
  const before = turns().length;
  await dismiss(id);
  assert.deepEqual((await data('question')).find((q) => q.id === id).settled.dismissed, true);
  assert.equal((await data('question_result')).at(-1).settled.by, 'Cara');
  assert.match(await lastPrompt(before), /^\[Cara\]: Cara dismissed your card "Which layout\?" as no longer relevant\./);
  await idle();
  // The other open card still waits.
  assert.equal((await data('question')).find((q) => q.id === other.id).settled, undefined);
  // Settled: not open again, and neither dismissed nor answered twice.
  await assert.rejects(dismiss(id), /409 Cara dismissed this card/);
  await assert.rejects(dismiss('no-such-card'), /404/);
  await assert.rejects(call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: id, answers: [{ selected: ['A'], other: '' }] } }), /409 Cara dismissed this card/);
});

test('a person dismisses a plan card: it reads dismissed and the minion is told', async () => {
  const { id } = await call(`/api/tickets/${ticket.id}/plans`, { method: 'POST', token: live(), body: { summary: 'Old plan', plan: '- a step' } });
  const before = turns().length;
  await dismiss(id);
  const plan = (await data('plan')).find((p) => p.id === id);
  assert.equal(plan.status, 'dismissed');
  assert.equal(plan.by, 'Cara');
  assert.match(await lastPrompt(before), /dismissed your card "Old plan"/);
  await idle();
  await assert.rejects(call(`/api/tickets/${ticket.id}/verdict`, { method: 'POST', body: { planId: id, verdict: 'approve' } }), /409 Cara dismissed this card/);
});

test('the minion itself cannot dismiss, and a ship go card is refused', async () => {
  const { id } = await ask('Ship it?', { kind: 'ship' });
  await assert.rejects(dismiss(id, live()), /403/);
  await assert.rejects(dismiss(id), /409 This card is answered with its own buttons/);
  assert.equal((await data('question')).find((q) => q.id === id).settled, undefined);
});
