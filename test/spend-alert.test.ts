import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_STAGES, openSpend, SpendMeter, spendText, stagesFrom, visibleChars } from '../src/spend-alert.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/spend-turns.json', import.meta.url), 'utf8'));

test("the estimate lands within 10% of three real turns' final cost", () => {
  for (const turn of fixture.turns) {
    const meter = new SpendMeter();
    turn.messages.forEach(([model, input, read, w5, w1, snapshot, chars]: number[], i: number) => {
      const usage = { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: w5 + w1, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, output_tokens: snapshot };
      // As the stream sends it: the visible output in two events, the usage repeated on each.
      meter.addMessage(`m${i}`, turn.models[model], usage, Math.floor(chars / 2));
      meter.addMessage(`m${i}`, turn.models[model], usage, chars - Math.floor(chars / 2));
    });
    const off = Math.abs(meter.usd - turn.real) / turn.real;
    assert.ok(off < 0.1, `turn ${turn.turn}: estimated $${meter.usd.toFixed(2)}, really $${turn.real} (${(off * 100).toFixed(1)}% off)`);
  }
});

const event = (id: string, usage: object, content: object[] = [], model = 'claude-opus-5-5') => ({ type: 'assistant', parent_tool_use_id: null, message: { id, model, usage, content } });

test('usage counts once per message id, visible output across its events', () => {
  const meter = new SpendMeter();
  const usage = { input_tokens: 1_000_000, output_tokens: 5 };
  assert.equal(meter.add(event('a', usage, [{ type: 'thinking', thinking: 'hmm' }])), true);
  assert.equal(meter.usd, 4 + 5 * 20e-6); // $4 input, the snapshot's 5 output tokens
  meter.add(event('a', usage, [{ type: 'text', text: 'x'.repeat(4000) }]));
  assert.equal(meter.usd, 4 + 3000 * 20e-6); // 1000 visible tokens x3 beats the snapshot
  // A Grunt's message counts too; an unpriced model (Codex, <synthetic>) and other events don't.
  meter.add({ ...event('b', { cache_read_input_tokens: 1_000_000 }, [], 'claude-sonnet-5-5'), parent_tool_use_id: 'toolu_1' });
  assert.ok(Math.abs(meter.usd - (4.06 + 0.1)) < 1e-9);
  assert.equal(meter.add(event('c', usage, [], 'gpt-5.1-codex')), false);
  assert.equal(meter.add({ type: 'user', message: { id: 'd', usage } }), false);
  assert.equal(visibleChars([{ type: 'tool_use', input: { command: 'ls' } }]), '{"command":"ls"}'.length);
});

test('each stage fires once, the highest when several pass at once, and Keep going mutes the rest', () => {
  const meter = new SpendMeter();
  const spend = (usd: number) => meter.addMessage(`m${usd}`, 'claude-opus-5-5', { input_tokens: usd * 250_000 }, 0);
  spend(10);
  assert.equal(meter.crossed(DEFAULT_STAGES), null);
  spend(20); // $30
  assert.equal(meter.crossed(DEFAULT_STAGES), 25);
  assert.equal(meter.crossed(DEFAULT_STAGES), null);
  spend(80); // $110: past $50 and $100 at once
  assert.equal(meter.crossed(DEFAULT_STAGES), 100);
  assert.equal(meter.crossed(DEFAULT_STAGES), null);

  const muted = new SpendMeter({ usd: 30, fired: 1 }); // as restored after a restart
  muted.muted = 'Cara';
  muted.addMessage('x', 'claude-opus-5-5', { input_tokens: 10_000_000 }, 0); // $70
  assert.equal(muted.crossed(DEFAULT_STAGES), null);
  assert.deepEqual(muted.state, { usd: 70, open: { 'claude-opus-5-5': 40 }, fired: 2, muted: 'Cara' });
});

test("stages from the setting, and the alert's words", () => {
  assert.deepEqual(stagesFrom([100, 20, 'x', -5]), [20, 100]);
  assert.deepEqual(stagesFrom(null), DEFAULT_STAGES);
  assert.deepEqual(stagesFrom([]), DEFAULT_STAGES);
  assert.equal(spendText(30.4, 70 * 60_000), 'This turn has used about $30 in 70 min.');
});

test('the open alert for the list row and Needs you: kept across a restart, gone once muted, and a broken one is dropped', () => {
  const meter = new SpendMeter({ usd: 31.6, fired: 1, alert: { stage: 25, event: 7, at: 1000 } } as never);
  assert.deepEqual(openSpend(meter.state), { stage: 25, event: 7, at: 1000, usd: 32 });
  meter.muted = 'Cara';
  assert.equal(openSpend(meter.state), null);
  assert.equal(openSpend(undefined), null);
  assert.equal(openSpend(new SpendMeter({ usd: 30, fired: 1, alert: { stage: 25, event: 'x', at: 1 } } as never).state), null);
});
