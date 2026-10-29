import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// Question cards a minion settles (settle_question): it judged a typed reply answered the card, so the
// card stops waiting on people. A stand-in `claude -p` records each turn's prompt and thread token,
// then ends the turn.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'settle-question-'));
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});

const fakeClaude = join(root, 'claude-fake');
writeFileSync(fakeClaude, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', (prompt) => {
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ prompt: JSON.parse(prompt), cwd: process.cwd(), token: process.env.COORDINATOR_TOKEN, shared: process.env.COORDINATOR_SHARED_DIR, files: process.env.COORDINATOR_FILES_DIR }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
chmodSync(fakeClaude, 0o755);

let base = '';
let cookie = '';

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as any;
  await new Promise((r) => srv.close(r));
  return port;
}

async function call(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : { Cookie: cookie }), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.error}`);
  return data;
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const turns = () => existsSync(join(root, 'turns.jsonl')) ? readFileSync(join(root, 'turns.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const idle = (id: number) => until('the turn to end', async () => (await call(`/api/tickets/${id}`)).ticket.status !== 'running');

let ticket: any;
let turn: any;

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: String(port), DATA_DIR: join(root, 'data'), CLAUDE_BIN: fakeClaude,
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: 'test-password-123', SESSION_SECRET: 'x'.repeat(40),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  procs.push(server);
  const res = await until('the server', () => fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: 'test-password-123' }),
  }).catch(() => undefined));
  cookie = res.headers.get('set-cookie')!.split(';')[0];
  const project = await call('/api/projects', { method: 'POST', body: { name: 'P' } });
  ticket = await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'ask me something' } });
  [turn] = await until('the first turn', () => turns().length >= 1 && turns());
  await idle(ticket.id);
});


const ask = (q: string) => call(`/api/tickets/${ticket.id}/questions`, { method: 'POST', token: turn.token, body: { questions: [{ question: q, options: [{ label: 'A', recommended: true }, { label: 'B' }] }] } });
const settle = (questionId?: string) => call(`/api/tickets/${ticket.id}/settle`, { method: 'POST', token: turn.token, body: { questionId: questionId ?? null } });
const inbox = async () => (await call(`/api/projects/${ticket.project_id}/inbox`)).items.filter((i: any) => i.kind === 'question');

test('a settled card leaves the inbox, records it on the card and refuses a late click', async () => {
  const { id } = await ask('Which one?');
  assert.equal((await inbox()).length, 1);
  await assert.rejects(call(`/api/tickets/${ticket.id}/settle`, { method: 'POST', body: { questionId: id } }), /403/);
  assert.deepEqual(await settle(id), { settled: [id] });
  assert.equal((await inbox()).length, 0);
  const events = await call(`/api/tickets/${ticket.id}/events?after=0`);
  assert.equal(JSON.parse(events.find((e: any) => e.kind === 'question').data).settled.at > 0, true);
  assert.deepEqual(events.filter((e: any) => e.kind === 'question_result').map((e: any) => JSON.parse(e.data).id), [id]);
  await assert.rejects(call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: id, answers: [{ selected: ['A'], other: '' }] } }), /409 Claude took this as answered/);
  await assert.rejects(settle(id), /404 No open question card/);
});

test('with no id it settles every open card, and skips ones already answered by a click', async () => {
  const clicked = await ask('First?');
  await call(`/api/tickets/${ticket.id}/answer`, { method: 'POST', body: { questionId: clicked.id, answers: [{ selected: ['A'], other: '' }] } });
  await idle(ticket.id);
  const a = await ask('Second?');
  const b = await ask('Third?');
  assert.deepEqual(await settle(), { settled: [a.id, b.id] });
  assert.deepEqual(await settle(), { settled: [] });
  assert.equal((await inbox()).length, 0);
});
