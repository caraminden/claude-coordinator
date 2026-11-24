// The audit's overlap list (kit/skills/test-quality/scripts/test-overlap.ts): lcov reading and pair ranking.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodeArgs, parseLcov, scorePairs } from '../kit/skills/test-quality/scripts/test-overlap.ts';

const range = (file: string, from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `${file}:${from + i}`);

test('parseLcov keeps only lines that ran', () => {
  const lcov = 'TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nDA:3,4\nend_of_record\nSF:src/b.ts\nDA:1,2\nend_of_record\n';
  assert.deepEqual([...parseLcov(lcov)].sort(), ['src/a.ts:1', 'src/a.ts:3', 'src/b.ts:1']);
});

test('a small file inside a big one ranks as a suspect, an unrelated one does not', () => {
  const load = range('src/boot.ts', 1, 100); // every file runs it: it must not count as overlap
  const covered = new Map([
    ['t/big.test.ts', new Set([...load, ...range('src/x.ts', 1, 200), ...range('src/y.ts', 1, 100)])],
    ['t/small.test.ts', new Set([...load, ...range('src/x.ts', 1, 50)])],
    ['t/other.test.ts', new Set([...load, ...range('src/z.ts', 1, 80)])],
  ]);
  for (let i = 0; i < 40; i++) covered.set(`t/f${i}.test.ts`, new Set([...load, ...range(`src/own${i}.ts`, 1, 60)])); // a suite's many files all run the load lines
  const pairs = scorePairs(covered, { min: 0.5, minLines: 30 });
  assert.equal(pairs.length, 1, JSON.stringify(pairs));
  assert.deepEqual([pairs[0].a, pairs[0].b].sort(), ['t/big.test.ts', 't/small.test.ts']);
  assert.ok(pairs[0].containment > 0.9 && pairs[0].jaccard < 0.4, `containment ${pairs[0].containment}, jaccard ${pairs[0].jaccard}`);
  assert.equal(pairs[0].top[0], 'src/x.ts');
});

test('a file with fewer covered lines than the floor is never paired', () => {
  const covered = new Map([
    ['t/a.test.ts', new Set(range('src/x.ts', 1, 10))],
    ['t/b.test.ts', new Set(range('src/x.ts', 1, 10))],
  ]);
  assert.deepEqual(scorePairs(covered, { minLines: 30 }), []);
});

test('nodeArgs keeps the test script launcher, global setup and timeout', () => {
  const r = nodeArgs('tools/citadel-node --test --test-timeout=$(( 60 * 1000 )) --test-global-setup=test/leak-guard.ts test/');
  assert.equal(r.launcher, 'tools/citadel-node');
  assert.ok(r.flags.includes('--test-global-setup=test/leak-guard.ts'));
  assert.equal(nodeArgs('node --test').launcher, 'node');
});
