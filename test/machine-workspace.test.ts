import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { until } from './wait.ts';
// @ts-ignore: a plain .mjs the agent's computers download
import { WorkspaceHost, expand, joinScreenLine, leaveScreenLine, loadConfig, screenLine, screenState, workspaceReply } from '../public/machine-agent.mjs';
import { JOB_WORDS } from '../src/machines.ts';

// The agent's workspace tools against a real clone with a real origin, as on a laptop.
const root = mkdtempSync(join(tmpdir(), 'machine-ws-'));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

const origin = join(root, 'origin.git');
const seed = join(root, 'seed');
const clone = join(root, 'clone');
const vault = join(root, 'vault');
const outside = join(root, 'outside');
const logs = join(root, 'appdata-logs');
mkdirSync(seed);
mkdirSync(outside);
mkdirSync(logs);
writeFileSync(join(outside, 'secret.txt'), 'nope');
writeFileSync(join(logs, 'godot.log'), 'line one\nline two\n');
git(root, 'init', '-q', '--bare', '-b', 'main', origin);
git(seed, 'init', '-q', '-b', 'main');
writeFileSync(join(seed, 'project.godot'), 'a\nb\n');
writeFileSync(join(seed, 'readme.txt'), 'hello\n');
git(seed, 'add', '.');
git(seed, 'commit', '-q', '-m', 'first');
git(seed, 'remote', 'add', 'origin', origin);
git(seed, 'push', '-q', 'origin', 'main');
git(root, 'clone', '-q', origin, clone);
git(root, 'clone', '-q', origin, vault);
// The laptop's standing local change: a reorder of project.godot.
writeFileSync(join(clone, 'project.godot'), 'b\na\n');
symlinkSync(outside, join(clone, 'escape'));

const node = process.execPath;
const configFile = join(root, 'machine-agent.json');
writeFileSync(configFile, JSON.stringify({
  workspaces: {
    delve: {
      path: clone,
      read: [logs, join(root, 'missing')],
      tasks: {
        ok: { run: [node, '-e', 'console.log("built fine")'], about: 'says hi' },
        nogodot: { run: [node, '-e', 'process.exit(2)'], hints: [{ exit: 2, say: 'Unzip Godot into Downloads or set GODOT.' }] },
        locked: { run: [node, '-e', 'console.log("error MSB3027: being used by another process"); process.exit(1)'], hints: [{ match: 'MSB3027|used by another process', say: 'Close the game and the Delve Editor, then retry.' }] },
        slow: { run: [node, '-e', 'setTimeout(() => console.log("done"), 1500)'] },
        unset: { run: ['%CITADEL_NOT_SET%'] },
        'bad task!': { run: ['x'] },
        empty: { run: [] },
      },
    },
    gone: { path: join(root, 'nowhere') },
    vault: { path: vault, git_sync: false },
    typo: { path: vault, git_sync: 'no' },
  },
}));
const host = new WorkspaceHost({ configFile, jobsDir: join(root, 'jobs') });
const call = (tool: string, args: object = {}) => host.call(tool, args, '#90 in Citadel', async (name: string, bytes: Buffer) => `/srv/${name}:${bytes.length}`);
const refused = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (err: Error) => re.test(err.message));

test('the config keeps good workspaces and tasks and says what it left out', () => {
  assert.deepEqual([...host.workspaces.keys()], ['delve', 'vault', 'typo']);
  assert.deepEqual([...host.workspaces.values()].map((w) => w.gitSync), [true, false, false]);
  assert.deepEqual(host.summary().workspaces.map((w: any) => w.git_sync), [true, false, false]);
  assert.deepEqual([...host.workspaces.get('delve').tasks.keys()], ['ok', 'nogodot', 'locked', 'slow', 'unset']);
  const problems = host.problems.join('\n');
  assert.match(problems, /gone: .*does not exist/);
  assert.match(problems, /read folder .*missing/);
  assert.match(problems, /bad task!: names use/);
  assert.match(problems, /empty: "run" must be/);
  assert.match(problems, /typo: "git_sync" must be true or false, so it is off/);
  assert.deepEqual(loadConfig(join(root, 'none.json')), { workspaces: new Map(), servers: new Map(), problems: [], screenLock: null, screenshots: false, jobs: null });
  assert.match(loadConfig(seed + '/readme.txt').problems[0], /JSON/);
  assert.equal(expand('%Home%/x', { HOME: '/h' }), '/h/x');
  assert.throws(() => expand('%NOPE%', {}), /NOPE is not set/);
});

