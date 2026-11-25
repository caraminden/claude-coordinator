import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BEGIN, END, commandLine, commandOutput, slugOf } from '../tools/heavy-ci.ts';

// citadel-heavy on the scheme's CI (#1160): tools/heavy-ci.ts's parsers, then the whole path through tools/citadel-heavy
// against a fake `gh` and a local bare repo standing in for GitHub.
test('slugOf reads github.com remotes only', () => {
  assert.equal(slugOf('https://github.com/caraminden/claude-coordinator'), 'caraminden/claude-coordinator');
  assert.equal(slugOf('https://x-access-token@github.com/o/r.git'), 'o/r');
  assert.equal(slugOf('git@github.com:o/peek-auras.git'), 'o/peek-auras');
  assert.equal(slugOf('/srv/git/r.git'), null);
  assert.equal(slugOf('https://gitlab.com/o/r'), null);
});

test("a turn's copy of heavy-ci.ts runs alone, with no src/ beside it (src/turn-launch.ts)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-alone-'));
  try {
    writeFileSync(join(dir, 'heavy-ci.ts'), readFileSync(join(import.meta.dirname, '../tools/heavy-ci.ts')));
    const r = spawnSync(process.execPath, [join(dir, 'heavy-ci.ts'), '--repo'], { cwd: dir, encoding: 'utf8' });
    assert.match(r.stderr, /not a git checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commandLine quotes for bash, and commandOutput takes the lines between the markers with the status', () => {
  assert.equal(commandLine(['cargo', 'test', '--workspace']), 'cargo test --workspace');
  assert.equal(commandLine(['sh', '-c', "echo 'a b'"]), `sh -c 'echo '\\''a b'\\'''`);
  const ts = (l: string) => `2026-11-20T10:00:00.1234567Z ${l}`;
  const log = ['﻿' + ts('##[group]Run actions/checkout@v4'), ts(BEGIN), ts('one'), ts(''), ts('two'), ts(`${END}3 ===`), ts('##[error]Process completed with exit code 3.')].join('\r\n');
  assert.deepEqual(commandOutput(log), { lines: ['one', '', 'two'], code: 3 });
  assert.deepEqual(commandOutput([ts(BEGIN), ts('half')].join('\n')), { lines: ['half'], code: null });
  assert.deepEqual(commandOutput(ts('nothing')), { lines: [], code: null });
  // CB3 (#1519): output with no newline at its end. A workflow copied before the fix ends it mid-line; the fixed one
  // prints a newline first, and that added line goes again.
  assert.deepEqual(commandOutput([ts(BEGIN), ts('one'), ts(`no newline${END}0 ===`), ts('Post job cleanup.')].join('\n')), { lines: ['one', 'no newline'], code: 0 });
  assert.deepEqual(commandOutput([ts(BEGIN), ts('done'), ts(''), ts(`${END}0 ===`)].join('\n')), { lines: ['done'], code: 0 });
});

// CB3 (#1519): the workflow's own step, Citadel's and the kit template's, run with a command whose output has no newline
// at its end: the end marker still comes on a line of its own, so the status reads.
test("both citadel-heavy workflows' command step keeps the end marker readable after output with no trailing newline", () => {
  for (const f of ['.github/workflows/citadel-heavy.yml', 'kit/skills/scheme-setup/templates/citadel-heavy.yml']) {
    const yml = readFileSync(join(import.meta.dirname, '..', f), 'utf8');
    const step = /- name: the command\n(?:.*\n)*?\s+run: \|\n((?:\s{10}.*\n|\n)+)/.exec(yml);
    assert.ok(step, f);
    const script = step[1].replace(/^ {10}/gm, '');
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, COMMAND: 'printf "last words"; exit 4' } });
    assert.equal(res.status, 4, f);
    const log = res.stdout
      .split('\n')
      .map((l) => `2026-11-20T10:00:00Z ${l}`)
      .join('\n');
    assert.deepEqual(commandOutput(log), { lines: ['last words'], code: 4 }, f);
  }
});

