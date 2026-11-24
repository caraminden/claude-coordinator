import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMerge, toInfo } from '../src/merge-card.ts';

const call = (over = {}) => ({ target: '192', repo: null, method: 'squash', auto: false, admin: false, moved: false, ...over });

test("parseMerge reads the merge in a pipe and ; chain like Delve's", () => {
  const cmd = `gh pr merge 192 --squash --match-head-commit "$(git rev-parse 7b85b69d)" 2>&1 | tail -3; gh pr view 192 --json state,mergeCommit -q '.state+" "+(.mergeCommit.oid // "")[:8]'`;
  assert.deepEqual(parseMerge(cmd), call());
});

test('parseMerge finds the merge anywhere in a chain, after env assignments and redirects', () => {
  assert.deepEqual(parseMerge('cd ~/repo && git fetch -q && GH_PAGER= gh pr merge 7 --rebase -d 2>/dev/null || echo failed'), call({ target: '7', method: 'rebase', moved: true }));
  assert.deepEqual(parseMerge('git push\ngh pr merge "#12" -m > /tmp/out.txt'), call({ target: '12', method: 'merge' }));
  // Unquoted, # starts a comment, so the shell runs a bare `gh pr merge`.
  assert.deepEqual(parseMerge('gh pr merge #12 -m'), call({ target: null, method: null }));
  assert.deepEqual(parseMerge('(cd sub; gh pr merge 3 -sd)'), call({ target: '3', moved: true }));
});

test('parseMerge reads --repo in its forms, and the repo from a PR URL', () => {
  assert.deepEqual(parseMerge('gh pr merge 192 --repo caraminden/gamedevtest --squash'), call({ repo: 'caraminden/gamedevtest' }));
  assert.deepEqual(parseMerge('gh pr merge --squash -R caraminden/gamedevtest 192'), call({ repo: 'caraminden/gamedevtest' }));
  assert.deepEqual(parseMerge('gh pr merge 192 --repo=github.com/o/r -s'), call({ repo: 'o/r' }));
  assert.deepEqual(parseMerge("gh pr merge 'https://github.com/o/r/pull/45' --merge"), call({ target: '45', repo: 'o/r', method: 'merge' }));
  // A value attached to -R, as gh takes it (#468 S06-2).
  assert.deepEqual(parseMerge('gh pr merge 12 -Rother/repo --squash'), call({ target: '12', repo: 'other/repo' }));
  assert.deepEqual(parseMerge('gh pr merge 12 -R=other/repo --squash'), call({ target: '12', repo: 'other/repo' }));
  assert.deepEqual(parseMerge('gh pr merge 12 -sRother/repo'), call({ target: '12', repo: 'other/repo' }));
  assert.equal(parseMerge('gh pr merge 12 -s/R -R o/r'), null, 'a word that is no switch bundle');
  // A URL for one repo with --repo naming another is a contradiction, not a guess.
  assert.equal(parseMerge('gh pr merge https://github.com/o/r/pull/45 --repo o/other'), null);
});

test('parseMerge reads branches, no target, no method, --auto and --admin', () => {
  assert.deepEqual(parseMerge('gh pr merge ticket/77-port-push-guard-fixes --squash --auto'), call({ target: 'ticket/77-port-push-guard-fixes', auto: true }));
  assert.deepEqual(parseMerge('gh pr merge --admin'), call({ target: null, method: null, admin: true }));
  assert.deepEqual(parseMerge('gh pr merge 5 --subject "Fix #4; ship it" --body-file - -s'), call({ target: '5' }));
});

test('parseMerge falls back to the plain card for anything else', () => {
  for (const cmd of [
    'git push origin HEAD',
    'gh pr view 192 --json state',
    'gh pr create --title "gh pr merge"',
    'gh pr merge 1 -s && gh pr merge 2 -s',
    'echo "$(gh pr merge 3 -s)"',
    'gh pr list -q .[].number | xargs -n1 gh pr merge --squash',
    'time gh pr merge 4',
    'gh pr merge $PR --squash',
    'gh pr merge 4 --repo "$REPO"',
    'gh pr merge 4 --squash --rebase',
    'gh pr merge 4 5',
    'gh pr merge "4',
    'gh pr merge 4 --repo',
    'GH_REPO=o/other gh pr merge 5 --squash',
    'export GH_REPO=o/other; gh pr merge 5 -s',
    'env GH_HOST=ghe.example.com gh pr merge 5 -s',
  ])
    assert.equal(parseMerge(cmd), null, cmd);
});

test("toInfo keeps what the card shows from gh pr view, and refuses what isn't a PR", () => {
  const info = toInfo({
    number: 192,
    title: 'Port the guard',
    url: 'https://github.com/o/r/pull/192',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'ticket/77',
    baseRefName: 'main',
    additions: 344,
    deletions: 30,
    changedFiles: 4,
    commits: [{}, {}, {}],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'perf', status: 'COMPLETED', conclusion: 'SKIPPED' },
    ],
  });
  assert.deepEqual(info, { number: 192, title: 'Port the guard', url: 'https://github.com/o/r/pull/192', state: 'OPEN', draft: false, head: 'ticket/77', base: 'main', additions: 344, deletions: 30, files: 4, commits: 3, checks: 'passed' });
  assert.equal(toInfo({ number: 1, title: 't', url: 'javascript:alert(1)', statusCheckRollup: [] })?.url, '');
  assert.equal(toInfo({ number: 1, title: 't', statusCheckRollup: [] })?.checks, null);
  const skipped = { __typename: 'CheckRun', name: 'windows', status: 'COMPLETED', conclusion: 'SKIPPED' };
  assert.equal(toInfo({ number: 1, title: 't', statusCheckRollup: [skipped, { ...skipped, name: 'desktop' }] })?.checks, null, 'all skipped tested nothing (#558)');
  assert.equal(toInfo({ message: 'not found' }), null);
});
