import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { bootServer, PASSWORD, SECRET, tempRoot, type Booted } from './helpers.ts';
import { agentEnv, mcpOnce } from './mcp-agent.ts';
import { json } from './typed.ts';

// Files in a scheme's shared folder can be pinned: by people in the Shared viewer.
// A pin is keyed by path, so a rewrite keeps it and a deleted file shows as missing.
const scratch = tempRoot('shared-pins-');
const root = scratch.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });

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
store.db.close(); // the server below is the only writer to this file
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
after(async () => {
  await srv?.stop(); // ends the server and its turns before the folder goes (#218)
  await scratch.teardown();
});

async function tool(ticket: { id: number; project_id: number; kind: string }, name: string, args: object): Promise<{ text: string; error: boolean }> {
  const result = await mcpOnce(agentEnv(srv.base, tokens.agentToken(ticket.id), ticket, ticket.kind === 'coordinator' ? 'coordinator' : 'thread'), 'tools/call', { name, arguments: args }, scratch.track);
  return { text: result.content[0].text, error: !!result.isError };
}
type SharedFile = { path: string; kind: string; pinned_at: number | null; pinned_by: string | null; missing?: number };
const shared = async (projectId = A.id) => (await srv.call(`/api/projects/${projectId}/shared`)).data as SharedFile[];
const entry = async (path: string) => (await shared()).find((f) => f.path === path);
const pin = (path: string, pinned: boolean) => srv.call(`/api/projects/${A.id}/shared/pin`, { path, pinned });

test('a person pins a shared file; the Shared list carries the pin', async () => {
  assert.equal((await entry('handoff.md'))!.pinned_at, null);
  const r = await pin('handoff.md', true);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.file.pinned_by, 'Cara');
  const e = (await entry('handoff.md'))!;
  assert.equal(e.pinned_by, 'Cara');
  assert.equal(e.missing, 0);
  assert.equal((await pin('specs/town.md', true)).data.file.path, 'specs/town.md');
});

test('rewriting a pinned file keeps its pin; deleting it leaves it listed as missing until unpinned', async () => {
  writeFileSync(join(dirA, 'handoff.md'), '# Lairs handoff, take two');
  assert.equal((await entry('handoff.md'))!.pinned_by, 'Cara');
  unlinkSync(join(dirA, 'specs', 'town.md'));
  const gone = (await entry('specs/town.md'))!;
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
  assert.equal((await entry('notes/n.md'))!.missing, 1);
  await pin('notes/n.md', false);
});

test('only files the Shared list shows can be pinned', async () => {
  assert.equal((await pin('../../../../secret.md', true)).status, 400);
  assert.equal((await pin('/etc/passwd', true)).status, 400);
  assert.equal((await pin('link.md', true)).status, 404); // a symlink out of the folder
  assert.equal((await pin('nothing.md', true)).status, 404);
  assert.equal((await pin('specs/../handoff.md', true)).status, 200); // same file, already pinned
  assert.deepEqual(
    (await shared()).filter((f) => f.pinned_at).map((f) => f.path),
    ['handoff.md'],
  );
});

test('list_artifacts shows shared files, marked as shared, with their pins', async () => {
  const { text, error } = await tool(M1, 'list_artifacts', {});
  assert.equal(error, false, text);
  assert.match(text, /\[shared\] Lairs handoff, take two \| scheme shared\/handoff\.md \| in the shared folder .*\| pinned by Cara/);
  assert.doesNotMatch(text, /Theirs/);
  assert.match((await tool(M1, 'list_artifacts', { pinned_only: true })).text, /^\[shared\] Lairs handoff/);
});

test('people upload into the shared folder: the bytes as sent, a cleaned name, never overwriting, never outside it (#676)', async () => {
  const put = (q: string, body: Buffer | string, headers: Record<string, string> = { Cookie: srv.cookie }) => fetch(`${srv.base}/api/projects/${A.id}/shared/upload?${q}`, { method: 'PUT', headers, body });
  // Not valid UTF-8, so any re-encoding on the way would show.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);
  const r = await put('name=snap.png', png);
  assert.equal(r.status, 201);
  const got = await json<{ path: string }>(r);
  assert.equal(got.path, 'inbox/snap.png'); // inbox/ unless a folder is named
  assert.deepEqual(readFileSync(join(dirA, 'inbox', 'snap.png')), png);
  assert.equal((await entry('inbox/snap.png'))!.kind, 'image'); // pictures are listed now
  // A folder of the person's choosing, made as needed; a second file of the same name keeps the first.
  assert.equal((await json<{ path: string }>(await put('folder=fixtures-inbox/poe2/&name=snap.png', png))).path, 'fixtures-inbox/poe2/snap.png');
  assert.equal((await json<{ path: string }>(await put('folder=fixtures-inbox/poe2&name=snap.png', 'two'))).path, 'fixtures-inbox/poe2/snap (2).png');
  assert.deepEqual(readFileSync(join(dirA, 'fixtures-inbox', 'poe2', 'snap.png')), png);
  // A name can't climb out; a folder can't climb, hide, or go through a link that leads out.
  assert.equal((await json<{ path: string }>(await put(`name=${encodeURIComponent('../../evil.png')}`, 'x'))).path, 'inbox/evil.png');
  for (const folder of ['..', 'specs/../..', '.git', 'a/b/c/d/e/f/g/h/i']) assert.equal((await put(`folder=${encodeURIComponent(folder)}&name=x.png`, 'x')).status, 400, folder);
  symlinkSync(join(root, 'elsewhere'), join(dirA, 'away'));
  assert.equal((await put('folder=away/deeper&name=x.png', 'x')).status, 400);
  assert.ok(!existsSync(join(root, 'elsewhere', 'deeper')));
  assert.equal((await put('folder=handoff.md&name=x.png', 'x')).status, 400); // a file, not a folder
  // People only: an agent's token, or another scheme's Taskmaster, is turned away.
  assert.equal((await put('name=y.png', 'y', { Authorization: `Bearer ${tokens.agentToken(M1.id)}` })).status, 403);
  // Agents' list_artifacts keeps to documents and pages, so a folder of snaps doesn't bury it.
  assert.doesNotMatch((await tool(M1, 'list_artifacts', {})).text, /snap/);
});

test('scheme scoping: another scheme cannot see these', async () => {
  const res = await fetch(`${srv.base}/api/projects/${A.id}/shared`, { headers: { Authorization: `Bearer ${tokens.agentToken(TB.id)}` } });
  assert.equal(res.status, 403);
  assert.equal((await shared(B.id)).find((f) => f.path === 'theirs.md')!.pinned_at, null);
  assert.equal((await entry('handoff.md'))!.pinned_by, 'Cara');
});

test('deleting a scheme drops its shared pins', () => {
  const s = new Store(join(data, 'coordinator.db'));
  const P = s.createProject('Doomed', null);
  s.setSharedPin(P.id, 'x.md', 'Cara');
  s.deleteProject(P.id);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM shared_pins WHERE project_id = ?').get(P.id)!.n, 0);
});
