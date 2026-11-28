// Regenerated files (#1827) on tools/land.sh: the cases both ship scripts share are in regenerate-cases.ts; these are
// the ones only Citadel's says or has.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, git, setup } from './land-fixture.ts';
import { copyLand } from './land-files.ts';
import { FMT, declare, regenerateCases, write as writeWith } from './regenerate-cases.ts';
import { test } from 'node:test';

const side = {
  name: 'tools/land.sh',
  git,
  setup: () => {
    const r = setup();
    return { ...r, main: r.source, check: () => r.run({}, ['--check']) };
  },
  making: /making \*\.txt again on main \([0-9a-f]+\): for f in/,
  failed: /the Regenerate command `.*exit 4` failed \(exit 4\) on main \([0-9a-f]+\), so nothing landed and what it wrote was put back\. Its output ended: formatter broke/,
  outside: /changed files outside Regenerate-files \(\*\.txt\): (made\.log notes\.md|notes\.md made\.log), so nothing landed/,
};
regenerateCases(side);

const write = (where: string, files: Record<string, string>, msg: string, body?: string) => writeWith(git, where, files, msg, body);
const show = (r: { source: string }, ref: string, f: string) => git(r.source, 'show', `${ref}:${f}`);

// Citadel's only: the template has no hand-over to a newer land.sh a rebase brings (#500).
test('a declared commit the rebase empties still ships its command when the rebase brought a newer land.sh, which runs over', () => {
  // The branch's only commit formats a.txt, and main changed a.txt: the driver takes main's side, the commit drops out of
  // the rebase, and land.sh starts over as the rebased copy. The trailers come from the branch as it was before the rebase.
  const r = setup();
  const tools = join(import.meta.dirname, '..', 'tools');
  for (const f of readdirSync(tools, { withFileTypes: true })) if (f.isFile() && f.name !== 'deploy.sh') copyFileSync(join(tools, f.name), join(r.source, 'tools', f.name));
  copyLand(join(r.source, 'tools'), tools);
  write(r.source, {}, 'the real tools');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  write(r.wt, { 'a.txt': 'ONE\n' }, '#1: format a.txt', declare(FMT, '*.txt'));
  write(r.source, { 'a.txt': 'one\ntwo\n' }, 'a.txt: two');
  write(r.source, { 'tools/land.sh': readFileSync(join(r.source, 'tools', 'land.sh'), 'utf8') + '# newer\n' }, 'a newer land.sh');
  const res = spawnSync('bash', [join(r.wt, 'tools', 'land.sh')], { cwd: r.wt, encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note') } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(show(r, 'main', 'a.txt'), 'ONE\nTWO');
  assert.equal(git(r.source, 'log', '-1', '--format=%s', 'main'), `#1: regenerated at ship time: ${FMT}`);
});
