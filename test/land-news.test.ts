import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { landNews, readTail } from '../src/land-news.ts';

// src/land-news.ts (#1368): the ship under way's news on Releases, read from its land.sh output. The lines are land.sh's
// own words, as a real train's log has them (landing 2832, 2026-11-20); "bisect: testing the first K of N ships" is the line
// land.sh gets in #1368's pipeline ship; the rerun window's and the cut-off run's are #1374's and #1377's.
const root = mkdtempSync(join(tmpdir(), 'land-news-'));
after(() => rmSync(root, { recursive: true, force: true }));

const name = (b: string) => `#${b.match(/ticket\/(\d+)/)?.[1] ?? b}`;
const url = 'https://github.com/o/r/actions/runs';
const T = 'test\tthe full suite\t2026-11-21T03:31:26.1129952Z';

const front = [
  "land: riding in ticket/1345-x's ship train: waiting for CI on the train",
  'land: ship train: ticket/1999-old stays in line (it changes the ship pipeline, which ships alone)',
  'land: back in line on its own: the ship train went without ticket/1311-front',
  'land: rebasing ticket/1311-front onto main (e4913962 "#1306: something")',
  'land: guard tests passed on a49185c7 in 3 s',
  "land: ship train: ticket/1325-a stays in line (it doesn't rebase cleanly onto the train)",
  'land: ship train: ticket/1337-b stays in line (it changes the ship pipeline, which ships alone)',
  "land: ship train: ticket/1355-c stays in line (it doesn't rebase cleanly onto the train)",
  'land: ship train: ticket/1311-front takes the 4 ships waiting behind it (ticket/1348-d ticket/1331-e ticket/1351-f ticket/1350-g): CI runs once on all 5, and they ship together',
  "land: waiting for CI on 13f924f3: the full suite on Cara's desktop (at most 6 min, then it runs here once perigee is quiet)",
];
const red = [
  `${T} ✖ the Overlord hears of every start, and gets a card when one reads like another person's open minion (14014.300228ms)`,
  `${T} ✖ checks run one at a time (476.842151ms)`,
  `${T} run-tests: 4 test file(s) failed; rerunning each alone once to tell load from a real failure`,
  `land: CI is red on the ship train (${url}/1): finding the first ship that turned it red`,
];

test('a train: who stayed in line (grouped by why), only its last try, CI red with its tests, then the bisect under way', () => {
  const n = landNews([...front, ...red].join('\n'), name);
  assert.deepEqual(n, [
    { tone: 'info', text: "Stayed in line: #1325, #1355 (doesn't rebase cleanly onto the train); #1337 (changes the ship pipeline, which ships alone)" },
    { tone: 'bad', text: "CI red on the train: the Overlord hears of every start, and gets a card when one… · checks run one at a time" },
    { tone: 'warn', text: 'Finding the ship that turned the train red' },
  ], 'the old train it rode before its own rebase is left out');
});

test('the bisect counts its CI runs, or says land.sh\'s K of N; flakes run once more; its result replaces it', () => {
  const wait = "land: waiting for CI on d66e2d82: the full suite on Cara's desktop";
  let lines = [...front, ...red, wait];
  assert.equal(landNews(lines.join('\n'), name).at(-1)!.text, 'Finding the ship that turned the train red: CI run 1');
  lines.push('land: bisect: testing the first 2 of 4 ships');
  assert.equal(landNews(lines.join('\n'), name).at(-1)!.text, 'Finding the ship that turned the train red: testing the first 2 of 4');
  lines = [...front, ...red, wait,
    'land: flake: test/memory.test.ts · in CI',
    'land: failed in the full run but passed alone (test/memory.test.ts, test/minion-index.test.ts, test/overlord.test.ts, test/wake-when-live.test.ts); running CI once more on d66e2d82, the land needs a fully green run',
    wait, `land: CI passed on d66e2d82 in 337s (${url}/2)`,
    `land: the bisect found ticket/1331-e the first ship that turned the train red (${url}/3): it is refused, and the 1 before it ship`,
  ];
  assert.deepEqual(landNews(lines.join('\n'), name).slice(1), [
    { tone: 'bad', text: "CI red on the train: the Overlord hears of every start, and gets a card when one… · checks run one at a time" },
    { tone: 'warn', text: 'memory, minion-index, overlord +1 more failed in the full suite but passed alone: one fresh CI run' },
    { tone: 'bad', text: '#1331 dropped: it turned the train red; back in line: #1351, #1350' },
  ]);
});

