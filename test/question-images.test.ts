import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// Option pictures on question cards and comments on files, through the real server. A stand-in
// `claude -p` records each turn's prompt, folder and thread token, then ends the turn.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'question-images-'));
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
let shared = '';

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
  ticket = await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'draw three takes' } });
  [turn] = await until('the first turn', () => turns().length >= 1 && turns());
  await idle(ticket.id);
  shared = join(root, 'data', 'projects', String(project.id), 'shared', String(ticket.id));
  assert.equal(turn.shared, join(root, 'data', 'projects', String(project.id), 'shared', 'project'));
  assert.equal(turn.files, shared);
  mkdirSync(join(turn.cwd, 'takes'), { recursive: true });
  mkdirSync(shared, { recursive: true });
  for (const f of [join(turn.cwd, 'takes/a.png'), join(turn.cwd, 'takes/b.gif'), join(turn.cwd, 'report.md'), join(shared, 'c.mp4'), join(root, 'secret.png')]) writeFileSync(f, 'x');
});

const ask = (images: (string | undefined)[]) => call(`/api/tickets/${ticket.id}/questions`, {
  method: 'POST', token: turn.token,
  body: { questions: [{ question: 'Which take?', options: images.map((image, i) => ({ label: `Take ${i + 1}`, ...(image ? { image } : {}), ...(i ? {} : { recommended: true }) })) }] },
});

test('a question card keeps option pictures from the thread\'s folders', async () => {
  const { id } = await ask(['takes/a.png', join(turn.cwd, 'takes/b.gif'), join(shared, 'c.mp4'), undefined]);
  const card = (await call(`/api/tickets/${ticket.id}/events`)).find((e: any) => e.kind === 'question' && JSON.parse(e.data).id === id);
  assert.deepEqual(JSON.parse(card.data).questions[0].options.map((o: any) => o.image), ['takes/a.png', join(turn.cwd, 'takes/b.gif'), join(shared, 'c.mp4'), undefined]);
  const res = await fetch(`${base}/api/tickets/${ticket.id}/file?path=${encodeURIComponent('takes/a.png')}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
});

test('a question card refuses pictures outside those folders, missing or not pictures', async () => {
  await assert.rejects(ask(['takes/a.png', '../../../../secret.png']), /400 Question 1 option 2 image must be a file in your working directory or shared folder/);
  await assert.rejects(ask([join(root, 'secret.png'), 'takes/a.png']), /400 Question 1 option 1 image must be a file/);
  await assert.rejects(ask(['takes/none.png', 'takes/a.png']), /400 .*must be a file/);
  await assert.rejects(ask(['report.md', 'takes/a.png']), /400 .*must be an image/);
  await assert.rejects(ask(['/etc/passwd', 'takes/a.png']), /400 .*must be an image/);
});

const askWith = (options: object[], multiSelect = false) => call(`/api/tickets/${ticket.id}/questions`, {
  method: 'POST', token: turn.token, body: { questions: [{ question: 'Tabs or list?', multiSelect, options }] },
});

test('every question on a card recommends an option', async () => {
  await assert.rejects(askWith([{ label: 'Tabs' }, { label: 'List' }]), /400 Question 1 needs a recommended option/);
  await assert.rejects(askWith([{ label: 'Tabs', recommended: true }, { label: 'List', recommended: true }]), /400 Question 1 recommends 2 options; mark just one/);
  await askWith([{ label: 'Tabs', recommended: true }, { label: 'List', recommended: true }, { label: 'Both' }], true);
  // A label that says "(Recommended)" itself becomes the flag, so the card doesn't show the words twice.
  const { id } = await askWith([{ label: 'Tabs' }, { label: 'List (Recommended)' }]);
  const card = (await call(`/api/tickets/${ticket.id}/events`)).find((e: any) => e.kind === 'question' && JSON.parse(e.data).id === id);
  assert.deepEqual(JSON.parse(card.data).questions[0].options, [{ label: 'Tabs' }, { label: 'List', recommended: true }]);
});

test('a comment on a file is a chat message from the person that wakes the thread', async () => {
  const before = turns().length;
  await call(`/api/tickets/${ticket.id}/comments`, { method: 'POST', body: { path: 'report.md', text: 'Shorter, please.', quote: 'The long intro' } });
  const next = (await until('the comment\'s turn', () => turns().length > before && turns())).at(-1);
  assert.deepEqual(next.prompt.message.content, [{ type: 'text', text: '[Cara on report.md]: > The long intro\n\nShorter, please.' }]);
  const message = (await call(`/api/tickets/${ticket.id}/events`)).filter((e: any) => e.kind === 'user_message').at(-1);
  assert.deepEqual(JSON.parse(message.data), { author: 'Cara', text: '> The long intro\n\nShorter, please.', comment: { path: 'report.md', about: 'report.md' } });
  await idle(ticket.id);
});

test('comments only on files the thread may show, and only from people', async () => {
  await assert.rejects(call(`/api/tickets/${ticket.id}/comments`, { method: 'POST', body: { path: '../../../../secret.png', text: 'x' } }), /404/);
  await assert.rejects(call(`/api/tickets/${ticket.id}/comments`, { method: 'POST', body: { path: 'report.md', text: ' ' } }), /400/);
  await assert.rejects(call(`/api/tickets/${ticket.id}/comments`, { method: 'POST', token: turn.token, body: { path: 'report.md', text: 'x' } }), /403/);
});

test('a thread can message its coordinator, which wakes with the thread named', async () => {
  const before = turns().length;
  await call(`/api/tickets/${ticket.id}/coordinator`, { method: 'POST', token: turn.token, body: { text: 'Send #2 the handoff' } });
  const next = (await until('the coordinator\'s turn', () => turns().length > before && turns())).at(-1);
  assert.match(next.prompt.message.content[0].text, /^\[#1 .+\]: Send #2 the handoff$/);
  assert.notEqual(next.token, turn.token);
  await assert.rejects(call(`/api/tickets/${ticket.id}/coordinator`, { method: 'POST', body: { text: 'x' } }), /403/);
  await assert.rejects(call(`/api/tickets/${ticket.id}/coordinator`, { method: 'POST', token: next.token, body: { text: 'x' } }), /403/);
});

test('a zip in the thread\'s folders is served as a download, never shown', async () => {
  writeFileSync(join(shared, 'Game build.zip'), 'PK');
  const res = await fetch(`${base}/api/tickets/${ticket.id}/file?path=${encodeURIComponent(join(shared, 'Game build.zip'))}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('content-disposition'), "attachment; filename*=UTF-8''Game%20build.zip");
});
