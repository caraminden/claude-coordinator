import assert from 'node:assert/strict';
import { test } from 'node:test';
import { systemPrompt, turnContext } from '../src/prompts.ts';

const project = { id: 2, name: 'Citadel', instructions: '', approval_rules: '', onboarding: 'done', repo_dir: '/repo' } as any;
const tm = { id: 1, number: 1, title: 'Taskmaster', kind: 'coordinator' } as any;
const prompt = (role: 'person' | 'overlord' | null, builds = true) =>
  systemPrompt(project, tm, '/s/1', '/s/p', '/t', '/m', [], true, '', null, [], null, builds, null, null, false, role);

test('a scheme with one Taskmaster gets no role line', () => {
  const p = prompt(null);
  assert.ok(!p.includes('own Taskmaster') && !p.includes('Overlord'));
  assert.ok(p.includes('Builds:'));
});

test("a person's Taskmaster is told whose minions it owns, to use for_everyone, and leaves builds to the Overlord", () => {
  const p = prompt('person');
  assert.match(p, /one member's own Taskmaster/);
  assert.match(p, /for_everyone: true/);
  assert.ok(!p.includes('Builds: a big feature'));
});

test("the Overlord's job is the narrow list and it is not a relay hub", () => {
  const p = prompt('overlord');
  assert.match(p, /pipeline-lane/);
  assert.match(p, /not a relay hub/);
  assert.ok(p.includes('Builds: a big feature'));
});

test('a minion names its owner\'s Taskmaster', () => {
  const m = systemPrompt(project, { ...tm, kind: 'ticket', number: 5 }, '/s/1', '/s/p', '/t', '/m');
  assert.match(m, /the session of the person who owns you/);
});

test('a stalled minion is stepped up a tier: the Taskmaster calls update_ticket, a Sonnet minion asks for it', () => {
  const minion = { id: 2, number: 2, title: 'M', kind: 'ticket', branch: 'ticket/2-m' } as any;
  const m = systemPrompt(project, minion, '/s/1', '/s/p', '/t', '/m', [], true, '', null, [], null, true, null, null, false, null);
  assert.match(prompt(null), /Stalled minions step up: .*update_ticket with the next step from its tier's `then` before relaying/);
  assert.match(m, /On Sonnet, ask the Taskmaster for the next model or effort step \(`message_coordinator`, need: ask\)/);
});

test('only an advisor-trial model gets the consult lines (#954)', () => {
  const turn = (model: string | null) => turnContext(project, { id: 2, number: 2, title: 'M', kind: 'ticket', branch: 'ticket/2-m', model } as any, '/s/1', '/s/p', '/t', '/m');
  const on = turn('claude-sonnet-5-5+opus-advisor');
  assert.match(on, /opus advisor tool.*once with your plan before your first code edit, once with your diff summary before you ship, and again whenever a fix did not hold/);
  assert.ok(!turn('claude-sonnet-5-5').includes('advisor'));
  assert.ok(!turn(null).includes('advisor'));
});
