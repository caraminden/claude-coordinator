// What the worker line's drawer shows and what a move in it asks for (public/worker-linemath.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMove, applyStart, dropped, laneSaid, lineGroups, lineWhy, nextUrgent, ownSaid } from '../public/worker-linemath.js';

const wait = (ticket, more = {}) => ({ ticket, project: 2, number: ticket, title: `m${ticket}`, person: 'Josh', since: 1, urgent: false, ...more });
const tag = (ticket, more = {}) => ({ ticket, project: 2, number: ticket, title: `m${ticket}`, waiting: true, kind: 'person', by: 'Josh', at: 1, ...more });
const server = () => ({
  urgent: [tag(1), tag(null, { by: undefined, title: undefined }), tag(2, { kind: 'server', by: 'Citadel', reason: 'a fix for shipping' }), tag(3, { waiting: false })],
  forced: [],
  line: [wait(1, { urgent: true }), wait(null, { urgent: true }), wait(2, { urgent: true }), wait(4), wait(5)],
});
const ids = (g) => [g.urgent.map((r) => r.ticket), g.rest.map((r) => r.ticket)];
const move = (row, on, before, by = 'Cara') => ({ row: { ticket: row, number: row, title: `m${row}` }, on, before, by });

test('the group shows whole, waiting or not, and once', () => {
  const g = lineGroups(server());
  assert.deepEqual(ids(g), [
    [1, null, 2, 3],
    [4, 5],
  ]);
  assert.equal(g.urgent[0].person, 'Josh');
});

test('a move shows as the server will have it, and twice changes nothing more', () => {
  const g = lineGroups(server());
  for (const [m, want] of [
    [move(5, true, null), [[1, null, 2, 3, 5], [4]]],
    [move(5, true, 1), [[5, 1, null, 2, 3], [4]]],
    [move(5, true, undefined), [[1, null, 2, 3, 5], [4]]],
    [
      move(2, true, 1),
      [
        [2, 1, null, 3],
        [4, 5],
      ],
    ],
    [
      move(1, true, null),
      [
        [null, 2, 3, 1],
        [4, 5],
      ],
    ],
    [
      move(2, true, undefined),
      [
        [1, null, 2, 3],
        [4, 5],
      ],
    ],
    [
      move(2, false),
      [
        [1, null, 3],
        [2, 4, 5],
      ],
    ],
    [
      move(3, false),
      [
        [1, null, 2],
        [4, 5],
      ],
    ],
    [
      move(4, false),
      [
        [1, null, 2, 3],
        [4, 5],
      ],
    ],
  ]) {
    const once = applyMove(g, m);
    assert.deepEqual(ids(once), want, JSON.stringify(m));
    assert.deepEqual(ids(applyMove(once, m)), want);
  }
});

test('whose mark it is: a move keeps a person, takes over the server, and names who pressed', () => {
  const g = lineGroups(server());
  const by = (m) => applyMove(g, m).urgent.find((r) => r.ticket === m.row.ticket);
  assert.equal(by(move(1, true, null)).by, 'Josh');
  assert.deepEqual([by(move(2, true, null)).by, by(move(2, true, null)).reason], ['Cara', undefined]);
  assert.equal(by(move(4, true, null)).by, 'Cara');
  assert.equal(by(move(9, true, null)).waiting, false); // pressed in its header while it runs
  assert.equal(by(move(3, true, 1)).waiting, false);
});

test('a drop above the divider is Urgent, below it is not', () => {
  const g = lineGroups(server()); // items: 1, other, 2, 3, divider, 4, 5
  const at = (from, to) => {
    const d = dropped(g, from, to);
    return d && [d.row.ticket, d.on, d.before];
  };
  assert.deepEqual(at(6, 0), [5, true, 1]);
  assert.deepEqual(at(6, 1), [5, true, 2]); // ahead of one nobody here can name: the next that can be
  assert.deepEqual(at(5, 4), [4, true, null]);
  assert.deepEqual(at(0, 3), [1, true, null]);
  assert.deepEqual(at(0, 4), [1, false, undefined]);
  assert.deepEqual(at(0, 6), [1, false, undefined]);
  assert.equal(at(5, 6), null); // below, the order is the server's
  const empty = lineGroups({ urgent: [], line: [wait(4)] });
  assert.deepEqual([dropped(empty, 1, 0).on, dropped(empty, 1, 0).before], [true, null]);
});

