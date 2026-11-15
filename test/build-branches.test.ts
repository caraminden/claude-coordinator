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

test('build lines are given only to a minion in a build with its branch made, and the Taskmaster gets the build line only when the scheme can land one', () => {
  assert.deepEqual(buildLines(null), []);
  assert.deepEqual(buildLines({ build: 7, branch: null, owner: false }), [], 'no branch yet (or Delve): nothing');
  assert.ok(buildLines({ build: 7, branch: 'build/7', owner: false }).length > 0);
  assert.ok(!prompt(null).includes('Build 7'), 'no role, no lines');
  assert.ok(prompt(null, true, 'coordinator').includes(BUILDS_LINE));
  assert.ok(!prompt(null, false, 'coordinator').includes(BUILDS_LINE));
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
