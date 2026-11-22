import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BY_TYPE, CLAUDE_MODELS, EFFORT_LEVELS, FALLBACK, guessType, pickFor, tableText, tierSummary, TIERS } from '../public/model-table.js';
import { EFFORTS, MODELS } from '../src/db.ts';
import { systemPrompt } from '../src/prompts.ts';

// The model table (#698): one copy that the prompt and the server's starts read.

test('every pick in the table is a model and effort the server takes', () => {
  for (const p of [...TIERS, ...Object.values(BY_TYPE), FALLBACK]) {
    assert.ok((MODELS as readonly string[]).includes(p.model), p.model);
    assert.ok((EFFORTS as readonly string[]).includes(p.effort), p.effort);
  }
  assert.deepEqual(CLAUDE_MODELS.map(([id]) => id), MODELS.filter((m) => m.startsWith('claude-')));
  assert.deepEqual(EFFORT_LEVELS, [...EFFORTS]);
});

test('a type picks its tier; no type, or other, the fallback; each pick is a fresh object', () => {
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
  assert.doesNotMatch(prompt, /leave both out/i);
});

test('the Models section rows are the table itself, and the picked-because line names who chose (#1061)', async () => {
  const { tierRows, advisorTrialEnd, pickReason, tierLabel } = await import('../public/model-table.js');
  assert.equal(tierRows().length, TIERS.length);
  tierRows().forEach((r, i) => {
    assert.equal(r.work, TIERS[i].work);
    assert.equal(r.tier, tierLabel(TIERS[i].model, TIERS[i].effort));
    assert.equal(r.then, TIERS[i].then ?? null);
  });
  assert.equal(advisorTrialEnd(), '2026-11-30');
  assert.equal(pickReason('table', 'bug', 'claude-sonnet-5-5', 'medium'), 'bug → Sonnet 5.5 medium');
  assert.equal(pickReason('Josh', null, 'claude-opus-5-5', 'high'), 'set by Josh: Opus 5.5 high');
  assert.match(pickReason('step-up', null, 'claude-opus-5-5', 'medium'), /^changed by the Taskmaster/);
});

test('the Taskmaster prompt switches to Opus high on its own once Fable is over its cap (#1061)', () => {
  const project = { id: 2, name: 'Citadel', instructions: '', approval_rules: '', onboarding: 'done', repo_dir: '/repo', fable_ok: 'on' } as any;
  const t = { id: 1, number: null, title: 'Taskmaster', kind: 'coordinator' } as any;
  const args = [project, t, '/s', '/p', '/t', '/m', [], true, '', null, [], null, false, null, null, false, null, []] as const;
  const under = (systemPrompt as any)(...args, false), over = (systemPrompt as any)(...args, true);
  assert.doesNotMatch(under, /over the weekly cap/);
  assert.match(over, /Fable use is over the weekly cap[^.]*start Fable-tier minions on Opus high/);
});

test("the model tiers moved out of every minion's prompt render in citadel:subagents and citadel:briefing from the table (#1574)", () => {
  const line = `Models by kind of work, from the Taskmaster's model table: ${tierSummary(true)}.`;
  const minion = systemPrompt({ id: 2, name: 'Citadel', instructions: '', approval_rules: '', onboarding: 'done', repo_dir: '/repo' } as any, { id: 9, number: 9, title: 'x', kind: 'ticket', branch: 'ticket/9-x' } as any, '/shared/9', '/shared/project', '/tickets', '/memory', [], true, '');
  assert.ok(!minion.includes('Models by kind of work'), 'the line left the minion prompt');
  const kit = join(import.meta.dirname, '..', 'kit');
  for (const skill of ['subagents', 'briefing']) {
    const text = readFileSync(join(kit, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(text, /^!`node "\$\{CLAUDE_SKILL_DIR\}\/\.\.\/\.\.\/model-tiers\.ts"`$/m, `${skill} runs the tiers script at load, on a line of its own`);
  }
  // In Citadel's repo the script finds public/; in a turn's kit copy, the table the server put beside it.
  assert.equal(execFileSync(process.execPath, [join(kit, 'model-tiers.ts')], { encoding: 'utf8' }).trim(), line);
  const copy = mkdtempSync(join(tmpdir(), 'kit-'));
  try {
    copyFileSync(join(kit, 'model-tiers.ts'), join(copy, 'model-tiers.ts'));
    assert.match(execFileSync(process.execPath, [join(copy, 'model-tiers.ts')], { encoding: 'utf8' }), /couldn't be read here; ask the Taskmaster/);
    copyFileSync(join(kit, '..', 'public', 'model-table.js'), join(copy, 'model-table.js'));
    assert.equal(execFileSync(process.execPath, [join(copy, 'model-tiers.ts')], { encoding: 'utf8' }).trim(), line);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
