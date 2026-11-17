import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AlertWakes, BATCH_MS, MAX_WAIT_MS, quietUntil } from '../src/alert-wakes.ts';
import { Store } from '../src/db.ts';

// A Mandate alert also wakes the Taskmaster it's about, to explain it unasked (#869; Cara, 2026-11-17: "there should be
// some callback to the relevant taskmaster so it can explain to me what happened without me asking").
const root = mkdtempSync(join(tmpdir(), 'alert-wakes-'));
after(() => rmSync(root, { recursive: true, force: true }));
// 2026-11-17 13:00 PST (21:00 UTC): outside the 2-9 AM hold.
const NOON = Date.UTC(2026, 10, 17, 21, 0);
const SEC = 1000;
const MIN = 60 * SEC;

let n = 0;
function world() {
  const store = new Store(join(root, `db-${n++}.db`));
  const woken: [number, string][] = [];
  const deps = { wake: (scheme: number, text: string) => (woken.push([scheme, text]), true) };
  return { store, woken, deps, wakes: new AlertWakes(store, deps) };
}
const ci = { id: 0, name: 'CI health' };
const peek = { id: 4, name: 'Peek Auras' };

test('one wake per alert, not per recipient, after the burst settles, naming who got it and its link', () => {
  const w = world();
  w.wakes.raise({ from: peek, key: 'fallback.ab', title: 'Turn for #12 ran inside the server', link: '/c/#/p/4/t/12', person: 'Cara' }, NOON);
  w.wakes.raise({ from: peek, key: 'fallback.ab', title: 'Turn for #12 ran inside the server', link: '/c/#/p/4/t/12', person: 'Josh' }, NOON + SEC);
  w.wakes.tick(NOON + 30 * SEC);
  assert.deepEqual(w.woken, [], 'still inside the batch window');
  w.wakes.tick(NOON + SEC + BATCH_MS);
  assert.equal(w.woken.length, 1);
  const [scheme, text] = w.woken[0];
  assert.equal(scheme, 4);
  assert.match(text, /Turn for #12 ran inside the server/);
  assert.match(text, /Cara and Josh/);
  assert.match(text, /\/c\/#\/p\/4\/t\/12/);
  assert.match(text, /what happened/);
  // Puts of the same alert again (a retry, a new admin) don't wake it twice.
  w.wakes.raise({ from: peek, key: 'fallback.ab', title: 'Turn for #12 ran inside the server', link: '/c/#/p/4/t/12', person: 'Rachel' }, NOON + 5 * MIN);
  w.wakes.tick(NOON + 10 * MIN);
  assert.equal(w.woken.length, 1);
});

test('alerts in a burst are one wake per scheme; Citadel-wide ones go out as scheme 0', () => {
  const w = world();
  w.wakes.raise({ from: peek, key: 'fallback.a', title: 'A failed', link: '/l', person: 'Cara' }, NOON);
  w.wakes.raise({ from: peek, key: 'timer.b', title: 'B failed', link: '/l', person: 'Cara' }, NOON + 40 * SEC);
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'CI: runner X offline', link: '/l', person: 'Cara' }, NOON + 50 * SEC);
  w.wakes.tick(NOON + 50 * SEC + BATCH_MS);
  assert.deepEqual(w.woken.map(([s]) => s).sort(), [0, 4]);
  const peekText = w.woken.find(([s]) => s === 4)![1];
  assert.match(peekText, /A failed/);
  assert.match(peekText, /B failed/);
});

test('a burst that keeps going still goes out after the longest wait', () => {
  const w = world();
  for (let t = 0; t <= MAX_WAIT_MS; t += 50 * SEC) {
    w.wakes.raise({ from: peek, key: `timer.${t}`, title: `job ${t} failed`, link: '/l', person: 'Cara' }, NOON + t);
    w.wakes.tick(NOON + t);
  }
  assert.equal(w.woken.length, 1);
});

