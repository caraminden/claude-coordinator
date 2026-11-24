// Land runs' reds by cause (#1607): each red CI run on land/** goes under one cause, read from the lines land.sh writes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landReds, parseRetro, type LandRun } from '../src/land-reds.ts';

const U = 'https://github.com/o/r/actions/runs/';
const run = (id: number, branch: string, at: string, end: string, conclusion: string | null = 'failure', status = 'completed'): LandRun => ({ id, head_branch: `land/${branch}`, status, conclusion, created_at: `2026-11-22T${at}:00Z`, updated_at: `2026-11-22T${end}:00Z`, html_url: `${U}${id}` });
const SINCE = Date.parse('2026-11-22T00:00:00Z');
const day = (md: string) => parseRetro(`# Retro log: land.sh\n\nheader text\n${md}`, '2026-11-22');

test('parseRetro reads time, kind, parts and the run a link names, and skips the header', () => {
  const [l] = day(`- 10:24:46Z · ship train red · ticket/1-a · ticket/2-b · ${U}77`);
  assert.deepEqual(l, { at: Date.parse('2026-11-22T10:24:46Z'), kind: 'ship train red', parts: ['ticket/1-a', 'ticket/2-b', `${U}77`], run: 77 });
  assert.equal(day('').length, 0);
});

test('each red run gets one cause from its own lines, and greens and cancels are counted apart', () => {
  const runs = [
    run(1, 'ticket/1-a', '01:00', '01:10', 'success'),
    run(2, 'ticket/2-b', '02:00', '02:10'), // shipped through main's red
    run(3, 'ticket/3-c', '03:00', '03:10'), // a rider failed alone
    run(4, 'ticket/4-d', '04:00', '04:10'), // burn-in race
    run(5, 'ticket/5-e', '05:00', '05:10'), // burn-in red in every copy
    run(6, 'ticket/6-f', '06:00', '06:10'), // lone ship, passed alone: flake rerun
    run(7, 'ticket/7-g', '07:00', '07:10'), // lone ship refused at CI
    run(8, 'ticket/8-h', '08:00', '08:10'), // nothing said
    run(9, 'ticket/9-i', '09:00', '09:10', 'cancelled'),
    run(10, 'ticket/10-j', '10:00', '10:10', 'failure'), // its lead's suspects pin the lead itself
    run(11, 'ticket/11-k', '11:00', '11:10', 'failure'), // a known flake
  ];
  const lines = day(
    [
      `- 02:12:00Z · shipped through main's red · ticket/2-b · test/x.test.ts · ${U}2`,
      `- 03:12:00Z · ship train suspects · ticket/3-c · #30 (test/y.test.ts) · failed alone here: #30 · ${U}3`,
      `- 04:11:00Z · burn-in red · ticket/4-d · test/z.test.ts: failed in 3 of 10 copies at once · ${U}4`,
      `- 05:11:00Z · burn-in red · ticket/5-e · test/z.test.ts: failed in 10 of 10 copies at once · ${U}5`,
      '- 06:11:00Z · flake · test/q.test.ts · load 9.1 · ticket/6-f · in CI',
      '- 06:15:00Z · flake rerun · ticket/6-f · test/q.test.ts · green',
      '- 07:11:00Z · timing · ticket/7-g · line 30 · rebase 1 · ci-queue 2 · ci-run 300 · fallback - · deploy - · live - · refused at ci',
      `- 10:12:00Z · ship train suspects · ticket/10-j · #10 (test/w.test.ts) · failed alone here: #10 · ${U}10`,
      `- 11:12:00Z · known flake · ticket/11-k · test/k.test.ts (seen on 3 other branches in 14 days) · ${U}11`,
    ].join('\n'),
  );
  const out = landReds(runs, lines, SINCE);
  assert.deepEqual({ runs: out.runs, green: out.green, red: out.red, other: out.other, riders: out.riders }, { runs: 11, green: 1, red: 9, other: 1, riders: 1 });
  assert.deepEqual(Object.fromEntries(out.reds.map((r) => [r.id, `${r.cause}${r.rider ? ' rider' : ''}`])), {
    2: 'main',
    3: 'change rider',
    4: 'flaky',
    5: 'change',
    6: 'flaky',
    7: 'change',
    8: 'unknown',
    10: 'change',
    11: 'flaky',
  });
  assert.deepEqual(out.causes, { change: 4, flaky: 3, main: 1, unknown: 1 });
  assert.equal(out.reds.find((r) => r.id === 11)?.why, 'known flake: test/k.test.ts');
});

