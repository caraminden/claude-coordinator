import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('commandLine quotes for bash, and commandOutput takes the lines between the markers with the status', () => {
  assert.equal(commandLine(['cargo', 'test', '--workspace']), 'cargo test --workspace');
  assert.equal(commandLine(['sh', '-c', "echo 'a b'"]), `sh -c 'echo '\\''a b'\\'''`);
  const ts = (l: string) => `2026-11-20T10:00:00.1234567Z ${l}`;
  const log = ['﻿' + ts('##[group]Run actions/checkout@v4'), ts(BEGIN), ts('one'), ts(''), ts('two'), ts(`${END}3 ===`), ts('##[error]Process completed with exit code 3.')].join('\r\n');
  assert.deepEqual(commandOutput(log), { lines: ['one', '', 'two'], code: 3 });
  assert.deepEqual(commandOutput([ts(BEGIN), ts('half')].join('\n')), { lines: ['half'], code: null });
  assert.deepEqual(commandOutput(ts('nothing')), { lines: [], code: null });
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
  fs.writeFileSync(state, JSON.stringify(f));
} else if (url.includes('/workflows/citadel-heavy.yml/runs')) out({ workflow_runs: fs.existsSync(state) ? [{ id: 7, display_title: 'heavy ' + id() }] : [] });
else if (url.endsWith('/runs/7/cancel')) fs.writeFileSync(path.join(dir, 'cancelled'), '');
else if (url.endsWith('/runs/7')) {
  const n = Number(fs.existsSync(path.join(dir, 'polls')) ? fs.readFileSync(path.join(dir, 'polls'), 'utf8') : 0) + 1;
  fs.writeFileSync(path.join(dir, 'polls'), String(n));
  const status = mode === 'queued' ? 'queued' : ['queued', 'in_progress'][n - 1] ?? 'completed';
  out({ id: 7, status, conclusion: status === 'completed' ? 'failure' : null, html_url: 'https://github.com/o/r/actions/runs/7' });
} else if (url.endsWith('/runs/7/jobs')) out({ jobs: [{ id: 9, runner_name: mode === 'queued' ? null : 'ci-r-1' }] });
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
  git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
  if (workflow) writeFileSync(join(d, '.github', 'workflows', 'citadel-heavy.yml'), 'name: citadel-heavy\n');
  writeFileSync(join(d, 'a.txt'), 'committed\n');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'one');
  git(d, 'remote', 'add', 'origin', 'https://github.com/o/r');
  git(d, 'config', `url.${bare}.pushInsteadOf`, 'https://github.com/o/r');
  writeFileSync(join(d, 'a.txt'), 'edited, not committed\n');
  writeFileSync(join(d, 'new.txt'), 'untracked\n');
  const gh = join(root, `gh${n}`);
  mkdirSync(gh);
  return { d, bare, gh };
}
const run = (r: ReturnType<typeof repo>, mode: string, extra: NodeJS.ProcessEnv = {}) => spawnSync(heavy, ['sh', '-c', 'echo ran here; exit 5'], {
  cwd: r.d, encoding: 'utf8', timeout: 30_000,
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_DIR: r.gh, FAKE_GH_MODE: mode, CITADEL_HEAVY_DIR: join(r.gh, 'locks'), CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_HERE: undefined, CITADEL_HEAVY_PRIORITY: undefined, CITADEL_HEAVY_CI_POLL: '0.05', CITADEL_HEAVY_PRESSURE: join(root, 'no-psi'), CITADEL_HEAVY_WHO: 'Peek #9', ...extra },
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
  const line = readFileSync(join(r.gh, 'locks', 'history'), 'utf8').trim().split('\t');
  assert.deepEqual([line[1], line[3], line[6]], ['Peek #9', 'ci:o/r', '3']);
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
