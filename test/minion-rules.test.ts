import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanRules } from '../src/approvals.ts';
import { findPlugins } from '../src/plugin-scan.ts';
import { APPROVALS, ciOn, handRules, pluginMode, setCi, setPluginMode, ticked, toggleApproval } from '../public/minion-rules.js';

test('approvals: ticking adds the rules, unticking removes only them, and hand rules stay', () => {
  let stored = 'Bash(tools/deploy.sh:*)';
  stored = toggleApproval(stored, 'merge', true);
  assert.deepEqual(stored.split('\n'), ['Bash(tools/deploy.sh:*)', 'Bash(gh pr merge:*)', 'mcp__*__merge_pull_request']);
  assert.deepEqual(
    ticked(stored.split('\n')).map((a) => a.id),
    ['merge'],
  );
  assert.deepEqual(handRules(stored), ['Bash(tools/deploy.sh:*)']);
  assert.equal(toggleApproval(stored, 'merge', false), 'Bash(tools/deploy.sh:*)');
  assert.equal(toggleApproval(stored, 'merge', true), stored, 'ticking twice adds nothing');
});

test('approvals: a box with only some of its rules is unticked and its rule shows by hand', () => {
  assert.deepEqual(ticked(['Edit(CLAUDE.md)']), []);
  assert.deepEqual(handRules('Edit(CLAUDE.md)'), ['Edit(CLAUDE.md)']);
  assert.equal(toggleApproval('Edit(CLAUDE.md)', 'docs', true), 'Edit(CLAUDE.md)\nEdit(.claude/**)');
});

test('every catalogue rule is one the server accepts as stored', () => {
  assert.doesNotThrow(() => cleanRules(APPROVALS.flatMap((a) => a.rules).join('\n')));
});

test('plugins: off, picked and every minion move a folder between the two stored lists', () => {
  const p = { plugin_dirs: 'tools/mods/delve', optional_plugin_dirs: '' };
  assert.equal(pluginMode(p, 'tools/mods/delve'), 'every');
  assert.equal(pluginMode(p, 'tools/plugins/devtools'), 'off');
  const picked = setPluginMode(p, 'tools/mods/delve', 'picked');
  assert.deepEqual(picked, { plugin_dirs: '', optional_plugin_dirs: 'tools/mods/delve' });
  assert.equal(pluginMode(picked, 'tools/mods/delve'), 'picked');
  assert.deepEqual(setPluginMode(picked, 'tools/mods/delve', 'off'), { plugin_dirs: '', optional_plugin_dirs: '' });
  assert.deepEqual(setPluginMode({ ...p, optional_plugin_dirs: 'a' }, 'b', 'every'), { plugin_dirs: 'tools/mods/delve\nb', optional_plugin_dirs: 'a' });
});

test('CI alerts: off joins ci_quiet and leaves ci_watch, on leaves ci_quiet', () => {
  const p = { ci_quiet: 'drift.yml', ci_watch: 'tests.yml' };
  assert.equal(ciOn(p, 'drift.yml'), false);
  assert.equal(ciOn(p, 'tests.yml'), true);
  assert.deepEqual(setCi(p, 'tests.yml', false), { ci_quiet: 'drift.yml\ntests.yml', ci_watch: '' });
  assert.deepEqual(setCi(p, 'drift.yml', true), { ci_quiet: '', ci_watch: 'tests.yml' });
  assert.equal(ciOn({ ci_quiet: 'a.yml', ci_watch: 'a.yml' }, 'a.yml'), true, 'watched beats quiet, as ci-health reads it');
});

test('findPlugins lists folders with a plugin manifest, skips kit/ and reads name and description', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-scan-'));
  try {
    for (const [dir, manifest] of [
      ['tools/plugins/devtools', '{"name":"devtools","description":"Console"}'],
      ['kit/skills', '{"name":"kit"}'],
      ['tools/mods/odd', '{broken'],
      ['tools/mods/nul', 'null'],
    ] as const) {
      mkdirSync(join(root, dir, '.claude-plugin'), { recursive: true });
      writeFileSync(join(root, dir, '.claude-plugin', 'plugin.json'), manifest);
    }
    assert.deepEqual(await findPlugins(root), [
      { dir: 'tools/mods/nul', name: 'nul', description: '' },
      { dir: 'tools/mods/odd', name: 'odd', description: '' },
      { dir: 'tools/plugins/devtools', name: 'devtools', description: 'Console' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
