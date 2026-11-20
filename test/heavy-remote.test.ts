import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { commandLine, freshLines, parseJob, parseWorkspaces } from '../tools/heavy-remote.ts';

// citadel-heavy --on <machine> (#1160): the parts of tools/heavy-remote.ts that read the machine agent's replies.
const workspaces = `## peek-auras
Folder: C:\\work\\peek-auras
Checked out: detached at 259d5fbc #680: crash dumps
Local changes:
?? e2e-gap/
Busy: no
Tasks:
- run: mise exec -- powershell.exe -NoProfile -NonInteractive -Command …takes arguments (with the screen)
- build: mise exec -- powershell.exe -NoProfile -NonInteractive -Command …takes arguments (no screen)
- lint: cargo clippy

## claude-coordinator
Folder: /home/cara/work/claude-coordinator
Checked out: detached at 649f766e
Busy: task build for #12 in Citadel, 40 s (job 1a2b3c4d)
Tasks:
- heavy: bash -lc …takes arguments (a shell command line)

Screen: busy, desktop CI job e2e.`;

test('it reads each workspace, whether it is busy, and its tasks that take a command', () => {
  const [peek, citadel] = parseWorkspaces(workspaces);
  assert.equal(peek.name, 'peek-auras');
  assert.equal(peek.busy, false);
  assert.deepEqual([...peek.tasks.keys()], ['run', 'build'], 'lint takes no arguments, so it is left out');
  assert.equal(peek.tasks.get('build')!.powershell, true);
  assert.equal(citadel.name, 'claude-coordinator');
  assert.equal(citadel.busy, true);
  assert.equal(citadel.tasks.get('heavy')!.powershell, false);
});

test('it quotes the command for a POSIX shell or for PowerShell, passing a native exit status on', () => {
  assert.equal(commandLine(['cargo', 'test', '-p', 'peek-core', '--locked'], false), 'cargo test -p peek-core --locked');
  assert.equal(commandLine(['sh', '-c', "echo 'hi' && exit 3"], false), `sh -c 'echo '\\''hi'\\'' && exit 3'`);
  assert.equal(commandLine(['cargo', 'build'], true), 'cargo build; if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }');
  assert.equal(commandLine(['C:\\Program Files\\x.exe', "it's"], true), `& 'C:\\Program Files\\x.exe' 'it''s'; if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`);
});

test('it tells a running job from an ended one, with its status and lines', () => {
  const running = parseJob('build in peek-auras is still running after 52 s (job 0a1b2c3d). Call job with id "0a1b2c3d" to wait for it.\n--- latest output ---\n   Compiling a\n   Compiling b');
  assert.deepEqual({ id: running.id, running: running.running, lines: running.lines }, { id: '0a1b2c3d', running: true, lines: ['   Compiling a', '   Compiling b'] });
  const ok = parseJob('build in peek-auras succeeded (exit 0) after 90 s. Job 0a1b2c3d; full log on that computer: C:\\jobs\\0a1b2c3d.log\n--- last 2 lines ---\ntest result: ok\ndone');
  assert.deepEqual({ id: ok.id, running: ok.running, code: ok.code, lines: ok.lines }, { id: '0a1b2c3d', running: false, code: 0, lines: ['test result: ok', 'done'] });
  assert.equal(parseJob('build in x FAILED (exit 101) after 3 s. Job ff; full log on that computer: /j.log\nhint\n--- last 1 lines ---\nboom').code, 101);
  assert.equal(parseJob('build in x FAILED (Stopped after 30 minutes) after 1800 s. Job ff; full log on that computer: /j.log\n--- last 0 lines ---\n').code, 1);
});

test('streaming prints only the lines it has not printed, and says when some were skipped', () => {
  assert.deepEqual(freshLines([], ['a', 'b']), { lines: ['a', 'b'], gap: false });
  assert.deepEqual(freshLines(['a', 'b'], ['b', 'c', 'd']), { lines: ['c', 'd'], gap: false });
  assert.deepEqual(freshLines(['a', 'b', 'c'], ['a', 'b', 'c']), { lines: [], gap: false });
  assert.deepEqual(freshLines(['a', 'b'], ['x', 'y']), { lines: ['x', 'y'], gap: true });
});

