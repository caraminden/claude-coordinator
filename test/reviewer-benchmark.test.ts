// The reviewer's benchmark (#1738): the pre-ship reviewer's text, lenses and pinned model match the run last recorded in
// test/reviewer-benchmark.json, and the planted set is well formed. A red here means: run the benchmark and record it
// (tools/review-escapes/README.md, "When the reviewer changes"). Separate from test/judges.test.ts: a judge is code replayed with
// no model, the reviewer is text that only a model run measures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { benchHash, lessonKinds, newLessons, NEW_LESSONS, readRecord, ROOT, staleReasons } from '../tools/review-escapes/bench.ts';

const FILES = ['kit/agents/reviewer.md', 'kit/skills/self-review/SKILL.md', 'kit/skills/self-review/references/lenses.md', 'kit/skills/ponytail-review/SKILL.md'];

/** A copy of the four files the reviewer is made of, to change one of them. */
function copy(change?: (file: string, text: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  for (const f of FILES) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    const text = readFileSync(join(ROOT, f), 'utf8');
    writeFileSync(join(dir, f), change ? change(f, text) : text);
  }
  return dir;
}

test("the reviewer's text, lenses and model match the last recorded benchmark run", () => {
  const rec = readRecord();
  assert.ok(rec, 'no benchmark is recorded: run node tools/review-escapes/bench.ts record (tools/review-escapes/README.md)');
  const why = staleReasons(rec);
  assert.deepEqual(why, [], `${why.join('; ')}. Run the benchmark on both sets, two passes, and record it: tools/review-escapes/README.md, "When the reviewer changes". A drop of ${2} planted bugs or more makes the change high risk.`);
});

test('a changed reviewer text, model, lens or brief rule changes the hash; whitespace does not', () => {
  const dir = copy();
  try {
    assert.equal(benchHash(dir).hash, benchHash(ROOT).hash, 'a copy of the files hashes the same');
    for (const [file, from, to] of [
      ['kit/agents/reviewer.md', 'model: sonnet', 'model: opus'],
      ['kit/agents/reviewer.md', 'you report only what you can show', 'you report what you suspect'],
      ['kit/skills/self-review/references/lenses.md', 'Always', 'Sometimes'],
      ['kit/skills/self-review/SKILL.md', 'Start a `citadel:reviewer` Grunt', 'Start a `citadel:reviewer` Grunt, in the background'],
    ] as const) {
      const changed = copy((f, t) => (f === file ? t.replace(from, to) : t));
      try {
        assert.ok(readFileSync(join(changed, file), 'utf8') !== readFileSync(join(ROOT, file), 'utf8'), `${from} is no longer in ${file}: update this test`);
        assert.notEqual(benchHash(changed).hash, benchHash(ROOT).hash, `${file}: ${from}`);
        assert.ok(staleReasons({ ...readRecord()!, ...benchHash(ROOT) }, changed)[0]?.includes('changed since'), `${file}: staleReasons says so`);
      } finally { rmSync(changed, { recursive: true, force: true }); }
    }
    const spaced = copy((_, t) => t.replace(/\n/g, '  \n\n\n'));
    try { assert.equal(benchHash(spaced).hash, benchHash(ROOT).hash, 'trailing spaces and blank-line runs are not a change'); } finally { rmSync(spaced, { recursive: true, force: true }); }
    // Only self-review's section 2 is the reviewer's brief: another section's edit is not a reviewer change.
    const other = copy((f, t) => (f.endsWith('self-review/SKILL.md') ? t.replace('## 4. Label the risk', '## 4. Label the risk\n\nA new sentence.') : t));
    try { assert.equal(benchHash(other).hash, benchHash(ROOT).hash); } finally { rmSync(other, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test(`lessons count as a change once ${NEW_LESSONS} new ones are added since the run; removed ones do not`, () => {
  const rec = { ...readRecord()!, ...benchHash(ROOT), lessons: ['a', 'b'] };
  assert.deepEqual(newLessons(['a', 'b'], ['a', 'c', 'd']), ['c', 'd']);
  assert.deepEqual(staleReasons(rec, ROOT, ['a', 'c', 'd']), [], 'two new ones are not enough');
  assert.equal(staleReasons(rec, ROOT, ['a', 'b', 'c', 'd', 'e']).length, 1, 'three new ones are');
  assert.deepEqual(staleReasons(rec, ROOT, []), [], 'a removed lesson is not a change');
  assert.deepEqual(lessonKinds("## Lessons\n\n- race with no wrong outcome: refuted 3 times, last 2026-11-22. It was wrong because x.\n- a b: refuted 1 time, last 2026-11-01.\nnot - a lesson: refuted"), ['race with no wrong outcome', 'a b']);
});

test('the planted set: about 20 real small commits with one bug each, 5 controls, every kind of bug', () => {
  const set = JSON.parse(readFileSync(join(ROOT, 'tools/review-escapes/planted.json'), 'utf8')).cases as { id: string; kind: string; base: string; head: string; plantKind?: string; plant?: { file: string; from: string; to: string }[]; defects?: { why: string }[] }[];
  const old = new Set((JSON.parse(readFileSync(join(ROOT, 'tools/review-escapes/set.json'), 'utf8')).cases as { id: string }[]).map((c) => c.id));
  const ids = new Set<string>();
  for (const c of set) {
    assert.ok(!ids.has(c.id) && !old.has(c.id), `${c.id} is used twice`);
    ids.add(c.id);
    assert.match(c.base, /^[0-9a-f]{40}$/, c.id);
    assert.match(c.head, /^[0-9a-f]{40}$/, c.id);
    if (c.kind === 'planted') {
      assert.ok(c.plant?.length && c.plant.every((p) => p.file && p.from && p.from !== p.to), `${c.id} has a plant that changes nothing`);
      assert.ok(c.defects?.length === 1 && c.defects[0].why.length > 30, `${c.id} needs one defect with its failing case`);
    } else assert.equal(c.kind, 'control', c.id);
  }
  const planted = set.filter((c) => c.kind === 'planted');
  assert.ok(planted.length >= 18 && planted.length <= 24, `${planted.length} planted cases`);
  assert.equal(set.filter((c) => c.kind === 'control').length, 5);
  const kinds = new Set(planted.map((c) => c.plantKind));
  for (const k of ['flipped comparison or boundary', 'missed sibling', 'dropped await', 'wrong argument order', 'unescaped value']) assert.ok(kinds.has(k), `no plant of the kind: ${k}`);
});
