// tools/lane.sh (#753): the land lane of a change, from tools/lanes as a given commit has it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';

const laneSh = join(import.meta.dirname, '..', 'tools', 'lane.sh');
const root = mkdtempSync(join(tmpdir(), 'lane-'));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...scriptEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
// Citadel's own map, so these cases are the lanes Citadel's lands get.
mkdirSync(join(root, 'tools'));
copyFileSync(join(import.meta.dirname, '..', 'tools', 'lanes'), join(root, 'tools', 'lanes'));
git('add', 'tools/lanes');
git('commit', '-qm', 'map');
const map = git('rev-parse', 'HEAD');

const lane = (paths: string[], rev = map) => {
  const r = spawnSync('bash', [laneSh, rev], { cwd: root, env, input: paths.join('\n') + (paths.length ? '\n' : ''), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test("Citadel's light paths are light, and the path that decided it is named", () => {
  assert.equal(lane(['docs/adr/0001.md']), 'light docs/adr/0001.md');
  assert.equal(lane(['CLAUDE.md', '.claude/rules/x.md', 'README.md', '.github/pull_request_template.md']), 'light CLAUDE.md');
});

test('kit/ is the kit lane, with light paths beside it, but its land template is full', () => {
  assert.equal(lane(['docs/a.md', 'kit/skills/x/SKILL.md']), 'kit kit/skills/x/SKILL.md');
  assert.equal(lane(['kit/agents/a.md', 'kit/skills/scheme-setup/templates/land.sh']), 'full kit/skills/scheme-setup/templates/land.sh');
});

test('a path the map does not list is full, whatever else changed, and * crosses folders only where the map says', () => {
  assert.equal(lane(['docs/a.md', 'src/db.ts']), 'full src/db.ts');
  assert.equal(lane(['kit/a.md', 'public/app.js']), 'full public/app.js');
  assert.equal(lane(['.github/workflows/tests.yml']), 'full .github/workflows/tests.yml');
  assert.equal(lane(['sub/CLAUDE.md']), 'full sub/CLAUDE.md', 'CLAUDE.md is the root one only');
});

test('the map and lane.sh are full, so a change to them is judged by the old map with every test', () => {
  assert.equal(lane(['tools/lanes']), 'full tools/lanes');
  assert.equal(lane(['docs/a.md', 'tools/lane.sh']), 'full tools/lane.sh');
});

test('nothing changed, or a commit with no map, is full', () => {
  assert.equal(lane([]), 'full (nothing changed)');
  git('commit', '-q', '--allow-empty', '-m', 'empty');
  git('rm', '-q', 'tools/lanes');
  git('commit', '-qm', 'no map');
  const none = git('rev-parse', 'HEAD');
  assert.equal(lane(['docs/a.md'], none), `full (no tools/lanes at ${none})`);
});

test('the map is read from the commit named, not the working tree, and a pattern never globs the disk', () => {
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'tools', 'lanes'), 'light *\n');
  mkdirSync(join(root, 'docs'), { recursive: true }); // `docs/*` globbed here would match docs/a.md, not docs/x.md
  writeFileSync(join(root, 'docs', 'a.md'), '');
  assert.equal(lane(['src/db.ts']), 'full src/db.ts');
  assert.equal(lane(['docs/x.md']), 'light docs/x.md');
});