test('reads stay inside the workspace and its read folders', async () => {
  assert.match((await call('read_file', { workspace: 'delve', path: 'readme.txt' })).text, /1\thello/);
  assert.match((await call('read_file', { workspace: 'delve', path: join(logs, 'godot.log'), offset: 2 })).text, /2\tline two/);
  assert.match((await call('list_files', { workspace: 'delve' })).text, /readme\.txt/);
  assert.doesNotMatch((await call('list_files', { workspace: 'delve' })).text, /^\.git/m);
  await refused(call('read_file', { workspace: 'delve', path: '../outside/secret.txt' }), /outside workspace delve/);
  await refused(call('read_file', { workspace: 'delve', path: join(outside, 'secret.txt') }), /outside workspace delve/);
  await refused(call('read_file', { workspace: 'delve', path: 'escape/secret.txt' }), /outside workspace delve/);
  await refused(call('read_file', { workspace: 'delve', path: '.git/config' }), /\.git folder is off limits/);
  await refused(call('read_file', { workspace: 'nope', path: 'x' }), /No workspace "nope".*delve/);
  assert.equal((await call('fetch_file', { workspace: 'delve', path: join(logs, 'godot.log') })).text.match(/to (\S+) on/)[1], '/srv/godot.log:18');
  await refused(call('fetch_file', { workspace: 'delve', path: 'escape/secret.txt' }), /outside/);
});