test('Undo puts one back just ahead of what it was ahead of', () => {
  const g = lineGroups(server());
  assert.deepEqual([nextUrgent(g, 1), nextUrgent(g, 3), nextUrgent(g, 4)], [2, null, undefined]);
  const after = applyMove(g, move(1, false));
  assert.deepEqual(ids(applyMove(after, move(1, true, nextUrgent(g, 1))))[0], [null, 1, 2, 3]); // the unseen row has no id to go ahead of
});

test('why it stands there', () => {
  assert.equal(lineWhy(tag(1)), 'by Josh');
  assert.equal(lineWhy(tag(2, { kind: 'server', by: 'Citadel', reason: 'a fix' })), 'by Citadel: a fix');
  assert.equal(lineWhy(tag(null, { by: undefined })), '');
  assert.equal(lineWhy(wait(4, { warm: true })), 'warm, about to go cold');
  assert.equal(lineWhy(wait(4, { first: true, warm: true })), 'ship refused, or others wait on it · warm, about to go cold');
  assert.equal(lineWhy(wait(4)), '');
});

test('Start now takes a row out of the order and names who; Release puts it back; twice changes nothing more', () => {
  const start = (id, on) => ({ row: { ticket: id, project: 2, number: id, title: `m${id}` }, on, by: 'Josh', at: 9 });
  const on = applyStart(server(), start(4, true));
  assert.deepEqual(on.forced, [{ ticket: 4, project: 2, number: 4, title: 'm4', waiting: true, since: 9, by: 'Josh' }]);
  assert.deepEqual(ids(lineGroups(on))[1], [5]);
  assert.deepEqual(applyStart(on, start(4, true)), on);
  // The server's own word on who holds it stays over a later press.
  assert.equal(applyStart(on, { ...start(4, true), by: 'Cara', at: 20 }).forced[0].by, 'Josh');
  const off = applyStart(on, start(4, false));
  assert.deepEqual([off.forced, ids(lineGroups(off))[1]], [[], [4, 5]]);
  assert.deepEqual(applyStart(off, start(4, false)), off);
  // Urgent as well: it stays in that group, waiting or not.
  assert.deepEqual(ids(lineGroups(applyStart(server(), start(1, true))))[0], [1, null, 2, 3]);
});

test('what one with its own worker is doing', () => {
  assert.equal(ownSaid({ waiting: true }, 'Josh paused all minions'), 'waiting: Josh paused all minions');
  assert.equal(ownSaid({ waiting: true }, null), 'starting');
  assert.equal(ownSaid({ waiting: false, working: true }, null), 'working');
  assert.equal(ownSaid({ waiting: false }, null), 'idle');
});

test('the quick lane in words, at each memory level', () => {
  assert.equal(laneSaid({ used: 1, size: 2, moved: 0 }), '1 of 2 working');
  assert.equal(laneSaid({ used: 0, size: 2, moved: 2 }), '0 of 2 working · 2 moved to the pool');
  assert.equal(laneSaid({ used: 1, size: 1, moved: 0 }), '1 of 1 working, 1 while memory is under strain');
  assert.equal(laneSaid({ used: 0, size: 0, moved: 0 }), 'closed while memory is tight');
  assert.equal(laneSaid({ used: 2, size: 0, moved: 1 }), '2 working, closed while memory is tight · 1 moved to the pool');
  assert.equal(lineWhy({ quick: true, warm: true }), 'warm, about to go cold · may use the quick lane');
});