test("a train's first red run takes the bisect verdict that links a later run, and a lone ship's lines stop at its next run", () => {
  const runs = [
    run(20, 'ticket/20-t', '01:00', '01:10'), // the train's red run: no line links it
    run(21, 'ticket/20-t', '01:11', '01:20'), // the bisect's run, which the verdict links
    run(30, 'ticket/30-u', '02:00', '02:10'), // red, says nothing; its next run is refused at CI
    run(31, 'ticket/30-u', '02:12', '02:20'),
  ];
  const lines = day([`- 01:25:00Z · ship train red · ticket/20-t · ticket/22-v · ${U}21`, '- 02:21:00Z · timing · ticket/30-u · line 1 · rebase 1 · ci-queue 1 · ci-run 400 · fallback - · deploy - · live - · refused at ci'].join('\n'));
  const c = Object.fromEntries(landReds(runs, lines, SINCE).reds.map((r) => [r.id, `${r.cause}${r.rider ? ' rider' : ''}`]));
  assert.deepEqual(c, { 20: 'change rider', 21: 'change rider', 30: 'unknown', 31: 'change' });
});

test('runs before the window, and runs off land/ branches, are left out; a run still going is not red', () => {
  const runs: LandRun[] = [{ ...run(40, 'ticket/40-a', '01:00', '01:10'), created_at: '2026-11-21T23:00:00Z' }, { ...run(41, 'ticket/41-b', '01:00', '01:10'), head_branch: 'main' }, run(42, 'ticket/42-c', '01:00', '01:10', null, 'in_progress')];
  const out = landReds(runs, [], SINCE);
  assert.deepEqual({ runs: out.runs, red: out.red, other: out.other }, { runs: 1, red: 0, other: 1 });
});

test("a run's own verdict beats a later round's, a cut-off line names the run it cut off, and a red fresh run is the fresh run's own", () => {
  const runs = [
    run(50, 'ticket/50-a', '01:00', '01:10'), // its own suspects pin the lead
    run(52, 'ticket/50-a', '01:12', '01:20'), // a later round, whose bisect pins another ship
    run(60, 'ticket/60-c', '02:00', '02:05'), // cut off before any test failed
    run(61, 'ticket/60-c', '02:06', '02:20'), // the fresh run fails for real
    run(70, 'ticket/70-d', '03:00', '03:10'), // flakes only
    run(71, 'ticket/70-d', '03:11', '03:20'), // the fresh run after flakes fails too
  ];
  const lines = day(
    [
      `- 01:11:00Z · ship train suspects · ticket/50-a · #50 (test/a.test.ts) · failed alone here: #50 · ${U}50`,
      `- 01:25:00Z · ship train red · ticket/50-a · ticket/51-b · ${U}52`,
      `- 02:06:00Z · cut-off rerun · ticket/60-c · ${U}60 · red`,
      '- 02:21:00Z · timing · ticket/60-c · line 1 · rebase 1 · ci-queue 1 · ci-run 400 · fallback - · deploy - · live - · refused at ci',
      '- 03:10:30Z · flake · test/q.test.ts · load 9.1 · ticket/70-d · in CI',
      '- 03:21:00Z · flake rerun · ticket/70-d · test/q.test.ts · red',
      '- 03:21:01Z · timing · ticket/70-d · line 1 · rebase 1 · ci-queue 1 · ci-run 400 · fallback - · deploy - · live - · refused at ci',
    ].join('\n'),
  );
  const c = Object.fromEntries(landReds(runs, lines, SINCE).reds.map((r) => [r.id, `${r.cause}${r.rider ? ' rider' : ''}`]));
  assert.deepEqual(c, { 50: 'change', 52: 'change rider', 60: 'flaky', 61: 'change', 70: 'flaky', 71: 'change' });
});
