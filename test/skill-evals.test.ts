import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { firstSkill, flips, loadCases, score } from '../tools/skill-evals/run.ts';

// Skill trigger evals (#1110): the cases stay labelled with skills that exist in kit/skills/, and the scorer counts right.
test('every case is labelled with a kit skill or none, and ids are unique', () => {
  const skills = new Set([...readdirSync(new URL('../kit/skills/', import.meta.url), { withFileTypes: true })].filter((d) => d.isDirectory()).map((d) => d.name));
  const cases = loadCases();
  assert.ok(cases.length >= 40, `${cases.length} cases`);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  for (const c of cases) {
    for (const s of [c.expect, ...(c.also ?? [])]) assert.ok(s === 'none' || skills.has(s), `${c.id}: ${s} is not a kit skill (renamed? update cases.json)`);
    assert.ok(c.text.trim() && !/citadel:[a-z]/.test(c.text), `${c.id}: text names a skill outright`);
  }
});

test('the first Skill call is read from the stream', () => {
  const ev = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } });
  const call = (skill: string) => ({ type: 'tool_use', name: 'Skill', input: { skill } });
  assert.equal(firstSkill([ev([{ type: 'text', text: 'hi' }]), ev([call('citadel:grilling')]), ev([call('citadel:research')])].join('\n')), 'grilling');
  assert.equal(firstSkill(ev([call('verify')])), 'cc:verify');
  assert.equal(firstSkill('not json\n' + ev([{ type: 'text', text: 'no skill' }])), 'none');
});

test('hits, misses and false fires are scored per skill', () => {
  const cases = [
    { id: 'a', source: 'X', from: 'p', expect: 'bug-fixing', also: ['diagnosing-bugs'], text: 't' },
    { id: 'b', source: 'X', from: 'p', expect: 'none', text: 't' },
  ];
  const { rows, hits, total } = score(cases, [
    { id: 'a', fired: ['bug-fixing', 'diagnosing-bugs', 'grilling'] },
    { id: 'b', fired: ['grilling', 'none'] },
  ]);
  assert.deepEqual([hits, total], [3, 5]);
  const r = Object.fromEntries(rows.map((x) => [x.skill, x]));
  assert.deepEqual([r['bug-fixing'].hits, r['bug-fixing'].runs], [2, 3]);
  assert.deepEqual([r.none.hits, r.none.runs], [1, 2]);
  assert.equal(r.grilling.falseFires, 2);
  assert.match(flips(cases, [{ id: 'b', fired: ['none'] }], [{ id: 'b', fired: ['grilling'] }]), /\| b \|/, 'a pick that changes is a flip even when not scored');
  assert.match(
    flips(
      cases,
      [
        { id: 'a', fired: ['none'] },
        { id: 'b', fired: ['none'] },
      ],
      [
        { id: 'a', fired: ['bug-fixing'] },
        { id: 'b', fired: ['none'] },
      ],
    ),
    /\| a \|.*\| none \| bug-fixing \|/,
  );
});

test('a run that fails is not scored as "none", and the command exits non-zero', () => {
  const bin = mkdtempSync(join(tmpdir(), 'skill-evals-bin-'));
  try {
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'claude'), 0o755);
    const run = (...args: string[]) => spawnSync(process.execPath, [new URL('../tools/skill-evals/run.ts', import.meta.url).pathname, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const r = run('--case', 'n-peek-dps');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /1 run\(s\) failed.*n-peek-dps/);
    assert.match(r.stdout, /Overall: 0\/0 runs/);
    assert.match(run('--jobs', '0').stderr, /whole number above 0/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