test('git_sync checks out a pushed branch, carries local changes, and stops on a conflict', async () => {
  git(seed, 'checkout', '-q', '-b', 'build-7');
  writeFileSync(join(seed, 'readme.txt'), 'build seven\n');
  git(seed, 'commit', '-qam', 'seven');
  git(seed, 'push', '-q', 'origin', 'build-7');
  const synced = await call('git_sync', { workspace: 'delve', ref: 'build-7' });
  assert.match(synced.text, /Checked out build-7 in delve: detached at \w+ seven/);
  assert.match(synced.text, /Before: branch main/);
  assert.match(synced.text, /M project\.godot/);

  git(seed, 'checkout', '-q', '-b', 'touches-project');
  writeFileSync(join(seed, 'project.godot'), 'c\n');
  git(seed, 'commit', '-qam', 'project change');
  git(seed, 'push', '-q', 'origin', 'touches-project');
  await refused(call('git_sync', { workspace: 'delve', ref: 'origin/touches-project' }), /would overwrite local changes on this computer in:\nproject\.godot\nNothing was changed/);
  assert.match(git(clone, 'log', '-1', '--format=%s'), /seven/);
  assert.equal(git(clone, 'status', '--porcelain', '-uno'), 'M project.godot');

  await refused(call('git_sync', { workspace: 'delve', ref: 'no-such' }), /origin has no branch no-such/);
  for (const ref of ['--upload-pack=x', 'a..b', 'x@{1}', '']) await refused(call('git_sync', { workspace: 'delve', ref }), /isn't a branch name/);
  const listed = (await call('workspaces')).text;
  assert.match(listed, /Checked out: detached at \w+ seven[\s\S]*- ok: .* \(says hi\)/);
  assert.doesNotMatch(listed.split('## vault')[0], /git_sync: off/);
  assert.match(listed.split('## vault')[1], /git_sync: off/);
});

test('git_sync refuses in a workspace that has it off and leaves its branch alone', async () => {
  await refused(call('git_sync', { workspace: 'vault', ref: 'build-7' }), /git_sync is off for workspace vault: its owner keeps it on a branch\. Use its tasks instead\./);
  assert.equal(git(vault, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.match(git(vault, 'log', '-1', '--format=%s'), /first/);
});

test('only configured tasks run, with hints, one at a time, and long ones become jobs', async () => {
  const ok = await call('run_task', { workspace: 'delve', task: 'ok' });
  assert.match(ok.text, /ok in delve succeeded \(exit 0\)[\s\S]*built fine/);
  assert.equal(ok.isError, false);
  const missing = await call('run_task', { workspace: 'delve', task: 'nogodot' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /FAILED \(exit 2\)[\s\S]*Unzip Godot/);
  assert.match((await call('run_task', { workspace: 'delve', task: 'locked' })).text, /Close the game and the Delve Editor/);
  await refused(call('run_task', { workspace: 'delve', task: 'rm -rf' }), /no task "rm -rf".*Only this computer's owner/);
  await refused(call('run_task', { workspace: 'delve', task: 'unset' }), /CITADEL_NOT_SET is not set/);

  const started = await call('run_task', { workspace: 'delve', task: 'slow', wait: 0 });
  const id = started.text.match(/job (\w+)\)/)[1];
  assert.match(started.text, /still running/);
  await refused(call('git_sync', { workspace: 'delve', ref: 'main' }), /busy: task slow for #90 in Citadel/);
  await refused(call('run_task', { workspace: 'delve', task: 'ok' }), /busy/);
  const finished = await call('job', { id, wait: 10 });
  assert.match(finished.text, /slow in delve succeeded[\s\S]*done/);
  assert.match((await call('run_task', { workspace: 'delve', task: 'ok' })).text, /succeeded/);
  await refused(call('job', { id: 'nope' }), /No job nope/);
  // Its folder unticked on the Machines page (#439): the job goes out of reach with it.
  host.lent = new Set(['vault']);
  await refused(call('job', { id }), /no longer lends/);
  await refused(call('stop_job', { id }), /no longer lends/);
  host.lent = null;
  assert.match((await call('job', { id })).text, /./);
});

test('run_task names the commit it ran, and refuses a caller whose own git_sync another minion has since moved (MA5)', async () => {
  const as = (who: string) => (tool: string, args: object) => host.call(tool, args, who, async () => '');
  const sha = (ref: string) => git(clone, 'rev-parse', ref);
  await as('#90 in Citadel')('git_sync', { workspace: 'delve', ref: 'build-7' });
  assert.match((await as('#90 in Citadel')('run_task', { workspace: 'delve', task: 'ok' })).text, new RegExp(`succeeded \\(exit 0\\) after \\d+ s at commit ${sha('HEAD').slice(0, 10)}\\.`));
  await as('#91 in Delve')('git_sync', { workspace: 'delve', ref: 'main' });
  await refused(as('#90 in Citadel')('run_task', { workspace: 'delve', task: 'ok' }), new RegExp(`Not run: delve has moved since your git_sync\\. You checked out ${sha('origin/build-7').slice(0, 10)}; it is now at ${sha('origin/main').slice(0, 10)}, synced since by #91 in Delve\\. Run git_sync again`));
  assert.match((await as('#91 in Delve')('run_task', { workspace: 'delve', task: 'ok' })).text, /succeeded/, 'the one who synced last runs, and the workspace is free again');
  assert.match((await as('#92 in Peek')('run_task', { workspace: 'delve', task: 'ok' })).text, /succeeded/, 'one that never synced runs what is there');
  await as('#90 in Citadel')('git_sync', { workspace: 'delve', ref: 'build-7' });
  assert.match((await as('#90 in Citadel')('run_task', { workspace: 'delve', task: 'ok' })).text, /succeeded/, 'its own sync again lets it run');
});

test('the MCP side lists the tools and answers calls and unknown methods', async () => {
  const list = await workspaceReply(host, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'x');
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['workspaces', 'git_sync', 'run_task', 'job', 'stop_job', 'read_file', 'list_files', 'fetch_file']);
  const bad = await workspaceReply(host, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_task', arguments: { workspace: 'delve', task: 'nope' } } }, 'x');
  assert.equal(bad.result.isError, true);
  assert.equal((await workspaceReply(host, { jsonrpc: '2.0', id: 3, method: 'resources/list' }, 'x')).error.code, -32601);
  assert.equal(await workspaceReply(host, { jsonrpc: '2.0', method: 'notifications/initialized' }, 'x'), null);
  // An agent whose every workspace has git_sync off doesn't offer it.
  const vaultOnly = join(root, 'vault-only.json');
  writeFileSync(vaultOnly, JSON.stringify({ workspaces: { vault: { path: vault, git_sync: false } } }));
  const offered = await workspaceReply(new WorkspaceHost({ configFile: vaultOnly, jobsDir: join(root, 'jobs') }), { jsonrpc: '2.0', id: 4, method: 'tools/list' }, 'x');
  assert.deepEqual(offered.result.tools.map((t: any) => t.name), ['workspaces', 'run_task', 'job', 'stop_job', 'read_file', 'list_files', 'fetch_file']);
});

// A Windows test box (#369): tasks that take a minion's arguments, a stoppable app, one screen
// lock shared with the box's CI desktop jobs, and screenshots.
const lockFile = join(root, 'screen.lock');
const boxFile = join(root, 'box.json');
writeFileSync(boxFile, JSON.stringify({
  screen_lock: lockFile,
  screenshots: true,
  workspaces: {
    peek: {
      path: clone,
      tasks: {
        shell: { run: [node, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))'], args: true },
        build: { run: [node, '-e', 'console.log("built")'], screen: false },
        app: { run: [node, '-e', 'console.log("window up"); setInterval(() => {}, 1000)'] },
        typo: { run: ['x'], args: 'yes' },
      },
    },
  },
}));
const shots: string[] = [];
const box = new WorkspaceHost({
  configFile: boxFile,
  jobsDir: join(root, 'box-jobs'),
  // A screenshot waits a second in line here, not 50, and the line is looked at often.
  screenWaitS: 1,
  linePollMs: 30,
  capture: async (file: string, window: string) => {
    writeFileSync(file, 'PNG!');
    shots.push(window);
    return window ? `window "${window} - Peek Auras", 800x600` : 'the whole screen, 2400x1350';
  },
});
const boxCall = (tool: string, args: object = {}, who = '#121 in Peek Auras') => box.call(tool, args, who, async (name: string, bytes: Buffer) => `/srv/machine-files/${name}:${bytes.length}`);
const deadPid = Number(execFileSync(node, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
const holdLock = (pid: number, extra: object = {}) => writeFileSync(lockFile, JSON.stringify({ pid, what: 'desktop CI job', who: 'GitHub Actions (peek-auras)', since: Date.now(), ...extra }));

test('a task that takes arguments gets them as argv, no shell; others refuse them', async () => {
  assert.deepEqual([...box.workspaces.get('peek').tasks.keys()], ['shell', 'build', 'app']);
  assert.match(box.problems.join('\n'), /typo: "args" must be true or false/);
  const r = await boxCall('run_task', { workspace: 'peek', task: 'shell', args: ['a b', '--x', 'c;rm -rf /'] });
  assert.match(r.text, /\["a b","--x","c;rm -rf \/"\]/);
  assert.match((await boxCall('workspaces')).text, /- shell: .*…takes arguments/);
  await refused(boxCall('run_task', { workspace: 'peek', task: 'build', args: ['--release'] }), /takes no arguments/);
  assert.match((await boxCall('run_task', { workspace: 'peek', task: 'build', args: [] })).text, /succeeded/);
  await refused(boxCall('run_task', { workspace: 'peek', task: 'shell', args: 'cargo test' }), /list of at most/);
  await refused(boxCall('run_task', { workspace: 'peek', task: 'shell', args: [1] }), /list of at most/);
  assert.equal(box.summary().workspaces[0].tasks[0].args, true);
});

test('stop_job ends a launched app and frees the workspace and the screen', async () => {
  const started = await boxCall('run_task', { workspace: 'peek', task: 'app', wait: 1 });
  const id = started.text.match(/job (\w+)\)/)[1];
  assert.match(started.text, /still running[\s\S]*window up/);
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).who, '#121 in Peek Auras');
  const stopped = await boxCall('stop_job', { id }, '#121 in Peek Auras');
  assert.match(stopped.text, /app in peek FAILED \(Stopped by #121 in Peek Auras\)/);
  assert.equal(existsSync(lockFile), false);
  assert.match((await boxCall('run_task', { workspace: 'peek', task: 'build' })).text, /succeeded/);
  await refused(boxCall('stop_job', { id: 'nope' }), /No job nope/);
});

test('stop_job also ends what the task started, off Windows (a shell running a launcher, say)', { skip: process.platform === 'win32' }, async () => {
  const file = join(root, 'tree.json');
  writeFileSync(file, JSON.stringify({ workspaces: { tree: { path: clone, tasks: { launch: { run: ['sh', '-c', 'sleep 47 & echo "child $!"; wait'] } } } } }));
  const tree = new WorkspaceHost({ configFile: file, jobsDir: join(root, 'tree-jobs') });
  const started = await tree.call('run_task', { workspace: 'tree', task: 'launch', wait: 1 }, '#1', async () => '');
  const id = started.text.match(/job (\w+)\)/)[1];
  const pid = Number(started.text.match(/child (\d+)/)[1]);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    assert.equal(alive(), true);
    await tree.call('stop_job', { id }, '#1', async () => '');
    assert.equal(alive(), false, 'the sleep the shell started is gone too');
  } finally {
    if (alive()) process.kill(pid, 'SIGKILL');
  }
});

test('a task whose jobs folder can\'t be made fails without leaving its workspace busy', async () => {
  const file = join(root, 'nojobs.json');
  const jobsFile = join(root, 'jobs-is-a-file');
  writeFileSync(jobsFile, 'x');
  writeFileSync(file, JSON.stringify({ workspaces: { w: { path: clone, tasks: { t: { run: [node, '-e', '0'] } } } } }));
  const h = new WorkspaceHost({ configFile: file, jobsDir: jobsFile });
  const run = () => h.call('run_task', { workspace: 'w', task: 't' }, '#1', async () => '');
  await refused(run(), /EEXIST/);
  await refused(run(), /EEXIST/);
  assert.deepEqual([...h.busy.keys()], []);
});

const lineDir = join(root, 'screen-line');
/** A waiter in the screen's line as screen-lock.ps1 writes one: named by when it arrived. */
const ciWaiter = (pid: number, since: number, token = `ci-${pid}`) => {
  mkdirSync(lineDir, { recursive: true });
  const place = join(lineDir, `${String(since).padStart(15, '0')}-${token}.json`);
  writeFileSync(place, JSON.stringify({ pid, what: `desktop CI job ${token}`, who: 'GitHub Actions (caraminden/peek-auras)', since, token }));
  return place;
};
const jobId = (text: string) => text.match(/\(job (\w+)\)/)[1];

test('the screen\'s line (#1422): behind a live holder a screen task gets a place in line, not a refusal, and starts once the screen is free', async () => {
  holdLock(process.ppid);
  // A build doesn't touch the screen, so it runs beside a CI desktop job.
  assert.match((await boxCall('run_task', { workspace: 'peek', task: 'build' })).text, /succeeded/);
  const queued = await boxCall('run_task', { workspace: 'peek', task: 'shell', wait: 0.2 });
  assert.match(queued.text, /shell in peek is waiting in line for the screen \(job \w+\), \d+ s so far: desktop CI job for GitHub Actions \(peek-auras\) has the screen, started \d+ s ago; it is next, 1 in line\. Nothing has started yet/);
  const id = jobId(queued.text);
  // A screenshot waits behind it, inside its call, then refuses naming the holder and the line.
  await refused(boxCall('screenshot', {}, '#7 in Delve'), /The screen is busy: desktop CI job for GitHub Actions \(peek-auras\) has the screen, started \d+ s ago, and 1 other is in line \(1 ahead of this\)\. Waited 1 s/);
  const listed = (await boxCall('workspaces')).text;
  assert.match(listed, /Screen: busy, desktop CI job for GitHub Actions \(peek-auras\)/);
  assert.match(listed, /1 in line[\s\S]*1\. task shell in peek for #121 in Peek Auras/);
  assert.deepEqual(screenState(lockFile).line.map((w: any) => w.who), ['#121 in Peek Auras']);
  assert.match((await boxCall('job', { id, wait: 0.2 })).text, /waiting in line for the screen.*it is next, 1 in line/);

  rmSync(lockFile); // the CI job ends
  assert.match((await boxCall('job', { id, wait: 10 })).text, /shell in peek succeeded/);
  assert.equal(existsSync(lockFile), false, 'let go once done');
  assert.deepEqual(readdirSync(lineDir), [], 'and out of the line');
});

test('the screen\'s line serves CI jobs before minion tasks, each kind in arrival order', async () => {
  const ci = ciWaiter(process.ppid, Date.now() - 1000);
  const first = await boxCall('run_task', { workspace: 'peek', task: 'shell', wait: 0.2 });
  assert.match(first.text, /nobody has the screen this moment; 1 ahead of it, 2 in line/, 'the screen is free, but the CI job came first');
  const id = jobId(first.text);
  // A second CI job that arrives after the task still goes ahead of it; a second task stays behind the first.
  const later = ciWaiter(process.ppid, Date.now() + 5, 'ci-later');
  const second = joinScreenLine(lockFile, 'a screenshot', 'someone');
  const order = screenLine(lockFile).map((w: any) => w.what);
  assert.deepEqual(order.slice(0, 2), ['desktop CI job ci-' + process.ppid, 'desktop CI job ci-later']);
  assert.deepEqual(order.slice(2).map((w) => w.replace(/ in peek$/, '').replace(/^task shell.*/, 'task')), ['task', 'a screenshot']);
  // Both CI jobs take the screen in turn and leave; the first task is then next, and a running task isn't pre-empted.
  holdLock(process.ppid, { what: 'desktop CI job ci-1', who: 'GitHub Actions (caraminden/peek-auras)' });
  rmSync(ci);
  rmSync(later);
  leaveScreenLine(second);
  assert.match((await boxCall('job', { id, wait: 0.2 })).text, /desktop CI job ci-1 for GitHub Actions \(caraminden\/peek-auras\) has the screen.*; it is next, 1 in line/);
  rmSync(lockFile);
  assert.match((await boxCall('job', { id, wait: 10 })).text, /succeeded/);
});

test('the screen\'s line drops waiters that died or went quiet, and keeps a fresh one it can\'t read yet', () => {
  const old = (Date.now() - 2 * 60_000) / 1000;
  const live = ciWaiter(process.ppid, 3);
  const dead = ciWaiter(deadPid, 1);
  const quiet = ciWaiter(process.ppid, 2, 'ci-quiet');
  utimesSync(quiet, old, old);
  const writing = join(lineDir, '000000000000004-half.json');
  writeFileSync(writing, '{"pid":');
  const broken = join(lineDir, '000000000000005-broken.json');
  writeFileSync(broken, 'nope');
  utimesSync(broken, old, old);
  assert.deepEqual(screenLine(lockFile).map((w: any) => w.token), [`ci-${process.ppid}`]);
  assert.deepEqual(readdirSync(lineDir).sort(), [live, writing].map((p) => p.slice(lineDir.length + 1)).sort());
  rmSync(live);
  rmSync(writing);
});

test('a queued task leaves the line when stopped, or when its turn comes and nobody has asked after it for 3 minutes', async () => {
  holdLock(process.ppid);
  const a = jobId((await boxCall('run_task', { workspace: 'peek', task: 'shell', wait: 0 })).text);
  assert.match((await boxCall('stop_job', { id: a })).text, /FAILED \(Stopped by #121 in Peek Auras\)/);
  assert.deepEqual(readdirSync(lineDir), []);
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.ppid, 'the holder keeps the screen');

  const b = jobId((await boxCall('run_task', { workspace: 'peek', task: 'shell', wait: 0 })).text);
  box.jobs.get(b).seen = Date.now() - 4 * 60_000; // its minion's turn ended
  rmSync(lockFile);
  await until('the job to leave the line', () => box.jobs.get(b).ended);
  assert.match((await boxCall('job', { id: b })).text, /FAILED \(Left the screen's line: its turn came and nobody had called job for it in 3 minutes\. Nothing was started\.\)/);
  assert.equal(existsSync(lockFile), false, 'it never took the screen');
  assert.deepEqual(readdirSync(lineDir), []);
});

test('Citadel reads the agent\'s own words for a job waiting, running, ended and forgotten (#1425): the box never updates itself, so they must keep matching', async () => {
  holdLock(process.ppid);
  const id = JOB_WORDS.queued.exec((await boxCall('run_task', { workspace: 'peek', task: 'app', wait: 0 })).text)?.[1];
  assert.ok(id, 'waiting in line');
  rmSync(lockFile);
  assert.equal(JOB_WORDS.running.exec((await boxCall('job', { id, wait: 1 })).text)?.[1], id);
  assert.equal(JOB_WORDS.ended.exec((await boxCall('stop_job', { id })).text)?.[1], id);
  await refused(boxCall('job', { id: 'ffff0000' }), JOB_WORDS.gone);
});

test('the screen lock: a dead holder is taken over; an unreadable fresh one is waited on', async () => {
  holdLock(deadPid);
  assert.match((await boxCall('run_task', { workspace: 'peek', task: 'shell' })).text, /succeeded/);
  assert.equal(existsSync(lockFile), false);
  holdLock(process.ppid, { since: Date.now() - 3 * 60 * 60_000 });
  assert.match((await boxCall('run_task', { workspace: 'peek', task: 'shell' })).text, /succeeded/);
  writeFileSync(lockFile, '');
  const id = jobId((await boxCall('run_task', { workspace: 'peek', task: 'shell', wait: 0.2 })).text);
  assert.match((await boxCall('job', { id, wait: 0.1 })).text, /waiting in line/);
  const old = (Date.now() - 2 * 60_000) / 1000;
  utimesSync(lockFile, old, old); // unreadable and over a minute old: broken
  assert.match((await boxCall('job', { id, wait: 10 })).text, /succeeded/);
  assert.equal(existsSync(lockFile), false);
});

test('screenshots: off unless the owner turns them on, shared with the screen lock, copied to the app', async () => {
  await refused(call('screenshot'), /Screenshots are off on this computer/);
  const whole = await boxCall('screenshot', { delay: 0 });
  assert.match(whole.text, /Took the whole screen, 2400x1350 \(1 KB\) and copied it to \/srv\/machine-files\/screenshot-[\d-TZ]+\.png:4 /);
  assert.equal(existsSync(lockFile), false);
  assert.deepEqual(readdirSync(join(root, 'box-jobs')).filter((f) => f.endsWith('.png')), []);

  // The minion whose app holds the screen can look at it; another minion waits.
  const started = await boxCall('run_task', { workspace: 'peek', task: 'app', wait: 0 });
  const id = started.text.match(/job (\w+)\)/)[1];
  assert.match((await boxCall('screenshot', { window: 'Peek' })).text, /Took window "Peek - Peek Auras", 800x600/);
  await refused(boxCall('screenshot', {}, '#7 in Delve'), /screen is busy: task app in peek for #121 in Peek Auras has the screen, started \d+ s ago\. Waited 1 s; nothing was taken\. A screenshot waits only inside its own call\. To see your app, start it with run_task: a screen task keeps its place in line/);
  await assert.rejects(boxCall('screenshot', {}, '#7 in Delve'), (err: Error) => !/try again|retry/i.test(err.message), 'a busy screen never says to retry by hand (#1819)');
  await boxCall('stop_job', { id });
  assert.deepEqual(shots, ['', 'Peek']);
  await refused(boxCall('screenshot', { window: 'x'.repeat(201) }), /at most 200/);

  const offered = await workspaceReply(box, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, 'x');
  assert.ok(offered.result.tools.some((t: any) => t.name === 'screenshot'));
  if (process.platform !== 'win32') {
    const real = new WorkspaceHost({ configFile: boxFile, jobsDir: join(root, 'box-jobs') });
    await refused(real.call('screenshot', {}, 'x', async () => ''), /only on a Windows computer/);
  }
});
