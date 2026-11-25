// Explain on the time log (#1994): the input, the checks on Haiku's reply, what's kept and when it's out of date
// (src/time-log-explain.ts). The route, and that a press leaves the minion alone: test/time-log-explain-route.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventRow } from '../src/db-rows.ts';
import { explainInput, explainView, mergeReading, readExplain, readReading, statesLength, type Explain } from '../src/time-log-explain.ts';
import type { TimeLog } from '../src/time-log.ts';

const MIN = 60_000;
const T0 = 1_795_000_000_000;
const at = (m: number) => T0 + m * MIN;

// Two steps with a wait on Cara between them.
const log: TimeLog = {
  start: at(0),
  end: at(30),
  running: false,
  closed: false,
  segs: [
    { start: at(0), end: at(10), kind: 'work', row: 0 },
    { start: at(10), end: at(20), kind: 'wait', sub: 'person', title: 'Waiting on Cara', event: 3, row: 1 },
    { start: at(20), end: at(30), kind: 'work', row: 2 },
  ],
  rows: [
    { type: 'step', title: 'Read', kind: 'work', status: 'completed', outcome: 'Found it.', start: at(0), end: at(10), work: 10 * MIN, wait: 0, lost: 0 },
    { type: 'wait', title: 'Waiting on Cara', kind: 'wait', sub: 'person', start: at(10), end: at(20), work: 0, wait: 10 * MIN, lost: 0, event: 3 },
    { type: 'step', title: 'Build', kind: 'work', status: 'completed', start: at(20), end: at(30), work: 10 * MIN, wait: 0, lost: 0 },
    { type: 'step', title: 'Ship', kind: 'work', status: 'pending', start: null, end: null, work: 0, wait: 0, lost: 0 },
  ],
  totals: { work: 20 * MIN, wait: 10 * MIN, lost: 0, guess: 0 },
};
const KEYS = [`step:${at(0)}`, `wait:${at(10)}`, `step:${at(20)}`];
const claude = (id: number, m: number, d: unknown): EventRow => ({ id, ticket_id: 1, kind: 'claude', data: JSON.stringify(d), created_at: at(m) });
const events: EventRow[] = [
  claude(1, 2, { type: 'assistant', message: { content: [{ type: 'text', text: 'The bug is in the parser, reading it now.' }] } }),
  claude(2, 5, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'g', name: 'Agent', input: { description: 'Review the diff' } }] } }),
  { id: 3, ticket_id: 1, kind: 'question', data: JSON.stringify({ id: 'q', questions: [{ question: 'Ship it now?' }] }), created_at: at(10) },
  claude(4, 9, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'g', content: [{ type: 'text', text: 'Read it all. **Findings** 1. The parser drops the last line.' }] }] } }),
  { id: 5, ticket_id: 1, kind: 'user_message', data: JSON.stringify({ author: 'Cara', text: 'Yes, ship it' }), created_at: at(20) },
  claude(6, 22, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'citadel-test test/x.test.ts' } }] } }),
  claude(7, 25, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'Exit code 124 Command timed out after 2m', is_error: true }] } }),
  claude(8, 26, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'g2', name: 'Agent', input: { description: 'x' } }] }, parent_tool_use_id: 'g' }),
];

