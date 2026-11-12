// The build headers' counts (src/builds.ts, #592): feeders merged in and open, and commits behind main, all from git.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Builds, buildSummaries } from '../src/builds.ts';
import { buildOwnerKey, Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'builds-'));
after(() => rmSync(root, { recursive: true, force: true }));
const repo = join(root, 'repo');
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
let n = 0;
const commit = () => {
  writeFileSync(join(repo, `f${++n}`), String(n));
  git('add', '-A');
  git('commit', '-q', '-m', `c${n}`);
  return git('rev-parse', 'HEAD');
};
commit();

const store = new Store(join(root, 'coordinator.db'));
const p = store.createProject('Scheme', null);
store.setProjectRepoDir(p.id, repo);
/** A minion in `build` on its own branch cut from `from`, with `commits` of its own. */
function minion(build: number | null, from: string, commits: number, status: 'idle' | 'closed' = 'idle') {
  const t = store.createTicket({ project_id: p.id, title: 'm', permission_mode: 'default', created_by: 'Cara' });
  const branch = `ticket/${t.id}`;
  git('checkout', '-q', '-b', branch, from);
  for (let i = 0; i < commits; i++) commit();
  git('checkout', '-q', 'main');
  store.setTicketDir(t.id, join(root, branch), branch);
  store.updateTicket(t.id, { build, status });
  return { ...t, branch };
}
const fold = (t: { branch: string }) => git('update-ref', 'refs/heads/build/7', git('rev-parse', t.branch));

test('no build branch, no headers: the build label alone (Delve) changes nothing', async () => {
  minion(7, 'main', 1);
  assert.deepEqual(await buildSummaries(store, p.id), []);
});

test('a build branch counts its feeders merged in and open, not its owner, and how far main is ahead', async () => {
  git('branch', 'build/7', 'main');
  const owner = minion(7, 'build/7', 0);
  store.setSetting(buildOwnerKey(p.id, 7), owner.id);
  const a = minion(7, 'build/7', 2);
  fold(a);
  const d = minion(7, 'build/7', 1, 'closed'); // folded in, then closed as "folded into Build 7"
  git('checkout', '-q', d.branch);
  git('rebase', '-q', 'build/7');
  git('checkout', '-q', 'main');
  fold(d);
  minion(7, 'build/7', 0); // just started: nothing of its own, so not "merged" though build/7 contains its tip
  minion(7, 'build/7', 1, 'closed'); // dismissed without merging in: neither
  minion(8, 'main', 1); // another build, without a branch
  commit();
  commit();
  assert.deepEqual(await buildSummaries(store, p.id), [{ build: 7, merged: 2, open: 2, behind: 2, owner: owner.id }]);
});

test('Builds broadcasts a scheme\'s headers when they change, and only then', async () => {
  const sent: any[] = [];
  const b = new Builds({ store, broadcast: (m) => sent.push(m) });
  await b.poll();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'builds');
  assert.equal(b.get(p.id)[0].behind, 2);
  await b.refresh(p.id);
  assert.equal(sent.length, 1, 'unchanged');
  commit();
  await b.refresh(p.id);
  assert.equal(sent.length, 2);
  assert.equal(b.get(p.id)[0].behind, 3);
});
