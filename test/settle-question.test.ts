import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { bootServer, jsonLines, until, stopProcs, stopTurns, ok, type Booted } from './helpers.ts';

// Question cards a minion settles (settle_question): it judged a typed reply answered the card, so the
// card stops waiting on people. A stand-in `claude -p` records each turn's prompt and thread token,
// then ends the turn.
const root = mkdtempSync(join(tmpdir(), 'settle-question-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

const fakeClaude = join(root, 'claude-fake');
writeFileSync(
  fakeClaude,
  `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', (prompt) => {
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ prompt: JSON.parse(prompt), cwd: process.cwd(), token: process.env.COORDINATOR_TOKEN, shared: process.env.COORDINATOR_SHARED_DIR, files: process.env.COORDINATOR_FILES_DIR }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`,
);
chmodSync(fakeClaude, 0o755);

let base = '';
let cookie = '';

let srv: Booted;
const call = async (path: string, opts: { method?: string; body?: unknown; token?: string } = {}) => ok(await (opts.token ? srv.as({ token: opts.token }) : srv.call)(path, opts.body || undefined, opts.method ?? 'GET'));

const turns = () => jsonLines(join(root, 'turns.jsonl'));
// The token the minion's latest turn holds: each turn's token dies when the next turn starts.
const live = () =>
  turns()
    .filter((t) => t.token.startsWith(`${ticket.id}.`))
    .at(-1).token;
const idle = (id: number) => until('the turn to end', async () => (await call(`/api/tickets/${id}`)).ticket.status !== 'running');

let ticket: any;
let turn: any;

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
  const project = await call('/api/projects', { method: 'POST', body: { name: 'P' } });
  ticket = await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'ask me something' } });
  [turn] = await until('the first turn', () => turns().length >= 1 && turns());
  await idle(ticket.id);
});

const ask = (q: string) => call(`/api/tickets/${ticket.id}/questions`, { method: 'POST', token: live(), body: { questions: [{ question: q, options: [{ label: 'A', recommended: true }, { label: 'B' }] }] } });
const settle = (questionId?: string) => call(`/api/tickets/${ticket.id}/settle`, { method: 'POST', token: live(), body: { questionId: questionId ?? null } });
const inbox = async () => (await call(`/api/projects/${ticket.project_id}/inbox`)).items.filter((i: any) => i.kind === 'question');

test('a settled card leaves the inbox, records it on the card and refuses a late click', async () => {
  const { id } = await ask('Which one?');
  assert.equal((await inbox()).length, 1);
  await assert.rejects(call(`/api/tickets/${ticket.id}/settle`, { method: 'POST', body: { questionId: id } }), /403/);
  assert.deepEqual(await settle(id), { settled: [id] });
  assert.equal((await inbox()).length, 0);
  const events = await call(`/api/tickets/${ticket.id}/events?after=0`);
  assert.equal(JSON.parse(events.find((e: any) => e.kind === 'question').data).settled.at > 0, true);
  assert.deepEqual(
    events.filter((e: any) => e.kind === 'question_result').map((e: any) => JSON.parse(e.data).id),
    [id],
  );
  await assert.rejects(call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: id, answers: [{ selected: ['A'], other: '' }] } }), /409 Claude took this as answered/);
  await assert.rejects(settle(id), /404 No open card with that id/);
});

// #1488: settling every open card at once (no id) took cards still waiting on people; now it settles only a lone one.
test('with no id it settles the one open card, skipping ones answered by a click, and with two open it names them and settles none', async () => {
  const clicked = await ask('First?');
  await call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: clicked.id, answers: [{ selected: ['A'], other: '' }] } });
  await idle(ticket.id);
  const a = await ask('Second?');
  const b = await ask('Third?');
  await assert.rejects(settle(), (err: Error) => /409 2 cards are open, so say which: pass question_id/.test(err.message) && err.message.includes(`${a.id} (question card "Second?")`) && err.message.includes(b.id));
  assert.equal((await inbox()).length, 2, 'both still wait');
  assert.deepEqual(await settle(a.id), { settled: [a.id] });
  assert.deepEqual(await settle(), { settled: [b.id] }, 'one left: no id needed');
  assert.deepEqual(await settle(), { settled: [] });
  assert.equal((await inbox()).length, 0);
});

// Cara, 2026-11-14: "Cards should always pass along the text in addition to the selection".
test('a card answer reaches the minion as the pick plus the text typed with it, or the text alone', async () => {
  const both = await ask('Pick plus text?');
  await call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: both.id, answers: [{ selected: ['B'], other: 'but keep it small' }] } });
  await until('the answer turn', () => turns().some((t) => JSON.stringify(t.prompt).includes('Pick plus text?')));
  await idle(ticket.id);
  const own = await ask('Text only?');
  await call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: own.id, answers: [{ selected: [], other: 'neither' }] } });
  await until('the answer turn', () => turns().some((t) => JSON.stringify(t.prompt).includes('Text only?')));
  await idle(ticket.id);
  const prompts = JSON.stringify(turns().map((t) => t.prompt));
  assert.ok(prompts.includes('Pick plus text?\\n→ B\\n  Added: but keep it small'), prompts);
  assert.ok(prompts.includes('Text only?\\n→ In their own words: neither'), prompts);
});

