import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tableText } from '../public/model-table.js';
import { BUILDS_LINE, minionRulesLines, systemPrompt } from '../src/prompts.ts';

// Minion rules switches (#1045): each value of a per-scheme setting changes one prompt line.

const base = { id: 7, name: 'Theory', instructions: '', approval_rules: '', onboarding: 'done', repo_dir: '/repo', fable_ok: 'on', builds: 'suggest', grill: 'design', gh_runners: 'ask' } as any;
const taskmaster = { id: 1, number: null, title: 'Taskmaster', kind: 'coordinator' } as any;
const minion = { id: 2, number: 5, title: 'A minion', kind: 'ticket' } as any;
const prompt = (project: any, ticket: any, builds = false) => systemPrompt(project, ticket, '/s', '/p', '/t', '/m', [], false, '', null, [], null, builds);

test('Fable off drops the Fable tier from the table and tells every minion', () => {
  assert.match(tableText(true), /claude-fable-5-2/);
  assert.doesNotMatch(tableText(false), /claude-fable-5-2/);
  assert.match(tableText(false), /Fable is off/);
  const off = { ...base, fable_ok: 'off' };
  assert.doesNotMatch(prompt(off, taskmaster), /claude-fable-5-2 at/);
  assert.match(prompt(off, minion), /No Fable in this scheme/);
  assert.match(prompt(base, taskmaster), /claude-fable-5-2 at/);
  assert.doesNotMatch(prompt(base, minion), /No Fable in this scheme/);
});

test('Major builds off leaves the builds line out of the Taskmaster prompt', () => {
  assert.ok(prompt(base, taskmaster, true).includes(BUILDS_LINE));
  assert.ok(!prompt({ ...base, builds: 'off' }, taskmaster, true).includes(BUILDS_LINE));
});

test('Grill adds a line naming the Citadel-wide rule only off the default', () => {
  assert.equal(minionRulesLines({ ...base }).filter((l) => /Grill/.test(l)).length, 0);
  assert.match(minionRulesLines({ ...base, grill: 'all' }).join('\n'), /Grill design-shaped features first.*every feature minion/s);
  assert.match(minionRulesLines({ ...base, grill: 'never' }).join('\n'), /no feature minion runs/);
});

test("GitHub's runners: each value has its own line", () => {
  const line = (v: string) => minionRulesLines({ ...base, gh_runners: v }).filter((l) => /runners/.test(l)).join('');
  assert.match(line('ask'), /ask a person first/);
  assert.match(line('ok'), /needs no one/);
  assert.match(line('never'), /never use them/);
  assert.match(prompt({ ...base, gh_runners: 'never' }, minion), /never use them/);
});