const root = mkdtempSync(join(tmpdir(), 'heavy-ci-'));
after(() => rmSync(root, { recursive: true, force: true }));
const heavy = join(import.meta.dirname, '..', 'tools', 'citadel-heavy');
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

// A fake gh: the API calls heavy-ci.ts makes, a run that goes queued -> in_progress -> completed (or stays queued), a
// job log with the markers. It keeps what it was sent in its folder.
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.FAKE_GH_DIR, mode = process.env.FAKE_GH_MODE || 'ok';
const a = process.argv.slice(2).filter((x) => x !== 'api' && x !== '--allow-escape-sequences');
const escapes = process.argv.includes('--allow-escape-sequences');
const post = a[0] === '-X' ? a.splice(0, 2)[1] : '';
const url = a.shift();
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const state = path.join(dir, 'dispatch.json');
const id = () => JSON.parse(fs.readFileSync(state, 'utf8'))['inputs[id]'];
if (/^repos\\/o\\/r$/.test(url)) out({ default_branch: 'main' });
else if (url.endsWith('/dispatches')) {
  if (mode === 'refuse') { process.stderr.write('HTTP 404: Not Found\\n'); process.exit(1); }
  const f = {}; for (let i = 0; i < a.length; i += 2) { const [k, ...v] = a[i + 1].split('='); f[k] = v.join('='); }
  f.shipLooks = fs.existsSync(path.join(dir, 'ship-looks')) ? fs.readFileSync(path.join(dir, 'ship-looks'), 'utf8') : '0';
  fs.writeFileSync(state, JSON.stringify(f));
} else if (url.includes('/workflows/citadel-heavy.yml/runs')) {
  // mode late: the run shows only from the 9th look; lost: never.
  const f = path.join(dir, 'finds'), k = Number(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 0) + 1;
  fs.writeFileSync(f, String(k));
  const hidden = mode === 'lost' || (mode === 'late' && k < 9);
  out({ workflow_runs: fs.existsSync(state) && !hidden ? [{ id: 7, display_title: 'heavy ' + id() }] : [] });
}
else if (url.includes('/actions/runs?status=')) {
  // mode ship: a ship's run is queued for the first three looks, then gone; each look is counted, and the dispatch notes the count.
  const f = path.join(dir, 'ship-looks'), n = Number(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 0) + (url.includes('status=queued') ? 1 : 0);
  fs.writeFileSync(f, String(n));
  const ship = mode === 'ship' && url.includes('status=queued') && n <= 3 ? [{ head_branch: 'land/ticket/1-x', created_at: new Date().toISOString() }] : [];
  out({ total_count: mode === 'busy' && url.includes('in_progress') ? 1 : ship.length, workflow_runs: ship });
}
else if (url.endsWith('/runs/7/cancel')) fs.writeFileSync(path.join(dir, 'cancelled'), '');
else if (url.endsWith('/runs/7') && mode === 'held') {
  // mode held: stopped at the 2nd look, queued again at the 5th (Citadel started it again), then done.
  const n = Number(fs.existsSync(path.join(dir, 'polls')) ? fs.readFileSync(path.join(dir, 'polls'), 'utf8') : 0) + 1;
  fs.writeFileSync(path.join(dir, 'polls'), String(n));
  const status = ['in_progress', 'completed', 'completed', 'completed', 'queued', 'in_progress'][n - 1] ?? 'completed';
  if (n === 7) fs.rmSync(path.join(dir, 'locks', 'long', 'hold.json'));
  out({ id: 7, status, conclusion: status === 'completed' ? (n > 6 ? 'failure' : 'cancelled') : null, html_url: 'https://github.com/o/r/actions/runs/7' });
} else if (url.endsWith('/runs/7')) {
  const n = Number(fs.existsSync(path.join(dir, 'polls')) ? fs.readFileSync(path.join(dir, 'polls'), 'utf8') : 0) + 1;
  fs.writeFileSync(path.join(dir, 'polls'), String(n));
  // mode skip: queued, then completed at the next look, never seen in progress.
  const status = mode === 'queued' || (mode === 'busy' && n < 12) ? 'queued' : mode === 'busy' ? 'completed' : mode === 'skip' ? (n < 2 ? 'queued' : 'completed') : ['queued', 'in_progress'][n - 1] ?? 'completed';
  out({ id: 7, status, conclusion: status === 'completed' ? 'failure' : null, html_url: 'https://github.com/o/r/actions/runs/7' });
} else if (/\\/runs\\/7\\/jobs$|\\/jobs\\/9\\/logs$/.test(url) && (mode === 'skip' || (mode === 'blip' && !fs.existsSync(path.join(dir, 'blip-' + url.split('/').pop()))))) {
  // mode blip: the first read of the jobs and of the log each fail once; skip: the jobs never read.
  fs.writeFileSync(path.join(dir, 'blip-' + url.split('/').pop()), '');
  process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1);
} else if (url.endsWith('/runs/7/jobs')) out({ jobs: [{ id: 9, runner_name: mode === 'queued' ? null : 'ci-r-1', started_at: '2026-11-20T10:00:00Z', completed_at: '2026-11-20T10:00:' + (process.env.FAKE_GH_TOOK || '00') + 'Z' }] });
else if (url.endsWith('/jobs/9/logs') && !escapes) { process.stderr.write('the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway\\n'); process.exit(1); }
else if (url.endsWith('/jobs/9/logs')) out(['2026-11-20T10:00:00Z \x1b[36;1mset -e\x1b[0m', '2026-11-20T10:00:01Z ${BEGIN}', '2026-11-20T10:00:02Z hello from CI', '2026-11-20T10:00:03Z ${END}3 ==='].join('\\n'));
else { process.stderr.write('fake gh: no ' + url + '\\n'); process.exit(1); }
`;
const bin = join(root, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'gh'), fakeGh);
chmodSync(join(bin, 'gh'), 0o755);

let n = 0;
function repo(workflow = true) {
  const d = join(root, `r${n++}`);
  const bare = `${d}-github.git`;
  spawnSync('git', ['init', '-q', '--bare', bare]);
  mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@t');
  git(d, 'config', 'user.name', 't');
  if (workflow) writeFileSync(join(d, '.github', 'workflows', 'citadel-heavy.yml'), 'name: citadel-heavy\n');
  writeFileSync(join(d, 'a.txt'), 'committed\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'one');
  git(d, 'remote', 'add', 'origin', 'https://github.com/o/r');
  git(d, 'config', `url.${bare}.pushInsteadOf`, 'https://github.com/o/r');
  writeFileSync(join(d, 'a.txt'), 'edited, not committed\n');
  writeFileSync(join(d, 'new.txt'), 'untracked\n');
  const gh = join(root, `gh${n}`);
  mkdirSync(gh);
  return { d, bare, gh };
}
const run = (r: ReturnType<typeof repo>, mode: string, extra: NodeJS.ProcessEnv = {}, cwd = r.d) =>
  spawnSync(heavy, ['sh', '-c', 'echo ran here; exit 5'], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_GH_DIR: r.gh,
      FAKE_GH_MODE: mode,
      CITADEL_HEAVY_DIR: join(r.gh, 'locks'),
      CITADEL_HEAVY_HELD: undefined,
      CITADEL_HEAVY_HERE: undefined,
      CITADEL_HEAVY_PRIORITY: undefined,
      CITADEL_HEAVY_CI_POLL: '0.05',
      CITADEL_HEAVY_PRESSURE: join(root, 'no-psi'),
      CITADEL_HEAVY_JUDGE: undefined,
      CITADEL_HEAVY_GUESS: 'heavy',
      CITADEL_HEAVY_WHO: 'Peek #9',
      ...extra,
    },
  });

test('a job runs the working copy on CI, prints its output, exits with its status and leaves the branch alone', () => {
  const r = repo();
  const before = git(r.d, 'status', '--porcelain');
  const res = run(r, 'ok');
  assert.equal(res.status, 3, res.stderr);
  assert.equal(res.stdout, 'hello from CI\n');
  assert.doesNotMatch(res.stdout, /ran here/);
  assert.match(res.stderr, /running on o\/r's CI, not here: https:\/\/github.com\/o\/r\/actions\/runs\/7/);
  const sent = JSON.parse(readFileSync(join(r.gh, 'dispatch.json'), 'utf8'));
  assert.equal(sent.ref, 'main');
  assert.equal(sent['inputs[command]'], `sh -c 'echo ran here; exit 5'`);
  assert.equal(git(r.bare, 'show', `${sent['inputs[sha]']}:a.txt`), 'edited, not committed', 'the snapshot has the uncommitted edit');
  assert.equal(git(r.bare, 'show', `${sent['inputs[sha]']}:new.txt`), 'untracked');
  assert.equal(git(r.bare, 'for-each-ref'), '', 'the scratch ref is gone again');
  assert.equal(git(r.d, 'status', '--porcelain'), before, 'the branch and index are as they were');
  assert.equal(git(r.d, 'rev-list', '--count', 'HEAD'), '1');
  const line = readFileSync(join(r.gh, 'locks', 'history'), 'utf8')
    .trim()
    .split('\t');
  assert.deepEqual([line[1], line[3], line[6]], ['Peek #9', 'ci:o/r', '3']);
});

// Peek's pre-push hook runs its whole check.sh and failed every snapshot push, so its jobs always ran on perigee (#1254).
test("the repo's own pre-push hook doesn't stop the snapshot push or its clean-up: the job still runs on CI", () => {
  const r = repo();
  const hooks = join(r.d, '.git', 'hooks');
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\necho "warning: tools/land.sh has 1662 lines" >&2\nexit 1\n');
  chmodSync(join(hooks, 'pre-push'), 0o755);
  const res = run(r, 'ok');
  assert.equal(res.status, 3, res.stderr);
  assert.match(res.stderr, /running on o\/r's CI, not here/);
  assert.doesNotMatch(res.stdout, /ran here/);
  assert.equal(git(r.bare, 'for-each-ref'), '', 'the scratch ref is gone again');
});

test('a job no runner takes is cancelled on CI and runs here instead', () => {
  const r = repo();
  const res = run(r, 'queued', { CITADEL_HEAVY_CI_QUEUE: '0.3' });
  assert.equal(res.status, 5, res.stderr);
  assert.equal(res.stdout, 'ran here\n');
  assert.ok(existsSync(join(r.gh, 'cancelled')), 'the queued run is cancelled, so it never runs twice');
  assert.match(res.stderr, /no runner took the job/);
  assert.equal(git(r.bare, 'for-each-ref'), '');
});

test('without the workflow, or when GitHub refuses the dispatch, it runs here and says why', () => {
  const none = run(repo(false), 'ok');
  assert.equal(none.status, 5);
  assert.equal(none.stdout, 'ran here\n');
  assert.match(none.stderr, /not on CI: this repo has no \.github\/workflows\/citadel-heavy\.yml/);
  const r = repo();
  const refused = run(r, 'refuse');
  assert.equal(refused.status, 5);
  assert.match(refused.stderr, /starting the workflow: HTTP 404/);
  assert.equal(git(r.bare, 'for-each-ref'), '', 'the snapshot ref is deleted');
  const here = run(repo(), 'ok', { CITADEL_HEAVY_HERE: '1' });
  assert.equal(here.stdout, 'ran here\n', 'CITADEL_HEAVY_HERE keeps it on perigee');
});

test('busy runners keep the job waiting on CI: it never comes back to perigee', () => {
  const r = repo();
  const res = run(r, 'busy', { CITADEL_HEAVY_CI_QUEUE: '0.1' });
  assert.equal(res.status, 3, res.stderr);
  assert.equal(res.stdout, 'hello from CI\n');
  assert.ok(!existsSync(join(r.gh, 'cancelled')));
});

// HE3 (#1863): the light/heavy judge reads the run column, and a quick job that waited long for a runner read as a long one.
test("a CI job's history line counts its wait for a runner as waiting, and only the runner's time on it as its run", () => {
  const r = repo();
  const at = (t: string) => {
    assert.equal(run(r, 'busy', { CITADEL_HEAVY_CI_POLL: '0.2', FAKE_GH_TOOK: t, CITADEL_HEAVY_CI_QUEUE: '60' }).status, 3);
    rmSync(join(r.gh, 'polls'));
    return readFileSync(join(r.gh, 'locks', 'history'), 'utf8')
      .trim()
      .split('\n')
      .at(-1)!
      .split('\t')
      .slice(4, 6)
      .map(Number);
  };
  const [wait, ran] = at('01');
  assert.equal(ran, 1, 'the second the runner worked on it');
  assert.ok(wait >= 1, `it waited ${wait} s`);
  const [, odd] = at('59');
  assert.ok(odd < 59, 'never more than the time that passed here');
});

test("a ship's CI run goes first: a new heavy job waits for it before it is dispatched, and never runs on perigee", () => {
  const r = repo();
  const res = run(r, 'ship', { CITADEL_HEAVY_CI_POLL: '0.05' });
  assert.equal(res.status, 3, res.stderr);
  assert.equal(res.stdout, 'hello from CI\n');
  assert.equal(JSON.parse(readFileSync(join(r.gh, 'dispatch.json'), 'utf8')).shipLooks, '4', 'dispatched only once the ship run was gone');
  assert.match(res.stderr, /waiting for 1 ship run\(s\) on CI/);
});

test("a ship run that never ends holds the job only up to the limit, then it goes to CI's queue", () => {
  const r = repo();
  const res = run(r, 'ship', { CITADEL_HEAVY_SHIP_WAIT: '0.01' });
  assert.equal(res.status, 3, res.stderr);
  assert.match(res.stderr, /starting anyway/);
});

test('from a subfolder it runs there on CI, with every edit in the repo and no untracked secrets', () => {
  const r = repo();
  mkdirSync(join(r.d, 'sub dir'));
  writeFileSync(join(r.d, 'sub dir', 'b.txt'), 'b\n');
  writeFileSync(join(r.d, '.env'), 'TOKEN=x\n');
  writeFileSync(join(r.d, 'sub dir', 'deploy.pem'), 'key\n');
  const res = run(r, 'ok', {}, join(r.d, 'sub dir'));
  assert.equal(res.status, 3, res.stderr);
  const sent = JSON.parse(readFileSync(join(r.gh, 'dispatch.json'), 'utf8'));
  assert.equal(sent['inputs[command]'], `cd 'sub dir/' && sh -c 'echo ran here; exit 5'`);
  assert.equal(git(r.bare, 'show', `${sent['inputs[sha]']}:a.txt`), 'edited, not committed', 'an edit outside the folder goes too');
  assert.equal(git(r.bare, 'show', `${sent['inputs[sha]']}:sub dir/b.txt`), 'b');
  assert.equal(
    git(r.bare, 'ls-tree', '-r', '--name-only', sent['inputs[sha]'])
      .split('\n')
      .filter((f) => /\.env|\.pem/.test(f)).length,
    0,
    'no .env or key file pushed',
  );
});

// Long jobs (#1363): --long only queues; the server's pump (src/long-jobs.ts, test/long-jobs.test.ts) starts and watches them.
test('--long pushes the snapshot, writes the job for the server and returns at once without dispatching', () => {
  const r = repo();
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_DIR: r.gh, CITADEL_HEAVY_DIR: join(r.gh, 'locks'), CITADEL_HEAVY_HERE: undefined, CITADEL_HEAVY_JUDGE: undefined, CITADEL_HEAVY_GUESS: 'heavy', CITADEL_HEAVY_WHO: 'Peek #9 (cara)', COORDINATOR_TICKET: '42' };
  const res = spawnSync(heavy, ['--long', 'sh', '-c', 'echo ran here; exit 5'], { cwd: r.d, encoding: 'utf8', timeout: 30_000, env });
  assert.equal(res.status, 0, res.stderr);
  const id = res.stdout.trim();
  assert.match(id, /^[a-z0-9]+-\d+-[a-z0-9]+$/);
  assert.match(res.stderr, /end your turn/);
  assert.ok(!existsSync(join(r.gh, 'dispatch.json')), 'nothing is dispatched yet');
  const job = JSON.parse(readFileSync(join(r.gh, 'locks', 'long', `${id}.json`), 'utf8'));
  assert.deepEqual([job.ticket, job.slug, job.state, job.who, job.command], [42, 'o/r', 'queued', 'Peek #9 (cara)', `sh -c 'echo ran here; exit 5'`]);
  assert.equal(git(r.bare, 'show', `refs/citadel-heavy/${id}:a.txt`), 'edited, not committed', 'the snapshot stays on GitHub for the run');
  assert.equal(git(r.bare, 'rev-parse', `refs/citadel-heavy/${id}`), job.sha);
  assert.doesNotMatch(res.stdout, /ran here/);

  const noTicket = spawnSync(heavy, ['--long', 'true'], { cwd: r.d, encoding: 'utf8', timeout: 30_000, env: { ...env, COORDINATOR_TICKET: undefined } });
  assert.equal(noTicket.status, 2, 'only a minion can queue one: nobody else could be woken');
  const here = spawnSync(heavy, ['--here', '--long', 'true'], { cwd: r.d, encoding: 'utf8', timeout: 30_000, env });
  assert.equal(here.status, 2);
  const none = spawnSync(heavy, ['--long', 'true'], { cwd: repo(false).d, encoding: 'utf8', timeout: 30_000, env });
  assert.equal(none.status, 2, 'a repo without the workflow cannot take long jobs');
  const huge = spawnSync(heavy, ['--long', 'echo', 'x'.repeat(20_001)], { cwd: r.d, encoding: 'utf8', timeout: 30_000, env });
  assert.equal(huge.status, 2, 'a command the server would drop is refused, not queued to wait forever');
  assert.match(huge.stderr, /at most 20000/);
});

// CB1 (#1519): one failed read of the job or its log is tried again, not the run reported lost; and once the run has
// completed the command never runs here as well, even when it went queued to completed between two looks.
test('a blip reading the job or its log is tried again, and a run that completed is never run here too', () => {
  const blip = run(repo(), 'blip');
  assert.equal(blip.status, 3, blip.stderr);
  assert.equal(blip.stdout, 'hello from CI\n');
  const r = repo();
  const skip = run(r, 'skip');
  assert.equal(skip.status, 1, skip.stderr);
  assert.doesNotMatch(skip.stdout, /ran here/);
  assert.doesNotMatch(skip.stderr, /running it here/);
  assert.match(skip.stderr, /reading the job: HTTP 502/);
});

// CB4 (#1519): a fallback before the dispatched run was found looks for it and cancels it, so the command doesn't run
// on CI later as well as here; one that can't be found at all runs nothing here.
test('a dispatched run found only after the fallback is cancelled before it runs here; one never found runs nothing here', () => {
  const r = repo();
  const late = run(r, 'late', { CITADEL_HEAVY_CI_FIND: '0.1' });
  assert.equal(late.status, 5, late.stderr);
  assert.equal(late.stdout, 'ran here\n');
  assert.ok(existsSync(join(r.gh, 'cancelled')), 'the run found late is cancelled');
  const l = repo();
  const lost = run(l, 'lost', { CITADEL_HEAVY_CI_FIND: '0.1' });
  assert.equal(lost.status, 1, lost.stderr);
  assert.doesNotMatch(lost.stdout, /ran here/);
  assert.match(lost.stderr, /or it couldn't be found yet; nothing runs here: look for "heavy /);
});

// Deploys first (#1902): the server's word (hold.json) keeps a job off the CI desktop while ships are in line.
const hold = (r: ReturnType<typeof repo>, o: Record<string, unknown> = {}) => {
  mkdirSync(join(r.gh, 'locks', 'long'), { recursive: true });
  writeFileSync(join(r.gh, 'locks', 'long', 'hold.json'), JSON.stringify({ at: Date.now(), off: false, why: '3 ships are in line', repos: ['o/r'], held: [], ...o }));
};
const jobs = (r: ReturnType<typeof repo>) =>
  readdirSync(join(r.gh, 'locks', 'long'))
    .filter((f) => f.endsWith('.json') && f !== 'hold.json')
    .map((f) => JSON.parse(readFileSync(join(r.gh, 'locks', 'long', f), 'utf8')));

test('while ships are in line a job is not dispatched: after its wait it is handed to Citadel, its snapshot kept', () => {
  const r = repo();
  hold(r);
  const res = run(r, 'ok', { CITADEL_HEAVY_HOLD_WAIT: '0.2', COORDINATOR_TICKET: '42' });
  assert.equal(res.status, 75, res.stderr);
  assert.match(res.stderr, /waiting: 3 ships are in line \(0 min\)/);
  assert.match(res.stderr, /Citadel starts it by itself when it may go, and wakes you/);
  assert.equal(existsSync(join(r.gh, 'dispatch.json')), false, 'nothing was dispatched');
  assert.doesNotMatch(res.stdout, /ran here/);
  const [job] = jobs(r);
  assert.deepEqual([job.ticket, job.slug, job.state, job.quiet, job.command], [42, 'o/r', 'queued', true, `sh -c 'echo ran here; exit 5'`]);
  assert.equal(git(r.bare, 'rev-parse', `refs/citadel-heavy/${job.id}`), job.sha);
});

test("a hold that is off, old, not this repo's, unreadable, or asked by a ship's own check holds nothing", () => {
  const cases: [Record<string, unknown>, NodeJS.ProcessEnv][] = [
    [{ off: true, why: null }, {}],
    [{ at: Date.now() - 5 * 60_000 }, {}],
    [{ repos: ['o/other'] }, {}],
    [{ held: 'x' }, {}],
    [{}, { CITADEL_HEAVY_SHIP: '1' }],
  ];
  for (const [o, env] of cases) {
    const r = repo();
    hold(r, o);
    const res = run(r, 'ok', { CITADEL_HEAVY_HOLD_WAIT: '0.2', COORDINATOR_TICKET: '42', ...env });
    assert.equal(res.status, 3, `${JSON.stringify(o)}: ${res.stderr}`);
    const id = JSON.parse(readFileSync(join(r.gh, 'dispatch.json'), 'utf8'))['inputs[id]'];
    assert.equal(id.startsWith('ship'), env.CITADEL_HEAVY_SHIP === '1', "a ship's check is named so the hold leaves it alone");
  }
});

test('a running job stopped for a ship is handed to Citadel, which starts the same run again', () => {
  const r = repo();
  hold(r, { why: null, held: [{ run: 7 }] });
  const res = run(r, 'held', { COORDINATOR_TICKET: '42' });
  assert.equal(res.status, 75, res.stderr);
  assert.match(res.stderr, /another CI job goes first, so this job was stopped: Citadel starts it again by itself/);
  const [job] = jobs(r);
  assert.deepEqual([job.state, job.run_id, job.quiet], ['running', 7, true]);
  assert.equal(git(r.bare, 'rev-parse', `refs/citadel-heavy/${job.id}`), job.sha, 'the run needs its snapshot again');
  assert.equal(existsSync(join(r.gh, 'cancelled')), false);
});

test('with no minion to wake, a stopped job waits here for the same run to come back', () => {
  const r = repo();
  hold(r, { why: null, held: [{ run: 7 }] });
  const res = run(r, 'held', { COORDINATOR_TICKET: undefined });
  assert.equal(res.status, 3, res.stderr);
  assert.equal(res.stdout, 'hello from CI\n');
  assert.ok(Number(readFileSync(join(r.gh, 'polls'), 'utf8')) >= 7, 'it watched the run past its cancelled end');
});
