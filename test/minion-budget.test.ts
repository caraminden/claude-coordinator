import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { budgetCard, budgetFor, budgetFrom, budgetKey, CARD, markOf, medians, passed, turnLine, wakeText, ASK, WAKE } from '../src/minion-budget.ts';
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
  // A Codex minion's turns aren't priced: no budget, and its history counts for no Claude family.
  const withCodex = medians([...rows('feature', 'gpt-6-astra', 50, 50, 50, 50, 50), ...rows('feature', 'claude-opus-5-5', 1, 1, 1, 1, 1)]);
  assert.equal(budgetFrom(withCodex, 'feature', 'gpt-6-astra'), null);
  assert.deepEqual(budgetFrom(withCodex, 'feature', null), { usd: 1, n: 5, basis: 'a feature on Opus' });
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
  assert.deepEqual(passed(dear, 63.9, { asked: 1, woke: 2 }), []);
  assert.match(turnLine(dear, 2), /usually cost about \$8\.00.*used \$2\.00 so far.*Past \$16 you'll be asked/);
  assert.match(turnLine(dear, 17), /past 2x: if you haven't yet, say in one line why/);
});

test('past the 4x wake, the Taskmaster is woken again at each doubling, and past 10x (at least $50) the owner gets a card (#1672)', () => {
  const dear = { usd: 8, n: 9, basis: 'a feature on Opus' };
  const cheap = { usd: 0.5, n: 9, basis: 'a chore on Sonnet' };
  assert.deepEqual([markOf(dear, CARD), markOf(cheap, CARD)], [80, 50]);
  const after4 = { asked: 1, woke: 2 };
  // 8x is $64, 16x $128: each once, and a jump past several doublings wakes once.
  assert.deepEqual(passed(dear, 64, after4), ['wake']);
  assert.deepEqual(passed(dear, 70, { ...after4, wakes: 2 }), []);
  assert.deepEqual(passed(dear, 127, { ...after4, wakes: 2 }), ['card']);
  assert.deepEqual(passed(dear, 128, { ...after4, wakes: 2, carded: 3 }), ['wake']);
  assert.deepEqual(passed(dear, 600, { ...after4, wakes: 3, carded: 3 }), ['wake']);
  assert.deepEqual(passed(dear, 1000, { ...after4, wakes: 7, carded: 3 }), []);
  // A minion woken before this shipped kept only `woke`: that counts as the 4x wake.
  assert.deepEqual(passed(dear, 60, after4), []);
  // The cheap one: wakes at $10, $20, $40; the card at $50, not 10x's $5.
  assert.deepEqual(passed(cheap, 40, { asked: 1, woke: 2 }), ['wake']);
  assert.deepEqual(passed(cheap, 49.9, { asked: 1, woke: 2, wakes: 3 }), []);
  assert.deepEqual(passed(cheap, 50, { asked: 1, woke: 2, wakes: 3 }), ['card']);
  // A jump from nothing past everything gives each kind once.
  assert.deepEqual(passed(dear, 200, {}), ['ask', 'wake', 'card']);

  // A Taskmaster's carry on lasts to the next mark, and it checks what it asked for last time.
  assert.match(wakeText(dear, 64, 2), /over 8x the usual \$8\.00/);
  assert.match(wakeText(dear, 64, 2), /carry on lasts only until the next mark, \$128/);
  assert.match(wakeText(dear, 64, 2), /conditions you set last time/);
  assert.match(wakeText(dear, 33, 1), /over 4x the usual/);

  const card = budgetCard(dear, 81, 'fixing the flaky ship test');
  assert.match(card.question, /used about \$81, over 10x the usual \$8\.00 for a feature on Opus/);
  assert.match(card.question, /fixing the flaky ship test/);
  assert.deepEqual(card.options.map((o) => o.label), ['Carry on', 'Split', 'Stop']);
  assert.match(card.options[0].description!, /\$128/);
  assert.doesNotMatch(budgetCard(dear, 81, null).question, /null/);
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
  const cards: { ticket: number; question: string }[] = [];
  runner.onBudgetCard = (ticket, q) => cards.push({ ticket, question: q.question });
  const make = (type: string) => {
    const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Josh' });
    store.setTicketDir(t.id, root, null);
    store.updateTicket(t.id, { status: 'idle' });
    store.props.set('minion', t.id, project.id, { type }, 'Josh');
    return t.id;
  };
  // Five closed features that cost $5 each: the ask at $10, the wake at $20. Open ones, still short of their final
  // cost, count for nothing: five at $1 would otherwise pull the median down to $1.
  for (let i = 0; i < 5; i++) {
    const done = make('feature');
    store.recordTurn(done, { session_id: `s${i}`, ended_at: Date.now(), session_cost_usd: 5 });
    store.updateTicket(done, { status: 'closed' });
  }
  for (let i = 0; i < 5; i++) store.recordTurn(make('feature'), { session_id: `open${i}`, ended_at: Date.now(), session_cost_usd: 1 });
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

  // Nor after a dismissal and a reopen (2R1): the marks outlive the close.
  await runner.close(id, 'Dismissed.');
  writeFileSync(script, JSON.stringify({ before: 1, after: 0 }));
  runner.send(id, 'Josh', 'reopened');
  await until('the reopened turn to end', () => store.listEvents(id).filter((e) => e.kind === 'claude' && JSON.parse(e.data).type === 'result').length === 3 && !runner.isRunning(id));
  assert.equal(notes().length, 1);
  assert.equal(wakes.length, 2);
  assert.equal(cards.length, 1);
});
