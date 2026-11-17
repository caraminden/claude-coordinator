import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { LiveWaiters, type Relay } from '../src/wake.ts';
import { bootServer, PASSWORD, REPO, SECRET, stopProcs, type Booted } from './helpers.ts';

// relay_when_live: a note queued for a Taskmaster or minion, sent as held mail once its commit is live. The
// Taskmaster of the sender sees the text at once. LiveWaiters is tested in process (a stand-in live checkout);
// the tool and its routes through the real MCP server, in a scheme whose repo this server doesn't run, where live means merged.
const root = mkdtempSync(join(tmpdir(), 'relay-when-live-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
let srv: Booted | undefined;
after(async () => {
  if (srv) await stopProcs([srv.proc]);
  rmSync(root, { recursive: true, force: true });
});

const repo = join(root, 'scheme-repo');
mkdirSync(repo);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
let n = 0;
const commit = () => {
  writeFileSync(join(repo, 'f.txt'), String(++n));
  git('add', '-A');
  git('commit', '-q', '-m', `c${n}`);
  return git('rev-parse', 'HEAD');
};
commit();

const store = new Store(join(data, 'coordinator.db'));
const A = store.createProject('A', null);
const B = store.createProject('B', null);
store.setProjectRepoDir(A.id, repo);
const TM = store.createTicket({ project_id: A.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
const BTM = store.createTicket({ project_id: B.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
const mk = (title: string) => store.createTicket({ project_id: A.id, kind: 'ticket', title, permission_mode: 'default', created_by: 'Cara' });
const M1 = mk('Sender');
const M2 = mk('Receiver');
store.setTicketDir(M1.id, repo, 'ticket/1-sender');
store.setSetting('relay-when-live', []);

const mail = (id: number) => store.listEvents(id).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data));

test('in process: nothing is delivered before the commit is live, then once, and a restart keeps it pending', async () => {
  const got: Relay[] = [];
  const mkw = (head: string) => {
    const w = new LiveWaiters(store, repo, head, () => {});
    w.deliver = (r) => got.push(r);
    return w;
  };
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'work');
  const work = commit();
  git('checkout', '-q', 'main');
  const w = mkw(head);
  const { queued, relay } = await w.addRelay({ ticket: M1.id, to: { minion: M2.id, number: M2.number }, text: 'hello', commit: work });
  assert.equal(queued, true);
  await w.check();
  assert.equal(got.length, 0, 'not live yet');
  const restarted = mkw(head);
  assert.deepEqual(restarted.relays().map((r) => r.id), [relay.id], 'survives a restart');
  git('merge', '-q', '--ff-only', 'work');
  await restarted.check(git('rev-parse', 'HEAD'));
  assert.deepEqual(got.map((r) => r.text), ['hello']);
  assert.equal(restarted.relays().length, 0);
  await restarted.check();
  assert.equal(got.length, 1, 'sent once');
  // Already live: delivered at once, never stored.
  const again = await restarted.addRelay({ ticket: M1.id, to: { minion: M2.id, number: M2.number }, text: 'now', commit: work });
  assert.equal(again.queued, false);
  assert.equal(got.length, 2);
  // Cancel.
  const head2 = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'work2');
  const c2 = commit();
  git('checkout', '-q', 'main');
  const q = await mkw(head2).addRelay({ ticket: M1.id, to: { minion: M2.id, number: M2.number }, text: 'x', commit: c2 });
  const w3 = mkw(head2);
  assert.equal(w3.cancelRelay(M2.id, q.relay.id), null, "another minion can't cancel it");
  assert.ok(w3.cancelRelay(M1.id, q.relay.id));
  assert.equal(w3.relays().length, 0);
  store.setSetting('relay-when-live', []);
});

const tokens = new Auth(PASSWORD, SECRET);
before(async () => {
  srv = await bootServer({ root });
});

async function tool(from: number, name: string, args: object): Promise<{ text: string; error: boolean }> {
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
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

test('through the tool: queued, the Taskmaster has the full text as held mail, listed, cancelled', async () => {
  git('checkout', '-q', '-b', 'work3');
  const c = commit();
  git('checkout', '-q', 'main');
  const text = 'Peek: the new route is live. '.repeat(40);
  const r = await tool(M1.id, 'relay_when_live', { to: M2.number === 2 ? '#2' : `#${M2.number}`, text, commit: c });
  assert.equal(r.error, false, r.text);
  const id = /^Queued as #(\d+)/.exec(r.text)?.[1];
  assert.ok(id, r.text);
  const tm = mail(TM.id).at(-1);
  assert.equal(tm.mail, true, 'held mail: no Taskmaster turn');
  assert.ok(tm.text.includes(text.trim()), 'the full text');
  assert.match(tm.text, new RegExp(`#${M1.number} will send this to #${M2.number} once ${c.slice(0, 7)} is live`));
  assert.equal(mail(M2.id).length, 0, 'nothing sent before live');
  assert.match((await tool(M1.id, 'relay_when_live', {})).text, new RegExp(`^Pending relays:\\n#${id} to #2`));
  assert.match((await tool(M1.id, 'relay_when_live', { cancel: Number(id) })).text, new RegExp(`^Cancelled relay #${id}\\. None left`));
  assert.match(mail(TM.id).at(-1).text, /cancelled its relay/);
});

test('through the tool: a live commit goes out at once to a scheme Taskmaster, who gets it labelled; its sender gets "went out"', async () => {
  const live = git('rev-parse', 'HEAD');
  const r = await tool(M1.id, 'relay_when_live', { to: 'B', text: 'for B', commit: live });
  // B may be unreachable for this turn's person (membership): then the tool says so and nothing is sent.
  if (r.error) return assert.match(r.text, /No scheme called "B"/);
  assert.match(r.text, /live already/);
  assert.match(mail(BTM.id).at(-1).author, /A #1 \(relayed once live\)/);
  assert.match(mail(TM.id).at(-1).text, /relay to B went out/);
});
