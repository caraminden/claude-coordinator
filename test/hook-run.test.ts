// The combined PreToolUse runner (#1296): on recorded calls it answers exactly as the checks it replaced did, each run alone
// as its own hook, the way Claude Code ran them; and a check that can't load blocks or passes as its own hook did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookCommand, hookRunHooks, schemeRefsHooks, sideGuardHook, wordingHooks } from '../src/turn-launch.ts';
import { BIG_READ_MATCHER, TRIPWIRE_MATCHER } from '../src/hook-matchers.ts';
import { hookRun, hookRunMatcher, mergeResults } from '../src/hook-run.ts';
import type { TripwireConfig } from '../src/tripwire-base.ts';
import { testPins } from './helpers.ts';

const pins = testPins();
const root = mkdtempSync(join(tmpdir(), 'hook-run-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

// A home that holds nothing, so the tripwire reads the scratch files as this user's wherever TMPDIR is: with the real
// home, a temp folder beside it (a CI runner's, in the burn-in) read as another person's. Its paths are only ever checked.
const home = '/hook-run-test-homes/me';
const data = `${home}/.local/share/claude-coordinator`;
const worktree = `${data}/projects/2/tickets/9`;
const otherShared = `${data}/projects/3/shared/project`;
const tripwireCfg: TripwireConfig = { home, data, checkout: `${home}/claude-coordinator`, project: 2, claudeConfig: `${home}/.claude`, ask: true, env: { TMPDIR: root, PATH: '/usr/bin:/bin' } };
const refsFile = join(root, 'scheme-refs.json');
writeFileSync(refsFile, JSON.stringify({ scheme: 'Citadel', others: ['Peek Auras', 'Delve'], minions: { 83: { title: 'Old sidebar spacing', closed: true } } }));
const big = join(root, 'big.ts');
writeFileSync(big, Array.from({ length: 900 }, (_, i) => `const line${i} = ${i};`).join('\n'));

interface Out {
  stdout: string;
  stderr: string;
  code: number;
}
const run = (command: string, input: string): Out => {
  const r = spawnSync('bash', ['-c', command], { input, encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? -1 };
};

/** One call's hooks, old and new. */
function setup(side: boolean, name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const wording = { shared: [otherShared], sent: join(dir, 'wording-sent') };
  const schemeRefs = { refs: refsFile, sent: join(dir, 'scheme-refs-sent') };
  // The hooks a turn had before #1296, in its order, plus the kit's big-read guard (kit/hooks/hooks.json's old entry).
  const alone = [
    ...(side ? [{ ...sideGuardHook(pins.SIDE_GUARD), hard: true }] : []),
    { matcher: TRIPWIRE_MATCHER, command: hookCommand(pins.TRIPWIRE, JSON.stringify(tripwireCfg)), hard: true },
    wordingHooks(wording.shared, wording.sent, pins.WORDING),
    schemeRefsHooks(schemeRefs.refs, schemeRefs.sent, pins.SCHEME_REFS),
    { matcher: BIG_READ_MATCHER, command: `'${process.execPath}' '${join(pins.KIT, 'hooks', 'big-read.ts')}'` },
  ].map((h: any) => ({ matcher: h.matcher, command: h.command ?? h.hooks[0].command, hard: !!h.hard }));
  // Its own sent files: wording and scheme-refs let a sentence through the second time, by design.
  const runner = hookRunHooks({ ...(side ? { side: true } : {}), tripwire: tripwireCfg, wording: { ...wording, sent: join(dir, 'runner-wording-sent') }, schemeRefs: { ...schemeRefs, sent: join(dir, 'runner-scheme-refs-sent') }, kit: pins.KIT });
  return { alone, runner };
}

const decision = (s: string) => JSON.parse(s).hookSpecificOutput.permissionDecision as string;
const reason = (s: string) => JSON.parse(s).hookSpecificOutput.permissionDecisionReason as string;

/** Feed one call to each old hook whose matcher takes it and to the runner, and hold the runner to their answers. */
function same(call: object, side = false, label = JSON.stringify(call).slice(0, 80)) {
  const { alone, runner } = setup(side, `case-${Math.random().toString(36).slice(2)}`);
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: worktree, ...call });
  const tool = (call as any).tool_name;
  const outs = alone.filter((h) => new RegExp(h.matcher).test(tool)).map((h) => run(h.command, input));
  const entries = runner.filter((e) => new RegExp(e.matcher).test(tool));
  assert.equal(entries.length, outs.length > 0 ? 1 : 0, `${label}: the runner starts exactly when some old hook did, once`);
  // Block on failure exactly where a hard check (tripwire, side guard) read the call before, as before.
  const hardBefore = alone.some((h) => h.hard && new RegExp(h.matcher).test(tool));
  if (entries.length) assert.equal(entries[0].hooks[0].onFailure === 'block', hardBefore, `${label}: blocks on failure only where a hard check did`);
  const got = run(runner[0].hooks[0].command, input);
  const blocked = outs.filter((o) => o.code === 2);
  if (blocked.length) {
    // The blockers' messages as they were, then any deny's reason: alone, Claude Code showed one or the other.
    assert.equal(got.code, 2, label);
    const denies = outs.map((o) => o.stdout).filter((o) => o && decision(o) === 'deny');
    assert.equal(got.stderr, outs.map((o) => o.stderr).join('') + denies.map((d) => reason(d) + '\n').join(''), label);
    return { outs, got };
  }
  assert.equal(got.code, 0, label);
  assert.equal(got.stderr, outs.map((o) => o.stderr).join(''), label);
  const answers = outs.map((o) => o.stdout).filter(Boolean);
  if (answers.length <= 1) assert.equal(got.stdout, answers[0] ?? '', label);
  else {
    const denies = answers.filter((a) => decision(a) === 'deny');
    assert.equal(decision(got.stdout), denies.length ? 'deny' : 'ask', label);
    for (const d of denies) assert.ok(reason(got.stdout).includes(reason(d)), `${label}: every deny's reason is in the answer`);
  }
  return { outs, got };
}

test('recorded calls: the runner blocks, asks, denies and passes exactly as the old hooks did, each alone', () => {
  const cases: [object, string][] = [
    [{ tool_name: 'Bash', tool_input: { command: 'ls -la', description: 'List files in the worktree' } }, 'pass'],
    [{ tool_name: 'Bash', tool_input: { command: 'rm "$HOME/.local/share/claude-coordinator/coordinator.db-wal"', description: 'Delete the DB copies Cara approved in #54' } }, 'block'],
    [{ tool_name: 'Bash', tool_input: { command: 'tools/deploy.sh --now', description: 'Deploy the change Cara approved in #54 now' } }, 'ask'],
    [{ tool_name: 'Bash', tool_input: { command: `cat ${big}`, description: 'Show the big file' } }, 'deny'],
    [{ tool_name: 'Read', tool_input: { file_path: big } }, 'deny'],
    [{ tool_name: 'Read', tool_input: { file_path: big, limit: 50 } }, 'pass'],
    [{ tool_name: 'Read', tool_input: { file_path: `${data}/coordinator.db` } }, 'any'],
    [{ tool_name: 'Grep', tool_input: { pattern: 'x', path: worktree } }, 'pass'],
    [{ tool_name: 'Write', tool_input: { file_path: `${worktree}/notes.md`, content: 'Fold it in.' } }, 'pass'],
    [{ tool_name: 'Write', tool_input: { file_path: `${otherShared}/notes.md`, content: 'Fold it in.' } }, 'block'],
    [{ tool_name: 'Edit', tool_input: { file_path: `${worktree}/a.ts`, old_string: 'a', new_string: 'b' } }, 'pass'],
    [{ tool_name: 'mcp__thread__message_coordinator', tool_input: { text: 'Looks good, fold it and deploy.' } }, 'deny'],
    [{ tool_name: 'mcp__thread__message_coordinator', tool_input: { text: 'Peek Auras #60, #71 and #83 can carry on.' } }, 'deny'],
    [{ tool_name: 'mcp__thread__ask_question', tool_input: { questions: [{ question: 'Fold it? Peek Auras #60, #71 and #83 can carry on.' }] } }, 'deny'],
    [{ tool_name: 'mcp__thread__message_taskmaster', tool_input: { text: 'Peek Auras #71 is done.' } }, 'pass'],
    [{ tool_name: 'Skill', tool_input: { skill: 'citadel:self-review' } }, 'pass'],
  ];
  for (const [call, want] of cases) {
    const { got } = same(call);
    const was = got.code === 2 ? 'block' : got.stdout ? decision(got.stdout) : 'pass';
    if (want !== 'any') assert.equal(was, want, JSON.stringify(call));
  }
  // Both wording and scheme-refs refused the card: one deny carries both reasons.
  const { outs } = same({ tool_name: 'mcp__thread__ask_question', tool_input: { questions: [{ question: 'Fold it? Peek Auras #60, #71 and #83 can carry on.' }] } });
  assert.equal(outs.filter((o) => o.stdout).length, 2);
  // Tools no check reads start no hook at all, as before.
  for (const tool of ['Agent', 'TaskCreate', 'mcp__thread__set_properties', 'WebSearch']) assert.doesNotMatch(tool, new RegExp(hookRunMatcher(false)));
});

test('a side question: the read-only guard refuses writes first, every tool goes through it, as before', () => {
  for (const [call, want] of [
    [{ tool_name: 'Write', tool_input: { file_path: `${worktree}/a.ts`, content: 'x' } }, 'block'],
    [{ tool_name: 'Read', tool_input: { file_path: `${worktree}/a.ts` } }, 'pass'],
    [{ tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Clear the build folder' } }, 'block'],
    [{ tool_name: 'Agent', tool_input: { prompt: 'p' } }, 'any'],
    [{ tool_name: 'WebSearch', tool_input: { query: 'q' } }, 'any'],
  ] as [object, string][]) {
    const { got } = same(call, true);
    if (want !== 'any') assert.equal(got.code === 2 ? 'block' : 'pass', want, JSON.stringify(call));
  }
  assert.equal(hookRunMatcher(true), '.*');
});

test("the runner keeps the tripwire's 10 s limit and its block on failure (#817), and pins every file it loads", () => {
  const { runner } = setup(false, 'shape');
  const [hard, soft] = runner;
  assert.equal(runner.length, 2);
  assert.equal(hard.hooks[0].timeout, 10);
  assert.equal(hard.hooks[0].onFailure, 'block');
  assert.match(hard.hooks[0].command, /^NODE_COMPILE_CACHE='[^']*\.compile-cache' '[^']+' '[^']*hook-run\.ts' '\{/);
  // The message and card tools only the soft checks read: same process, but a timeout or crash lets them through.
  assert.equal(soft.hooks[0].command, hard.hooks[0].command);
  assert.equal(soft.hooks[0].timeout, 10);
  assert.equal(soft.hooks[0].onFailure, undefined);
  for (const t of ['mcp__thread__message_coordinator', 'mcp__coordinator__message_ticket', 'mcp__thread__ask_question', 'mcp__thread__propose_plan']) assert.ok(new RegExp(soft.matcher).test(t) && !new RegExp(hard.matcher).test(t), t);
  for (const t of ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Skill']) assert.ok(new RegExp(hard.matcher).test(t) && !new RegExp(soft.matcher).test(t), t);
  // A side question's fork: one entry, every tool, blocking.
  const [only, ...rest] = setup(true, 'shape-side').runner;
  assert.deepEqual([only.matcher, only.hooks[0].onFailure, rest.length], ['.*', 'block', 0]);
  for (const f of ['hook-run.ts', 'hook-matchers.ts', 'pre-tool-hook.ts', 'tripwire.ts', 'side-guard.ts', 'wording.ts', 'scheme-refs.ts']) assert.ok(readFileSync(join(pins.MCP_DIR, f)), f);
});

test("a check that can't load blocks or passes as its own hook did: the tripwire and side guard block, the rest pass", () => {
  const copy = (missing: string) => {
    const dir = join(root, `pin-no-${missing}`);
    rmSync(dir, { recursive: true, force: true });
    cpSync(pins.MCP_DIR, dir, { recursive: true, verbatimSymlinks: true });
    rmSync(join(dir, missing), { force: true });
    return join(dir, 'hook-run.ts');
  };
  const cfg = (side = false) => JSON.stringify({ ...(side ? { side: true } : {}), tripwire: tripwireCfg, wording: { shared: [otherShared], sent: join(root, 'x-sent') }, schemeRefs: { refs: refsFile, sent: join(root, 'y-sent') }, kit: join(root, 'no-kit') });
  const call = (tool_name: string, tool_input: object) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd: worktree, tool_name, tool_input });
  const go = (script: string, input: string, side = false) => spawnSync(process.execPath, [script, cfg(side)], { input, encoding: 'utf8' });
  // Its own hook dead: Claude Code's onFailure 'block' blocks the call on any non-zero exit but 2's own refusal.
  const noTripwire = go(copy('tripwire.ts'), call('Bash', { command: 'ls', description: 'List the files here' }));
  assert.notEqual(noTripwire.status, 0);
  const noSide = go(copy('side-guard.ts'), call('Read', { file_path: `${worktree}/a.ts` }), true);
  assert.notEqual(noSide.status, 0);
  // The soft ones: the call goes through, as their own crashed hooks (no onFailure) let it.
  const noWording = go(copy('wording.ts'), call('mcp__thread__message_coordinator', { text: 'Looks good, fold it and deploy.' }));
  assert.equal(noWording.status, 0);
  assert.equal(noWording.stdout, '');
  // A kit folder with no big-read guard: the big read goes through, as with no kit hook.
  const noKit = go(join(pins.MCP_DIR, 'hook-run.ts'), call('Read', { file_path: big }));
  assert.equal(noKit.status, 0);
  assert.equal(noKit.stdout, '');
  // A hard check that can't load still lets the soft ones run first: wording records its refusal as sent, as when
  // its own hook ran beside the dead tripwire, so the retry isn't refused again as new.
  const sent = join(root, 'x-sent');
  rmSync(sent, { force: true });
  assert.notEqual(go(copy('tripwire.ts'), call('Write', { file_path: join(otherShared, 'n.md'), content: 'Fold it in.' })).status, 0);
  assert.ok(existsSync(sent), 'wording ran and recorded the sentence');
  // An unreadable call: the side guard still refuses it; otherwise nothing reads it.
  assert.equal(go(join(pins.MCP_DIR, 'hook-run.ts'), 'not json', true).status, 2);
  assert.equal(go(join(pins.MCP_DIR, 'hook-run.ts'), 'not json').status, 0);
});

test('a runner already past its soft deadline lets the soft checks pass unrun, as their own timed-out hooks did; the tripwire still runs', async () => {
  const cfg = { tripwire: tripwireCfg, wording: { shared: [otherShared], sent: join(root, 'late-sent') }, schemeRefs: { refs: refsFile, sent: join(root, 'late-refs-sent') }, kit: pins.KIT };
  const msg = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: worktree, tool_name: 'mcp__thread__message_coordinator', tool_input: { text: 'Looks good, fold it and deploy.' } });
  // This test process is long past the deadline itself: give the first call all the time it needs.
  assert.equal(decision((await hookRun(msg, cfg, Infinity)).stdout!), 'deny');
  rmSync(cfg.wording.sent, { force: true });
  assert.deepEqual(await hookRun(msg, cfg, 0), {});
  const read = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: worktree, tool_name: 'Read', tool_input: { file_path: big } });
  assert.deepEqual(await hookRun(read, cfg, 0), {});
  const kill = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: worktree, tool_name: 'Bash', tool_input: { command: 'pkill -x node' } });
  assert.equal((await hookRun(kill, cfg, 0)).code, 2);
});

test('merging: a refusal wins, a deny beats an ask, one answer goes out as it is', () => {
  const deny = (r: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r } });
  const ask = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '[tripwire] x' } });
  assert.deepEqual(mergeResults([{ stderr: 'a\n', code: 2 }, { stdout: deny('w') }, { stderr: 'b\n', code: 2 }]), { stderr: 'a\nb\nw\n', code: 2 });
  assert.deepEqual(mergeResults([{ stderr: 'a\n', code: 2 }, { stdout: ask }]), { stderr: 'a\n', code: 2 });
  assert.deepEqual(mergeResults([{ stdout: ask }]), { stdout: ask });
  assert.deepEqual(mergeResults([{ stdout: ask }, { stdout: deny('w') }]), { stdout: deny('w') });
  assert.equal(reason(mergeResults([{ stdout: deny('w') }, { stdout: deny('r') }]).stdout!), 'w\n\nr');
  assert.deepEqual(mergeResults([{ stderr: '[tripwire] skipped: x\n' }, {}]), { stderr: '[tripwire] skipped: x\n' });
  assert.deepEqual(mergeResults([]), {});
});
