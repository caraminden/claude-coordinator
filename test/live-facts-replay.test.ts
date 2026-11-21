import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffSheet } from '../src/live-facts.ts';

// #1127 review fix (ee4bfd88): a Taskmaster's fresh-session facts sheet lists at most SHEET_MINIONS (40, not exported)
// card lines, like its minions-in-flight list, so a scheme with a hundred open cards doesn't bloat it.
const CAP = 40;

test('a facts sheet built from more cards than the cap lists at most the cap, from the first minions', () => {
  const tm = { id: 1, project_id: 3, kind: 'coordinator' };
  const minions = [10, 11, 12].map((n) => ({ id: n, number: n, title: `M${n}`, project_id: 3, kind: 'minion', status: 'idle', state: null, note: null, branch: null }));
  const store = {
    listTickets: () => [tm, ...minions],
    getProject: () => ({ name: 'S' }),
    eventsBefore: () => [],
  };
  // 20 open cards on each of 3 minions: 60 in all.
  const runner = { view: (t: { number: number }) => ({ open_cards: Array.from({ length: 20 }, (_, i) => ({ minion: t.number, kind: 'question', label: `Q${t.number}-${i}`, href: `#/p/3/t/${t.number}?e=${i}` })) }) };
  const sheet = handoffSheet(store as never, runner as never, tm as never);
  const cards = sheet.split('\n\n')[0].split('\n').slice(1);
  assert.equal(cards.length, CAP, 'capped');
  assert.match(cards[0], /^- #10: question card "Q10-0"/);
  assert.doesNotMatch(sheet, /Q12-19/, 'the rest is left off');
});