test('only new problems inside an open alert wake again; rewording, a problem leaving and the clear do not', () => {
  const w = world();
  const runnerX = { id: '1:runner:X', title: 'runner X offline' };
  const runnerY = { id: '9:runner:Y', title: 'runner Y offline', facts: 'host DESKTOP-Y' };
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'CI: runner X offline since 09:00', link: '/l', person: 'Cara', parts: [runnerX] }, NOON);
  w.wakes.tick(NOON + BATCH_MS);
  assert.equal(w.woken.length, 1);
  // Reworded, same problems.
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'CI: runner X offline since 09:00 (1 scheme)', link: '/l', person: 'Cara', parts: [runnerX] }, NOON + 5 * MIN);
  w.wakes.tick(NOON + 10 * MIN);
  assert.equal(w.woken.length, 1, 'rewording is not news');
  // Y joins: one wake naming Y, with its facts, and not X again as new.
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'CI: 2 runners offline', link: '/l', person: 'Cara', parts: [runnerX, runnerY] }, NOON + 11 * MIN);
  w.wakes.tick(NOON + 11 * MIN + BATCH_MS);
  assert.equal(w.woken.length, 2);
  assert.match(w.woken[1][1], /runner Y offline/);
  assert.match(w.woken[1][1], /host DESKTOP-Y/);
  assert.doesNotMatch(w.woken[1][1], /New in it:[^\n]*runner X/);
  // X leaves, then the whole alert clears: no wakes.
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'CI: runner Y offline', link: '/l', person: 'Cara', parts: [runnerY] }, NOON + 20 * MIN);
  w.wakes.clear(ci, 'ci.open');
  w.wakes.tick(NOON + 30 * MIN);
  assert.equal(w.woken.length, 2);
  // Open again later: news again.
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'CI: runner Y offline', link: '/l', person: 'Cara', parts: [runnerY] }, NOON + 40 * MIN);
  w.wakes.tick(NOON + 40 * MIN + BATCH_MS);
  assert.equal(w.woken.length, 3);
});

test('an alert that clears inside the batch window never wakes anyone, nor a problem that leaves before it goes', () => {
  const w = world();
  w.wakes.raise({ from: peek, key: 'fallback.a', title: 'A failed', link: '/l', person: 'Cara' }, NOON);
  w.wakes.clear(peek, 'fallback.a');
  w.wakes.tick(NOON + 10 * MIN);
  assert.deepEqual(w.woken, []);
  const x = { id: 'x', title: 'X down' };
  const y = { id: 'y', title: 'Y down' };
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'X and Y down', link: '/l', person: 'Cara', parts: [x, y] }, NOON + 20 * MIN);
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'Y down', link: '/l', person: 'Cara', parts: [y] }, NOON + 20 * MIN + SEC);
  w.wakes.tick(NOON + 20 * MIN + SEC + BATCH_MS);
  assert.equal(w.woken.length, 1);
  assert.doesNotMatch(w.woken[0][1], /X down/);
  assert.match(w.woken[0][1], /Y down/);
});

test('2-9 AM Pacific holds the wake until 9 (Cara, 2026-11-17: "Hold overnight ... between 2am and 9am"), across a restart', () => {
  const w = world();
  // 3:00 AM PST on Nov 18 = 11:00 UTC.
  const three = Date.UTC(2026, 10, 18, 11, 0);
  const nine = Date.UTC(2026, 10, 18, 17, 0);
  assert.equal(quietUntil(three), nine);
  assert.equal(quietUntil(NOON), null);
  assert.equal(quietUntil(Date.UTC(2026, 10, 18, 9, 59)), null, '1:59 AM is not held');
  w.wakes.raise({ from: peek, key: 'fallback.a', title: 'A failed', link: '/l', person: 'Cara' }, three);
  w.wakes.tick(three + BATCH_MS);
  w.wakes.tick(nine - SEC);
  assert.deepEqual(w.woken, []);
  // A restart before 9 keeps it.
  const again = new AlertWakes(w.store, w.deps);
  again.tick(nine);
  assert.equal(w.woken.length, 1);
  assert.match(w.woken[0][1], /held overnight/);
  // PDT too: 2:30 AM on Jul 1 is 09:30 UTC; 9 AM PDT is 16:00 UTC.
  assert.equal(quietUntil(Date.UTC(2026, 6, 1, 9, 30)), Date.UTC(2026, 6, 1, 16, 0));
});

test('a scheme with no Taskmaster drops its batch rather than retrying forever', () => {
  const w = world();
  const wakes = new AlertWakes(w.store, { wake: (s, t) => (w.woken.push([s, t]), false) });
  wakes.raise({ from: peek, key: 'fallback.a', title: 'A failed', link: '/l', person: 'Cara' }, NOON);
  wakes.tick(NOON + BATCH_MS);
  wakes.tick(NOON + 2 * BATCH_MS);
  assert.equal(w.woken.length, 1);
});
