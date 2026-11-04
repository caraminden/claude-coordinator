// The setup lines the Machines page drafts: the folder step really writes machine-agent.json (#305), and
// the background setups (#309) install a service that keeps running once the window is closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanFolder, machineSetup, machineSetupBackground, machineSetupWindows, workspaceName } from '../public/machine-setup.js';
import { backgroundService } from '../public/machine-agent.mjs';

const root = mkdtempSync(join(tmpdir(), 'machine-setup-'));
let n = 0;

/** A fresh agent folder and a vault folder (with spaces and both quotes in its name) inside it. */
function dirs(git = false) {
  const agent = join(root, `agent-${++n}`);
  const vault = join(agent, `My "Notes" it's ${n}`);
  mkdirSync(vault, { recursive: true });
  if (git) mkdirSync(join(vault, '.git'));
  return { agent, vault, file: join(agent, 'machine-agent.json') };
}

/** Runs the terminal snippet's folder step (the lines between the download and the agent) with sh. */
function runPosix(agent, folder) {
  const lines = machineSetup('https://app.example', 'ccm_1_x', 'none', '', folder).split('\n');
  assert.match(lines[0], /^curl /);
  assert.match(lines.at(-1), /^node machine-agent\.mjs https:\/\/app\.example ccm_1_x --config machine-agent\.json$/);
  const step = lines.slice(1, -1).join('\n').replace(/ &&$/, '');
  return spawnSync('sh', ['-c', step], { cwd: agent, encoding: 'utf8' });
}

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('workspace names come from the folder\'s last part', () => {
  assert.equal(workspaceName('C:\\Users\\Josh\\Documents\\Vault\\'), 'vault');
  assert.equal(workspaceName('/home/josh/My Notes!/'), 'my-notes');
  assert.equal(workspaceName('~/Obsidian/Josh_Vault'), 'josh_vault');
  assert.equal(workspaceName('/'), 'folder');
  assert.equal(cleanFolder(' C:\\Vault\\\\ '), 'C:\\Vault');
  assert.equal(cleanFolder('C:\\'), 'C:\\');
  assert.equal(cleanFolder('/'), '/');
});

