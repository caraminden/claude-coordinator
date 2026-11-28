import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { queueKey } from '../src/minion-queue.ts';
import { bootServer, type Booted } from './helpers.ts';

// #1527: a scheme's open list and the scheme list cost one small read per minion per kind (cards, costs, queue settings,
// chains, people...), about 2,100 statements for 60 open minions on the live data. Batched in a read scope, the count
// stays the same however many minions are open, and what the routes send doesn't change.
const COUNTER = join(import.meta.dirname, 'fixtures', 'sql-count.ts');
const roots: string[] = [];

/** A database with `n` open minions in one scheme, each with what a list row reads: properties, a person who touched it,
 *  a turn's cost, an open card, held mail, a loop hold, a chain behind an open minion and a relay from a dismissed one.
 *  Nothing here may be something a server acts on by itself: about 3 s after boot its live check started every chain
 *  behind a dismissed leader and stamped each row from its own clock, so two servers' answers differed (#2286). */
function seed(n: number): string {
  const root = mkdtempSync(join(tmpdir(), `list-reads-${n}-`));
  roots.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const store = new Store(join(root, 'data', 'coordinator.db'));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const now = Date.now();
  for (const [name, count] of [
    ['A', n],
    ['B', 3],
  ] as const) {
    const p = store.createProject(name, null);
    store.addMember(p.id, josh.id);
    store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Cara' });
    const leader = store.createTicket({ project_id: p.id, title: 'leader', permission_mode: 'default', created_by: 'Josh' });
    store.updateTicket(leader.id, { status: 'closed' });
    const ahead = store.createTicket({ project_id: p.id, title: 'ahead', permission_mode: 'default', created_by: 'Josh' }); // open, so its chains wait
    for (let i = 0; i < count; i++) {
      const t = store.createTicket({ project_id: p.id, title: `minion ${i}`, permission_mode: 'default', created_by: i % 2 ? 'Cara' : 'Josh' });
      store.props.set('minion', t.id, p.id, { type: 'bug', assigned: 'Josh' }, 'Cara');
      store.touch(t.id, josh.id);
      store.recordTurn(t.id, { ended_at: now - i, session_cost_usd: 0.25, session_id: `s${t.id}` });
      store.addEvent(t.id, 'question', { id: `q${t.id}`, questions: [{ question: 'Tabs or list?', header: 'Pick', options: [{ label: 'Tabs' }, { label: 'List' }] }] });
      const mail = store.addEvent(t.id, 'user_message', { text: 'held for later', author: 'Josh' });
      store.setSetting(queueKey(t.id), { held: [{ author: 'Josh', text: 'held for later', images: [], id: mail.id }] });
      store.setSetting(`loop:${t.id}`, { sent: [now], held: [{ to: t.id, author: 'Josh', text: 'again', at: now }] });
      store.addDelivery({ project_id: p.id, kind: 'chain', to_kind: 'minion', to_id: t.id, when_kind: 'live', when_arg: { after: ahead.id, base: null }, payload: { message: 'go on', from: 'Josh', reason: "ahead's work is live" }, set_by: 'Josh' });
      store.addDelivery({ project_id: p.id, kind: 'relay', to_kind: 'minion', to_id: t.id, when_kind: 'live', when_arg: 'f'.repeat(40), payload: { ticket: leader.id, to: { minion: t.id, number: t.number ?? 0 }, text: 'once live' }, set_by: 'Josh' });
    }
  }
  store.db.close();
  return root;
}

// The main thread answers (the front's off switch): the counter counts its statements, and readers (#1590) run the same views.
const boot = (root: string, env: NodeJS.ProcessEnv = {}) => bootServer({ root, env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${COUNTER}`, CITADEL_FRONT: '0', ...env } });
let s10: Booted, s60: Booted, off: Booted;
before(async () => {
  const r60 = seed(60);
  const rOff = mkdtempSync(join(tmpdir(), 'list-reads-off-'));
  roots.push(rOff);
  cpSync(join(r60, 'data'), join(rOff, 'data'), { recursive: true }); // the same rows, before either server writes
  // One after another: ten copies of this file at once (the ship's burn-in) then boot ten servers together, as any
  // one-server file does. All three at once made thirty, and none said its port within the 20 s it is given (#2286).
  s10 = await boot(seed(10));
  s60 = await boot(r60);
  off = await boot(rOff, { CITADEL_READ_SCOPE: '0' });
});
after(async () => {
  await Promise.all([s10, s60, off].map((s) => s?.stop()));
  for (const r of roots) rmSync(r, { recursive: true, force: true }); // timing-ok: own temp dir
});

/** The statements a request ran, and its body. The first call to each route writes its seen marks, so the second counts. */
async function get(s: Booted, path: string): Promise<{ n: number; body: string }> {
  let res: Response | undefined;
  for (let i = 0; i < 2; i++) {
    res = await fetch(s.base + path, { headers: { Cookie: s.cookie } });
    assert.equal(res.status, 200, path);
    if (i === 0) await res.text();
  }
  return { n: Number(res!.headers.get('x-sql-statements')), body: await res!.text() };
}

const scheme = async (s: Booted) => ((await (await fetch(`${s.base}/api/projects`, { headers: { Cookie: s.cookie } })).json()) as { id: number; name: string }[]).find((p) => p.name === 'A')!.id;

test("a scheme's open list and the scheme list run as many statements for 60 open minions as for 10", async () => {
  const [a10, a60] = [await scheme(s10), await scheme(s60)];
  const open10 = await get(s10, `/api/projects/${a10}?tickets=open`),
    open60 = await get(s60, `/api/projects/${a60}?tickets=open`);
  assert.equal(JSON.parse(open60.body).tickets.length, 61, 'the 60 and the minion they wait behind');
  assert.ok(open10.n > 0, 'the counter is loaded');
  assert.equal(open60.n, open10.n, `?tickets=open: ${open10.n} statements for 10 open minions, ${open60.n} for 60`);
  const list10 = await get(s10, '/api/projects'),
    list60 = await get(s60, '/api/projects');
  assert.equal(list60.n, list10.n, `/api/projects: ${list10.n} statements for 10 open minions, ${list60.n} for 60`);
});

test('both routes send the same JSON, key for key and in order, with the read scope on and off', async () => {
  const a = await scheme(s60);
  for (const path of [`/api/projects/${a}?tickets=open`, '/api/projects', `/api/projects/${a}`]) {
    const [on, was] = [await get(s60, path), await get(off, path)];
    assert.equal(on.body, was.body, path);
    assert.ok(was.n > on.n, `${path}: ${was.n} statements without the scope, ${on.n} with it`);
  }
});
