import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { systemPrompt } from '../src/prompts.ts';

// The starting prompt's size budget (#415): every API call re-reads it, so it only grows by decision.
// Budgets are characters (about 4 per token), today's size plus 10% on 2026-11-08. Raising one is a
// one-line edit here with the reason in the commit message; then refresh the baseline with
// PROMPT_BASELINE=write node --test test/prompt-budget.test.ts
const BUDGET = { minion: 41_300, taskmaster: 40_600 };

// Today's longest instructions: the Citadel-wide text (11,664) and Delve's scheme text (10,123).
const app = 'x'.repeat(11_664);
const project = { id: 2, name: 'Citadel', instructions: 'y'.repeat(10_123), approval_rules: '', onboarding: 'done', repo_dir: '/repo' } as any;
const minion = { id: 929, number: 415, title: 'Prompt size budget check', kind: 'ticket', branch: 'ticket/415-prompt-size-budget-check' } as any;
const prompts = {
  minion: systemPrompt(project, minion, '/shared/929', '/shared/project', '/tickets', '/memory', [], true, app),
  taskmaster: systemPrompt(project, { ...minion, kind: 'coordinator' }, '/shared/929', '/shared/project', '/tickets', '/memory', [], true, app),
};

/** Each line's length, keyed by how it starts, to say which lines grew since the baseline. */
function lineSizes(prompt: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const line of prompt.split('\n')) {
    const key = line.slice(0, 60);
    sizes[key] = (sizes[key] ?? 0) + line.length + 1;
  }
  return sizes;
}

const BASELINE = new URL('prompt-baseline.json', import.meta.url);
if (process.env.PROMPT_BASELINE === 'write') {
  writeFileSync(BASELINE, JSON.stringify({ minion: lineSizes(prompts.minion), taskmaster: lineSizes(prompts.taskmaster) }, null, 1) + '\n');
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

/** The lines that grew or are new since the baseline, biggest growth first. */
function growth(was: Record<string, number>, now: Record<string, number>): string[] {
  return Object.entries(now)
    .map(([key, n]) => ({ key, n, d: n - (was[key] ?? 0) }))
    .filter((x) => x.d > 0)
    .sort((a, b) => b.d - a.d)
    .slice(0, 10)
    .map((x) => `  +${x.d} ${x.key in was ? '' : '(new) '}"${x.key}…"`);
}

for (const role of ['minion', 'taskmaster'] as const) {
  test(`a ${role}'s starting prompt stays within its budget`, () => {
    const size = prompts[role].length;
    assert.ok(size <= BUDGET[role], [
      `A ${role}'s starting prompt is ${size} characters, over its budget of ${BUDGET[role]} (about ${Math.round((size - BUDGET[role]) / 4)} tokens over).`,
      'Each 1k tokens in it costs about $11 a week. Trim it, or raise the budget in this file with the reason in the commit message.',
      'What grew since test/prompt-baseline.json:',
      ...growth(baseline[role], lineSizes(prompts[role])),
    ].join('\n'));
  });
}

// Build branches (#592): the build minion's steps and the Taskmaster's test for a build fit the same budgets.
test("a build minion's and a Taskmaster's prompt with builds on stay within the budgets too", () => {
  const owner = systemPrompt(project, { ...minion, build: 7 }, '/shared/929', '/shared/project', '/tickets', '/memory', [], true, app, null, [], { build: 7, branch: null, owner: true }, true);
  const taskmaster = systemPrompt(project, { ...minion, kind: 'coordinator' }, '/shared/929', '/shared/project', '/tickets', '/memory', [], true, app, null, [], null, true);
  assert.ok(owner.length <= BUDGET.minion, `build minion: ${owner.length} > ${BUDGET.minion}`);
  assert.ok(taskmaster.length <= BUDGET.taskmaster, `Taskmaster: ${taskmaster.length} > ${BUDGET.taskmaster}`);
});

test('the growth list names a line that grew and one that is new', () => {
  const tripwire = 'A tripwire hook checks every tool call and stops known accidents: ';
  const was = lineSizes(`Keep this.\n${tripwire}a, b`);
  const now = lineSizes(`Keep this.\n${tripwire}a, b, c, d\nA new rule.`);
  assert.deepEqual(growth(was, now), ['  +12 (new) "A new rule.…"', `  +6 "${tripwire.slice(0, 60)}…"`]);
});

test('saving instructions says what they cost, the same in the settings page and the Taskmaster tools', async () => {
  const { instructionCost } = await import('../src/prompt-cost.ts');
  const page = (await import('../public/prompt-cost.js')).instructionCost;
  assert.equal(instructionCost('x'.repeat(11_664)), 'These instructions are about 2.9k tokens; each 1k costs about $11 a week across minions.');
  assert.equal(instructionCost('x'.repeat(400)), 'These instructions are about 100 tokens; each 1k costs about $11 a week across minions.');
  assert.equal(instructionCost('  '), '');
  for (const n of [0, 400, 11_664, 16_000]) assert.equal(page('x'.repeat(n)), instructionCost('x'.repeat(n)));
});