test('without a folder the snippets are what they were, and None lends no MCP server', () => {
  assert.equal(machineSetup('https://a', 't', 'claude', ''), 'curl -fsSLO https://a/machine-agent.mjs\nnode machine-agent.mjs https://a t --config machine-agent.json --claude-mcp godot-ai');
  assert.match(machineSetup('https://a', 't', 'command', 'npx -y x'), / --config machine-agent\.json -- npx -y x$/);
  const win = machineSetupWindows('https://a', 'pc', 't', 'none', '');
  assert.doesNotMatch(win, /CC_WORKSPACE_SETUP|--claude-mcp/);
  assert.match(win, /--config `"\$dir\\machine-agent\.json`" --log `"\$log`""\n/);
});

test('the terminal folder step creates the file, with no pull task for a plain folder', () => {
  const { agent, vault, file } = dirs();
  const run = runPosix(agent, vault);
  assert.equal(run.status, 0, run.stderr);
  const name = workspaceName(vault);
  assert.deepEqual(read(file), { workspaces: { [name]: { path: vault, tasks: {} } } });
  assert.match(run.stdout, new RegExp(`Workspace ${name} is `));
});

test('a git repo gets the pull task with git_sync off, and a second run keeps what the owner added', () => {
  const { agent, vault, file } = dirs(true);
  writeFileSync(file, JSON.stringify({ workspaces: { godot: { path: '/elsewhere', tasks: { build: { run: ['make'] } } } } }));
  assert.equal(runPosix(agent, `${vault}/`).status, 0);
  const name = workspaceName(vault);
  let config = read(file);
  assert.deepEqual(config.workspaces.godot, { path: '/elsewhere', tasks: { build: { run: ['make'] } } }, 'other workspaces stay as they were');
  assert.equal(config.workspaces[name].path, vault);
  assert.deepEqual(config.workspaces[name].tasks.pull.run, ['git', 'pull', '--ff-only']);
  assert.deepEqual(config.workspaces[name].tasks.pull.hints, [{ match: 'index.lock', say: 'Obsidian Git is mid-commit; wait 5 s and run pull again.' }]);
  assert.equal(config.workspaces[name].git_sync, false);

  // The owner edits it by hand, then sets the machine up again with a new token.
  config.workspaces[name].tasks.pull.about = 'mine';
  config.workspaces[name].tasks.lint = { run: ['npm', 'run', 'lint'] };
  config.workspaces[name].git_sync = true;
  writeFileSync(file, JSON.stringify(config));
  assert.equal(runPosix(agent, vault).status, 0);
  assert.deepEqual(read(file), config);
});

test('the terminal folder step refuses a missing folder or a broken file and leaves the file alone', () => {
  const { agent, vault, file } = dirs();
  let run = runPosix(agent, join(vault, 'nope'));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /is not a folder on this computer/);
  assert.equal(spawnSync('test', ['-e', file]).status, 1);
  writeFileSync(file, '{ not json');
  run = runPosix(agent, vault);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /is not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
  for (const text of ['[]', 'null', '{"workspaces":[]}']) {
    writeFileSync(file, text);
    run = runPosix(agent, vault);
    assert.equal(run.status, 1, text);
    assert.match(run.stderr, /does not hold/);
    assert.equal(readFileSync(file, 'utf8'), text);
  }
});

test('a folder that moves keeps its workspace name and says where it was', () => {
  const { agent, vault, file } = dirs();
  writeFileSync(file, JSON.stringify({ workspaces: { [workspaceName(vault)]: { path: '/old/place', tasks: {} } } }));
  const run = runPosix(agent, vault);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /\(it was \/old\/place\)/);
  assert.equal(read(file).workspaces[workspaceName(vault)].path, vault);
});

test('the Windows folder step runs the same script from a literal here-string, before the task is registered', () => {
  const win = machineSetupWindows('https://a', 'pc', 'ccm_1_x', 'none', '', 'C:\\Users\\Jo O\'Neil\\Documents\\Vault\\');
  const lines = win.split('\n');
  const open = lines.indexOf("$env:CC_WORKSPACE_SETUP = @'");
  const close = lines.indexOf("'@");
  assert.ok(open > 0 && close > open);
  assert.ok(!lines.slice(open + 1, close).some((l) => l.startsWith("'@")), 'nothing ends the here-string early');
  assert.equal(lines[open + 1], 'const file = process.argv[1], { folder, name } = {"folder":"C:\\\\Users\\\\Jo O\'Neil\\\\Documents\\\\Vault","name":"vault"};');
  assert.ok(win.indexOf('if ($code) { throw') < win.indexOf('Register-ScheduledTask'));
  assert.match(win, /-Argument "--headless `"\$node`" `"\$dir\\machine-agent\.mjs`" https:\/\/a ccm_1_x --config `"\$dir\\machine-agent\.json`" --log `"\$log`""/);

  // What node gets on Windows, run here against a local folder: the body through the environment.
  const { agent, vault, file } = dirs(true);
  const local = machineSetupWindows('https://a', 'pc', 't', 'none', '', vault).split('\n');
  const body = local.slice(local.indexOf("$env:CC_WORKSPACE_SETUP = @'") + 1, local.indexOf("'@")).join('\n');
  execFileSync(process.execPath, ['-e', 'eval(process.env.CC_WORKSPACE_SETUP)', file], { env: { ...process.env, CC_WORKSPACE_SETUP: body } });
  assert.deepEqual(read(file).workspaces[workspaceName(vault)].tasks.pull.run, ['git', 'pull', '--ff-only']);
});

/**
 * Runs the macOS/Linux background lines in sh, as pasted, with HOME in a temp folder: curl hands over
 * this repo's agent, and systemctl only notes what it was asked, writing `said` to the agent's log
 * when asked to restart it, as the started agent would.
 */
function runBackground({ folder, said = 'Connected to app.example as "pc".', systemctl = 0, kind = 'claude', what = '' } = {}) {
  const home = mkdtempSync(join(root, 'home-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const agentFile = join(import.meta.dirname, '..', 'public', 'machine-agent.mjs');
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\ncp ${JSON.stringify(agentFile)} machine-agent.mjs\n`);
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
echo "$*" >> "$HOME/systemctl-calls"
case "$*" in *restart*) echo ${posixQuote(said)} >> "$HOME/coordinator-agent/machine-agent-pc.log";; esac
exit ${systemctl}
`);
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'systemctl'), 0o755);
  // A Claude Code config with godot-ai, as its dock's Configure button leaves it.
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'godot-ai': { command: 'uvx', args: ['godot-ai'] } } }));
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home };
  const lines = machineSetupBackground('https://app.example', 'pc', 'ccm_1_x', kind, what, folder);
  const run = spawnSync('sh', ['-c', lines], { cwd: root, env, encoding: 'utf8' });
  const unit = join(home, '.config', 'systemd', 'user', 'coordinator-agent-pc.service');
  return { run, home, unit, calls: existsSync(join(home, 'systemctl-calls')) ? readFileSync(join(home, 'systemctl-calls'), 'utf8') : '' };
}
const posixQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

