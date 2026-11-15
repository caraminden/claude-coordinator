import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BY_TYPE, CLAUDE_MODELS, EFFORT_LEVELS, FALLBACK, guessType, pickFor, tableText, TIERS } from '../public/model-table.js';
import { EFFORTS, MODELS } from '../src/db.ts';
import { systemPrompt } from '../src/prompts.ts';

// The model table (#698): one copy that the prompt, the server's starts and the new-minion box read.

test('every pick in the table is a model and effort the server takes', () => {
  for (const p of [...TIERS, ...Object.values(BY_TYPE), FALLBACK]) {
    assert.ok((MODELS as readonly string[]).includes(p.model), p.model);
    assert.ok((EFFORTS as readonly string[]).includes(p.effort), p.effort);
  }
  assert.deepEqual(CLAUDE_MODELS.map(([id]) => id), MODELS.filter((m) => m.startsWith('claude-')));
  assert.deepEqual(EFFORT_LEVELS, [...EFFORTS]);
});

test('a type picks its tier; no type, or other, the fallback; each pick is a fresh object', () => {
  assert.deepEqual(pickFor('chore'), { model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(pickFor('feature'), { model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(pickFor('other'), FALLBACK);
  assert.deepEqual(pickFor(undefined), FALLBACK);
  pickFor(null).model = 'x';
  assert.notEqual(FALLBACK.model, 'x');
});

test("the box guesses the type from a first message's words", () => {
  const cases: [string, string | null][] = [
    ['The settings link is broken on phones', 'bug'],
    ['Fix the flaky land test', 'bug'],
    ['Rename the inbox in the docs', 'chore'],
    ['Investigate why the board is slow', 'research'],
    ['Brainstorm ideas for the shelf', 'ideation'],
    ['A mockup of the new rail', 'design'],
    ['Add a usage bar to the top bar', 'feature'],
    ['Hmm, something about the inbox', null],
    ['', null],
  ];
  for (const [text, type] of cases) assert.equal(guessType(text), type, text);
});

test("the Taskmaster's prompt carries the table, with every tier's model and effort", () => {
  const project = { id: 2, name: 'Citadel', instructions: '', approval_rules: '', onboarding: 'done', repo_dir: '/repo' } as any;
  const prompt = systemPrompt(project, { id: 1, number: null, title: 'Taskmaster', kind: 'coordinator' } as any, '/s', '/p', '/t', '/m', [], true, '');
  assert.ok(prompt.includes(tableText()));
  for (const t of TIERS) assert.ok(tableText().includes(`${t.work} ${t.model} at ${t.effort}`), t.work);
  assert.doesNotMatch(prompt, /leave both out/i);
});
