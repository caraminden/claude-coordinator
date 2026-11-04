// The setup lines the Machines page drafts: the folder step really writes machine-agent.json (#305).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanFolder, machineSetup, machineSetupWindows, workspaceName } from '../public/machine-setup.js';

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
  assert.match(win, /--config `"\$dir\\machine-agent\.json`""\n/);
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
  assert.match(win, /-Argument "`"\$dir\\machine-agent\.mjs`" https:\/\/a ccm_1_x --config `"\$dir\\machine-agent\.json`""/);

  // What node gets on Windows, run here against a local folder: the body through the environment.
  const { agent, vault, file } = dirs(true);
  const local = machineSetupWindows('https://a', 'pc', 't', 'none', '', vault).split('\n');
  const body = local.slice(local.indexOf("$env:CC_WORKSPACE_SETUP = @'") + 1, local.indexOf("'@")).join('\n');
  execFileSync(process.execPath, ['-e', 'eval(process.env.CC_WORKSPACE_SETUP)', file], { env: { ...process.env, CC_WORKSPACE_SETUP: body } });
  assert.deepEqual(read(file).workspaces[workspaceName(vault)].tasks.pull.run, ['git', 'pull', '--ff-only']);
});