test('a card addressed to one person (#687): to must be a member; a notice takes Got it and sends nothing back; an answer wakes the asker, cold or not (#702)', async () => {
  const opts = [{ label: 'A', recommended: true }, { label: 'B' }];
  const post = (body: unknown) => call(`/api/tickets/${ticket.id}/questions`, { method: 'POST', token: live(), body });
  await assert.rejects(post({ to: 'nobody', questions: [{ question: 'Who?', options: opts }] }), /400 to must be a member of this scheme: cara/);
  await assert.rejects(post({ notice: 'no one to tell' }), /400 questions must be a list/);

  const notice = await post({ to: '@Cara', notice: 'Runner slots went to 3' });
  let events = await call(`/api/tickets/${ticket.id}/events?after=0`);
  assert.deepEqual(JSON.parse(events.find((e: any) => e.kind === 'question' && JSON.parse(e.data).id === notice.id).data), { id: notice.id, questions: [], to: 'Cara', notice: 'Runner slots went to 3' });
  assert.equal((await inbox()).length, 1);
  const turnsBefore = turns().length;
  await call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: notice.id } });
  assert.equal((await inbox()).length, 0);
  events = await call(`/api/tickets/${ticket.id}/events?after=0`);
  assert.equal(JSON.parse(events.find((e: any) => e.kind === 'question' && JSON.parse(e.data).id === notice.id).data).settled.by, 'Cara');
  assert.equal(events.filter((e: any) => e.kind === 'user_message' && JSON.parse(e.data).answer?.questionId === notice.id).length, 0, 'nothing sent back');
  await assert.rejects(call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: notice.id } }), /409 Cara already marked this seen/);

  // #702: the answer wakes the asker even once it has gone cold (its last turn ended over 55 minutes ago).
  const { id } = await post({ to: 'cara', questions: [{ question: 'Direct?', options: opts }] });
  const db = new DatabaseSync(join(root, 'data', 'coordinator.db'), { timeout: 30_000 });
  db.prepare('UPDATE turns SET ended_at = ended_at - ? WHERE ticket_id = ?').run(2 * 3_600_000, ticket.id);
  db.close();
  await call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: id, answers: [{ selected: ['B'], other: '' }] } });
  await until("the answer's turn", () => turns().length > turnsBefore);
  await idle(ticket.id);
  assert.ok(JSON.stringify(turns().at(-1).prompt).includes('Direct?\\n→ B'));
});

// Cara, 2026-11-18: a pasted screenshot rides in the card's answer message, the pick and the picture together.
test('a card answer carries pasted images to the minion in the same message, and the answer event names them', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==';
  const { id } = await ask('Picture too?');
  const before = turns().length;
  await assert.rejects(call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: id, answers: [{ selected: ['A'], other: '' }], images: [{ mediaType: 'image/png', data: Buffer.from('not an image').toString('base64') }] } }), /415/);
  await call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: id, answers: [{ selected: ['A'], other: 'see this' }], images: [{ mediaType: 'image/png', data: png }] } });
  await until('the answer turn', () => turns().length > before);
  await idle(ticket.id);
  const prompt = JSON.stringify(turns().at(-1).prompt);
  assert.ok(prompt.includes('Picture too?\\n→ A\\n  Added: see this'), prompt);
  assert.ok(prompt.includes('"type":"image"') && prompt.includes(png.slice(0, 20)), prompt);
  const events = await call(`/api/tickets/${ticket.id}/events?after=0`);
  const answer = events.map((e: any) => JSON.parse(e.data)).find((d: any) => d.answer?.questionId === id);
  assert.equal(answer.images.length, 1);
  assert.match(answer.images[0], /\.png$/);
});

// Cara, 2026-11-18: "you should be able to click send with just the image and no other option or text selected".
test('an image alone answers a card: no pick needed, the minion is told so beside the image; no image and no pick is still refused', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==';
  const { id } = await ask('Look at this?');
  await assert.rejects(call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: id, answers: [{ selected: [], other: '' }] } }), /400 Answer question 1/);
  const before = turns().length;
  await call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: id, answers: [{ selected: [], other: '' }], images: [{ mediaType: 'image/png', data: png }] } });
  await until('the answer turn', () => turns().length > before);
  await idle(ticket.id);
  const prompt = JSON.stringify(turns().at(-1).prompt);
  assert.ok(prompt.includes('Look at this?\\n→ (no option picked; see the attachment)'), prompt);
  assert.ok(prompt.includes('"type":"image"'), prompt);
});
