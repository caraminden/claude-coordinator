// citadel-cloud (#2200, src/cloud-helper.ts) against a fake `claude` that runs the real runner (src/cloud-run-vm.mjs) the
// brief carries, in a clone of a bare origin, as a cloud VM would: progress lines, the result and files back, exit 69 for
// every way the cloud can't be used or goes quiet, and Stop, which ends the runner's job through its deleted source branch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { AT_HOME, cloud, collect, due, type Facts, HAND_MINUTES, helper, io, ON_ITS_OWN, type Job, MAX_MINUTES, parse, pickPlace, SLOWER, sessionText, slower, stop } from '../src/cloud-helper.ts';
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
// citadel-heavy: says how it was called, and exits with FAKE_HEAVY_CODE.
const fakeHeavy = join(root, 'citadel-heavy');
writeFileSync(
  fakeHeavy,
  `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(join(root, 'heavy.log'))}, JSON.stringify({ args: process.argv.slice(2), github: process.env.CITADEL_HEAVY_GITHUB ?? null, what: process.env.CITADEL_HEAVY_WHAT }) + '\\n');
if (process.env.FAKE_HEAVY_CHILD) require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(root, 'grandchild.js'))}], { stdio: 'inherit' });
setTimeout(() => process.exit(Number(process.env.FAKE_HEAVY_CODE || 0)), Number(process.env.FAKE_HEAVY_MS || 0));
`,
);
chmodSync(fakeHeavy, 0o755);
// The command citadel-heavy runs: it notes its pid, and its finish only once it outlives a stop.
writeFileSync(
  join(root, 'grandchild.js'),
  `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(root, 'grandchild.pid'))}, String(process.pid));
setTimeout(() => fs.writeFileSync(${JSON.stringify(join(root, 'grandchild.finished'))}, 'finished'), Number(process.env.FAKE_HEAVY_MS));
`,
);
function heavyCalls(): { args: string[]; github: string | null; what: string }[] {
  if (!existsSync(join(root, 'heavy.log'))) return [];
  const text = readFileSync(join(root, 'heavy.log'), 'utf8'); // raw-read-ok: read only after the fake citadel-heavy has exited
  return text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}
const heavyDir = join(root, 'heavy');

const said: string[] = [];
/** The chat line's posts: [text, the event it rewrites]. */
const lines: [string, number | null][] = [];
const kept = { ...io };
beforeEach(() => {
  said.length = 0;
  lines.length = 0;
  Object.assign(io, kept, {
    claude: fake,
    cwd: () => work,
    helpersOff: async () => null,
    log: (l: string) => said.push(l),
    pollMs: 100,
    everyMs: 500,
    place: async () => ({ on: true, machine: false }),
    isPublic: () => false,
    heavy: fakeHeavy,
    heavyDir: () => heavyDir,
    line: async (text: string, _: string, event: number | null) => (lines.push([text, event]), event ?? 41),
    lineMs: 200,
  });
  rmSync(join(root, 'claude.log'), { force: true });
  rmSync(join(root, 'heavy.log'), { force: true });
  rmSync(heavyDir, { recursive: true, force: true }); // timing-ok: own temp dir
  rmSync(join(work, '.github'), { recursive: true, force: true }); // timing-ok: own temp dir
  delete process.env.FAKE_HEAVY_CODE;
  delete process.env.FAKE_HEAVY_MS;
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
  // The job holds until the test has seen a progress line, so a beat and the result never arrive in one look.
  const go = join(root, 'go-progress');
  const j = job(`cat marker.txt; while [ ! -e ${go} ]; do sleep 0.1; done; echo made > out.txt; echo all done`, { files: ['out.txt', 'nope.txt'] });
  const ran = cloud(j);
  await until('a progress line', () => said.some((l) => /^citadel-cloud: \d+ min: the minion commit/.test(l)));
  writeFileSync(go, '');
  assert.equal(await ran, 0);
  assert.ok(!said.some((l) => /min:\s*$/.test(l)), `a beat before any output reads "N min", not "N min:": ${said.join('\n')}`);
  const reply = said.find((l) => l.includes('after 0 min in the cloud')) ?? '';
  assert.match(reply, /exit 0/);
  assert.match(reply, /the minion commit[\s\S]*all done/, 'ran on the unpushed commit');
  assert.match(reply, /Not found, or over 5 MB: `nope\.txt`/);
  assert.equal(readFileSync(join(j.out, 'out.txt'), 'utf8'), 'made\n');
  assert.match(readFileSync(join(j.out, 'output.log'), 'utf8'), /all done/);
  assert.equal(cloudBranches(), '', 'source, beat and result branches all deleted');
  assert.equal(git(work, 'rev-parse', 'HEAD'), head);
});

