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

async function edit(scope: string, edits: unknown, overlaps?: string[]) {
  const res = await fetch(`${base}/api/tickets/${ticket.id}/edit-instructions`, {
    method: 'POST', headers: { Authorization: `Bearer ${live()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, edits, overlaps }),
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
  // A minion in another scheme first, so this one's number in its scheme isn't its id (#1287 F4).
  store.createTicket({ project_id: (await api('/api/projects', 'POST', { name: 'Other' })).id, title: 'earlier', permission_mode: 'bypassPermissions', created_by: 'x' });
  ticket = await api(`/api/projects/${project.id}/tickets`, 'POST', { message: 'edit the settings' }, joshCookie);
  await until('the first turn', () => turns().length >= 1);
  assert.notEqual(ticket.number, ticket.id, 'the number in the scheme differs from the id, or the checks below prove nothing (#1287 F4)');
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
  assert.equal(row.by, `#${ticket.number} for Josh`);
  assert.equal(row.old_text, 'Alpha one.\nBeta two.\nBeta two again.');
});

test('Citadel-wide text is refused for a turn run for a non-member, and saves once the person is one', async () => {
  store.setAppInstructions('Rule A.', 'Cara');
  await assert.rejects(edit('citadel', [{ find: 'Rule A.', replace: 'Rule B.' }]), /403/);
  assert.equal(store.appInstructions().text, 'Rule A.');
  store.updateUser(josh, { admin: 1 });
  await edit('citadel', [{ find: 'Rule A.', replace: 'Rule B.' }]);
  assert.equal(store.appInstructions().text, 'Rule B.');
  assert.equal(store.appInstructionHistory(1)[0].by, `#${ticket.number} for Josh`);
});

// One home per rule (#1162): an edit that repeats a registered rule, or that the turn's Grunt says is already written, is
// held on a card; Save anyway saves exactly what it showed, Work it in and Cancel edit save nothing.
const COPY = 'Ask with a card for a go, A or B, or an offer of work; tuning details are yours to pick.';
const lastCard = () => JSON.parse(store.eventsOfKinds(ticket.id, ['plan']).at(-1)!.data);
// A decided card wakes the minion with the answer: wait for that turn, whose token the next edit uses.
const verdict = async (verdict: string, as = cookie, notes?: string) => {
  const n = turns().length;
  const res = await fetch(`${base}/api/tickets/${ticket.id}/verdict`, { method: 'POST', headers: { Cookie: as, 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: lastCard().id, verdict, notes }) });
  // and for it to end, so the test's own writes don't race the server's.
  if (res.status === 202) await until('the answer\'s turn', () => turns().length > n && store.getTicket(ticket.id)!.status !== 'running');
  return { status: res.status, body: await res.json() };
};

test('an edit repeating the card rule is held on a card, and Save anyway saves what it showed', async () => {
  const was = store.getProject(project.id)!.instructions;
  const r = await edit('scheme', [{ find: 'Gamma.', replace: `Gamma.\n\n${COPY}` }]);
  assert.equal(r.held, 1);
  assert.match(r.found[0], /Registered rule: When to use a card/);
  assert.equal(store.getProject(project.id)!.instructions, was, 'nothing saved yet');
  const card = lastCard();
  assert.equal(card.instructions.scope, 'scheme');
  assert.equal(card.to, 'Josh');
  assert.match(card.plan, /Already said elsewhere[\s\S]*the Citadel-wide card rule/);
  const ok = await verdict('approve');
  assert.equal(ok.status, 202, JSON.stringify(ok.body).slice(0, 300));
  assert.equal(store.getProject(project.id)!.instructions, `${was}\n\n${COPY}`);
  assert.match(store.instructionHistory(project.id, 1)[0].by, new RegExp(`#${ticket.number} for Josh, saved by `));
  assert.equal((await verdict('reject')).status, 409, 'decided once');
});

test("the turn's own Grunt findings hold an edit too; Cancel edit and Work it in save nothing", async () => {
  const was = store.getProject(project.id)!.instructions;
  const r = await edit('scheme', [{ find: 'Alpha 1.', replace: 'Alpha 1. Plus a short new line here.' }], ['CLAUDE.md, Working rules: already says this']);
  assert.equal(r.held, 1);
  assert.match(lastCard().plan, /From the minion's own check: CLAUDE\.md, Working rules/);
  assert.equal((await verdict('reject')).status, 202);
  assert.equal(lastCard().status, 'rejected');
  await edit('scheme', [{ find: 'Alpha 1.', replace: 'Alpha 1. Plus a short new line here.' }], ['CLAUDE.md says it']);
  assert.equal((await verdict('revise')).status, 202, 'notes are optional');
  assert.equal(store.getProject(project.id)!.instructions, was);
});

test('Save anyway refuses when the text changed under the card, and a Citadel-wide one needs an admin', async () => {
  await edit('scheme', [{ find: 'Beta two.', replace: `Beta two.\n\n${COPY} Again.` }]);
  store.setProjectInstructions(project.id, `${store.getProject(project.id)!.instructions}\nMoved on.`, 'Cara');
  assert.equal((await verdict('approve')).status, 409);
  store.setAppInstructions('Rule B.', 'Cara');
  await edit('citadel', [{ find: 'Rule B.', replace: `Rule B.\n\n${COPY}` }]);
  store.updateUser(josh, { admin: 0 });
  assert.equal((await verdict('approve', joshCookie)).status, 403);
  assert.equal(store.appInstructions().text, 'Rule B.');
  assert.equal((await verdict('approve')).status, 202);
  assert.match(store.appInstructions().text, /tuning details/);
});

test('a newer held edit posted while Save anyway is writing does not turn the saved card back into "superseded" (A2)', async () => {
  const was = store.getProject(project.id)!.instructions;
  await edit('scheme', [{ find: 'Moved on.', replace: `Moved on.\n\n${COPY} First.` }]);
  const first = lastCard();
  const n = turns().length;
  const save = fetch(`${base}/api/tickets/${ticket.id}/verdict`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: first.id, verdict: 'approve' }) });
  const again = edit('scheme', [{ find: 'Moved on.', replace: `Moved on.\n\n${COPY} Second.` }]).catch((e) => e);
  const res = await save;
  await again;
  assert.equal(res.status, 202);
  const cards = store.eventsOfKinds(ticket.id, ['plan']).map((e) => JSON.parse(e.data));
  assert.equal(cards.find((c) => c.id === first.id).status, 'approved', 'the card that was saved says so');
  assert.match(store.getProject(project.id)!.instructions!, /First\./);
  assert.notEqual(store.getProject(project.id)!.instructions, was);
  await until('the answer\'s turn', () => turns().length > n && store.getTicket(ticket.id)!.status !== 'running');
});

test('a person\'s own Settings save is checked by the same matcher', async () => {
  const r = await api(`/api/projects/${project.id}/instructions/overlaps`, 'POST', { scope: 'scheme', text: `Hello.\n\nOne card, one choice: ask early and together, with your pick marked.` });
  assert.equal(r.found.length, 1);
  assert.match(r.found[0].why, /one home is the Citadel-wide card rule/);
  assert.deepEqual((await api(`/api/projects/${project.id}/instructions/overlaps`, 'POST', { scope: 'scheme', text: 'Hello there, a brand new line about lunch plans.' })).found, []);
});