test('the input: each asked part in time order, its events labelled, a wait with the last words before it, a Grunt from its findings', async () => {
  const input = await explainInput('Fix the parser', log, events, KEYS);
  assert.deepEqual(
    [...input.parts.entries()],
    [
      ['P1', KEYS[0]],
      ['P2', KEYS[1]],
      ['P3', KEYS[2]],
    ],
  );
  const t = input.text;
  assert.match(t, /PART P1: step "Read" \(done\); the minion's own outcome: "Found it."/);
  assert.match(t, /PART P2: \[e\d+\] WAIT: Waiting on Cara/);
  assert.match(t, /\[e\d+\] the minion's last words before it: "The bug is in the parser/, 'its own label, so a wait with no event of its own can rest on it');
  assert.match(t, /The Grunt reported: \*\*Findings\*\* 1\. The parser drops the last line\./);
  assert.doesNotMatch(t, /Read it all/, 'a report starts at its findings');
  assert.match(t, /Cara wrote to it: Yes, ship it/);
  assert.match(t, /CUT OFF by a time limit: citadel-test/);
  assert.doesNotMatch(t, /PART P4/, 'a step with no time is no part');
  assert.equal(t.match(/Started a Grunt/g)?.length, 1, "a Grunt's own steps stay out");
  // Every label names a real event.
  for (const [label, id] of input.labels)
    assert.ok(
      events.some((e) => e.id === id),
      label,
    );
  // Only the parts asked for.
  const second = await explainInput('Fix the parser', log, events, [KEYS[2]]);
  assert.deepEqual([...second.parts.values()], [KEYS[2]]);
  assert.doesNotMatch(second.text, /Waiting on Cara/);
});

test("the reply: lines whose evidence isn't in the log, or that state a length or a time, are dropped; at most 4 a part", async () => {
  const input = await explainInput('Fix the parser', log, events, KEYS);
  const real = [...input.labels.keys()];
  const reply = JSON.stringify({
    parts: [
      {
        part: 'P1',
        lines: [
          { text: 'It found the bug in the parser.', kind: 'work', evidence: [real[0]] },
          { text: 'It made something up.', kind: 'work', evidence: ['e99'] },
          { text: 'It read for 10 minutes.', kind: 'work', evidence: [real[0]] },
          { text: 'No evidence at all.', kind: 'work', evidence: [] },
        ],
      },
      { part: 'P2', lines: [{ text: 'It waited on Cara to answer its ship card.', kind: 'wait', evidence: [`[${real[2]}]`, 'e99'] }] },
      { part: 'P9', lines: [{ text: 'A part nobody asked about.', kind: 'work', evidence: [real[0]] }] },
      { part: 'P3', lines: Array.from({ length: 6 }, (_, i) => ({ text: `Line ${'abcdef'[i]}.`, kind: 'odd', evidence: [real.at(-1)] })) },
    ],
  });
  const read = readReading('```json\n' + reply + '\n```', input.labels, input.parts);
  assert.deepEqual(read.get(KEYS[0]), [{ kind: 'work', text: 'It found the bug in the parser.', ev: [input.labels.get(real[0])!] }]);
  assert.deepEqual(
    read.get(KEYS[1])!.map((l) => [l.kind, l.ev]),
    [['wait', [input.labels.get(real[2])!]]],
    'unknown labels drop out, a known one keeps the line',
  );
  assert.equal(read.get(KEYS[2])!.length, 4);
  assert.equal(read.get(KEYS[2])![0].kind, 'work', 'an unknown kind reads as work');
  assert.throws(() => readReading('I would rather chat.', input.labels, input.parts), /wasn't the reading/);
  const empty = readReading('{"parts":[]}', input.labels, input.parts);
  assert.deepEqual([...empty.values()], [[], [], []], 'every asked part gets an entry, empty when nothing came back');
});

test('a length or a clock time in a line', async () => {
  for (const t of ['It took 12 minutes.', 'After an hour it gave up.', 'Waited half an hour.', 'Ran for 37 s.', 'At 3:05 it shipped.', 'two hours of tests', 'several minutes later', 'a 5m run']) assert.ok(statesLength(t), t);
  for (const t of ['It ran the tests twice.', 'It shipped the fix.', 'Step 2 of 4 failed.', 'It waited on Cara.', 'Found 3 bugs in the minutes file.', 'An index takes the query to 40 ms.']) assert.ok(!statesLength(t), t);
});

test('kept, out of date, and a second press writes only the new parts', async () => {
  const input = await explainInput('Fix the parser', log, events, KEYS);
  const first = new Map(KEYS.map((k, i) => [k, [{ kind: 'work' as const, text: `Part ${i}.`, ev: [1] }]]));
  let e = mergeReading(readExplain(null), log, first, KEYS, { by: 'Josh', at: at(31), cost: 0.004, parts: 3 }, 8);
  assert.equal(input.parts.size, 3);
  // Nothing new since: every part read, nothing fresh.
  let v = explainView(e, log, null, at(32));
  assert.deepEqual(v.fresh, []);
  assert.deepEqual(Object.keys(v.parts), KEYS);
  assert.deepEqual(
    v.presses.map((p) => p.by),
    ['Josh'],
  );
  // New events from minute 28 on: the last step is out of date, and a part the log grew is new.
  const grown: TimeLog = { ...log, end: at(40), segs: [...log.segs, { start: at(30), end: at(40), kind: 'wait', sub: 'person', row: 3 }], rows: [...log.rows.slice(0, 3), { type: 'wait', title: 'Waiting on Josh', kind: 'wait', start: at(30), end: at(40), work: 0, wait: 10 * MIN, lost: 0 }, log.rows[3]] };
  v = explainView(e, grown, at(28), at(41));
  assert.deepEqual(v.fresh, [KEYS[2], `wait:${at(30)}`]);
  // The second press read only those two: the first two parts keep their lines.
  const second = new Map([
    [KEYS[2], [{ kind: 'work' as const, text: 'Part 2, again.', ev: [7] }]],
    [`wait:${at(30)}`, []],
  ]);
  e = mergeReading(e, grown, second, v.fresh, { by: 'Cara', at: at(41), cost: null, parts: 2 }, 12);
  v = explainView(e, grown, null, at(42));
  assert.deepEqual(v.fresh, []);
  assert.deepEqual(
    Object.values(v.parts).map((l) => l.map((x) => x.text)),
    [['Part 0.'], ['Part 1.'], ['Part 2, again.'], []],
  );
  assert.deepEqual(e.upTo, 12);
  assert.deepEqual(
    v.presses.map((p) => p.by),
    ['Josh', 'Cara'],
  );
});

test('a press under way shows to everyone, and one older than the limit is taken as gone', async () => {
  const e: Explain = { ...readExplain(null), writing: { by: 'Josh', at: at(0) } };
  assert.deepEqual(explainView(e, log, null, at(1)).writing, { by: 'Josh', at: at(0) });
  assert.equal(explainView(e, log, null, at(10)).writing, null);
});

test('a saved reading of version 1 still reads, and a later version with fields it does not know', async () => {
  // Frozen: what version 1 writes. Never edit this; add a case for a new version beside it.
  const v1 = `{"v":1,"parts":{"step:${at(0)}":{"lines":[{"kind":"work","text":"It found the bug.","ev":[1,2]}],"end":${at(10)}},"wait:${at(10)}":{"lines":[],"end":${at(20)}}},"upTo":8,"presses":[{"by":"Josh","at":${at(31)},"cost":0.004,"parts":2}]}`;
  const e = readExplain(v1);
  assert.deepEqual(e.parts[`step:${at(0)}`].lines, [{ kind: 'work', text: 'It found the bug.', ev: [1, 2] }]);
  assert.deepEqual(e.parts[`wait:${at(10)}`].lines, []);
  assert.equal(e.upTo, 8);
  assert.deepEqual(e.presses, [{ by: 'Josh', at: at(31), cost: 0.004, parts: 2 }]);
  const later = readExplain(`{"v":7,"parts":{"step:1":{"lines":[{"kind":"surprise","text":"Kept.","ev":[3],"extra":true},{"text":"No evidence."}],"why":"x"}},"presses":[{"by":"Cara","at":5}],"what":1}`);
  assert.deepEqual(later.parts['step:1'].lines, [{ kind: 'work', text: 'Kept.', ev: [3] }]);
  assert.deepEqual(later.presses, [{ by: 'Cara', at: 5, cost: null, parts: 0 }]);
  for (const bad of [null, '', 'not json', '[]', '{"parts":"x"}']) assert.deepEqual(readExplain(bad).parts, {});
});
