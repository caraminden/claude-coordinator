import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { systemPrompt } from '../src/prompts.ts';

// The starting prompt's size budget (#415): every API call re-reads it, so it only grows by decision.
// Budgets are characters (about 4 per token), today's size plus 10% on 2026-11-08. Raising one is a
// one-line edit here with the reason in the commit message; then refresh the baseline with
// PROMPT_BASELINE=write node --test test/prompt-budget.test.ts
const BUDGET = { minion: 41_300, taskmaster: 41_200 };

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
      'Each 1k tokens in it costs about $22 a week. Trim it, or raise the budget in this file with the reason in the commit message.',
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
  assert.equal(instructionCost('x'.repeat(11_664)), 'These instructions are about 2.9k tokens; each 1k costs about $22 a week across minions.');
  assert.equal(instructionCost('x'.repeat(400)), 'These instructions are about 100 tokens; each 1k costs about $22 a week across minions.');
  assert.equal(instructionCost('  '), '');
  for (const n of [0, 400, 11_664, 32_000]) assert.equal(page('x'.repeat(n)), instructionCost('x'.repeat(n)));
});

// The kit's skill and agent descriptions (#708): Claude Code lists every one in the prefix each call re-reads,
// next to the built-in prompt, so they get a budget too. Characters of name + description, today's size
// plus about 5% on 2026-11-14. This never asks for shorter text: a skill with a longer description is a
// deliberate decision, made by raising the number with the reason in the commit message.
const KIT_BUDGET = 8_800;

/** A skill's or agent's `name` and `description` frontmatter, a folded or plain description joined on one line. */
function listing(file: string): string {
  const front = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const name = front.match(/^name:\s*(.*)$/m)?.[1] ?? '';
  const desc = front.match(/^description:\s*(?:[>|][-+]?)?\s*((?:.*)(?:\n[ \t]+.*)*)/m)?.[1] ?? '';
  return `${name}: ${desc.replace(/\s*\n\s*/g, ' ').trim()}`;
}

test("the kit's skill and agent descriptions stay within their budget", () => {
  const kit = new URL('../kit/', import.meta.url);
  const files = [
    ...readdirSync(new URL('skills/', kit)).map((d) => new URL(`skills/${d}/SKILL.md`, kit)),
    ...readdirSync(new URL('agents/', kit)).filter((f) => f.endsWith('.md')).map((f) => new URL(`agents/${f}`, kit)),
  ].filter((f) => existsSync(f));
  const sizes = files.map((f) => ({ f: f.pathname.split('/kit/')[1], n: listing(f.pathname).length })).sort((a, b) => b.n - a.n);
  const total = sizes.reduce((s, x) => s + x.n, 0);
  assert.ok(total <= KIT_BUDGET, [
    `The kit's skill and agent descriptions are ${total} characters, over their budget of ${KIT_BUDGET} (about ${Math.round((total - KIT_BUDGET) / 4)} tokens over).`,
    'Every minion API call re-reads them; each 1k tokens costs about $22 a week (#699: reads plus rewrites). A longer description is a deliberate choice: raise KIT_BUDGET in this file with the reason in the commit message.',
    'Longest now:',
    ...sizes.slice(0, 5).map((x) => `  ${x.n} ${x.f}`),
  ].join('\n'));
});
