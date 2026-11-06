import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// The kit's skills-survey Workflow script, run with the Workflow runtime's globals stubbed:
// agent() as given, parallel() turning a throwing thunk into null, as Claude Code's does.
const SCRIPT = readFileSync(join(import.meta.dirname, '..', 'kit', 'skills', 'skills-survey', 'survey.workflow.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const run = (args: unknown, agent: (prompt: string, opts: any) => Promise<any>) => {
  const calls: { prompt: string; opts: any }[] = [];
  const parallel = (thunks: (() => Promise<any>)[]) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const spy = (prompt: string, opts: any) => (calls.push({ prompt, opts }), agent(prompt, opts));
  const result = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', SCRIPT)(args, spy, parallel, () => {}, () => {});
  return { result, calls };
};
const args = { brief: '/s/BRIEF.md', scratch: '/s', groups: [{ name: 'Rust Studio', repos: 'a/b', compare: 'x' }, { name: 'bug-ops', repos: 'c/d', compare: 'y' }] };
const ok = { ok: true, use: 0, mine: 1, skip: 2, headline: 'mine the perf rules' };

test('survey script: every agent is pinned to Sonnet at medium effort', async () => {
  const { result, calls } = run(args, async (_p, o) => (o.phase === 'Read' ? ok : 'Counts: 0 use'));
  const out = await result;
  assert.equal(calls.length, 3);
  for (const c of calls) assert.deepEqual([c.opts.model, c.opts.effort], ['sonnet', 'medium']);
  assert.equal(out.ranked, '/s/verdicts/_ranked.md');
  assert.deepEqual(out.groups, ['Rust Studio: 0 use, 1 mine, 2 skip; mine the perf rules', 'bug-ops: 0 use, 1 mine, 2 skip; mine the perf rules']);
  assert.match(calls[0].prompt, /write `\/s\/verdicts\/rust-studio\.md`/);
  assert.match(calls[2].prompt, /`\/s\/verdicts\/rust-studio\.md`, `\/s\/verdicts\/bug-ops\.md`/);
});

test('survey script: a reader that throws fails its group, and the rest still collate', async () => {
  const { result, calls } = run(args, async (p, o) => {
    if (o.label === 'read:bug-ops') throw new Error('schema retries exhausted');
    return o.phase === 'Read' ? ok : 'Counts: 0 use';
  });
  const out = await result;
  assert.equal(out.groups[1], 'bug-ops: FAILED; agent threw');
  assert.doesNotMatch(calls[2].prompt, /bug-ops\.md/);
  assert.match(calls[2].prompt, /Groups that failed \(list them in the file\): bug-ops: agent threw/);
});

test('survey script: no ranked path when the collation dies', async () => {
  const { result } = run(args, async (_p, o) => (o.phase === 'Read' ? ok : null));
  const out = await result;
  assert.equal(out.ranked, null);
  assert.deepEqual(out.verdicts, ['/s/verdicts/rust-studio.md', '/s/verdicts/bug-ops.md']);
});

test('survey script: no collation when every group fails', async () => {
  const { result, calls } = run(args, async () => null);
  const out = await result;
  assert.equal(calls.length, 2);
  assert.equal(out.ranked, null);
});

test('survey script: refuses bad args and groups that share a folder', async () => {
  await assert.rejects(run({}, async () => ok).result, /args must be/);
  const clash = { ...args, groups: [{ name: 'Godot', repos: 'a', compare: 'x' }, { name: 'godot!', repos: 'b', compare: 'y' }] };
  await assert.rejects(run(clash, async () => ok).result, /distinct/);
});
