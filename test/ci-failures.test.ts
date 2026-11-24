import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// tools/ci-failures (#644) against a fake gh that answers from a recorded red run (test/ci-failures.fixture.log is
// gh's --log-failed output for run 43388018762, cut down): no network.
const tool = join(import.meta.dirname, '..', 'tools', 'ci-failures');
const dir = mkdtempSync(join(tmpdir(), 'ci-failures-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const run = (id: number, conclusion: string, branch = 'land/ticket/628-releases-page-feedback') => ({
  id,
  name: 'tests',
  head_branch: branch,
  head_sha: 'a972a3d1b5c0ffee',
  status: 'completed',
  conclusion,
  run_attempt: 1,
  created_at: '2026-11-13T07:45:24Z',
  updated_at: '2026-11-13T07:46:45Z',
  html_url: `https://github.com/o/r/actions/runs/${id}`,
});
const jobs = (conclusion: string) => ({
  jobs: [
    {
      name: 'test',
      conclusion,
      started_at: '2026-11-13T07:45:26Z',
      completed_at: '2026-11-13T07:46:43Z',
      steps: [
        { name: 'actions/checkout@v4', conclusion: 'success' },
        { name: 'the full suite', conclusion },
      ],
    },
  ],
});
const answers: Record<string, unknown> = {
  'api repos/o/r/actions/runs/1': run(1, 'failure'),
  'api repos/o/r/actions/runs/1/jobs?per_page=100': jobs('failure'),
  'api repos/o/r/actions/runs/2': run(2, 'success'),
  'api repos/o/r/actions/runs/2/jobs?per_page=100': jobs('success'),
  'api repos/o/r/actions/runs?per_page=20': { workflow_runs: [run(2, 'success'), run(1, 'failure')] },
  'api repos/o/r/actions/runs/1/jobs': jobs('failure'),
  'api repos/o/r/actions/runs/2/jobs': jobs('success'),
};
writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers));
const gh = join(dir, 'gh');
writeFileSync(
  gh,
  `#!${process.execPath}
const { readFileSync } = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (args === 'run view 1 -R o/r --log-failed') process.stdout.write(readFileSync(${JSON.stringify(join(import.meta.dirname, 'ci-failures.fixture.log'))}));
else {
  const answer = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'answers.json'))}, 'utf8'))[args];
  if (answer === undefined) { process.stderr.write('gh: no fake answer for ' + args + '\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(answer));
}
`,
);
chmodSync(gh, 0o755);
const ci = (...args: string[]) => spawnSync(tool, ['-R', 'o/r', ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir } });

test('a red run: its line, the failed step, each failed test with its message and diff, and nothing else', () => {
  const r = ci('1');
  assert.equal(r.stderr, '');
  assert.equal(r.status, 1);
  assert.equal(
    r.stdout,
    `✖ run 1 failure · tests · land/ticket/628-releases-page-feedback a972a3d1 · Nov 12 23:45 PST · queued 2s, ran 1m17s · https://github.com/o/r/actions/runs/1
✖ job test failure, step "the full suite" failure

2 failing tests:
test at test/chained-minions.test.ts:207:1
✖ a feeder folded into its build and dismissed is merged for a chain, and live once the build lands (160.007195ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  0 !== 1

      at TestContext.<anonymous> (test/chained-minions.test.ts:222:10)

test at test/chained-minions.test.ts:382:1
✖ a chained minion's brief stays held until its start sends it: a start that never gets there isn't repeated, and runs again after a restart (#468 S04-5) (185.243483ms)
  AssertionError [ERR_ASSERTION]: the brief is still stored
  + actual - expected

    [
      'build part two',
  +   'build part two',
  +   'build part two'
    ]

      at TestContext.<anonymous> (test/chained-minions.test.ts:390:10)

run-tests: 1 test file(s) failed; rerunning each alone once to tell load from a real failure (the run fails either way; output in /opt/actions-runner-claude-coordinator/_work/_temp/tests-rerun.log)
run-tests: test/chained-minions.test.ts: failed in the full run, passed alone: likely load, not your change (1-minute load 5.90)
run-tests: the run still fails: a rerun only labels flakes, it never turns a red run green

full log: ${join(dir, 'ci-1.log')}
`,
  );
  // The saved log is the whole of it, cleaned: no timestamps, escape codes or job and step columns.
  const saved = readFileSync(join(dir, 'ci-1.log'), 'utf8');
  assert.match(saved, /^Current runner version: '2.338.2'\nRunner name/);
  assert.match(saved, /generatedMessage: true/);
  assert.doesNotMatch(saved, /\d{4}-\d\d-\d\dT[\d:.]+Z|\^\[|\x1b|UNKNOWN STEP|﻿/);
  assert.equal(ci('1', '--full').stdout.includes('ps -u "$(id -u)"'), true, '--full prints it all');
});

test('a green run is one line', () => {
  const r = ci('2');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '✔ run 2 success · tests · land/ticket/628-releases-page-feedback a972a3d1 · Nov 12 23:45 PST · queued 2s, ran 1m17s · https://github.com/o/r/actions/runs/2\n');
});

test('--list: one line a run, with queued and run times', () => {
  const r = ci('--list');
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.split('\n'), ['2  success    a972a3d1  Nov 12 23:45 PST  queued    2s  ran  1m17s  land/ticket/628-releases-page-feedback', '1  failure    a972a3d1  Nov 12 23:45 PST  queued    2s  ran  1m17s  land/ticket/628-releases-page-feedback', '']);
});

test('gh failing is exit 2 with what gh said', () => {
  const r = ci('3');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^ci-failures: gh api repos\/o\/r\/actions\/runs\/3 failed: gh: no fake answer/);
});
