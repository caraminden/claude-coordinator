import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { SpendMeter } from '../src/spend-alert.ts';
import { stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// A killed turn's spend (#1938): claude says what a session cost only in its result, and one killed outright (SIGKILL,
// out of memory, its container removed) says nothing and saves nothing, so the resumed session's total starts without
// it. Nov 24, 5:03 PM PST: 25 turns killed at once, about $100 in no minion's cost.
//
// Fake `claude -p`: streams Opus messages of $10 each, then hangs ("hang"), hangs after a $10 result ("steered"), ends
// on SIGTERM as claude does ("term"), or, resumed after a kill, ends with a $20 total that leaves the killed part out.
const root = mkdtempSync(join(tmpdir(), 'killed-spend-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
const SID = '11111111-2222-4333-8444-555555555555';
writeFileSync(
  fake,
  `#!${process.execPath}
const out = (o) => console.log(JSON.stringify(o));
const msg = (id, model) => out({ type: 'assistant', parent_tool_use_id: null, message: { id, model, usage: { input_tokens: 2500000, output_tokens: 1 }, content: [{ type: 'text', text: 'hi' }] } });
const result = (usd) => out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: '${SID}', total_cost_usd: usd, duration_ms: 5, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { 'claude-opus-5-5': { costUSD: usd } } });
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  out({ type: 'system', subtype: 'init', session_id: '${SID}' });
  if (/was killed|was restarted|restarted|interrupted/i.test(input)) {
    msg('r1', 'claude-opus-5-5');
    msg('r2', 'claude-opus-5-5');
    result(20);
    process.exit(0);
  }
  msg('m1', 'claude-opus-5-5');
  if (input.includes('steered')) result(10);
  msg('m2', 'claude-opus-5-5');
  msg('m3', 'claude-opus-5-5');
  if (input.includes('term')) process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1000);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
// Five closed features at $5 each, so a feature's budget card comes at $50. Before any turn: the medians are cached.
for (let i = 0; i < 5; i++) {
  const done = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.props.set('minion', done.id, project.id, { type: 'feature' }, 'Cara');
  await store.recordTurn(done.id, { session_id: `b${i}`, ended_at: Date.now(), session_cost_usd: 5, duration_ms: 1 });
  store.updateTicket(done.id, { status: 'closed' });
}
function makeRunner() {
  const r = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  r.pollMs = 10;
  r.resumeGapMs = 0;
  r.killStarved = async () => ({ starved: false, why: '' });
  return r;
}
let runner = makeRunner();
const live = (id: number) => (runner as unknown as { turns: Map<number, { dir: string }> }).turns.get(id);

async function start(text: string, props: Record<string, string> = {}) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  if (Object.keys(props).length) store.props.set('minion', t.id, project.id, props, 'Cara');
  runner.send(t.id, 'Cara', text);
  await until('its three messages', () => store.listEvents(t.id).filter((e) => e.kind === 'claude' && e.data.includes('"type":"assistant"')).length === 3 && !!live(t.id) && existsSync(join(live(t.id)!.dir, 'pid.json')));
  return t.id;
}
const pids = (id: number) => JSON.parse(readFileSync(join(live(id)!.dir, 'pid.json'), 'utf8')) as { wrapper: number; claude: number };
const kill = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(pid, signal);
  } catch {}
};
async function ended(id: number) {
  await until('the resume to end', () => store.getTicket(id)!.status === 'idle' && !runner.isRunning(id));
}
const costs = (id: number) => store.listTurns(id).map((t) => Math.round(t.cost_usd));

test('a killed turn costs its minion what it spent, and its resume adds only its own', async () => {
  const dayCost = () => store.dailyCosts(Date.now() - 3_600_000).reduce((n, d) => n + d.cost, 0);
  const before = dayCost();
  const id = await start('hang');
  const p = pids(id);
  kill(p.wrapper, 'SIGKILL');
  kill(-p.claude, 'SIGKILL');
  await until('both turns in its cost', () => costs(id).length === 2);
  await ended(id);
  assert.deepEqual(costs(id), [30, 20], 'the killed part, then the resume');
  assert.equal(Math.round(store.ticketCost(id)), 50);
  assert.equal(Math.round(dayCost() - before), 50, 'the Costs page has it too');
});

test('only claude killed, its exit noted: counted the same', async () => {
  const id = await start('hang');
  kill(-pids(id).claude, 'SIGKILL');
  await until('both turns in its cost', () => costs(id).length === 2);
  await ended(id);
  assert.deepEqual(costs(id), [30, 20]);
});

test('a turn killed after a result of its own (a steer) counts only what came after that result', async () => {
  const id = await start('steered');
  const p = pids(id);
  kill(p.wrapper, 'SIGKILL');
  kill(-p.claude, 'SIGKILL');
  await until('both in its cost', () => costs(id).length === 2);
  await until('it to end', () => !runner.isRunning(id));
  assert.deepEqual(costs(id), [10, 20]);
});

test('a turn ended by SIGTERM is not counted: claude saves its cost, so its resume says it', async () => {
  const id = await start('term');
  kill(pids(id).claude, 'SIGTERM');
  await ended(id);
  assert.ok(!costs(id).includes(30), `no estimate beside the resume's total: ${costs(id)}`);
});

test('a killed turn found at a restart is counted once', async () => {
  const id = await start('hang');
  const p = pids(id);
  runner.detachAll();
  kill(p.wrapper, 'SIGKILL');
  kill(-p.claude, 'SIGKILL');
  runner = makeRunner();
  runner.recover();
  await until('both turns in its cost', () => costs(id).length === 2);
  await ended(id);
  assert.deepEqual(costs(id), [30, 20]);
});

test('a budget card counts the killed part and its resume together', async () => {
  const cards: number[] = [];
  runner.onBudgetCard = (ticket) => cards.push(ticket);
  // $50 is the card's mark, which neither the killed $30 nor its resume's $20 reaches alone.
  const id = await start('hang', { type: 'feature' });
  assert.equal(cards.length, 0);
  const p = pids(id);
  kill(p.wrapper, 'SIGKILL');
  kill(-p.claude, 'SIGKILL');
  await until('the card', () => cards.includes(id));
  await ended(id);
});

test('killedSpend: which ends leave spend that nothing saved', async () => {
  const { killedSpend } = await import('../src/turn-row.ts');
  const turn = { spend: { usd: 30, fired: 0, open: { 'claude-opus-5-5': 30 } } };
  assert.deepEqual(killedSpend(turn, null), { 'claude-opus-5-5': 30 });
  for (const exit of [
    { code: 137, signal: null },
    { code: 134, signal: null },
    { code: null, signal: 'SIGKILL' },
    { code: null, signal: 'SIGABRT' },
  ])
    assert.ok(killedSpend(turn, exit), JSON.stringify(exit));
  for (const exit of [
    { code: 0, signal: null },
    { code: 1, signal: null },
    { code: 143, signal: null },
    { code: null, signal: 'SIGTERM' },
    { code: 130, signal: null },
  ])
    assert.equal(killedSpend(turn, exit), null, JSON.stringify(exit));
  assert.equal(killedSpend({ spend: { usd: 30, fired: 0, open: {} } }, null), null, 'all of it in a result already');
  assert.equal(killedSpend({}, null), null, 'a Codex turn, unmetered');
  assert.equal(killedSpend(null, null), null);
});

test('the meter keeps what no result has said yet, by model, across a restart', () => {
  const add = (m: SpendMeter, id: string, model: string) => m.addMessage(id, model, { input_tokens: 2_500_000, output_tokens: 0 }, 0);
  const m = new SpendMeter();
  add(m, 'a', 'claude-opus-5-5');
  m.settle();
  add(m, 'b', 'claude-opus-5-5');
  const again = new SpendMeter(JSON.parse(JSON.stringify(m.state)));
  add(again, 'c', 'claude-haiku-5-5');
  assert.deepEqual(Object.keys(again.open), ['claude-opus-5-5', 'claude-haiku-5-5']);
  assert.equal(Math.round(again.open['claude-opus-5-5']), 10);
  assert.ok(again.usd > 20, 'the alert and the header still count the whole turn');
});

test('an estimate leaves the session running totals as they were, so the next turn splits by model exactly', async () => {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const at = Date.now();
  const opus = (n: number) => ({ 'claude-opus-5-5': { costUSD: n } });
  await store.recordTurn(t.id, { session_id: 's', ended_at: at, session_cost_usd: 5, duration_ms: 1, modelUsage: opus(5) });
  const killed = await store.recordTurn(t.id, { session_id: 's', ended_at: at, session_cost_usd: 0, estimate: { 'claude-opus-5-5': 2, 'claude-haiku-5-5': 1 } });
  assert.deepEqual([killed.cost_usd, killed.session_cost_usd], [3, 5]);
  const next = await store.recordTurn(t.id, { session_id: 's', ended_at: at, session_cost_usd: 9, duration_ms: 1, modelUsage: opus(9) });
  assert.equal(next.cost_usd, 4);
  const rows = store.db.prepare('SELECT model, SUM(cost_usd) AS c FROM turn_models WHERE turn_id IN (SELECT id FROM turns WHERE ticket_id = ?) GROUP BY model ORDER BY model').all(t.id) as { model: string; c: number }[];
  assert.deepEqual(
    rows.map((r) => [r.model, r.c]),
    [
      ['claude-haiku-5-5', 1],
      ['claude-opus-5-5', 11],
    ],
  );
  // A session killed in its first turn has no total to carry.
  const fresh = await store.recordTurn(t.id, { session_id: 's2', ended_at: at, session_cost_usd: 0, estimate: { 'claude-opus-5-5': 2 } });
  assert.deepEqual([fresh.cost_usd, fresh.session_cost_usd], [2, 0]);
  assert.equal((await store.recordTurn(t.id, { session_id: 's2', ended_at: at, session_cost_usd: 4, duration_ms: 1, modelUsage: opus(4) })).cost_usd, 4);
});