test('a command that fails in the cloud exits with its own code, as at home, and says so in the reply', async () => {
  assert.equal(await cloud(job('echo broke; exit 3')), 3);
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

test("pickPlace: Cara's order, a PC with room, GitHub on a public repo, the cloud unless WAY slower, else perigee; with helpers off, perigee for all", () => {
  const f = (more: Partial<Facts>): Facts => ({ on: true, machine: false, workflow: true, public: false, slower: null, ...more });
  const run = { kind: 'run' as const, files: [] };
  const cases: [Partial<Facts>, Pick<Job, 'kind' | 'files'>, string][] = [
    [{ machine: true, public: true }, run, 'machine'],
    [{ public: true }, run, 'github'],
    [{ machine: true, public: true, workflow: false }, run, 'cloud'],
    [{ machine: true, public: true }, { kind: 'run', files: ['out.txt'] }, 'cloud'],
    [{ slower: SLOWER - 0.1 }, run, 'cloud'],
    [{ slower: SLOWER }, run, 'home'],
    [{ on: false }, run, 'home'],
    [{ on: false, machine: true, public: true }, run, 'home'],
    [{ machine: true }, { kind: 'brief', files: [] }, 'cloud'],
    [{ on: false, machine: true }, { kind: 'brief', files: [] }, 'home'],
  ];
  for (const [facts, job, place] of cases) assert.equal(pickPlace(f(facts), job).place, place, JSON.stringify([facts, job]));
});

test("slower: the cloud's runs of a command over this scheme's runs of it on perigee, newest 5 of each, failures and CI left out", () => {
  const dir = mkdtempSync(join(root, 'hist-'));
  process.env.CITADEL_HEAVY_WHO = 'Citadel #9 (x)';
  const line = (who: string, what: string, reason: string, secs: number, status: number) => `2026-11-27T00:00:00-0800\t${who}\t${what}\t${reason}\t0\t${secs}\t${status}\t-\n`;
  assert.equal(slower('npm test', dir), null, 'no runs');
  writeFileSync(join(dir, 'history'), [line('Citadel #1 (a)', 'npm test', 'none', 100, 0), line('Citadel #2 (b)', 'npm test', 'slots', 100, 1), line('Citadel #3', 'npm test', 'ci:o/r', 9, 0), line('Delve #4', 'npm test', 'none', 9, 0), line('Citadel #5', 'npm test', 'none', 9, 2)].join(''));
  assert.equal(slower('npm test', dir), null, 'no cloud runs yet');
  writeFileSync(join(dir, 'cloud-history'), [line('Citadel #6', 'npm test', 'cloud', 900, 0), line('Citadel #7', 'npm test', 'cloud', 300, 0), line('Citadel #8', 'npm test', 'cloud', 300, 0)].join(''));
  assert.equal(slower('npm test', dir), 3);
  assert.equal(slower('npm run other', dir), null);
  delete process.env.CITADEL_HEAVY_WHO;
  rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
});

test('a command goes through citadel-heavy to a PC with room, to GitHub on a public repo, or to perigee when helpers are off', async () => {
  mkdirSync(join(work, '.github/workflows'), { recursive: true });
  writeFileSync(join(work, '.github/workflows/citadel-heavy.yml'), 'on:\n  workflow_dispatch:\n    inputs:\n      runner:\n');
  io.place = async () => ({ on: true, machine: true });
  process.env.FAKE_HEAVY_CODE = '75';
  assert.equal(await helper(job('npm test')), 75, "citadel-heavy's exit code, 75 included");
  io.place = async () => ({ on: true, machine: false });
  io.isPublic = () => true;
  process.env.FAKE_HEAVY_CODE = '3';
  assert.equal(await helper(job('npm test')), 3);
  io.place = async () => ({ on: false, machine: true });
  delete process.env.FAKE_HEAVY_CODE;
  assert.equal(await helper(job('npm test')), 0, 'helpers off: neither a PC nor GitHub');
  assert.deepEqual(
    heavyCalls().map((c) => [c.args.join(' '), c.github, c.what]),
    [
      ['bash -c npm test', null, 'npm test'],
      ['bash -c npm test', '1', 'npm test'],
      ['--here bash -c npm test', null, 'npm test'],
    ],
  );
  assert.match(said.join('\n'), /runs on a machine lending this scheme CI[\s\S]*runs on GitHub's own runners[\s\S]*runs here, in perigee's heavy-job slot: cloud helpers are off/);
  assert.deepEqual(claudeCalls(), [], 'no session for any of them');
});

test("a public repo whose citadel-heavy workflow has no runner input (the kit's template) isn't sent to GitHub, which would refuse the run", async () => {
  mkdirSync(join(work, '.github/workflows'), { recursive: true });
  writeFileSync(join(work, '.github/workflows/citadel-heavy.yml'), 'on: workflow_dispatch\n');
  io.place = async () => ({ on: true, machine: false });
  io.isPublic = () => true;
  process.env.FAKE_MODE = 'quiet';
  io.quietMs = 1500;
  await helper(job('npm test', { minutes: 60 }));
  assert.match(said.join('\n'), /runs in a cloud session/);
  assert.ok(!heavyCalls().some((c) => c.github), 'never on GitHub');
});

test('at home --minutes still holds (exit 124) and --files come to --out, as from the cloud', async () => {
  io.place = async () => ({ on: false, machine: false });
  io.minuteMs = 200;
  process.env.FAKE_HEAVY_MS = '20000';
  assert.equal(await helper(job('npm test', { minutes: 1 })), 124);
  assert.match(lines.at(-1)![0], /stopped at its 1-minute limit$/);
  delete process.env.FAKE_HEAVY_MS;
  writeFileSync(join(work, 'made.txt'), 'made here');
  const j = job('make it', { files: ['made.txt', 'nope.txt'] });
  assert.equal(await helper(j), 0);
  assert.equal(readFileSync(join(j.out, 'made.txt'), 'utf8'), 'made here');
});

test('at home a stop or the limit ends the command citadel-heavy runs too, not only citadel-heavy', async () => {
  io.place = async () => ({ on: false, machine: false });
  io.minuteMs = 300;
  process.env.FAKE_HEAVY_MS = '30000';
  process.env.FAKE_HEAVY_CHILD = '1';
  try {
    assert.equal(await helper(job('npm test', { minutes: 1 })), 124);
    const pid = Number(readFileSync(join(root, 'grandchild.pid'), 'utf8'));
    const alive = () => {
      try {
        return (process.kill(pid, 0), true);
      } catch {
        return false;
      }
    };
    await until('the command is gone', () => !alive());
    assert.ok(!existsSync(join(root, 'grandchild.finished')), 'the command ran on past its limit');
  } finally {
    delete process.env.FAKE_HEAVY_CHILD;
    delete process.env.FAKE_HEAVY_MS;
  }
});

test("a cloud session that goes quiet falls back to perigee's slot by itself; a brief the cloud can't take comes back 69 for a Grunt", async () => {
  process.env.FAKE_MODE = 'quiet';
  io.quietMs = 1500;
  assert.equal(await helper(job('echo hi', { minutes: 60 })), 0, "the home run's exit code");
  assert.deepEqual(claudeCalls(), ['--cloud', '--teleport']);
  assert.deepEqual(
    heavyCalls().map((c) => c.args.join(' ')),
    ['--here bash -c echo hi'],
  );
  assert.match(said.join('\n'), /No progress from the cloud session[\s\S]*runs here, in perigee's heavy-job slot instead/);
  rmSync(join(root, 'claude.log'), { force: true });
  io.place = async () => ({ on: false, machine: true });
  assert.equal(await helper(job('', { kind: 'brief', brief: 'Look into X.', minutes: 60 })), AT_HOME);
  assert.equal(heavyCalls().length, 1, 'a brief never goes to citadel-heavy');
  assert.deepEqual(claudeCalls(), [], 'nor to a session with helpers off');
});

test('a cloud run is remembered for the next pick\'s "WAY slower" check', async () => {
  assert.equal(await helper(job('echo remembered')), 0);
  const lines = readFileSync(join(heavyDir, 'cloud-history'), 'utf8').trim().split('\n');
  assert.deepEqual(
    lines.map((l) => l.split('\t').slice(2, 4).concat(l.split('\t')[6])),
    [['echo remembered', 'cloud', '0']],
  );
  assert.equal(heavyCalls().length, 0);
  const vm = readFileSync(join(root, 'vm-dir'), 'utf8');
  await until('the VM saw DONE and ended', () => existsSync(join(vm, 'said')) && /DONE/.test(readFileSync(join(vm, 'said'), 'utf8')));
});

test('the chat line names how a step ended: ✗ and its exit code on a failure, its time limit on 124', async () => {
  assert.equal(await helper(job('exit 3')), 3);
  assert.match(lines.at(-1)![0], /in a cloud session · ✗ failed \(exit 3\) after 0 min$/);
  lines.length = 0;
  assert.equal(await helper(job('exit 124')), 124);
  assert.match(lines.at(-1)![0], /in a cloud session · stopped at its time limit, after 0 min$/);
});

test('the chat line: one note for the step, rewritten from its start to its exit, and through a fallback home', async () => {
  assert.equal(await helper(job('echo lined; sleep 1')), 0);
  const texts = lines.map(([t]) => t);
  assert.equal(texts[0], 'citadel-cloud: “echo lined; sleep 1” in a cloud session · starting');
  assert.ok(texts.includes('citadel-cloud: “echo lined; sleep 1” in a cloud session · started'), texts.join('\n'));
  assert.match(texts.at(-1)!, /in a cloud session · ✔ done after 0 min$/);
  assert.deepEqual(
    lines.map(([, e]) => e),
    [null, ...lines.slice(1).map(() => 41)],
    'posted once, then rewritten',
  );
  const vm = readFileSync(join(root, 'vm-dir'), 'utf8');
  await until('the VM saw DONE and ended', () => existsSync(join(vm, 'said')) && /DONE/.test(readFileSync(join(vm, 'said'), 'utf8')));
  lines.length = 0;
  process.env.FAKE_MODE = 'quiet';
  io.quietMs = 1500;
  assert.equal(await helper(job('echo hi', { minutes: 60 })), 0);
  assert.deepEqual(
    lines.map(([t]) => t.replace('citadel-cloud: “echo hi” ', '')),
    ['in a cloud session · starting', 'in a cloud session · started', "in a cloud session · the cloud session didn't deliver, so it runs here", "here, in perigee's heavy-job slot · ✔ done after 0 min"],
  );
});

test('a step allowed long but done before the hand-over time waits in the turn to its end (Cara\'s "Both, by length": how long it runs, not its cap)', async () => {
  io.canHand = () => true;
  const j = job('echo quick one', { minutes: HAND_MINUTES + 10 });
  assert.equal(await helper(j), 0);
  assert.ok(!existsSync(join(j.out, '.hand.json')), 'never handed over');
  assert.match(lines.at(-1)![0], /✔ done after 0 min$/);
  const vm = readFileSync(join(root, 'vm-dir'), 'utf8');
  await until('the VM saw DONE and ended', () => existsSync(join(vm, 'said')) && /DONE/.test(readFileSync(join(vm, 'said'), 'utf8')));
});

test('a long cloud step runs on its own once it has run past the hand-over time: check says when, collect brings it home with its chat line', async () => {
  io.canHand = () => true;
  io.handMs = 0;
  const go = join(root, 'go-hand');
  const j = job(`echo long one; while [ ! -e ${go} ]; do sleep 0.1; done; echo made > out.txt`, { minutes: HAND_MINUTES + 10, files: ['out.txt'] });
  assert.equal(await helper(j), ON_ITS_OWN);
  assert.equal(await collect(j.out), ON_ITS_OWN, 'woken early, collect leaves it running');
  assert.match(cloudBranches(), /cloud\/src-t7-/, 'and its source branch stays');
  writeFileSync(go, '');
  const said1 = said.join('\n');
  assert.match(said1, new RegExp(`citadel-wait cmd 'citadel-cloud check ${j.out}'[\\s\\S]*citadel-cloud collect ${j.out}`));
  assert.match(lines.at(-1)![0], /runs on its own in the cloud; Citadel watches for its result$/);
  assert.equal(JSON.parse(readFileSync(join(j.out, '.hand.json'), 'utf8')).event, 41, 'collect rewrites the same line');
  assert.match(cloudBranches(), /cloud\/src-t7-/, 'its source branch stays: deleting it would stop the job');
  await until('check says collect', () => due(j.out) !== null);
  assert.equal(due(j.out), 'its result is pushed');
  lines.length = 0;
  assert.equal(await collect(j.out), 0);
  assert.match(said.join('\n'), /long one[\s\S]*done after \d+ min/);
  assert.equal(readFileSync(join(j.out, 'out.txt'), 'utf8'), 'made\n');
  assert.deepEqual(
    lines.map(([t, e]) => [t.replace(/^.*· /, ''), e]),
    [[/✔ done after \d+ min/.exec(lines[0][0])![0], 41]],
  );
  assert.equal(cloudBranches(), '');
  const vm = readFileSync(join(root, 'vm-dir'), 'utf8');
  await until('the VM saw DONE and ended', () => existsSync(join(vm, 'said')) && /DONE/.test(readFileSync(join(vm, 'said'), 'utf8')));
});

test('check: a step on its own that goes quiet or passes its limit is due; collect then runs it here', async () => {
  const out = mkdtempSync(join(root, 'hand-'));
  const beat = 'cloud/t7-quiet-beat';
  const sha = git(work, 'commit-tree', git(work, 'write-tree'), '-m', 'beat');
  git(work, 'push', '-q', 'origin', `${sha}:refs/heads/${beat}`);
  const hand = { cwd: work, branch: 'cloud/t7-quiet', ref: 'cloud/src-t7-quiet', beat, url: 'https://claude.ai/code/session_q', began: Date.now(), minutes: 60, quietMs: 60_000, job: job('echo here', { out }), event: 9 };
  writeFileSync(join(out, '.hand.json'), JSON.stringify(hand));
  assert.equal(due(out), null, 'a fresh beat: still running');
  assert.match(due(out, Date.now() + 5 * 60_000) ?? '', /^no progress for [45] min$/);
  assert.equal(due(out, Date.now() + 76 * 60_000), 'it passed its time limit');
  assert.equal(await collect(out), ON_ITS_OWN, 'not due yet: collect stops nothing and runs nothing');
  assert.deepEqual(heavyCalls(), []);
  writeFileSync(join(out, '.hand.json'), JSON.stringify({ ...hand, began: Date.now() - 76 * 60_000 }));
  assert.equal(await collect(out), 0);
  assert.deepEqual(
    heavyCalls().map((c) => c.args.join(' ')),
    ['--here bash -c echo here'],
  );
  assert.deepEqual(
    lines.map(([t, e]) => [t.replace('citadel-cloud: “echo here” ', ''), e]),
    [
      ["in a cloud session · the cloud session didn't deliver, so it runs here", 9],
      ["here, in perigee's heavy-job slot · ✔ done after 0 min", 9],
    ],
  );
  assert.equal(cloudBranches(), '', 'its beat branch deleted');
  process.env.FAKE_HEAVY_CODE = '5';
  assert.equal(due(out), 'it is already collected');
  assert.equal(await collect(out), 0, 'a second collect repeats the first exit code');
  assert.equal(heavyCalls().length, 1, 'and runs nothing again');
});
