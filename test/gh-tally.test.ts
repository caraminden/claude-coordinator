// #1722: the server's GitHub reads and posts are tallied by the shape of their path, a 304 apart (GitHub doesn't count
// it against the login's hour), so the next "API rate limit exceeded" says which poller spent the quota.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GhTally, ghGet, ghPost, ghTally, pathShape } from '../src/gh-api.ts';

test('a path keeps its repo and its query names, not run ids or values', () => {
  assert.equal(pathShape('repos/o/r/actions/runs?head_sha=abc123&per_page=20'), 'repos/o/r/actions/runs?head_sha&per_page');
  assert.equal(pathShape('repos/o/r/actions/runs/123456/jobs'), 'repos/o/r/actions/runs/N/jobs');
  assert.equal(pathShape('/repos/o/r/actions/workflows/tests.yml/runs?branch=main'), 'repos/o/r/actions/workflows/tests.yml/runs?branch');
  assert.equal(pathShape('repos/o/r/commits/0123456789abcdef0123456789abcdef01234567/pulls'), 'repos/o/r/commits/SHA/pulls');
});

test('the report counts what cost quota and what came back 304, busiest first, and starts afresh', () => {
  const t = new GhTally();
  assert.equal(t.report(), null, 'nothing asked: nothing to say');
  for (let i = 0; i < 3; i++) t.add('repos/o/r/actions/runs?status=in_progress', 200);
  t.add('repos/o/r/actions/runs?status=in_progress', 304);
  t.add('repos/o/r/actions/runs/5/jobs', 200);
  t.add('repos/o/r/actions/runs/6/jobs', 404);
  t.add('repos/o/r/actions/workflows', 304);
  t.add('repos/o/r/actions/workflows', 304);
  assert.equal(
    t.report(),
    '5 counted, 3 free (304): repos/o/r/actions/runs?status 3+1 free, repos/o/r/actions/runs/N/jobs 2, repos/o/r/actions/workflows 0+2 free',
  );
  assert.equal(t.report(), null, 'a report starts the next one empty');
});

test('a report names at most its busiest few paths', () => {
  const t = new GhTally();
  for (let i = 0; i < 12; i++) for (let k = 0; k <= i; k++) t.add(`repos/o/r/p${i}`, 200);
  const r = t.report(3)!;
  assert.match(r, /^78 counted, 0 free \(304\): repos\/o\/r\/p11 12, repos\/o\/r\/p10 11, repos\/o\/r\/p9 10, and 9 more paths 45$/);
});

test('the server\'s reads and posts land in its tally: a 304 free, every other answer counted', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'gh-tally-'));
  try {
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *If-None-Match*) printf 'HTTP/2.0 304 Not Modified\\r\\n\\r\\n'; exit 1 ;;
  *) printf 'HTTP/2.0 200 OK\\r\\n\\r\\n{}' ;;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const as = { PATH: `${bin}:${process.env.PATH}` };
    ghTally.report();
    assert.equal((await ghGet('repos/o/r/actions/runs/7', null, as)).status, 200);
    assert.equal((await ghGet('repos/o/r/actions/runs/8', 'W/"e"', as)).status, 304);
    assert.equal((await ghPost('repos/o/r/actions/runs/7/rerun', as)).status, 200);
    assert.equal(ghTally.report(), '2 counted, 1 free (304): repos/o/r/actions/runs/N 1+1 free, repos/o/r/actions/runs/N/rerun 1');
  } finally {
    rmSync(bin, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});
