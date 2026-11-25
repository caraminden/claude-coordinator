import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextSize, pick, POOL, type Waiting } from '../src/turn-line.ts';

// #1868, the pool's two rules. Josh, 2026-11-24: "Lets make the pool dynamic and performance of perigee based, not a static
// number", and "you should scale based on how many minions the user has waiting as well".
const calm = { cpu: 10, mem: 0, io: 0, starved: false, why: '' };
const busy = { cpu: 40, mem: 0, io: 0, starved: false, why: '' };
const starved = { cpu: 60, mem: 0, io: 0, starved: true, why: 'CPU pressure 60%' };
const full = { size: 10, at: 0, used: 10, waiting: 3 };
const LATER = 60_000;

test('the size grows by one while the pool is full, something waits and the box is calm', () => {
  assert.equal(nextSize(full, calm, LATER), 11);
  assert.equal(nextSize({ ...full, waiting: 0 }, calm, LATER), 10, 'nothing waits');
  assert.equal(nextSize({ ...full, used: 9 }, calm, LATER), 10, 'a worker is free');
  assert.equal(nextSize(full, calm, POOL.growMs - 1), 10, 'it moved a moment ago');
  assert.equal(nextSize({ ...full, size: POOL.max, used: POOL.max }, calm, LATER), POOL.max);
});

test('it holds between calm and starved, and with no reading', () => {
  assert.equal(nextSize(full, busy, LATER), 10);
  assert.equal(nextSize(full, { ...calm, mem: 12 }, LATER), 10);
  assert.equal(nextSize(full, { ...calm, cpu: null }, LATER), 10, 'an unreadable box never grows it');
});

test('starved, it shrinks by one, from what runs if fewer run, to the floor and no lower', () => {
  assert.equal(nextSize(full, starved, LATER), 9);
  assert.equal(nextSize({ ...full, used: 6 }, starved, LATER), 5);
  assert.equal(nextSize({ ...full, used: 14 }, starved, LATER), 9, 'turns over the size do not raise it');
  assert.equal(nextSize({ ...full, used: 0 }, starved, LATER), POOL.min);
  assert.equal(nextSize(full, starved, POOL.shrinkMs - 1), 10);
});

const w = (ticket: number, person: number, rank = 1, since = ticket): Waiting => ({ ticket, person, rank, since });

test('within a share: own messages, then started work, then automatic; then who waited longest', () => {
  assert.equal(pick([w(1, 7, 2), w(2, 7, 1), w(3, 7, 0), w(4, 7, 0)], new Map(), 0)?.ticket, 3);
});

test('one that waited 20 minutes goes with the front group', () => {
  assert.equal(pick([w(1, 7, 2, 0), w(2, 7, 0, POOL.agedMs)], new Map(), POOL.agedMs)?.ticket, 1);
});

test('everyone gets their first two workers before anyone gets more', () => {
  const waiting = [w(1, 7), w(2, 7), w(3, 7), w(4, 7), w(5, 8)];
  assert.equal(
    pick(
      waiting,
      new Map([
        [7, 2],
        [8, 1],
      ]),
      0,
    )?.ticket,
    5,
  );
});

test('past that, a share is in proportion to what a person has running and waiting', () => {
  const joshs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => w(n, 7, 1, n + 100));
  const caras = [w(20, 8), w(21, 8)];
  // Josh runs 3 of 13, Cara 2 of 4: he is further below his share.
  assert.equal(
    pick(
      [...caras, ...joshs],
      new Map([
        [7, 3],
        [8, 2],
      ]),
      0,
    )?.ticket,
    1,
  );
  // Josh runs 8 of 18, Cara 2 of 8: she is.
  assert.equal(
    pick(
      [...joshs, ...[20, 21, 22, 23, 24, 25].map((n) => w(n, 8))],
      new Map([
        [7, 8],
        [8, 2],
      ]),
      0,
    )?.ticket,
    20,
  );
});

test('an empty line picks nothing', () => assert.equal(pick([], new Map(), 0), null));
