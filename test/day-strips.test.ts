// Minion day strips (#1996): a scheme's minions that went live on a day, each cut from its real start to live (src/day-strips.ts).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { cutStrip, dayBounds, dayStartMs, dayStrips, PARTS } from '../src/day-strips.ts';
import type { TimeSeg } from '../src/time-log.ts';

const root = mkdtempSync(join(tmpdir(), 'day-strips-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const store = new Store(join(root, 'coordinator.db'));
const scheme = store.createProject('Day scheme', null);
const elsewhere = store.createProject('Another scheme', null);
const MIN = 60_000;
/** Midnight, Nov 20 2026, Pacific (PST, UTC-8). */
const DAY0 = Date.UTC(2026, 10, 20, 8);
const at = (m: number) => DAY0 + m * MIN;

/** A minion made at minute `made` of the day (negative: the day before), its events written at given minutes. */
function minion(made: number, projectId = scheme.id) {
  const t = store.createTicket({ project_id: projectId, kind: 'ticket', title: `Made at ${made}`, permission_mode: 'default', created_by: 'Cara' });
  store.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(at(made), t.id);
  const ev = (m: number, kind: string, data: unknown) => {
    const row = store.addEvent(t.id, kind, data);
    store.db.prepare('UPDATE events SET created_at = ? WHERE id = ?').run(at(m), row.id);
  };
  return {
    id: t.id,
    ev,
    turn: (from: number, to: number) => {
      ev(from, 'claude', { type: 'system', subtype: 'init' });
      ev(to, 'claude', { type: 'result', subtype: 'success' });
    },
    dismiss: (m: number, text: string) => {
      ev(m, 'note', { text });
      store.updateTicket(t.id, { status: 'closed' });
      store.db.prepare('UPDATE tickets SET closed_at = ? WHERE id = ?').run(at(m), t.id);
    },
  };
}

test('a Pacific day starts at its own midnight, summer or winter; anything else is no day', () => {
  assert.equal(dayStartMs('2026-11-20'), DAY0);
  assert.equal(dayStartMs('2026-07-01'), Date.UTC(2026, 6, 1, 7));
  assert.equal(dayStartMs('2026-03-08'), Date.UTC(2026, 2, 8, 8)); // the day clocks spring forward starts in PST
  assert.equal(dayStartMs('nope'), null);
  assert.equal(dayStartMs('2026-02-31'), null, 'a day the calendar lacks is no day (the route answers 400, not 500)');
  assert.equal(dayStartMs('2026-13-01'), null);
  assert.deepEqual(dayBounds('2026-11-20'), { from: DAY0, to: DAY0 + 24 * 60 * MIN });
  assert.equal(dayBounds('9999-12-31'), null, 'a day with no next day is no day either (the route answers 400)');
});

test('a strip: the log clipped to live, gaps nothing explains, and the ship stages over waits but never over work', () => {
  const s = (a: number, b: number, kind: TimeSeg['kind'], sub?: TimeSeg['sub'], guess?: true): TimeSeg => ({ start: a, end: b, kind, ...(sub && { sub }), ...(guess && { guess }) });
  const { parts, totals } = cutStrip([s(0, 10, 'work'), s(10, 20, 'wait', 'person'), s(25, 30, 'wait', 'unknown', true), s(30, 40, 'work'), s(40, 60, 'wait', 'ship'), s(60, 70, 'wait', 'sealed'), s(70, 90, 'gone', 'finished')], 0, 80, { line: 35, rebase: 42, test: 45, deploy: 55 });
  assert.deepEqual(
    parts.map((p) => [p.start, p.end, p.part]),
    [
      [0, 10, 'work'],
      [10, 20, 'person'],
      [20, 30, 'none'],
      [30, 40, 'work'], // in the line from 35, but working
      [40, 45, 'line'],
      [45, 55, 'ci'],
      [55, 80, 'deploy'], // the last stage runs to live, over the sealed wait and the dismissal's stretch
    ],
  );
  assert.equal(
    PARTS.reduce((n, k) => n + totals[k], 0),
    80,
  );
  // No stages (a scheme with no release rows): the log's own words stand, and what isn't named is another wait.
  assert.deepEqual(
    cutStrip([s(0, 5, 'work'), s(5, 9, 'wait', 'ship'), s(9, 10, 'wait', 'deploy'), s(10, 12, 'wait', 'hold'), s(12, 13, 'lost', 'kill')], 0, 13, null).parts.map((p) => p.part),
    ['work', 'line', 'deploy', 'other', 'work'],
  );
});

test('a seeded day: what went live is in, from its real start; what was dropped, is elsewhere or went live later is out', async () => {
  // Started the evening before, asked a card, shipped through a release with its stages.
  const a = minion(-180);
  a.turn(-179, -170);
  a.ev(-171, 'question', { id: 'q1', questions: [{}] });
  a.ev(30, 'user_message', { author: 'Cara', text: 'Yes', answer: { questionId: 'q1' } });
  a.turn(30.1, 60);
  a.dismiss(120, 'Shipped and live, so the server dismissed this minion.');
  store.addRelease({
    project_id: scheme.id,
    target: 'citadel-server',
    version: 'abc',
    changes: JSON.stringify([{ ticketId: a.id, number: 1, title: 'A', stages: { line: at(61), rebase: at(80), test: at(81), deploy: at(100) } }]),
    started_at: at(61),
    live_at: at(118),
    outcome: 'live',
    stages: '{}',
  });
  store.props.set('minion', a.id, scheme.id, { type: 'bug' }, 'Cara');
  // Another scheme's way: no release rows, live when the server dismissed it.
  const b = minion(600);
  b.turn(601, 640);
  b.dismiss(700, 'Shipped, so the server dismissed this minion.');
  // Dropped by a person, not shipped.
  const c = minion(10);
  c.turn(11, 20);
  c.dismiss(30, 'Josh dismissed this minion.');
  // Shipped the next day.
  const d = minion(1000);
  d.turn(1001, 1100);
  d.dismiss(1500, 'Shipped, so the server dismissed this minion.');
  // Another scheme's minion.
  const e = minion(100, elsewhere.id);
  e.turn(101, 110);
  e.dismiss(200, 'Shipped, so the server dismissed this minion.');

  const got = await dayStrips(store, scheme.id, '2026-11-20', at(2000));
  assert.equal(got.from, DAY0);
  assert.deepEqual(
    got.strips.map((s) => s.id),
    [a.id, b.id],
  );
  const [sa, sb] = got.strips;
  assert.equal(sa.start, at(-180), 'drawn from its real start, the day before');
  assert.equal(sa.live, at(118), "live when its release went live, not at the dismissal's note");
  assert.equal(sa.type, 'bug');
  assert.equal(sb.live, at(700));
  for (const s of got.strips)
    assert.equal(
      PARTS.reduce((n, k) => n + s.totals[k], 0),
      s.live - s.start,
      `#${s.number}'s parts add up to its start to live`,
    );
  assert.equal(sa.totals.person, 200 * MIN, 'the card waited from the end of its turn at minute -170 to the answer at 30');
  assert.equal(sa.totals.line, 20 * MIN);
  assert.equal(sa.totals.ci, 19 * MIN);
  assert.equal(sa.totals.deploy, 18 * MIN);
  assert.deepEqual([...new Set(sa.parts.map((p) => p.part))].slice(-3), ['line', 'ci', 'deploy']);

  assert.deepEqual((await dayStrips(store, scheme.id, '2026-11-19', at(2000))).strips, [], 'nothing went live the day before');
  await assert.rejects(dayStrips(store, scheme.id, '20-11-2026'), /Not a day/);
});
