import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

// tools/stale-docs (#1164): dead backticked paths in a repo's instruction files, and the shared folder's archive candidates.
const tool = join(import.meta.dirname, '..', 'tools', 'stale-docs');
const dir = mkdtempSync(join(tmpdir(), 'stale-docs-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args: string[]) => spawnSync('node', [tool, ...args], { encoding: 'utf8' });
const put = (root: string, rel: string, text: string, ageDays = 0) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
  if (ageDays) { const t = new Date(Date.now() - ageDays * 864e5); utimesSync(join(root, rel), t, t); }
};

test('refs: dead paths are named with file and line; real, allowed, placeholder and fenced ones pass', () => {
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  put(repo, 'tools/real.sh', '#!/bin/sh\n');
  put(repo, 'CLAUDE.md', [
    'Real `tools/real.sh --flag` and `real.sh` and `tools/` here.',
    'Dead `docs/retros/` and `tools/gone.ts:12` and `specs/plan.md`.',
    'Skipped: `tools/<name>.sh`, `https://x.dev/a/b.md`, `and/or`, `~/x/y.md`, `$HOME/a.md`.',
    'Allowed `examples/foo.md`.',
    '```',
    '`tools/in-a-fence.sh`',
    '```',
  ].join('\n'));
  put(repo, '.stale-docs-allow', 'examples/*  # an example folder\n');
  put(repo, 'docs/index.md', 'x\n');
  const r = run('refs', '--repo', repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /CLAUDE\.md:2  docs\/retros\//);
  assert.match(r.stdout, /CLAUDE\.md:2  tools\/gone\.ts/);
  assert.match(r.stdout, /CLAUDE\.md:2  specs\/plan\.md .*shared folder/);
  assert.equal((r.stdout.match(/CLAUDE\.md:\d/g) ?? []).length, 3);
});

test('refs: an allow-list line without a reason is an error; a clean repo says ok', () => {
  const repo = join(dir, 'clean');
  execFileSync('git', ['init', '-q', repo]);
  put(repo, 'README.md', 'See `README.md`.\n');
  assert.equal(run('refs', '--repo', repo).status, 0);
  put(repo, '.stale-docs-allow', 'foo/bar.md\n');
  const r = run('refs', '--repo', repo);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs a reason/);
});

test('shared: unpointed old files are candidates; pinned, pointed-at and young ones are not; archive moves only the candidates', () => {
  const sh = join(dir, 'shared');
  put(sh, 'handoffs/old-unpointed.md', 'Work for #42.\n', 30);
  put(sh, 'handoffs/old-pointed.md', 'x\n', 30);
  put(sh, 'handoffs/old-pinned.md', 'x\n', 30);
  put(sh, 'handoffs/fresh.md', 'x\n');
  put(sh, 'reports/r.md', 'Start from handoffs/old-pointed.md\n');
  put(sh, 'specs/s.md', 'Nothing is built.\n', 30);
  put(sh, 'pins.txt', 'handoffs/old-pinned.md\n');
  const r = run('shared', '--dir', sh, '--pins', join(sh, 'pins.txt'));
  assert.match(r.stdout, /^unpointed\s+handoffs\/old-unpointed\.md.*\[#42\]/m);
  assert.match(r.stdout, /^pointed-at\s+handoffs\/old-pointed\.md.*reports\/r\.md/m);
  assert.match(r.stdout, /^pinned\s+handoffs\/old-pinned\.md/m);
  assert.match(r.stdout, /^young\s+handoffs\/fresh\.md/m);
  assert.match(r.stdout, /specs\/s\.md.*\*\* says "Nothing is built"/);

  put(sh, 'list.txt', 'handoffs/old-unpointed.md\nhandoffs/old-pointed.md\nhandoffs/old-pinned.md\n../escape.md\n');
  assert.equal(run('archive', '--dir', sh, '--list', join(sh, 'list.txt')).status, 2);
  const a = run('archive', '--dir', sh, '--list', join(sh, 'list.txt'), '--pins', join(sh, 'pins.txt'), '--refs', join(dir, 'repo'));
  assert.match(a.stdout, /1 of 4 moved/);
  assert.ok(existsSync(join(sh, 'archive/handoffs/old-unpointed.md')));
  assert.ok(!existsSync(join(sh, 'handoffs/old-unpointed.md')));
  assert.ok(existsSync(join(sh, 'handoffs/old-pointed.md')) && existsSync(join(sh, 'handoffs/old-pinned.md')));
});
