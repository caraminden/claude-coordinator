// The lines the Machines page drafts for a person to paste on their computer: fetch the agent, add the
// folder they typed to its machine-agent.json, and start it. The file stays theirs: the app never stores it.

// What the add form suggests running: Delve's Godot MCP, as its dock's Configure button set it up
// for Claude Code on that computer.
export const DEFAULT_CLAUDE_MCP = 'godot-ai';

/** The agent's arguments for what it lends: a command, a Claude Code MCP server, or nothing (kind "none"). */
function runArgs(kind, what) {
  if (kind === 'none') return '';
  return kind === 'command' ? ` -- ${what}` : ` --claude-mcp ${what || DEFAULT_CLAUDE_MCP}`;
}

/** The folder as typed, minus spaces around it and trailing slashes (a root like C:\ or / keeps its own). */
export function cleanFolder(folder) {
  let f = (folder ?? '').trim();
  while (/[\\/]$/.test(f) && !/^([A-Za-z]:)?[\\/]$/.test(f)) f = f.slice(0, -1);
  return f;
}

/** The workspace a folder becomes: its last part, lower-cased, as a name the agent takes (Vault → vault). */
export function workspaceName(folder) {
  const last = cleanFolder(folder).split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  return last.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'folder';
}

// Runs on the computer with file, folder and name set. It adds or updates only that workspace, keeping
// every other workspace and any task its owner added, so running setup again (a new token) loses nothing.
// A git repo also gets a pull task, with git_sync off, since git_sync's detached checkout would break
// pull --ff-only and an Obsidian Git branch. No backslashes in it: it goes inside a POSIX single-quoted
// string, where fish would read them as escapes.
const MERGE = [
  'const fs = require("fs"), path = require("path"), os = require("os");',
  'const dir = folder === "~" || folder.startsWith("~/") || folder.startsWith("~" + path.sep) ? path.join(os.homedir(), folder.slice(1)) : folder;',
  'if (!path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {',
  '  console.error(`${folder} is not a folder on this computer. Type its full path on the Machines page and copy the setup again.`);',
  '  process.exit(1);',
  '}',
  'let config = {};',
  'if (fs.existsSync(file)) {',
  '  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) {',
  '    console.error(`${file} is not valid JSON (${err.message}). Fix or move it, then run this again.`);',
  '    process.exit(1);',
  '  }',
  '}',
  'const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);',
  'if (!isObject(config) || !isObject(config.workspaces ??= {}) || !isObject(config.workspaces[name] ??= {})) {',
  '  console.error(`${file} does not hold { "workspaces": { ... } } as the agent reads it. Fix or move it, then run this again.`);',
  '  process.exit(1);',
  '}',
  'const w = config.workspaces[name];',
  'const was = w.path && w.path !== dir ? ` (it was ${w.path})` : "";',
  'w.path = dir;',
  'w.tasks ??= {};',
  'const pull = fs.existsSync(path.join(dir, ".git")) && !w.tasks.pull;',
  'if (pull) {',
  '  w.tasks.pull = { run: ["git", "pull", "--ff-only"], about: "Bring the minion\'s push into the vault now",',
  '    hints: [{ match: "index.lock", say: "Obsidian Git is mid-commit; wait 5 s and run pull again." }] };',
  '  w.git_sync ??= false;',
  '}',
  'fs.writeFileSync(file, JSON.stringify(config, null, 2) + os.EOL);',
  'console.log(`Workspace ${name} is ${dir}${was}${pull ? ", with a pull task" : ""}, in ${path.resolve(file)}`);',
].join('\n');

const posix = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The lines to run on a machine to connect it, for its token, what it should run and the folder minions may use. */
export function machineSetup(url, token, kind, what, folder) {
  const f = cleanFolder(folder);
  return [
    `curl -fsSLO ${url}/machine-agent.mjs`,
    ...(f ? [`node -e ${posix(`const [file, folder, name] = process.argv.slice(1);\n${MERGE}`)} machine-agent.json ${posix(f)} ${workspaceName(f)} &&`] : []),
    `node machine-agent.mjs ${url} ${token} --config machine-agent.json${runArgs(kind, what)}`,
  ].join('\n');
}

/**
 * The same for Windows PowerShell, as a task that starts now and at every logon (in that person's
 * own session, so it can reach an open Godot editor), restarting if it ever stops. No reboot needed.
 * One script block, so a missing Node or failed download stops it before a broken task is registered.
 * The folder step's script goes through an environment variable from a literal here-string: Windows
 * PowerShell 5.1 drops the double quotes in arguments it passes to node, and paths keep their backslashes.
 */
export function machineSetupWindows(url, name, token, kind, what, folder) {
  const f = cleanFolder(folder);
  const task = `Coordinator agent (${name})`;
  return [
    '& {',
    '$ErrorActionPreference = "Stop"',
    '$node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source',
    'if (-not $node -or [version](& $node -v).TrimStart("v") -lt [version]"18.0") { throw "Node 18 or newer is not on this PowerShell\'s PATH. Install it (winget install OpenJS.NodeJS.LTS), open a new PowerShell window and paste this again." }',
    '$dir = "$env:USERPROFILE\\coordinator-agent"; New-Item -ItemType Directory -Force $dir | Out-Null',
    `curl.exe -fsSLo "$dir\\machine-agent.mjs" ${url}/machine-agent.mjs`,
    'if ($LASTEXITCODE) { throw "Could not download machine-agent.mjs (curl exit $LASTEXITCODE)." }',
    ...(f ? [
      "$env:CC_WORKSPACE_SETUP = @'",
      `const file = process.argv[1], { folder, name } = ${JSON.stringify({ folder: f, name: workspaceName(f) })};`,
      MERGE,
      "'@",
      '& $node -e "eval(process.env.CC_WORKSPACE_SETUP)" "$dir\\machine-agent.json"; $code = $LASTEXITCODE',
      'Remove-Item Env:CC_WORKSPACE_SETUP',
      'if ($code) { throw "Could not add the folder to machine-agent.json (see above)." }',
    ] : []),
    `$action = New-ScheduledTaskAction -Execute $node -WorkingDirectory $dir -Argument "\`"$dir\\machine-agent.mjs\`" ${url} ${token} --config \`"$dir\\machine-agent.json\`"${runArgs(kind, what).replace(/"/g, '`"')}"`,
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    `Register-ScheduledTask -Force -TaskName "${task}" -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) -Settings $settings | Out-Null`,
    `Start-ScheduledTask -TaskName "${task}"`,
    `"Started ${task}; it also starts at every logon. It shows online on the Machines page once it connects."`,
    '}',
  ].join('\n');
}