test('the other ways a train ends: the front itself red, no answer from CI, a rider leaving; flakes that stay red; the fallback; slow CI', () => {
  const at = (...l: string[]) => landNews([...front, ...l].join('\n'), name).slice(1);
  assert.deepEqual(at(...red, 'land: the bisect found ticket/1311-front itself red, so the ships behind it go back in line').map((x) => x.text).slice(1),
    ['#1311 itself red; back in line: #1348, #1331, #1351, #1350']);
  assert.deepEqual(at('land: the ship train goes back in line, since CI gave no answer (a timeout): ticket/1311-front goes on alone'),
    [{ tone: 'warn', text: 'CI gave no answer (a timeout): #1311 goes on alone; back in line: #1348, #1331, #1351, #1350' }]);
  assert.deepEqual(at(...red, 'land: the ship train goes back in line, since CI gave no answer (a timeout): ticket/1311-front goes on alone',
    "land: waiting for CI on 0123abcd: the full suite on Cara's desktop").map((x) => x.text).slice(1),
  ['CI gave no answer (a timeout): #1311 goes on alone; back in line: #1348, #1331, #1351, #1350'], 'a no-answer mid-bisect ends the bisect line');
  assert.deepEqual(at('land: ship train: ticket/1351-f left the line while the train was tested, so it ships without it and the ships after it go back in line'),
    [{ tone: 'info', text: '#1351 left the line during the test; back in line: #1350' }]);
  assert.equal(at('land: failed in the full run but passed alone (test/a.test.ts), but deleting land/x on GitHub to start a fresh run failed, so this stays red')[0].tone, 'bad');
  assert.deepEqual(at("land: CI's full run ended red and it is rerunning the failed files alone to tell flakes from real failures, so this waits up to 3 min 0 s more for them instead of falling back at 360s (https://ci/9)",
    'land: only known flakes failed in CI (https://ci/9): test/memory.test.ts (seen on 4 other branches in 14 days, fix #1381), test/overlord.test.ts (seen on 1 other branch in 14 days), so this goes on as green, with no fresh run'),
  [{ tone: 'warn', text: 'Only known flakes failed (memory, overlord): going on as green, with no fresh CI run' }], '#1419: and the reruns\' warning goes');
  assert.deepEqual(at("land: CI's full run ended red and it is rerunning the failed files alone to tell flakes from real failures, so this waits up to 3 min 0 s more for them instead of falling back at 360s (https://ci/9)",
    "land: SHIPPING THROUGH MAIN'S RED: test/clock.test.ts fails run alone on main's tip 0123abc here too, and it is the only real failure of this train's CI run (https://ci/9): no ship on it changed test/clock.test.ts or what it imports"),
  [{ tone: 'warn', text: "Red only on main's own red test (clock): shipping through it; main still needs a fix" }], '#1478: and the reruns\' warning goes');
  assert.deepEqual(at('land: broken test, not a flake: test/review-set-api.test.ts red in 4 of 10 runs in the last 6 h'),
    [{ tone: 'bad', text: 'review-set-api is a broken test, not a flake: red in 4 of 10 runs in the last 6 h' }], '#1487');
  assert.deepEqual(at('land: CI FALLBACK: no runner took the run. Running the full suite on perigee instead.'),
    [{ tone: 'warn', text: 'CI fallback: the full suite runs on perigee (no runner took the run)' }]);
  const slow = "land: waiting for CI or a quiet perigee: CI: CI didn't finish within 360s, but perigee is busy";
  assert.equal(at(slow).at(-1)!.text, 'CI is past its time limit: waiting on CI, or on a quiet perigee to run the suite here');
  assert.deepEqual(at(slow, `land: CI passed on a49185c7 in 395s (${url}/4)`), [], 'gone once CI answers');
  // #1374's rerun window and #1377's cut-off run, in their words.
  const rerun = `land: CI's full run ended red and it is rerunning the failed files alone to tell flakes from real failures, so this waits up to 3 min 0 s more for them instead of falling back at 360s (${url}/5)`;
  assert.deepEqual(at(slow, rerun).map((x) => x.text), ["CI's full run ended red: rerunning the failed files alone, to tell flakes from real failures (up to 3 min 0 s more)"]);
  assert.deepEqual(at(rerun, ...red).map((x) => x.text), ["CI red on the train: the Overlord hears of every start, and gets a card when one… · checks run one at a time", 'Finding the ship that turned the train red'], 'the red replaces it');
  assert.deepEqual(at('land: the CI run on d66e2d82 was cut off before any test failed (the runner went away), so it says nothing about this commit: running CI once more'),
    [{ tone: 'warn', text: 'CI run cut off before any test failed (the runner went away): one more run' }]);
  assert.deepEqual(at(slow, 'land: CI FALLBACK: perigee went quiet. Running the full suite on perigee instead.').map((x) => x.text),
    ['CI fallback: the full suite runs on perigee (perigee went quiet)'], 'or once the suite runs here');
});

