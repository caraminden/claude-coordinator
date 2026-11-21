import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, REPO, SECRET, type Booted, tempRoot } from './helpers.ts';

// #853: message_minion with unpark: true ignores wake: false. The message exists to start the parked
// minion's turn, so it goes in as a message (not held mail) and the minion leaves "parked".
const tmp = tempRoot('minion-unpark-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  if (srv) await srv.stop();
  await tmp.teardown();
});

const store = new Store(join(data, 'coordinator.db'));
const A = store.createProject('A', null);
store.createTicket({ project_id: A.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
const minion = (title: string) => store.createTicket({ project_id: A.id, kind: 'ticket', title, permission_mode: 'default', created_by: 'Cara' });
const M1 = minion('Sender');
const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});

async function tool(from: number, name: string, args: object): Promise<{ text: string; error: boolean }> {
  const child = tmp.spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(from),
      COORDINATOR_PROJECT: String(A.id), COORDINATOR_TICKET: String(from), COORDINATOR_ROLE: 'thread',
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

test('unpark: true with wake: false still unparks and delivers the message, not as held mail (#853)', async () => {
  const P = minion('Waiting on #1');
  store.updateTicket(P.id, { state: 'parked' });
  const r = await tool(M1.id, 'message_minion', { ticket_id: P.number, text: 'my work is on main, go ahead', unpark: true, wake: false });
  assert.equal(r.error, false, r.text);
  assert.doesNotMatch(r.text, /held mail/i, 'the reply does not say it was left as held mail');
  const msg = store.listEvents(P.id).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data)).find((m) => m.text === 'my work is on main, go ahead');
  assert.ok(msg, 'the message reached its chat');
  assert.notEqual(msg.mail, true, 'it went in as a message that starts the turn, not as held mail');
  assert.notEqual(store.getTicket(P.id)!.state, 'parked', 'the unparked minion does not stay parked');
});
