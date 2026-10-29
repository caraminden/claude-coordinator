import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { bootServer, PASSWORD, REPO, SECRET, type Booted } from './helpers.ts';

// Files in a scheme's shared folder can be pinned: by people in the Shared viewer, and by agents
// through pin_artifact. A pin is keyed by path, so a rewrite keeps it and a deleted file shows as missing.
const root = mkdtempSync(join(tmpdir(), 'shared-pins-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const store = new Store(join(data, 'coordinator.db'));
const A = store.createProject('A', null);
const B = store.createProject('B', null);
function thread(projectId: number, kind: 'ticket' | 'coordinator', title: string) {
  const t = store.createTicket({ project_id: projectId, kind, title, permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(root, 'work', String(t.id));
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  return store.getTicket(t.id)!;
}
const TA = thread(A.id, 'coordinator', 'Coordinator');
const M1 = thread(A.id, 'ticket', 'One');
const TB = thread(B.id, 'coordinator', 'Coordinator');
const dirA = projectSharedDir(data, A.id);
const dirB = projectSharedDir(data, B.id);
mkdirSync(join(dirA, 'specs'), { recursive: true });
mkdirSync(dirB, { recursive: true });
writeFileSync(join(dirA, 'handoff.md'), '# Lairs handoff');
writeFileSync(join(dirA, 'specs', 'town.md'), '# Town spec');
writeFileSync(join(dirA, 'outside.md'), '# Not this one');
writeFileSync(join(root, 'secret.md'), '# Secret');
symlinkSync(join(root, 'secret.md'), join(dirA, 'link.md'));
writeFileSync(join(dirB, 'theirs.md'), '# Theirs');

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});
after(() => srv?.proc.kill());

async function tool(ticket: { id: number; project_id: number; kind: string }, name: string, args: object): Promise<{ text: string; error: boolean }> {
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(ticket.id),
      COORDINATOR_PROJECT: String(ticket.project_id), COORDINATOR_TICKET: String(ticket.id),
      COORDINATOR_ROLE: ticket.kind === 'coordinator' ? 'coordinator' : 'thread',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const { result } = await reply;
    return { text: result.content[0].text, error: !!result.isError };
  } finally {
    child.kill();
  }
}
const shared = async (projectId = A.id) => (await srv.call(`/api/projects/${projectId}/shared`)).data as any[];
const entry = async (path: string) => (await shared()).find((f) => f.path === path);
const pin = (path: string, pinned: boolean) => srv.call(`/api/projects/${A.id}/shared/pin`, { path, pinned });

test('a person pins a shared file; the Shared list carries the pin', async () => {
  assert.equal((await entry('handoff.md')).pinned_at, null);
  const r = await pin('handoff.md', true);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.file.pinned_by, 'Cara');
  const e = await entry('handoff.md');
  assert.equal(e.pinned_by, 'Cara');
  assert.equal(e.missing, 0);
  assert.equal((await pin('specs/town.md', true)).data.file.path, 'specs/town.md');
});

test('rewriting a pinned file keeps its pin; deleting it leaves it listed as missing until unpinned', async () => {
  writeFileSync(join(dirA, 'handoff.md'), '# Lairs handoff, take two');
  assert.equal((await entry('handoff.md')).pinned_by, 'Cara');
  unlinkSync(join(dirA, 'specs', 'town.md'));
  const gone = await entry('specs/town.md');
  assert.equal(gone.missing, 1);
  assert.equal(gone.pinned_by, 'Cara');
  const r = await pin('specs/town.md', false);
  assert.equal(r.status, 200);
  assert.equal(r.data.file, null);
  assert.equal(await entry('specs/town.md'), undefined);
  // A pinned folder swapped for a symlink out of the shared folder reads as missing, not as the outside file.
  mkdirSync(join(dirA, 'notes'));
  writeFileSync(join(dirA, 'notes', 'n.md'), '# N');
  await pin('notes/n.md', true);
  rmSync(join(dirA, 'notes'), { recursive: true });
  mkdirSync(join(root, 'elsewhere'));
  writeFileSync(join(root, 'elsewhere', 'n.md'), '# Elsewhere');
  symlinkSync(join(root, 'elsewhere'), join(dirA, 'notes'));
  assert.equal((await entry('notes/n.md')).missing, 1);
  await pin('notes/n.md', false);
});

