import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { bootServer, jsonLines, stopProcs, stopTurns, until } from './helpers.ts';

// edit_instructions (#961): a minion edits Settings text through the same setters and history as a person.
const root = mkdtempSync(join(tmpdir(), 'edit-instr-'));
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
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ token: process.env.COORDINATOR_TOKEN }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
chmodSync(fakeClaude, 0o755);

let base = '';
let cookie = '';
let store: Store;
let ticket: any;
let project: any;
let josh = 0;
let joshCookie = '';
const turns = () => jsonLines(join(root, 'turns.jsonl'));
const live = () => turns().filter((t) => t.token.startsWith(`${ticket.id}.`)).at(-1).token;

async function edit(scope: string, edits: unknown) {
  const res = await fetch(`${base}/api/tickets/${ticket.id}/edit-instructions`, {
    method: 'POST', headers: { Authorization: `Bearer ${live()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, edits }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.error}`);
  return data;
}
const api = async (path: string, method = 'GET', body?: unknown, as = cookie) => {
  const res = await fetch(base + path, { method, headers: { Cookie: as, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};

before(async () => {
  const srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
  project = await api('/api/projects', 'POST', { name: 'P' });
  const made = await api('/api/people', 'POST', { name: 'Josh' });
  josh = made.person.id;
  const inv = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'Josh-password-1' }) });
  joshCookie = inv.headers.get('set-cookie')!.split(';')[0];
  await api(`/api/projects/${project.id}/members`, 'POST', { person: josh });
  store = new Store(join(srv.data, 'coordinator.db'));
  store.updateUser(josh, { server_login: 1 });
  store.setProjectInstructions(project.id, 'Alpha one.\nBeta two.\nBeta two again.', 'Cara');
  ticket = await api(`/api/projects/${project.id}/tickets`, 'POST', { message: 'edit the settings' }, joshCookie);
  await until('the first turn', () => turns().length >= 1);
});

test('a partial match saves nothing and names the failing edits', async () => {
  await assert.rejects(edit('scheme', [{ find: 'Alpha one.', replace: 'Alpha 1.' }, { find: 'Beta two', replace: 'x' }, { find: 'Missing', replace: 'y' }]),
    /409 Nothing saved\. edit 2: "Beta two" matches 2 times, not once; edit 3: "Missing" matches 0 times/);
  assert.equal(store.getProject(project.id)!.instructions, 'Alpha one.\nBeta two.\nBeta two again.');
  assert.equal(store.instructionHistory(project.id, 10).length, 1);
});

test('a scheme save is one history row by the minion and the person its turn runs for', async () => {
  await edit('scheme', [{ find: 'Alpha one.', replace: 'Alpha 1.' }, { find: 'Beta two again.', replace: 'Gamma.' }]);
  assert.equal(store.getProject(project.id)!.instructions, 'Alpha 1.\nBeta two.\nGamma.');
  const [row] = store.instructionHistory(project.id, 1);
  assert.equal(row.by, `#${ticket.id} for Josh`);
  assert.equal(row.old_text, 'Alpha one.\nBeta two.\nBeta two again.');
});

test('Citadel-wide text is refused for a turn run for a non-member, and saves once the person is one', async () => {
  store.setAppInstructions('Rule A.', 'Cara');
  await assert.rejects(edit('citadel', [{ find: 'Rule A.', replace: 'Rule B.' }]), /403/);
  assert.equal(store.appInstructions().text, 'Rule A.');
  store.updateUser(josh, { admin: 1 });
  await edit('citadel', [{ find: 'Rule A.', replace: 'Rule B.' }]);
  assert.equal(store.appInstructions().text, 'Rule B.');
  assert.equal(store.appInstructionHistory(1)[0].by, `#${ticket.id} for Josh`);
});