test('the macOS/Linux lines install a systemd user unit that keeps running, with the folder step first', () => {
  const { vault } = dirs(true);
  const { run, home, unit, calls } = runBackground({ folder: vault });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const dir = join(home, 'coordinator-agent');
  assert.equal(read(join(dir, 'machine-agent.json')).workspaces[workspaceName(vault)].path, vault, 'the folder step wrote the agent folder\'s file');
  assert.equal(calls, '--user daemon-reload\n--user enable coordinator-agent-pc.service\n--user restart coordinator-agent-pc.service\n');
  assert.equal(statSync(unit).mode & 0o777, 0o600, 'the unit holds the token');
  const text = readFileSync(unit, 'utf8');
  assert.match(text, new RegExp(`^ExecStart="${process.execPath}" "${dir}/machine-agent\\.mjs" "https://app\\.example" "ccm_1_x" "--config" "${dir}/machine-agent\\.json" "--claude-mcp" "godot-ai" "--log" "${dir}/machine-agent-pc\\.log"$`, 'm'));
  assert.match(text, /^Restart=always$/m);
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.ok(text.includes(`Environment="PATH=${home}/bin:`), 'the service finds what the shell that set it up found');
  assert.match(run.stdout, /Connected to app\.example/);
  assert.match(run.stdout, /runs in the background now/);
  assert.match(run.stdout, /loginctl enable-linger/);
  assert.ok(run.stdout.includes(`tail -f ${dir}/machine-agent-pc.log`));
  assert.match(run.stdout, /Stop it: systemctl --user stop coordinator-agent-pc\.service/);
});

