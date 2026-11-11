// The install line the Machines page drafts (#439): one per kind of computer, always the background install (#309),
// with nothing in it about what the machine lends, which is ticked on the page once its agent reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineSetupPosix, machineSetupRunnerAgent, machineSetupWindows } from '../public/machine-setup.js';
import { backgroundService, claudeServerNames, cmdLine, loadConfig } from '../public/machine-agent.mjs';

const root = mkdtempSync(join(tmpdir(), 'machine-setup-'));

test('the install lines name no MCP server and no folder: the page ticks those later', () => {
  assert.equal(machineSetupPosix('https://a', 'pc', 't'),
    'mkdir -p ~/coordinator-agent && cd ~/coordinator-agent &&\ncurl -fsSLO https://a/machine-agent.mjs &&\nnode machine-agent.mjs https://a t --config machine-agent.json --install pc');
  const win = machineSetupWindows('https://a', 'pc', 't');
  assert.doesNotMatch(win, /CC_WORKSPACE_SETUP|--claude-mcp| -- /);
  assert.match(win, /--config `"\$dir\\machine-agent\.json`" --log `"\$log`""\n/);
});

test('the agent finds Claude Code\'s stdio servers by name only, in every scope', () => {
  const home = mkdtempSync(join(root, 'names-'));
  const env = { CLAUDE_CONFIG_DIR: home };
  assert.deepEqual(claudeServerNames(env), [], 'no config is no servers');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'godot-ai': { command: 'uvx', args: ['godot-ai'], env: { KEY: 'secret-value' } }, remote: { type: 'http', url: 'https://x' }, 'bad name!': { command: 'x' } },
    projects: { '/a': { mcpServers: { blender: { command: 'blender-mcp' }, 'godot-ai': { command: 'other' } } }, '/b': {} },
  }));
  assert.deepEqual(claudeServerNames(env), ['blender', 'godot-ai'], 'stdio ones, each once; an http server and a name the app would refuse are left out');
  assert.doesNotMatch(JSON.stringify(claudeServerNames(env)), /secret-value|uvx|blender-mcp/);
  writeFileSync(join(home, '.claude.json'), 'not json');
  assert.deepEqual(claudeServerNames(env), []);
});

test('machine-agent.json lists the owner\'s own servers as a program and its arguments', () => {
  const file = join(mkdtempSync(join(root, 'servers-')), 'machine-agent.json');
  writeFileSync(file, JSON.stringify({ servers: { godot: { run: ['uvx', 'godot-ai', 'attach'] }, shelly: { run: 'uvx godot-ai' }, 'no good': { run: ['x'] }, empty: { run: [] } } }));
  const { servers, problems } = loadConfig(file);
  assert.deepEqual([...servers], [['godot', { run: ['uvx', 'godot-ai', 'attach'] }]]);
  assert.equal(problems.length, 3, 'a string to run through a shell, a bad name and an empty list are each left out with a problem');
  assert.match(problems.join('\n'), /server shelly: "run" must be a list/);
});

/**
 * Runs the macOS/Linux background lines in sh, as pasted, with HOME in a temp folder: curl hands over
 * this repo's agent, and systemctl only notes what it was asked, writing `said` to the agent's log
 * when asked to restart it, as the started agent would.
 */
function runBackground({ said = 'Connected to app.example as "pc".', systemctl = 0 } = {}) {
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
  const lines = machineSetupPosix('https://app.example', 'pc', 'ccm_1_x');
  const run = spawnSync('sh', ['-c', lines], { cwd: root, env, encoding: 'utf8' });
  const unit = join(home, '.config', 'systemd', 'user', 'coordinator-agent-pc.service');
  return { run, home, unit, calls: existsSync(join(home, 'systemctl-calls')) ? readFileSync(join(home, 'systemctl-calls'), 'utf8') : '' };
}
const posixQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

test('the macOS/Linux line installs a systemd user unit that keeps running, with nothing lent on its command line', () => {
  const { run, home, unit, calls } = runBackground();
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const dir = join(home, 'coordinator-agent');
  assert.equal(calls, '--user daemon-reload\n--user enable coordinator-agent-pc.service\n--user restart coordinator-agent-pc.service\n');
  assert.equal(statSync(unit).mode & 0o777, 0o600, 'the unit holds the token');
  const text = readFileSync(unit, 'utf8');
  assert.match(text, new RegExp(`^ExecStart="${process.execPath}" "${dir}/machine-agent\\.mjs" "https://app\\.example" "ccm_1_x" "--config" "${dir}/machine-agent\\.json" "--log" "${dir}/machine-agent-pc\\.log"$`, 'm'));
  assert.match(text, /^Restart=always$/m);
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.ok(text.includes(`Environment="PATH=${home}/bin:`), 'the service finds what the shell that set it up found');
  assert.match(run.stdout, /Connected to app\.example/);
  assert.match(run.stdout, /runs in the background now/);
  assert.match(run.stdout, /loginctl enable-linger/);
  assert.ok(run.stdout.includes(`tail -f ${dir}/machine-agent-pc.log`));
  assert.match(run.stdout, /Stop it: systemctl --user stop coordinator-agent-pc\.service/);
});

test('an agent set up the old way keeps its command\'s arguments after the log option, quoted as systemd reads them', () => {
  const s = backgroundService({ platform: 'linux', home: '/home/jo', uid: 1000, name: 'pc', env: {}, argv: ['/usr/bin/node', '/home/jo/a/machine-agent.mjs', 'https://a', 't', '--', 'npx', '-y', 'some-mcp', '100%'] });
  assert.match(s.text, /"--log" "[^"]+machine-agent-pc\.log" "--" "npx" "-y" "some-mcp" "100%%"$/m);
});

test('the background lines say so when the agent is refused, or there is no systemd user session', () => {
  let { run } = runBackground({ said: 'The app rejected this token. Make a new one in the Machines panel.' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /rejected this token[\s\S]*has not connected yet/);
  ({ run } = runBackground({ systemctl: 1 }));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no systemd user session: run the same line without --install/);
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
  const win = machineSetupWindows('https://a', 'pc', 'ccm_1_x');
  assert.match(win, /-Execute "\$env:SystemRoot\\System32\\conhost\.exe" -WorkingDirectory \$dir -Argument "--headless `"\$node`" `"\$dir\\machine-agent\.mjs`" https:\/\/a ccm_1_x --config `"\$dir\\machine-agent\.json`" --log `"\$log`""/);
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

test('systemd gets % doubled everywhere, but $ only in ExecStart, where it expands', () => {
  const s = backgroundService({ platform: 'linux', home: '/home/jo', uid: 1000, name: 'pc', env: { PATH: '/opt/$x/bin:/usr/bin' }, argv: ['/usr/bin/node', '/home/jo/a/machine-agent.mjs', 'https://a', 't$1', '--', 'run', '5%'] });
  assert.match(s.text, /^Environment="PATH=\/opt\/\$x\/bin:\/usr\/bin"$/m);
  assert.match(s.text, /^ExecStart="\/usr\/bin\/node" "\/home\/jo\/a\/machine-agent\.mjs" "https:\/\/a" "t\$\$1" "--log" "\/home\/jo\/a\/machine-agent-pc\.log" "--" "run" "5%%"$/m);
});

test('the runner agent line carries the real address and token, nothing to edit', () => {
  const t = machineSetupRunnerAgent('http://10.0.0.5:8574/', 'ccm_12_abc');
  assert.ok(t.startsWith("$u = 'http://10.0.0.5:8574';"));
  assert.match(t, /-CitadelUrl \$u -MachineToken 'ccm_12_abc'$/);
  assert.doesNotMatch(t, /perigee|…|</);
});

// Windows only (not run here): an MCP server from the config file, or after --, starts through cmd.exe, since
// npx and friends are .cmd files. Node's shell option joins the program and its arguments with bare spaces, so
// the agent hands it one line with each argument quoted and cmd's special characters escaped (as cross-spawn does).
test('a server started through cmd.exe on Windows gets each argument quoted, so spaces and & ; | stay literal', () => {
  assert.equal(cmdLine('npx', ['-y', 'godot mcp', 'a&b;echo x|y']), 'npx ^"-y^" ^"godot^ mcp^" ^"a^&b^;echo^ x^|y^"');
  // Quotes inside an argument, and backslashes before a quote or at the end, as the program's own parser reads them.
  assert.equal(cmdLine('uvx', ['say "hi"', 'C:\\dir\\', 'a\\"b']), 'uvx ^"say^ \\^"hi\\^"^" ^"C:\\dir\\\\^" ^"a\\\\\\^"b^"');
  assert.equal(cmdLine('C:\\Program Files\\nodejs\\npx.cmd', ['%PATH%', '!x!', '(y)']), 'C:\\Program^ Files\\nodejs\\npx.cmd ^"^%PATH^%^" ^"^!x^!^" ^"^(y^)^"');
  // An npm shim under node_modules\.bin hands its arguments to cmd a second time, so they are escaped twice.
  assert.equal(cmdLine('C:\\p\\node_modules\\.bin\\srv.cmd', ['a b']), 'C:\\p\\node_modules\\.bin\\srv.cmd ^^^"a^^^ b^^^"');
  assert.equal(cmdLine('srv', []), 'srv');
});
