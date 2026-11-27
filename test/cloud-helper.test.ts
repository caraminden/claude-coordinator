// citadel-cloud (#2200, src/cloud-helper.ts) against a fake `claude` that runs the real runner (src/cloud-run-vm.mjs) the
// brief carries, in a clone of a bare origin, as a cloud VM would: progress lines, the result and files back, exit 69 for
// every way the cloud can't be used or goes quiet, and Stop, which ends the runner's job through its deleted source branch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { AT_HOME, cloud, io, type Job, MAX_MINUTES, parse, sessionText, stop } from '../src/cloud-helper.ts';
import { until } from './wait.ts';

const root = mkdtempSync(join(tmpdir(), 'cloud-helper-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
const origin = join(root, 'origin.git');
const work = join(root, 'work');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
git(work, 'commit', '-q', '--allow-empty', '-m', 'start');
git(work, 'push', '-q', 'origin', 'HEAD:main');
// The minion's own commit, never pushed: the cloud job must run on it.
writeFileSync(join(work, 'marker.txt'), 'the minion commit\n');
git(work, 'add', 'marker.txt');
git(work, 'commit', '-q', '-m', 'mine');
const head = git(work, 'rev-parse', 'HEAD');

// The VM: a clone of origin running the brief's runner the way the session's model would, again until it isn't STILL RUNNING.
const vmScript = join(root, 'vm.cjs');
writeFileSync(
  vmScript,
  `const { execFileSync, spawnSync } = require('node:child_process');
const { appendFileSync, mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [text] = process.argv.slice(2);
const vm = mkdtempSync(join(${JSON.stringify(root)}, 'vm-'));
writeFileSync(join(${JSON.stringify(root)}, 'vm-dir'), vm);
execFileSync('git', ['clone', '-q', ${JSON.stringify(origin)}, join(vm, 'repo')]);
writeFileSync(join(vm, 'run.mjs'), Buffer.from(/echo (\\S+) \\| base64 -d/.exec(text)[1], 'base64'));
const arg = /node \\/tmp\\/citadel-run\\.mjs (\\S+)/.exec(text)[1];
for (;;) {
  const r = spawnSync(process.execPath, [join(vm, 'run.mjs'), arg], { cwd: join(vm, 'repo'), encoding: 'utf8', env: { ...process.env, CITADEL_RUN_DIR: join(vm, 'run'), CITADEL_RUN_BEAT_MS: '300', CITADEL_RUN_WAIT_MS: '1000' } });
  appendFileSync(join(vm, 'said'), r.stdout + r.stderr);
  if (!/STILL RUNNING/.test(r.stdout)) break;
}
`,
);
const fake = join(root, 'claude');
writeFileSync(
  fake,
  `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, 'claude.log'))}, args[0] + '\\n');
const mode = process.env.FAKE_MODE || 'run';
if (args[0] === '--teleport') process.stdout.write('transcript, no result\\n');
else if (args[0] === '--cloud') {
  process.stdout.write('Welcome\\n\\x1b[1mPress Enter to continue\\x1b[0m\\n');
  process.stdin.setRawMode?.(true);
  process.stdin.once('data', () => {
    process.stdout.write('Created https://claude.ai/code/session_01FAKEhelper\\n');
    // The VM outlives this screen, which the driver closes once it has the link.
    if (mode === 'run') spawn(process.execPath, [${JSON.stringify(vmScript)}, args[1]], { detached: true, stdio: 'ignore' }).unref();
    setInterval(() => {}, 1000);
  });
}
`,
);
chmodSync(fake, 0o755);

const said: string[] = [];
const kept = { ...io };
beforeEach(() => {
  said.length = 0;
  Object.assign(io, kept, { claude: fake, cwd: () => work, helpersOff: async () => null, log: (l: string) => said.push(l), pollMs: 100, everyMs: 500 });
  rmSync(join(root, 'claude.log'), { force: true });
  rmSync(join(root, 'vm-dir'), { force: true });
  delete process.env.CITADEL_JOB;
  delete process.env.CITADEL_CLOUD;
  delete process.env.FAKE_MODE;
  process.env.COORDINATOR_TICKET = '7';
  process.env.CITADEL_CLOUD_ORIGIN = origin;
});
after(() => {
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});

const job = (cmd: string, more: Partial<Job> = {}): Job => ({ kind: 'run', cmd, brief: '', minutes: 5, files: [], out: mkdtempSync(join(root, 'out-')), model: 'sonnet', ...more });
const cloudBranches = () => git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/cloud', 'refs/heads/claude');
const claudeCalls = () => (existsSync(join(root, 'claude.log')) ? readFileSync(join(root, 'claude.log'), 'utf8').trim().split('\n') : []);

test('a command runs on the minion commit in the cloud: progress lines, its output and files back, exit 0, no branch left', async () => {
  const j = job('cat marker.txt; sleep 1; echo made > out.txt; echo all done', { files: ['out.txt', 'nope.txt'] });
  assert.equal(await cloud(j), 0);
  assert.ok(
    said.some((l) => /^citadel-cloud: \d+ min: /.test(l)),
    `a progress line: ${said.join('\n')}`,
  );
  const reply = said.find((l) => l.includes('after 0 min in the cloud')) ?? '';
  assert.match(reply, /exit 0/);
  assert.match(reply, /the minion commit[\s\S]*all done/, 'ran on the unpushed commit');
  assert.match(reply, /Not found, or over 5 MB: `nope\.txt`/);
  assert.equal(readFileSync(join(j.out, 'out.txt'), 'utf8'), 'made\n');
  assert.match(readFileSync(join(j.out, 'output.log'), 'utf8'), /all done/);
  assert.equal(cloudBranches(), '', 'source, beat and result branches all deleted');
  assert.equal(git(work, 'rev-parse', 'HEAD'), head);
});

test('a command that fails in the cloud exits 1 with its exit code in the reply', async () => {
  assert.equal(await cloud(job('echo broke; exit 3')), 1);
  assert.match(said.join('\n'), /exit 3 after/);
  assert.equal(cloudBranches(), '');
});

test('every way the cloud cannot be used is exit 69 before anything starts', async () => {
  const cases: [string, () => void][] = [
    ['switch off', () => (io.helpersOff = async () => "Citadel's cloud helpers are off")],
    ['CITADEL_CLOUD=0', () => (process.env.CITADEL_CLOUD = '0')],
    ['under citadel-job', () => (process.env.CITADEL_JOB = '1')],
    ['no claude CLI', () => (io.claude = join(root, 'no-such-claude'))],
    ['origin not on GitHub', () => delete process.env.CITADEL_CLOUD_ORIGIN],
  ];
  for (const [name, set] of cases) {
    said.length = 0;
    Object.assign(io, { helpersOff: async () => null, claude: fake });
    delete process.env.CITADEL_CLOUD;
    delete process.env.CITADEL_JOB;
    process.env.CITADEL_CLOUD_ORIGIN = origin;
    set();
    assert.equal(await cloud(job('echo hi')), AT_HOME, name);
    assert.match(said.join('\n'), /exit 69: run this step at home now/, name);
  }
  assert.deepEqual(claudeCalls(), [], 'no session started');
  assert.equal(cloudBranches(), '', 'nothing pushed');
});

test('a session that never runs the job (no progress) is caught at the quiet limit, read back once, and is exit 69', async () => {
  process.env.FAKE_MODE = 'quiet';
  io.quietMs = 1500;
  assert.equal(await cloud(job('echo hi', { minutes: 60 })), AT_HOME);
  assert.match(said.join('\n'), /No progress from the cloud session session_01FAKEhelper/);
  assert.deepEqual(claudeCalls(), ['--cloud', '--teleport']);
  assert.equal(cloudBranches(), '');
});

test('Stop ends the helper and the cloud job: the deleted source branch makes the runner kill it and push nothing', async () => {
  const done = cloud(job('echo started; sleep 60'));
  await until('a progress line', () => said.some((l) => /^citadel-cloud: \d+ min: /.test(l)));
  stop();
  assert.equal(await done, 143);
  const vm = readFileSync(join(root, 'vm-dir'), 'utf8');
  await until('the runner stopped', () => existsSync(join(vm, 'said')) && /STOPPED/.test(readFileSync(join(vm, 'said'), 'utf8')));
  assert.equal(readFileSync(join(vm, 'run', 'code'), 'utf8'), 'stopped');
  assert.equal(cloudBranches(), '', 'no result pushed after the stop');
});

test('parse: the two kinds, and a bad call is a usage error', () => {
  const r = parse(['run', '--minutes', '40', '--files', 'a,b', '--', 'npm', 'test']);
  assert.equal(typeof r, 'object');
  assert.deepEqual([(r as Job).cmd, (r as Job).minutes, (r as Job).files], ['npm test', 40, ['a', 'b']]);
  writeFileSync(join(root, 'brief.md'), 'Look into X.');
  assert.equal((parse(['brief', join(root, 'brief.md'), '--model', 'opus']) as Job).brief, 'Look into X.');
  for (const bad of [[], ['run', 'npm', 'test'], ['run', '--minutes', String(MAX_MINUTES + 1), '--', 'x'], ['brief'], ['brief', join(root, 'none.md')], ['brief', join(root, 'brief.md'), '--model', 'gpt']]) assert.equal(typeof parse(bad), 'string', bad.join(' '));
});

test("a command job's session text carries the runner whole and its job; a brief's carries the brief and the result's shape", () => {
  const text = sessionText(job('npm test'), 'cloud/t7-x', 'cloud/src-t7-x', 'cloud/t7-x-beat', 7);
  assert.equal(Buffer.from(/echo (\S+) \| base64 -d/.exec(text)![1], 'base64').toString(), readFileSync(join(import.meta.dirname, '../src/cloud-run-vm.mjs'), 'utf8'));
  const vm = JSON.parse(Buffer.from(/node \/tmp\/citadel-run\.mjs (\S+)/.exec(text)![1], 'base64').toString());
  assert.deepEqual(vm, { ref: 'cloud/src-t7-x', branch: 'cloud/t7-x', beat: 'cloud/t7-x-beat', cmd: 'npm test', minutes: 5, files: [] });
  const brief = sessionText(job('', { kind: 'brief', brief: 'Look into X.' }), 'cloud/t7-y', '', '', 7);
  assert.match(brief, /Look into X\.[\s\S]*"job": "cloud\/t7-y"[\s\S]*git push origin HEAD:refs\/heads\/cloud\/t7-y/);
});
