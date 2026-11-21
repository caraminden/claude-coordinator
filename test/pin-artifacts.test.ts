import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, REPO, SECRET, type Booted, tempRoot } from './helpers.ts';

// list_artifacts through the real MCP server talking to a real server; the pin tools are retired (#1356).
const tmp = tempRoot('pin-artifacts-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  await srv?.stop();
  await tmp.teardown();
});

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

/** One tool call through a fresh mcp.ts acting as `ticket`. */
async function tool(ticket: { id: number; project_id: number; kind: string }, name: string, args: object): Promise<{ text: string; error: boolean }> {
  const child = tmp.spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
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
    const child = tmp.spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], { env: { ...process.env, COORDINATOR_ROLE: role }, stdio: ['pipe', 'pipe', 'inherit'] });
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    const names = (await reply).result.tools.map((t: any) => t.name);
    child.kill();
    assert.ok(names.includes('list_artifacts'), `${role} lacks list_artifacts`);
    for (const n of ['pin_artifact', 'unpin_artifact']) assert.ok(!names.includes(n), `${role} still offers ${n}`);
  }
});

test('list_artifacts shows titles, and only this scheme', async () => {
  const { text, error } = await tool(TA, 'list_artifacts', {});
  assert.equal(error, false);
  assert.match(text, new RegExp(`\\[${GLOSSARY.id}\\] Delve Glossary \\| glossary\\.html \\| from #${M1.number}`));
  assert.doesNotMatch(text, /Theirs/);
});
