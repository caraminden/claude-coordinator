import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, jsonLines, until, stopProcs } from './helpers.ts';

// Plan cards through the real server: a minion proposes, only a person approves or sends it back,
// and a newer plan supersedes the open one. A stand-in `claude -p` records each turn's prompt and
// thread token, then ends the turn.
const root = mkdtempSync(join(tmpdir(), 'plan-cards-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
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

const turns = () => jsonLines(join(root, 'turns.jsonl'));
// The token the minion's latest turn holds: each turn's token dies when the next turn starts.
const live = () => turns().filter((t) => t.token.startsWith(`${ticket.id}.`)).at(-1).token;
const idle = (id: number) => until('the turn to end', async () => (await call(`/api/tickets/${id}`)).ticket.status !== 'running');

let ticket: any;
let turn: any;

before(async () => {
  const srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
  const project = await call('/api/projects', { method: 'POST', body: { name: 'P' } });
  ticket = await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'run the plan back to me' } });
  [turn] = await until('the first turn', () => turns().length >= 1 && turns());
  await idle(ticket.id);
});

const propose = (summary: string) => call(`/api/tickets/${ticket.id}/plans`, { method: 'POST', token: live(), body: { summary, plan: `## ${summary}\n\n- step one` } });
const plans = async () => (await call(`/api/tickets/${ticket.id}/events?after=0`)).filter((e: any) => e.kind === 'plan').map((e: any) => JSON.parse(e.data));
const results = async () => (await call(`/api/tickets/${ticket.id}/events?after=0`)).filter((e: any) => e.kind === 'plan_result').map((e: any) => JSON.parse(e.data));

test('a plan card is stored as pending, and the minion cannot approve it', async () => {
  const { id } = await propose('First plan');
  assert.deepEqual(await plans(), [{ id, summary: 'First plan', plan: '## First plan\n\n- step one', status: 'pending' }]);
  await assert.rejects(call(`/api/tickets/${ticket.id}/verdict`, { method: 'POST', token: live(), body: { planId: id, verdict: 'approve' } }), /403/);
  await assert.rejects(call(`/api/tickets/${ticket.id}/plans`, { method: 'POST', body: { summary: 'x', plan: 'y' } }), /403/);
  await assert.rejects(propose(' '), /400 Summary is required/);
});

test('Revise needs notes, sends them to the minion, and the next plan supersedes the old card', async () => {
  const [{ id }] = await plans();
  await assert.rejects(call(`/api/tickets/${ticket.id}/verdict`, { method: 'POST', body: { planId: id, verdict: 'revise', notes: ' ' } }), /400 Notes is required/);
  const before = turns().length;
  await call(`/api/tickets/${ticket.id}/verdict`, { method: 'POST', body: { planId: id, verdict: 'revise', notes: 'Drop step one.' } });
  const next = (await until('the revise turn', () => turns().length > before && turns())).at(-1);
  assert.match(next.prompt.message.content[0].text, /^\[Cara\]: Revise the plan \("First plan"\) before building:\n\nDrop step one\./);
  await idle(ticket.id);
  // The revise turn got a new token, and the first turn's stopped working.
  assert.notEqual(next.token, turn.token);
  await assert.rejects(call(`/api/tickets/${ticket.id}`, { token: turn.token }), /401/);
  await call(`/api/tickets/${ticket.id}`, { token: next.token });
  assert.deepEqual((await plans())[0], { id, summary: 'First plan', plan: '## First plan\n\n- step one', status: 'revising', by: 'Cara', at: (await plans())[0].at });
  await assert.rejects(call(`/api/tickets/${ticket.id}/verdict`, { method: 'POST', body: { planId: id, verdict: 'approve' } }), /409 Cara already asked for changes/);

  const second = await propose('Second plan');
  assert.deepEqual((await plans()).map((p: any) => p.status), ['superseded', 'pending']);
  assert.deepEqual((await results()).map((r: any) => [r.id, r.status]), [[id, 'revising'], [id, 'superseded']]);
  await assert.rejects(call(`/api/tickets/${ticket.id}/verdict`, { method: 'POST', body: { planId: id, verdict: 'approve' } }), /409 A newer plan replaced this one/);
  assert.ok(second.id);
});

test('Approve sends the go once and records who and when', async () => {
  const [, { id }] = await plans();
  const before = turns().length;
  const t0 = Date.now();
  await call(`/api/tickets/${ticket.id}/verdict`, { method: 'POST', body: { planId: id, verdict: 'approve' } });
  const next = (await until('the go turn', () => turns().length > before && turns())).at(-1);
  assert.equal(next.prompt.message.content[0].text, '[Cara]: Plan approved: build it this way. ("Second plan")');
  const approved = (await plans())[1];
  assert.equal(approved.status, 'approved');
  assert.equal(approved.by, 'Cara');
  assert.ok(approved.at >= t0);
  const go = (await call(`/api/tickets/${ticket.id}/events?after=0`)).filter((e: any) => e.kind === 'user_message').at(-1);
  assert.deepEqual(JSON.parse(go.data).plan, { planId: id, verdict: 'approve' });
  await assert.rejects(call(`/api/tickets/${ticket.id}/verdict`, { method: 'POST', body: { planId: id, verdict: 'approve' } }), /409 Cara already approved this plan/);
  await idle(ticket.id);
  // An approved plan stays approved when a later one arrives.
  await propose('Third plan');
  assert.deepEqual((await plans()).map((p: any) => p.status), ['superseded', 'approved', 'pending']);
});

test('a dismissed minion\'s token stops working, except for its deploy report', async () => {
  const token = live();
  await call(`/api/tickets/${ticket.id}`, { token });
  await call(`/api/tickets/${ticket.id}/status`, { method: 'POST', body: { status: 'closed' } });
  await assert.rejects(call(`/api/tickets/${ticket.id}`, { token }), /401/);
  // It can still report the deploy it queued before it was dismissed.
  await call(`/api/tickets/${ticket.id}/deploy`, { method: 'POST', token, body: { ok: true, text: 'Live.' } });
});