test('only files the Shared list shows can be pinned', async () => {
  assert.equal((await pin('../../../../secret.md', true)).status, 400);
  assert.equal((await pin('/etc/passwd', true)).status, 400);
  assert.equal((await pin('link.md', true)).status, 404); // a symlink out of the folder
  assert.equal((await pin('nothing.md', true)).status, 404);
  assert.equal((await pin('specs/../handoff.md', true)).status, 200); // same file, already pinned
  assert.deepEqual((await shared()).filter((f) => f.pinned_at).map((f) => f.path), ['handoff.md']);
});

test('list_artifacts shows shared files, marked as shared, with their pins', async () => {
  const { text, error } = await tool(M1, 'list_artifacts', {});
  assert.equal(error, false, text);
  assert.match(text, /\[shared\] Lairs handoff, take two \| scheme shared\/handoff\.md \| in the shared folder .*\| pinned by Cara/);
  assert.doesNotMatch(text, /Theirs/);
  assert.match((await tool(M1, 'list_artifacts', { pinned_only: true })).text, /^\[shared\] Lairs handoff/);
});

test('agents pin and unpin shared files by the shown path or the absolute one', async () => {
  const p = await tool(M1, 'pin_artifact', { path: 'scheme shared/outside.md', requested_by: 'Josh' });
  assert.equal(p.error, false, p.text);
  assert.match(p.text, /^Pinned\. \[shared\] outside\.md .*pinned by #\d+ for Josh/);
  assert.equal((await entry('outside.md')).pinned_by, `#${M1.number} for Josh`);
  assert.match((await tool(TA, 'pin_artifact', { path: join(dirA, 'outside.md'), requested_by: 'Cara' })).text, /^Already pinned/);
  assert.match((await tool(TA, 'unpin_artifact', { path: join(dirA, 'outside.md'), requested_by: 'Cara' })).text, /^Unpinned\./);
  assert.equal((await entry('outside.md')).pinned_at, null);
  // Gone and pinned: unpinning takes it off the list.
  await pin('outside.md', true);
  unlinkSync(join(dirA, 'outside.md'));
  assert.match((await tool(M1, 'unpin_artifact', { path: 'scheme shared/outside.md', requested_by: 'Cara' })).text, /off the Artifacts panel now/);
  assert.equal(await entry('outside.md'), undefined);
  const bad = await tool(M1, 'pin_artifact', { path: 'scheme shared/link.md', requested_by: 'Cara' });
  assert.equal(bad.error, true);
});

test('scheme scoping: another scheme can neither see nor pin these', async () => {
  // B's Taskmaster naming A's shared file by its absolute path finds no artifact of its own scheme.
  const r = await tool(TB, 'pin_artifact', { path: join(dirA, 'handoff.md'), requested_by: 'Cara' });
  assert.equal(r.error, true);
  const res = await fetch(`${srv.base}/api/projects/${A.id}/shared`, { headers: { Authorization: `Bearer ${tokens.agentToken(TB.id)}` } });
  assert.equal(res.status, 403);
  assert.equal((await shared(B.id)).find((f) => f.path === 'theirs.md').pinned_at, null);
  assert.equal((await entry('handoff.md')).pinned_by, 'Cara');
});

test('deleting a scheme drops its shared pins', () => {
  const s = new Store(join(data, 'coordinator.db'));
  const P = s.createProject('Doomed', null);
  s.setSharedPin(P.id, 'x.md', 'Cara');
  s.deleteProject(P.id);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM shared_pins WHERE project_id = ?').get(P.id)!.n, 0);
});
