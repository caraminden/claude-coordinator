// #1823 (Cara, 2026-11-24, "Add it"): update_ticket's start_after: null takes a sealed minion off its start_after chain
// and keeps it sealed, in any scheme. Its brief stays held as mail; its old leader's work starts nothing.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { LiveWaiters } from '../src/wake.ts';
import { bootServer, PASSWORD, SECRET, tempRoot, testPins } from './helpers.ts';
testPins();

const tmp = tempRoot('unchain-');
const root = tmp.dir;
after(() => tmp.teardown());

test('start_after: null drops the chain, keeps the minion sealed with its brief held, and nothing starts it', async () => {
  const { base, cookie, stop } = await bootServer({ root: join(root, 'server') });
  try {
    const auth = new Auth(PASSWORD, SECRET);
    const call = async <T = { id: number; number: number; state: string | null; text: string; ticket: { state: string | null }; coordinator: { id: number } }>(path: string, body?: unknown, method?: string, as?: number) => {
      const res = await fetch(base + path, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { ...(as ? { Authorization: `Bearer ${auth.agentToken(as)}` } : { Cookie: cookie }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: (await res.json()) as T };
    };
    // A scheme that isn't Citadel's.
    const { data: p } = await call('/api/projects', { name: 'Other Scheme' });
    const taskmaster = (await call(`/api/projects/${p.id}`)).data.coordinator.id;
    const leader = (await call(`/api/projects/${p.id}/tickets`, { title: 'Leader', message: 'lead' })).data;
    const made = await call(`/api/projects/${p.id}/tickets`, { title: 'Follower', message: 'build part two', start_after: leader.number, model: 'claude-sonnet-5-5', effort: 'low', properties: { type: 'chore' } }, undefined, taskmaster);
    assert.equal(made.status, 201, JSON.stringify(made.data));
    assert.equal(made.status, 201);
    const f = made.data.id as number;
    const facts = async () => (await call(`/api/tickets/${f}/facts`)).data.text as string;
    assert.match(await facts(), /work is live/, 'chained to start with');

    // A minion's own call, and a value other than null, are refused; nothing changes.
    assert.equal((await call(`/api/tickets/${f}`, { start_after: null }, 'PATCH', f)).status, 400);
    assert.equal((await call(`/api/tickets/${f}`, { start_after: 3 }, 'PATCH', taskmaster)).status, 400);
    assert.match(await facts(), /work is live/);

    const r = await call(`/api/tickets/${f}`, { start_after: null }, 'PATCH', taskmaster);
    assert.equal(r.status, 200);
    assert.equal(r.data.state, 'parked', 'still sealed');
    const after = await facts();
    assert.doesNotMatch(after, /work (is live|has shipped)/, 'no chain left');
    assert.match(after, /sealed on: nothing wakes it by itself/);
    const said = (await call<{ kind: string; data: string }[]>(`/api/tickets/${f}/events?after=0`)).data.filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data));
    assert.ok(said.some((m: { text: string; parked?: boolean }) => m.text === 'build part two' && m.parked), 'its brief is held mail');
    assert.equal((await call(`/api/tickets/${f}`, { start_after: null }, 'PATCH', taskmaster)).status, 409, 'no chain left');
    assert.equal((await call(`/api/tickets/${f}`)).data.ticket.state, 'parked');
  } finally {
    await stop();
  }
});

test('an unchained follower is no longer in the chain list, so its leader shipping starts nothing', async () => {
  const store = new Store(join(root, 'u.db'));
  const p = store.createProject('P', null);
  const mk = () => store.createTicket({ project_id: p.id, title: 'T', permission_mode: 'default', created_by: 'Cara' }).id;
  const [lead, f] = [mk(), mk()];
  const w = new LiveWaiters(store, root, null, () => {});
  w.chain({ ticket: f, after: lead, when: 'live', message: 'brief', from: 'Taskmaster', base: null });
  assert.ok(w.heldFor(f));
  let sent = '';
  assert.equal(w.unchain(f, (c) => ((sent = c.message), null)), true);
  assert.equal(sent, 'brief');
  assert.equal(w.heldFor(f), null);
  assert.equal(w.chains().length, 0);
  assert.equal(await w.check(), 0);
  assert.equal(w.unchain(f, () => null), false, 'not chained any more');
});
