import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, REPO, SECRET, type Booted } from './helpers.ts';

// pin_artifact / unpin_artifact / list_artifacts: a Taskmaster or a minion pins an artifact of its own
// scheme when a person asks, through the real MCP server talking to a real server.
const root = mkdtempSync(join(tmpdir(), 'pin-artifacts-'));
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
const M2 = thread(A.id, 'ticket', 'Two');
const MB = thread(B.id, 'ticket', 'Other scheme');
writeFileSync(join(M1.cwd, 'glossary.html'), '<html><head><title>Delve Glossary</title></head></html>');
writeFileSync(join(M1.cwd, 'gone.md'), '# Gone');
writeFileSync(join(MB.cwd, 'theirs.md'), '# Theirs');
// Linked in replies, so the server's startup scan keeps them.
const reply = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
store.addEvent(M1.id, 'claude', reply('[Glossary](glossary.html) and [old](gone.md)'));
store.addEvent(MB.id, 'claude', reply('[Theirs](theirs.md)'));
store.syncArtifacts(M1, [{ path: 'glossary.html', size: 1, mtime: 1 }, { path: 'gone.md', size: 1, mtime: 1 }]);
store.syncArtifacts(MB, [{ path: 'theirs.md', size: 1, mtime: 1 }]);
const art = (projectId: number, path: string) => store.listArtifacts(projectId).find((a) => a.path === path)!;
const GLOSSARY = art(A.id, 'glossary.html');
const GONE = art(A.id, 'gone.md');
const THEIRS = art(B.id, 'theirs.md');

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});
after(() => srv?.proc.kill());

/** One tool call through a fresh mcp.ts acting as `ticket`. */
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
const pinnedBy = async (id: number) => (await srv.call(`/api/artifacts/${id}`)).data.artifact?.pinned_by ?? null;

test('both servers offer the artifact tools', async () => {
  for (const role of ['coordinator', 'thread']) {
    const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], { env: { ...process.env, COORDINATOR_ROLE: role }, stdio: ['pipe', 'pipe', 'inherit'] });
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    const names = (await reply).result.tools.map((t: any) => t.name);
    child.kill();
    for (const n of ['list_artifacts', 'pin_artifact', 'unpin_artifact']) assert.ok(names.includes(n), `${role} lacks ${n}`);
  }
});

test('list_artifacts shows titles, and only this scheme', async () => {
  const { text, error } = await tool(TA, 'list_artifacts', {});
  assert.equal(error, false);
  assert.match(text, new RegExp(`\\[${GLOSSARY.id}\\] Delve Glossary \\| glossary\\.html \\| from #${M1.number}`));
  assert.doesNotMatch(text, /Theirs/);
});

test('a Taskmaster pins by id and unpins, recorded as Taskmaster for the asker', async () => {
  const pin = await tool(TA, 'pin_artifact', { artifact: GLOSSARY.id, requested_by: 'Cara' });
  assert.equal(pin.error, false, pin.text);
  assert.match(pin.text, /^Pinned\. .*pinned by Taskmaster for Cara/);
  assert.equal(await pinnedBy(GLOSSARY.id), 'Taskmaster for Cara');
  assert.match((await tool(TA, 'list_artifacts', { pinned_only: true })).text, /Delve Glossary/);
  const unpin = await tool(TA, 'unpin_artifact', { artifact: GLOSSARY.id, requested_by: 'Cara' });
  assert.match(unpin.text, /^Unpinned\./);
  assert.equal(await pinnedBy(GLOSSARY.id), null);
});

test('a minion pins another minion\'s artifact by its shown path, and its own by the path it linked', async () => {
  // M2 didn't make it, so a relative path from M2's folder doesn't name it, but the shown path does.
  assert.match((await tool(M2, 'pin_artifact', { path: 'glossary.html', requested_by: 'Josh' })).text, /Pinned\..*pinned by #\d+ for Josh/);
  assert.equal(await pinnedBy(GLOSSARY.id), `#${M2.number} for Josh`);
  assert.equal((await tool(M1, 'pin_artifact', { path: join(M1.cwd, 'gone.md'), requested_by: 'Cara' })).error, false);
  assert.equal(await pinnedBy(GONE.id), `#${M1.number} for Cara`);
});

test('a re-pin keeps the first pinner; a relative path names the caller\'s own file; an ambiguous one asks for the id', async () => {
  const again = await tool(TA, 'pin_artifact', { artifact: GLOSSARY.id, requested_by: 'Cara' });
  assert.match(again.text, /^Already pinned/);
  assert.equal(await pinnedBy(GLOSSARY.id), `#${M2.number} for Josh`);
  // M2 links a glossary.html of its own: its relative path now means that one, not M1's.
  writeFileSync(join(M2.cwd, 'glossary.html'), '<title>Draft</title>');
  const s = new Store(join(data, 'coordinator.db'));
  s.syncArtifacts(M2, [{ path: 'glossary.html', size: 1, mtime: 1 }]);
  const own = s.listArtifacts(A.id).find((a) => a.ticket_id === M2.id)!;
  assert.match((await tool(M2, 'pin_artifact', { path: 'glossary.html', requested_by: 'Cara' })).text, new RegExp(`^Pinned\\. \\[${own.id}\\] glossary\\.html .*from #${M2.number}`));
  // The Taskmaster's folder has neither, and both show as glossary.html.
  const both = await tool(TA, 'unpin_artifact', { path: 'glossary.html', requested_by: 'Cara' });
  assert.equal(both.error, true);
  assert.match(both.text, new RegExp(`2 artifacts match glossary\\.html \\(ids .*${own.id}.*\\); give the id`));
});

test('a minion cannot pin in another scheme', async () => {
  const byId = await tool(M1, 'pin_artifact', { artifact: THEIRS.id, requested_by: 'Cara' });
  assert.equal(byId.error, true);
  assert.match(byId.text, /No artifact \d+ in this scheme/);
  const byPath = await tool(M1, 'pin_artifact', { path: join(MB.cwd, 'theirs.md'), requested_by: 'Cara' });
  assert.equal(byPath.error, true);
  // Straight at the API, naming the other scheme: refused before anything is looked up.
  const res = await fetch(`${srv.base}/api/projects/${B.id}/artifacts/pin`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokens.agentToken(M1.id)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ artifact: THEIRS.id, pinned: true, requested_by: 'Cara' }),
  });
  assert.equal(res.status, 403);
  assert.equal(await pinnedBy(THEIRS.id), null);
});

test('requested_by is required', async () => {
  const r = await tool(M1, 'pin_artifact', { artifact: GLOSSARY.id });
  assert.equal(r.error, true);
  assert.match(r.text, /requested_by is required/);
});

test('unpinning a missing artifact removes its row', async () => {
  rmSync(join(M1.cwd, 'gone.md'));
  const s = new Store(join(data, 'coordinator.db'));
  s.syncArtifacts(M1, [{ path: 'glossary.html', size: 1, mtime: 1 }]); // the scan finds it gone: kept as missing, since pinned
  assert.match((await tool(TA, 'list_artifacts', {})).text, /gone\.md.*missing/);
  const r = await tool(TA, 'unpin_artifact', { artifact: GONE.id, requested_by: 'Cara' });
  assert.match(r.text, /off the Artifacts panel/);
  assert.equal((await srv.call(`/api/artifacts/${GONE.id}`)).status, 404);
});