test('a lent command keeps its own arguments after the log option, quoted as systemd reads them', () => {
  const { run, unit } = runBackground({ kind: 'command', what: 'npx -y some-mcp 100%' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(unit, 'utf8'), /"--log" "[^"]+machine-agent-pc\.log" "--" "npx" "-y" "some-mcp" "100%%"$/m);
});

test('the background lines say so when the agent is refused, or there is no systemd user session', () => {
  let { run } = runBackground({ said: 'The app rejected this token. Make a new one in the Machines panel.' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /rejected this token[\s\S]*has not connected yet/);
  ({ run } = runBackground({ systemctl: 1 }));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no systemd user session/);
  // A server Claude Code doesn't have stops it before anything is installed.
  const missing = runBackground({ what: 'nope' });
  assert.equal(missing.run.status, 2);
  assert.match(missing.run.stderr, /no stdio MCP server named "nope"/);
  assert.equal(existsSync(missing.unit), false);
});

test('on macOS it is a launchd agent that starts at login and again if it stops', () => {
  const s = backgroundService({
    platform: 'darwin', home: '/Users/jo', uid: 501, name: 'mac', env: { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/jo' },
    argv: ['/opt/homebrew/bin/node', '/Users/jo/coordinator-agent/machine-agent.mjs', 'https://a', 't', '--', 'run', 'a&b<c>'],
  });
  assert.equal(s.file, '/Users/jo/Library/LaunchAgents/coordinator-agent.mac.plist');
  assert.deepEqual(s.before, [['launchctl', 'bootout', 'gui/501/coordinator-agent.mac']]);
  assert.deepEqual(s.start, [['launchctl', 'bootstrap', 'gui/501', s.file]]);
  const args = [...s.text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>(.*)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(args, ['/opt/homebrew/bin/node', '/Users/jo/coordinator-agent/machine-agent.mjs', 'https://a', 't', '--log', '/Users/jo/coordinator-agent/machine-agent-mac.log', '--', 'run', 'a&amp;b&lt;c&gt;']);
  assert.match(s.text, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(s.text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(s.text, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
});

test('--log copies what the agent prints to a file, a refusal included', async () => {
  const server = createServer((req, res) => res.writeHead(401).end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const log = join(mkdtempSync(join(root, 'log-')), 'agent.log');
    const agent = join(import.meta.dirname, '..', 'public', 'machine-agent.mjs');
    // Not spawnSync: this process answers the agent.
    const code = await new Promise((r) => execFile(process.execPath, [agent, `http://127.0.0.1:${server.address().port}`, 't', '--config', join(root, 'none.json'), '--log', log], { timeout: 20_000 }, (err) => r(err?.code ?? 0)));
    assert.equal(code, 1);
    const text = readFileSync(log, 'utf8');
    assert.match(text, /^--- started \d{4}-/);
    assert.match(text, /No workspaces in /);
    assert.match(text, /The app rejected this token/);
  } finally {
    server.close();
  }
});

test('the Windows task runs hidden, logs, replaces a running copy and shows what it logged', () => {
  const win = machineSetupWindows('https://a', 'pc', 'ccm_1_x', 'claude', '', '');
  assert.match(win, /-Execute "\$env:SystemRoot\\System32\\conhost\.exe" -WorkingDirectory \$dir -Argument "--headless `"\$node`" `"\$dir\\machine-agent\.mjs`" https:\/\/a ccm_1_x --config `"\$dir\\machine-agent\.json`" --log `"\$log`" --claude-mcp godot-ai"/);
  assert.match(win, /\$log = "\$dir\\machine-agent-pc\.log"/);
  const at = (s) => win.indexOf(s);
  assert.ok(at('Stop-ScheduledTask -TaskName "Coordinator agent (pc)" -ErrorAction SilentlyContinue') < at('Register-ScheduledTask'));
  // Restart-on-failure misses an agent that is killed: a 5-minute trigger starts it again, skipped while it runs.
  assert.match(win, /-MultipleInstances IgnoreNew/);
  assert.match(win, /\$triggers = \(New-ScheduledTaskTrigger -AtLogOn -User \$env:USERNAME\), \(New-ScheduledTaskTrigger -Once -At \(Get-Date\) -RepetitionInterval \(New-TimeSpan -Minutes 5\) -RepetitionDuration \(New-TimeSpan -Days 3650\)\)/);
  assert.match(win, /Register-ScheduledTask -Force -TaskName "Coordinator agent \(pc\)" -Action \$action -Trigger \$triggers /);
  // So stopping it disables the task too, and quotes inside the printed lines are doubled for PowerShell.
  assert.match(win, /'Stop it: Disable-ScheduledTask -TaskName "Coordinator agent \(pc\)" \| Out-Null; Stop-ScheduledTask [^\n]*-Filter "Name=''node\.exe''" [^\n]*machine-agent-pc\.log[^\n]*'\n/);
  assert.ok(at('$skip = @(Get-Content $log') < at('Start-ScheduledTask -TaskName "Coordinator agent (pc)"'));
  assert.ok(at('Start-ScheduledTask -TaskName "Coordinator agent (pc)"') < at('foreach ($i in 1..40)'));
  assert.match(win, /'Its output: Get-Content -Wait -Encoding UTF8 "\$env:USERPROFILE\\coordinator-agent\\machine-agent-pc\.log"'/);
  assert.match(win, /'Remove it: Unregister-ScheduledTask -TaskName "Coordinator agent \(pc\)" -Confirm:\$false; Get-CimInstance /);
  assert.match(win, /\n}$/);
});