test('at most six lines, the newest kept; nothing to say, nothing shown', () => {
  const many = Array.from({ length: 9 }, (_, i) => `land: CI FALLBACK: reason ${i}. Running the full suite on perigee instead.`);
  const n = landNews(many.join('\n'), name);
  assert.equal(n.length, 6);
  assert.match(n.at(-1)!.text, /reason 8/);
  assert.deepEqual(landNews('land: rebasing ticket/1-x onto main (abc "y")\nland: guard tests passed', name), []);
});

test('readTail: the log\'s end, read again only once it grows; a cut first line is dropped', () => {
  const f = join(root, 'output.log');
  assert.equal(readTail(f), '', 'no log yet');
  writeFileSync(f, 'land: one\n');
  assert.equal(readTail(f), 'land: one\n');
  appendFileSync(f, 'land: two\n');
  assert.equal(readTail(f), 'land: one\nland: two\n');
  writeFileSync(f, `${'x'.repeat(300 * 1024)}\nland: last\n`);
  assert.equal(readTail(f), 'land: last\n');
});

test('suspects: the ships sent back replace the bisect line, naming each with its failing tests (G2)', () => {
  const sus = "land: suspects: #1331 (test/memory.test.ts, test/a.test.ts), #1351 (test/b.test.ts): CI is red on the ship train (" + url + "/1) in tests only their changes touched, so they are likely the cause: they go back to their minions with the failure, and the next ships in line take their places";
  // land.sh guesses suspects before it bisects, so the log has no "CI is red on the ship train" line first
  const n = landNews([...front, ...red.slice(0, -1), sus].join('\n'), name);
  assert.deepEqual(n.slice(1), [
    { tone: 'bad', text: 'CI red on the train: the Overlord hears of every start, and gets a card when one… · checks run one at a time' },
    { tone: 'bad', text: 'Sent back to their minions: #1331 (memory, a), #1351 (b)' },
  ]);
  // a suspects line that gave up leaves the bisect line alone
  const none = [...front, ...red, "land: suspects: no ship on the train touched test/x.test.ts or what it imports, so the bisect looks for the ship"];
  assert.equal(landNews(none.join('\n'), name).at(-1)!.text, 'Finding the ship that turned the train red');
});