const root = mkdtempSync(join(tmpdir(), 'heavy-remote-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('citadel-heavy --on a machine this turn was not lent runs the command here, and says why', () => {
  const heavy = join(import.meta.dirname, '..', 'tools', 'citadel-heavy');
  const env = { ...process.env, CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_DIR: join(root, 'locks'), CITADEL_HEAVY_MACHINES: 'citadel-test-box=7', CITADEL_HEAVY_PRESSURE: join(root, 'none'), CITADEL_HEAVY_POLL: '0.1' };
  const r = spawnSync(heavy, ['--on', 'desktop', 'sh', '-c', 'echo here; exit 4'], { env, encoding: 'utf8' });
  assert.equal(r.status, 4);
  assert.equal(r.stdout, 'here\n');
  assert.match(r.stderr, /cara-desktop-heavy isn't lent to this turn with workspace tools \(lent: citadel-test-box\); running it here instead/);
  assert.match(readFileSync(join(root, 'locks', 'history'), 'utf8'), /\tnone\t\d+\t\d+\t4\t-\n$/, 'it ran in a slot here');
  assert.equal(spawnSync(heavy, ['--on', 'desktop'], { env }).status, 2);
});

// A fake Citadel with one lent machine, speaking the session route's SSE and POST the way src/routes/machines.ts does.
async function fakeMachine(tool: (name: string, args: any) => string) {
  const calls: { name: string; args: any }[] = [];
  let stream: import('node:http').ServerResponse | null = null;
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"session":"s1"}\n\n');
      stream = res;
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      const { message } = JSON.parse(body);
      res.writeHead(202).end();
      if (message.id === undefined) return;
      let result: object = {};
      if (message.method === 'tools/call') {
        calls.push({ name: message.params.name, args: message.params.arguments });
        result = { content: [{ type: 'text', text: tool(message.params.name, message.params.arguments) }] };
      }
      stream!.write(`data: ${JSON.stringify({ message: { jsonrpc: '2.0', id: message.id, result } })}\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { calls, api: `http://127.0.0.1:${(server.address() as any).port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

const repo = join(root, 'proj');
mkdirSync(repo);
for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://example.invalid/me/proj.git'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']]) spawnSync('git', args, { cwd: repo });
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
const proj = `## proj\nFolder: /w/proj\nBusy: task heavy for #3 in Citadel, 9 s (job 99)\nTasks:\n- heavy: bash -lc …takes arguments (a shell command line)\n\n## proj-2\nFolder: /w/proj-2\nBusy: no\nTasks:\n- heavy: bash -lc …takes arguments (a shell command line)\n\n## projector\nBusy: no\nTasks:\n- heavy: bash -lc …takes arguments\n`;

async function heavyOn(api: string, locks: string) {
  const env = { ...process.env, CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_DIR: join(root, locks), CITADEL_HEAVY_MACHINES: 'box=5', COORDINATOR_API: api, COORDINATOR_TOKEN: 't', CITADEL_HEAVY_PRESSURE: join(root, 'none') };
  const child = spawn(join(import.meta.dirname, '..', 'tools', 'citadel-heavy'), ['--on', 'box', 'sh', '-c', 'echo local-ran; exit 7'], { cwd: repo, env });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const status = await new Promise<number | null>((r) => child.on('close', r));
  return { status, stdout, stderr, history: readFileSync(join(root, locks, 'history'), 'utf8') };
}

test('a job on the machine runs in the first free workspace of the repo, streams back, and its own exit 120 is not a fallback', async () => {
  const m = await fakeMachine((name) => ({
    workspaces: proj,
    git_sync: 'proj-2 is at ' + head.slice(0, 8),
    run_task: 'heavy in proj-2 is still running after 50 s (job ab12). Call job with id "ab12" to wait for it.\n--- latest output ---\none\ntwo',
    job: 'heavy in proj-2 FAILED (exit 120) after 60 s. Job ab12; full log on that computer: /j.log\n--- last 3 lines ---\none\ntwo\nthree',
  })[name]!);
  try {
    const r = await heavyOn(m.api, 'locks-ok');
    assert.equal(r.status, 120, r.stderr);
    assert.equal(r.stdout, 'one\ntwo\nthree\n', 'the lines once each, and nothing ran here');
    assert.deepEqual(m.calls.map((c) => c.name), ['workspaces', 'git_sync', 'run_task', 'job']);
    assert.deepEqual(m.calls[1].args, { workspace: 'proj-2', ref: head }, 'proj is busy and projector is another repo');
    assert.deepEqual(m.calls[2].args.args, [`sh -c 'echo local-ran; exit 7'`]);
    assert.match(r.history, /\ton:box\t0\t\d+\t120\t-\n$/);
  } finally {
    m.close();
  }
});

test('a job lost after it started is stopped there, not run a second time here', async () => {
  const m = await fakeMachine((name) => ({
    workspaces: proj.replace('Busy: task heavy for #3 in Citadel, 9 s (job 99)', 'Busy: no'),
    git_sync: 'ok',
    run_task: 'heavy in proj is still running after 50 s (job ab12).\n--- latest output ---\none',
    job: 'No job ab12 on this computer.',
    stop_job: 'Stopped.',
  })[name]!);
  try {
    const r = await heavyOn(m.api, 'locks-lost');
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, 'one\n');
    assert.match(r.stderr, /lost job ab12 on box.*stopping job ab12/s);
    assert.deepEqual(m.calls.at(-1), { name: 'stop_job', args: { id: 'ab12' } });
    assert.equal(m.calls[1].args.workspace, 'proj');
  } finally {
    m.close();
  }
});
