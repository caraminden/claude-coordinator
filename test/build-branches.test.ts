// Build branches, the app side (specs/build-branches.md, #592): what a build's minions and the Taskmaster are told.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BUILDS_LINE, buildLines, systemPrompt } from '../src/prompts.ts';
import { landsBuilds } from '../src/workspace.ts';

const project = { id: 2, name: 'Citadel', instructions: '', approval_rules: '', onboarding: 'done', repo_dir: '/repo' } as any;
const minion = { id: 9, number: 12, title: 'A feeder', kind: 'ticket', branch: 'ticket/12-a-feeder', build: 7 } as any;
const prompt = (build: any, builds = false, kind = 'ticket') =>
  systemPrompt(project, { ...minion, kind }, null, null, '/tickets', null, [], true, '', null, [], build, builds);

test('a feeder hears about its build only once build/<n> exists', () => {
  assert.deepEqual(buildLines(null), []);
  assert.deepEqual(buildLines({ build: 7, branch: null, owner: false }), [], 'no branch yet (or Delve): nothing');
  const [line] = buildLines({ build: 7, branch: 'build/7', owner: false });
  assert.match(line, /your base is `build\/7`, not main/);
  assert.match(line, /`tools\/land\.sh --into build\/7 <the test files you touched>`/);
  assert.match(line, /Never land on main/);
  assert.match(line, /"folded into Build 7" and close_self/);
  assert.match(line, /rebase onto it first/, 'a minion moved into the build rebases itself');
  assert.ok(prompt({ build: 7, branch: 'build/7', owner: false }).includes(line));
  assert.ok(!prompt(null).includes('Build 7'), 'no role, no lines');
});

test("the build minion gets its steps from the start, and the first makes the branch", () => {
  const before = buildLines({ build: 7, branch: null, owner: true }).join('\n');
  assert.match(before, /You are the build minion of Build 7/);
  assert.match(before, /`git branch build\/7 main`/);
  assert.match(before, /`tools\/land\.sh --into build\/7 --full`/);
  assert.match(before, /`tools\/land\.sh --build`/);
  assert.match(before, /one go card \(ask_question, kind merge\)/);
  const once = buildLines({ build: 7, branch: 'build/7', owner: true }).join('\n');
  assert.doesNotMatch(once, /git branch build\/7 main/, 'made already');
  assert.doesNotMatch(once, /You are a feeder/);
});

test('the Taskmaster gets the test for suggesting a build only when the scheme can land one', () => {
  assert.ok(prompt(null, true, 'coordinator').includes(BUILDS_LINE));
  assert.ok(!prompt(null, false, 'coordinator').includes('Builds:'));
  for (const words of ['all three hold', 'three or more minions', 'Never for bug fixes', 'build_owner: true', 'highest build number plus one', '"folded into Build <n>" is done']) {
    assert.ok(BUILDS_LINE.includes(words), words);
  }
});

const root = mkdtempSync(join(tmpdir(), 'builds-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('builds switch on when the land script knows --into', () => {
  assert.equal(landsBuilds(null), false);
  assert.equal(landsBuilds(root), false, 'no land.sh');
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools', 'land.sh'), '#!/bin/sh\n# rebase, test, fast-forward main\n');
  assert.equal(landsBuilds(root), false, "today's land.sh");
  writeFileSync(join(root, 'tools', 'land.sh'), '#!/bin/sh\ncase "$1" in --into) target="$2" ;; esac\n');
  assert.equal(landsBuilds(root), true);
});
