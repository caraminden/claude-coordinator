// A scheme's repo moved on GitHub (#456: FuckSpamTexts went from KatzMeIfYouCan to caraminden): its
// checkout's origin points at the new repo, and the boot brings repo_url, which PR links, repo access
// and CI key on, in line with it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { followOrigins } from '../src/scheme-repo.ts';

const root = mkdtempSync(join(tmpdir(), 'follow-origin-'));
after(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string, origin: string | null): string {
  const dir = join(root, name);
  execFileSync('git', ['init', '--quiet', dir]);
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
  return dir;
}

test('repo_url follows a checkout whose GitHub origin moved, and only that', async () => {
  const store = new Store(':memory:');
  const scheme = (name: string, url: string | null, origin: string | null, githubError: string | null = null) => {
    const p = store.createProject(name, url);
    store.setProjectRepoDir(p.id, repo(name, origin));
    if (githubError) store.setProjectUpstream(p.id, url, githubError);
    return p.id;
  };
  const moved = scheme('moved', 'https://github.com/KatzMeIfYouCan/fuckspamtexts', 'https://github.com/caraminden/fuckspamtexts.git');
  const same = scheme('same', 'https://github.com/caraminden/peek-auras.git', 'https://github.com/CaraMinden/peek-auras');
  const notGithub = scheme('not-github', 'https://github.com/caraminden/a', 'https://gitlab.com/caraminden/a.git');
  const withToken = scheme('with-token', 'https://github.com/caraminden/b', 'https://x-access-token:secret@github.com/someone/b.git');
  const noOrigin = scheme('no-origin', 'https://github.com/caraminden/c', null);
  const failedCreate = scheme('failed-create', null, 'https://github.com/caraminden/d.git', 'gh said no');
  const unchanged = new Map(store.listProjects().map((p) => [p.id, p]));

  await followOrigins(store);

  assert.equal(store.getProject(moved)!.repo_url, 'https://github.com/caraminden/fuckspamtexts.git');
  // A GitHub origin means the repo exists: an old "couldn't create it" error is stale.
  assert.deepEqual([store.getProject(failedCreate)!.repo_url, store.getProject(failedCreate)!.github_error], ['https://github.com/caraminden/d.git', null]);
  // Same repo in another spelling, an origin off GitHub or carrying a login, or none at all: left alone.
  for (const id of [same, notGithub, withToken, noOrigin]) assert.deepEqual(store.getProject(id), unchanged.get(id));
});
