import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ASK, askText, type Budget, expectedCost, markOf, START_CARD_USD, turnLine, WAKE, withEstimate } from '../src/minion-budget.ts';
import { agentToken, bootServer } from './helpers.ts';
import { until } from './wait.ts';

// Every brief states an expected cost (#1674; Cara, 2026-11-22, "Build it" on #1668's card): the budget's marks scale
// from it, and a brief expected over $30 waits for a person's start card.

test('a brief\'s "Expected cost" line is read, a range by its top', () => {
  assert.equal(expectedCost('Opus 5.5 high. Expected cost: ~$15. Delete this file once it ships.'), 15);
  assert.equal(expectedCost('**Expected cost:** $12.50 (two Grunts)'), 12.5);
  assert.equal(expectedCost('expected cost: $20 to $40'), 40);
  assert.equal(expectedCost('Expected cost: $15–25'), 25);
  assert.equal(expectedCost('It cost $150 last time.'), null, 'only the named line counts');
  assert.equal(expectedCost('Expected cost: unknown'), null);
});

const usual: Budget = { usd: 5, n: 20, basis: 'a feature on Opus' };

test('the marks scale from the larger of the usual cost and the estimate', () => {
  const big = withEstimate(usual, 15)!;
  assert.equal(big.usd, 15);
  assert.equal(markOf(big, ASK), 30);
  assert.equal(markOf(big, WAKE), 60);
  assert.equal(withEstimate(usual, 3), usual, 'an estimate under the usual cost changes nothing');
  assert.equal(withEstimate(usual, undefined), usual);
  assert.deepEqual(withEstimate(null, 12), { usd: 12, n: 0, basis: 'its brief', estimate: 12 }, 'no history: the estimate alone');
  assert.match(turnLine(big, 1), /its brief expected about \$15 \(a feature on Opus has usually cost about \$5\.00/);
  assert.match(askText(big, 31), /over 2x its brief's expected \$15/);
  assert.doesNotMatch(turnLine(usual, 1), /brief/);
});

test('a Taskmaster brief over $30 waits for a person\'s start card; under it, or a person\'s own, starts as today', async () => {
  const s = await bootServer();
  try {
    const { data: p } = await s.call('/api/projects', { name: 'Delve' }); // any scheme
    const tm = (await s.call(`/api/projects/${p.id}`)).data.coordinator;
    const asTaskmaster = (path: string, body: object) => fetch(`${s.base}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${agentToken(s.data, tm.id)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, data: await r.json() }));
    const create = (title: string, message: string, extra: object = {}) => asTaskmaster(`/api/projects/${p.id}/tickets`, { title, message, model: 'claude-opus-5-5', effort: 'high', properties: { type: 'feature' }, ...extra });
    const events = async (id: number) => (await s.call(`/api/tickets/${id}/events?after=0`)).data as { id: number; kind: string; data: string }[];
    const card = async (id: number) => (await events(id)).map((e) => ({ e, d: JSON.parse(e.data) })).find(({ e, d }) => e.kind === 'question' && d.startCost);

    // The estimate read from the handoff the brief names, as briefWarning reads it.
    const shared = join(s.data, 'projects', String(p.id), 'shared', 'project', 'handoffs');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'handoff-big.md'), 'Port 300 tests.\n\n## Model and effort\nOpus high. Expected cost: ~$45.');
    const big = await create('Big', `Start from ${join(shared, 'handoff-big.md')}.`);
    assert.equal(big.status, 201, JSON.stringify(big.data));
    const id = big.data.id;
    assert.match(big.data.notes.join('\n'), /expects about \$45, over \$30.*start card/);
    assert.equal(big.data.state, 'parked');
    assert.equal(big.data.budget.usd, 45, 'its marks scale from the estimate');
    const held = await card(id);
    assert.ok(held, 'a start card in its chat');
    assert.deepEqual(held.d.questions[0].options.map((o: { label: string }) => o.label), ['Start', 'Split first']);
    const brief = (await events(id)).find((e) => e.kind === 'user_message');
    assert.equal(JSON.parse(brief!.data).parked, true, 'its brief is held, no turn');

    // The Taskmaster can't start it around the card, and can't answer cards at all.
    const unseal = await asTaskmaster(`/api/tickets/${id}/unpark`, {});
    assert.equal(unseal.status, 409, JSON.stringify(unseal.data));
    assert.match(unseal.data.error, /start card/);
    assert.equal((await asTaskmaster(`/api/tickets/${id}/answer`, { questionId: held.d.id, answers: [{ selected: ['Start'] }] })).status, 403);

    // A person's Start: the hold ends and its turn starts with the brief.
    const start = await s.call(`/api/tickets/${id}/answer`, { questionId: held.d.id, answers: [{ selected: ['Start'] }] });
    assert.equal(start.status, 202, JSON.stringify(start.data));
    await until('it starts', async () => (await s.call(`/api/tickets/${id}`)).data.ticket.state !== 'parked');
    assert.ok((await events(id)).some((e) => e.kind === 'user_message' && JSON.parse(e.data).answer), 'its answer is recorded');

    // Split first: dismissed, and the Taskmaster is told to split the brief.
    const split = await create('Bigger', 'Do it all.\nExpected cost: $60');
    const splitCard = await card(split.data.id);
    const r = await s.call(`/api/tickets/${split.data.id}/answer`, { questionId: splitCard!.d.id, answers: [{ selected: ['Split first'] }] });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    await until('it is dismissed', async () => (await s.call(`/api/tickets/${split.data.id}`)).data.ticket.status === 'closed');
    await until('the Taskmaster hears', async () => (await events(tm.id)).some((e) => e.kind === 'user_message' && /Split first/.test(JSON.parse(e.data).text)));

    // $30 or under starts as today; no estimate starts too, with a nudge for one.
    const small = await create('Small', 'Fix it.\nExpected cost: $30', { expected_cost: 30 });
    assert.notEqual(small.data.state, 'parked');
    assert.equal(await card(small.data.id), undefined);
    const none = await create('None', 'Fix it.');
    assert.notEqual(none.data.state, 'parked');
    assert.match(none.data.notes.join('\n'), /no "Expected cost: \$N" line/);
    // The larger of the param and the line counts, so a low param can't slip a big brief past its card.
    const param = await create('Param', 'Fix it.\nExpected cost: $5', { expected_cost: 40 });
    assert.equal(param.data.state, 'parked');
    const lowParam = await create('Low param', 'Do it all.\nExpected cost: ~$80', { expected_cost: 5 });
    assert.equal(lowParam.data.state, 'parked');

    // Dismissed another way, its start card can't start it.
    const gone = await create('Gone', 'Do it all.\nExpected cost: $50');
    const goneCard = await card(gone.data.id);
    assert.equal((await s.call(`/api/tickets/${gone.data.id}/status`, { status: 'closed' })).status, 200);
    const late = await s.call(`/api/tickets/${gone.data.id}/answer`, { questionId: goneCard!.d.id, answers: [{ selected: ['Start'] }] });
    assert.equal(late.status, 409, JSON.stringify(late.data));

    // A person starting their own minion is their OK.
    const own = await s.call(`/api/projects/${p.id}/tickets`, { title: 'Mine', message: `Huge.\nExpected cost: $${START_CARD_USD * 3}` });
    assert.equal(own.status, 201);
    assert.notEqual(own.data.state, 'parked');
    assert.equal(await card(own.data.id), undefined);
  } finally {
    await s.stop();
  }
});
