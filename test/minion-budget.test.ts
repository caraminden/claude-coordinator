import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { budgetFor, budgetFrom, budgetKey, markOf, medians, passed, turnLine, ASK, WAKE } from '../src/minion-budget.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

const rows = (type: string | null, model: string | null, ...costs: number[]) => costs.map((cost) => ({ type, model, cost }));

test('the usual cost is the median per type and model family, falling back to the family with too few', () => {
  const table = medians([
    ...rows('feature', 'claude-opus-5-5', 1, 2, 3, 4, 100),
    ...rows('bug', 'claude-opus-5-5', 9, 9), // too few of its own
    ...rows('feature', 'claude-sonnet-5-5', 1, 1, 1, 1, 1, 1),
    ...rows('ideation', null, 2, 2, 2), // no model is Opus
  ]);
  assert.deepEqual(budgetFrom(table, 'feature', 'claude-opus-5-5'), { usd: 3, n: 5, basis: 'a feature on Opus' });
  assert.deepEqual(budgetFrom(table, 'feature', 'claude-sonnet-5-5'), { usd: 1, n: 6, basis: 'a feature on Sonnet' });
  // Opus as a whole: 1 2 3 4 100 9 9 2 2 2, median 2.5.
  assert.deepEqual(budgetFrom(table, 'bug', 'opus'), { usd: 2.5, n: 10, basis: 'a minion on Opus' });
  assert.equal(budgetFrom(table, 'ideation', null)!.basis, 'a minion on Opus');
  assert.equal(budgetFrom(table, null, 'claude-fable-5-2'), null); // no Fable history at all
});

test('a mark is its multiple or its floor, whichever is more, and each fires once', () => {
  const cheap = { usd: 0.5, n: 9, basis: 'a chore on Sonnet' };
  const dear = { usd: 8, n: 9, basis: 'a feature on Opus' };
  assert.deepEqual([markOf(cheap, ASK), markOf(cheap, WAKE)], [3, 10]);
  assert.deepEqual([markOf(dear, ASK), markOf(dear, WAKE)], [16, 32]);
  assert.deepEqual(passed(dear, 15.9, {}), []);
  assert.deepEqual(passed(dear, 16, {}), ['ask']);
  assert.deepEqual(passed(dear, 40, {}), ['ask', 'wake']); // a jump past both still asks
  assert.deepEqual(passed(dear, 40, { asked: 1 }), ['wake']);
  assert.deepEqual(passed(dear, 400, { asked: 1, woke: 2 }), []);
  assert.match(turnLine(dear, 2), /usually cost about \$8\.00.*used \$2\.00 so far.*Past \$16 you'll be asked/);
  assert.match(turnLine(dear, 17), /past 2x: if you haven't yet, say in one line why/);
});

// A real turn (the spend-turn harness, #723): a fake `claude -p` streams $10 Opus messages, `before` of them, then waits
// for the go file and streams `after` more before its result. It logs its stdin, which carries the prompt and any steer.
const root = mkdtempSync(join(tmpdir(), 'budget-turn-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
const script = join(root, 'script.json');
const go = join(root, 'go');
const stdin = join(root, 'stdin.log');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
process.stdin.on('data', (d) => appendFileSync(${JSON.stringify(stdin)}, d));
const { before, after } = JSON.parse(readFileSync(${JSON.stringify(script)}, 'utf8'));
let n = 0;
const say = (count) => {
  for (let i = 0; i < count; i++, n++) console.log(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_' + n + '_' + Date.now(), model: 'claude-opus-5-5', usage: { input_tokens: 2500000, output_tokens: 1 }, content: [{ type: 'text', text: 'hi' }] } }));
};
say(before);
const wait = setInterval(() => {
  if (!existsSync(${JSON.stringify(go)})) return;
  clearInterval(wait);
  say(after);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

test('a turn past 2x gets the ask once, in the chat and the turn, and past 4x its Taskmaster hears once', async () => {
  const store = new Store(join(root, 'test.db'));
  const project = store.createProject('Delve', null); // any scheme: the medians pool every scheme's minions
  const runner = new Runner(store, () => {}, () => ({}), fake);
  const wakes: { ticket: number; text: string }[] = [];
  runner.onBudgetWake = (ticket, text) => wakes.push({ ticket, text });
  const make = (type: string) => {
    const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Josh' });
    store.setTicketDir(t.id, root, null);
    store.updateTicket(t.id, { status: 'idle' });
    store.props.set('minion', t.id, project.id, { type }, 'Josh');
    return t.id;
  };
  // Five features that cost $5 each: the ask at $10, the wake at $20.
  for (let i = 0; i < 5; i++) store.recordTurn(make('feature'), { session_id: `s${i}`, ended_at: Date.now(), session_cost_usd: 5 });
  const id = make('feature');
  assert.deepEqual(budgetFor(store, store.getTicket(id)!), { usd: 5, n: 5, basis: 'a feature on Opus' });
  assert.deepEqual(runner.view(store.getTicket(id)!).budget, { usd: 5, n: 5, basis: 'a feature on Opus', ask: 10, wake: 20 });

  const notes = () => store.listEvents(id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text as string).filter((t) => t.startsWith('Budget:'));
  rmSync(go, { force: true });
  writeFileSync(script, JSON.stringify({ before: 1, after: 2 }));
  runner.send(id, 'Josh', 'go');
  await until('the ask', () => notes().length === 1);
  assert.match(notes()[0], /about \$10 used, over 2x the usual \$5\.00 for a feature on Opus/);
  // The turn opened with its budget line and then read the ask, as a steer from Citadel.
  await until('the ask to reach the turn', () => existsSync(stdin) && readFileSync(stdin, 'utf8').includes('[System]: Budget: this minion has now used'));
  assert.match(readFileSync(stdin, 'utf8'), /Budget: a feature on Opus has usually cost about \$5\.00 \(the median of 5 minions/);
  assert.equal(wakes.length, 0);
  writeFileSync(go, '');
  await until('the turn to end', () => !runner.isRunning(id));
  assert.equal(notes().length, 1);
  assert.deepEqual(wakes.map((w) => w.ticket), [id]);
  assert.match(wakes[0].text, /used about \$20, over 4x the usual \$5\.00/);
  assert.deepEqual(Object.keys(store.getSetting(budgetKey(id)) as object).sort(), ['asked', 'woke']);

  // A later turn passing both again says nothing more: each mark is once per minion.
  writeFileSync(script, JSON.stringify({ before: 3, after: 0 }));
  runner.send(id, 'Josh', 'again');
  await until('the second turn to end', () => store.listEvents(id).filter((e) => e.kind === 'claude' && JSON.parse(e.data).type === 'result').length === 2 && !runner.isRunning(id));
  assert.equal(notes().length, 1);
  assert.equal(wakes.length, 1);
});
