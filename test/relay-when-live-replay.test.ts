import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { git as gitIn, makeRepo } from './git.ts';
import { bootServer, PASSWORD, REPO, SECRET, stopProcs, tempRoot, type Booted } from './helpers.ts';

// #1001 (daa79fd1): a relay_when_live to several recipients answers with the queued relays' ids, and the tool
// text names every one, so the sender can cancel or track the right relays.
const tmp = tempRoot('relay-when-live-replay-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
let srv: Booted | undefined;
after(async () => {
  if (srv) await stopProcs([srv.proc]);
  await tmp.teardown();
});

const repo = join(root, 'scheme-repo');
makeRepo(repo);
const git = (...args: string[]) => gitIn(repo, ...args);
writeFileSync(join(repo, 'f.txt'), '1');
git('add', '-A');
git('commit', '-q', '-m', 'c1');

const store = new Store(join(data, 'coordinator.db'));
const A = store.createProject('A', null);
store.setProjectRepoDir(A.id, repo);
store.createTicket({ project_id: A.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
const mk = (title: string) => store.createTicket({ project_id: A.id, kind: 'ticket', title, permission_mode: 'default', created_by: 'Cara' });
const M1 = mk('Sender');
const M2 = mk('Second');
const M3 = mk('Third');
store.setTicketDir(M1.id, repo, 'ticket/1-sender');
store.setSetting('relay-when-live', []);

const tokens = new Auth(PASSWORD, SECRET);
before(async () => {
  srv = await bootServer({ root });
});

async function tool(from: number, name: string, args: object): Promise<{ text: string; error: boolean }> {
  const child = tmp.spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: { ...process.env, COORDINATOR_API: srv!.base, COORDINATOR_TOKEN: tokens.agentToken(from), COORDINATOR_PROJECT: String(A.id), COORDINATOR_TICKET: String(from), COORDINATOR_ROLE: 'thread' },
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

test('a relay to two recipients: the route returns the queued ids, and the tool text names every relay', async () => {
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(repo, 'f.txt'), '2');
  git('add', '-A');
  git('commit', '-q', '-m', 'c2');
  const c = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  const res = await fetch(`${srv!.base}/api/tickets/${M1.id}/relay-when-live`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.agentToken(M1.id)}` },
    body: JSON.stringify({ to: [`#${M2.number}`, `#${M3.number}`], text: 'to both', commit: c }),
  });
  const body: any = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.queued, true);
  assert.equal(body.ids.length, 2, 'ids lists every queued relay');
  assert.equal(body.id, body.ids[0], 'id is a queued relay, not a sent one');
  const pending = body.relays.map((r: any) => r.id).sort();
  assert.deepEqual([...body.ids].sort(), pending, 'the listed ids are the pending relays');
  const t = await tool(M1.id, 'relay_when_live', { to: [`#${M2.number}`, `#${M3.number}`], text: 'again', commit: c });
  assert.equal(t.error, false, t.text);
  const m = /^Queued as #(\d+) \(relays #(\d+), #(\d+), one per recipient\)/.exec(t.text);
  assert.ok(m, `the text names every relay: ${t.text}`);
  assert.equal(m![1], m![2]);
});
