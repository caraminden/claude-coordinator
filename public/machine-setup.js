// The line the Machines page drafts for a person to paste on their computer (#439): fetch the agent and run it
// in the background, with its token. What it lends is ticked on the page afterwards, from what the agent finds
// there; machine-agent.json beside it stays its owner's, and the app never stores it.

/** @import { MachineWorkerCaps } from './types.js' */

/**
 * For macOS and Linux: the agent installs itself as a launchd agent or a systemd user unit
 * (machine-agent.mjs --install), from its own folder, logging there. Any shell: fish too.
 * @param {string} url
 * @param {string} name
 * @param {string} token
 */
export function machineSetupPosix(url, name, token) {
  return ['mkdir -p ~/coordinator-agent && cd ~/coordinator-agent &&', `curl -fsSLO ${url}/machine-agent.mjs &&`, `node machine-agent.mjs ${url} ${token} --config machine-agent.json --install ${name}`].join('\n');
}

/**
 * Connect a computer (Build 7 M2): the same, with a join code in place of the name and token. The agent swaps the code
 * for its token, names its service after the machine the app made for it, and installs as above.
 * @param {string} url
 * @param {string} code
 */
export function machineJoinPosix(url, code) {
  return ['mkdir -p ~/coordinator-agent && cd ~/coordinator-agent &&', `curl -fsSLO ${url}/machine-agent.mjs &&`, `node machine-agent.mjs ${url} --join ${code} --config machine-agent.json --install`].join('\n');
}

/** Where a background agent logs, as the page shows it. * @param {string} os
 * @param {string} name
 */
export function agentLog(os, name) {
  return os === 'windows' ? `%USERPROFILE%\\coordinator-agent\\machine-agent-${name}.log` : `~/coordinator-agent/machine-agent-${name}.log`;
}

/** @param {string} s */
const psq = (s) => `'${s.replace(/'/g, "''")}'`;
/** @param {string} name */
const taskName = (name) => `Coordinator agent (${name})`;
// This machine's agent by its log file, which no other agent on the computer has.
/** @param {string} name */
const killAgent = (name) => `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like "*machine-agent-${name}.log*" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;

/**
 * The same for Windows PowerShell, as a task that starts now and at every logon (in that person's
 * own session, so it can reach an open Godot editor), started again within 5 minutes if it ever stops,
 * with no window to close (#309). No reboot needed.
 * One script block, so a missing Node or failed download stops it before a broken task is registered.
 * @param {string} url
 * @param {string} name
 * @param {string} token
 */
export function machineSetupWindows(url, name, token) {
  return windowsScript(url, name, token, psq, []);
}

// A double-quoted PowerShell string in which only $name and $token expand: the join command's, which learns both as it runs.
/** @param {string} s */
const psJoined = (s) => `"${s.replace(/[`"]/g, '`$&').replace(/\$(?!name\b|token\b)/g, '`$')}"`;

/**
 * Connect a computer on Windows (Build 7 M2): the agent swaps the join code for the machine's name and token first,
 * then the same task as machineSetupWindows is registered with them. A used or old code stops it before any task.
 * @param {string} url
 * @param {string} code
 */
export function machineJoinWindows(url, code) {
  return windowsScript(url, '$name', '$token', psJoined, [
    `$j = & $node "$dir\\machine-agent.mjs" ${url} --join ${code} --config "$dir\\machine-agent.json" --json`,
    'if ($LASTEXITCODE) { throw "The app did not take the join code: the line above says why. A used or old code needs a new one from Connect a computer." }',
    '$j = $j | Select-Object -Last 1 | ConvertFrom-Json; $name = $j.name; $token = $j.token',
  ]);
}

/** The Windows script: `name` and `token` are literal, or $name and $token that `join` sets as it runs; `say` quotes the lines it prints. * @param {string} url
 * @param {string} name
 * @param {string} token
 * @param {(s: string) => string} say
 * @param {string[]} join
 */
function windowsScript(url, name, token, say, join) {
  const task = taskName(name);
  // Disabled as well as stopped, or the 5-minute trigger starts it again; its node goes too, in case
  // stopping its hidden console leaves it running.
  const help = {
    watch: `Get-Content -Wait -Encoding UTF8 "$env:USERPROFILE\\coordinator-agent\\machine-agent-${name}.log"`,
    stop: `Disable-ScheduledTask -TaskName "${task}" | Out-Null; Stop-ScheduledTask -TaskName "${task}"; ${killAgent(name)}`,
    start: `Enable-ScheduledTask -TaskName "${task}" | Out-Null; Start-ScheduledTask -TaskName "${task}"`,
    remove: `Unregister-ScheduledTask -TaskName "${task}" -Confirm:$false; ${killAgent(name)}`,
  };
  return [
    '& {',
    '$ErrorActionPreference = "Stop"',
    '$node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source',
    'if (-not $node -or [version](& $node -v).TrimStart("v") -lt [version]"18.0") { throw "Node 18 or newer is not on this PowerShell\'s PATH. Install it (winget install OpenJS.NodeJS.LTS), open a new PowerShell window and paste this again." }',
    '$dir = "$env:USERPROFILE\\coordinator-agent"; New-Item -ItemType Directory -Force $dir | Out-Null',
    `curl.exe -fsSLo "$dir\\machine-agent.mjs" ${url}/machine-agent.mjs`,
    'if ($LASTEXITCODE) { throw "Could not download machine-agent.mjs (curl exit $LASTEXITCODE)." }',
    ...join,
    `$log = "$dir\\machine-agent-${name}.log"`,
    // conhost --headless gives node a console nobody sees, so there is no window to close (a plain
    // node.exe gets one, in Windows Terminal on Windows 11 too); --log keeps what it prints.
    `$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\conhost.exe" -WorkingDirectory $dir -Argument "--headless \`"$node\`" \`"$dir\\machine-agent.mjs\`" ${url} ${token} --config \`"$dir\\machine-agent.json\`" --log \`"$log\`""`,
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    // Restart-on-failure doesn't cover an agent that exits or is killed, so a second trigger tries every
    // 5 minutes, which IgnoreNew skips while it runs. An explicit duration: some Windows 10 builds refuse none.
    '$triggers = (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME), (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))',
    // A running copy keeps its old arguments through Register -Force, and Start leaves it be.
    `Stop-ScheduledTask -TaskName "${task}" -ErrorAction SilentlyContinue; ${killAgent(name)}`,
    `Register-ScheduledTask -Force -TaskName "${task}" -Action $action -Trigger $triggers -Settings $settings | Out-Null`,
    '$skip = @(Get-Content $log -Encoding UTF8 -ErrorAction SilentlyContinue).Count',
    `Start-ScheduledTask -TaskName "${task}"`,
    '"Started. Waiting for it to connect..."',
    'foreach ($i in 1..40) { Start-Sleep -Milliseconds 500; $all = @(Get-Content $log -Encoding UTF8 -ErrorAction SilentlyContinue); if ($all.Count -lt $skip) { $skip = 0 }; $said = @($all | Select-Object -Skip $skip); if ($said -match "Connected to |rejected|refused") { break } }',
    '$said',
    'if ($said -match "Connected to ") { "It runs in the background now, also after you close this window, and starts again at every logon." } else { "It has not connected yet: the lines above say why (nothing above means it did not start)." }',
    say(`Its output: ${help.watch}`),
    say(`Stop it: ${help.stop}`),
    say(`Start it again: ${help.start}`),
    say(`Remove it: ${help.remove}`),
    '}',
  ].join('\n');
}

/** The CI runner agent's one-time install line (tools/ci-runner/README.md), for an admin PowerShell on a PC that hosts CI, with this app's machines address and the token filled in. * @param {string} url
 * @param {string} token
 */
export function machineSetupRunnerAgent(url, token) {
  const u = url.replace(/\/$/, '');
  return `$u = '${u}'; iwr "$u/ci-runner/install-runner-agent.ps1" -UseBasicParsing -OutFile "$env:TEMP\\install-runner-agent.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\install-runner-agent.ps1" -CitadelUrl $u -MachineToken '${token}'`;
}

/** The Linux runner agent's install line (#510, tools/ci-runner/README.md), for a root shell: in the WSL distro on a Windows PC, or on a Linux PC. * @param {string} url
 * @param {string} token
 */
export function machineSetupRunnerAgentLinux(url, token) {
  const u = url.replace(/\/$/, '');
  // A fresh file of root's own: a fixed /tmp name left by another user (an earlier try outside root) can't be
  // overwritten, even by root (fs.protected_regular), and curl fails with "(23) Failure writing output".
  return `u='${u}'; f=$(mktemp) && curl -fsSL "$u/ci-runner/install-runner-agent.sh" -o "$f" && CC_MACHINE_TOKEN='${token}' bash "$f" "$u"`;
}

/** What a worker's self-test checks, in the order its row shows (public/worker-agent.mjs runs them, src/worker-join.ts keeps them). */
export const WORKER_CHECKS = {
  image: 'Image built and starts',
  folders: 'Folders reach the container',
  sync: 'Scratch repo there and back',
  process: 'Process started and stopped',
  link: 'Link to Citadel',
  tools: 'Host tools',
  disk: 'Your disk is out of reach',
  programs: "Windows programs can't start",
};

/** The fixed caps every worker started on before #2250 (the Build 7 spec's): one still on all four was never sized to its PC. */
export const WORKER_CAPS = { workers: 6, threads: 8, memory_gb: 24, disk_gb: 60 };
/**
 * A worker's caps sized from its PC (#2250; tools/worker/citadel-worker caps holds the same rule for a first install):
 * its threads and memory less a quarter, at least 2 threads and 4 GB kept for its owner and CI, and a minion per 3 of each.
 * @param {{ threads: number, memory_gb: number }} pc @returns {MachineWorkerCaps}
 */
export function workerSize(pc) {
  const keep = (/** @type {number} */ n, /** @type {number} */ least) => n - Math.max(least, Math.ceil(n / 4));
  const threads = Math.min(1024, Math.max(1, keep(pc.threads, 2)));
  const memory_gb = Math.min(4096, Math.max(2, keep(pc.memory_gb, 4)));
  return { workers: Math.min(64, Math.max(1, Math.floor(Math.min(threads, memory_gb) / 3))), threads, memory_gb, disk_gb: WORKER_CAPS.disk_gb };
}
export const WORKER_LIMITS = { workers: [1, 64], threads: [1, 1024], memory_gb: [2, 4096], disk_gb: [20, 99999] };

/** The line that makes a Windows PC a minion worker (tools/worker/install-worker.ps1), for its owner's normal PowerShell. * @param {string} url
 * @param {string} token
 * @param {Partial<MachineWorkerCaps>} caps the caps its owner typed: one left out is sized from that PC
 */
export function machineSetupWorkerWindows(url, token, caps) {
  const u = url.replace(/\/$/, '');
  return `$u = '${u}'; $env:CC_MACHINE_TOKEN = '${token}'; iwr "$u/worker-setup/install-worker.ps1" -UseBasicParsing -OutFile "$env:TEMP\\install-worker.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\install-worker.ps1" -Url $u${CAP_KEYS.flatMap(([key, , ps]) => (caps[key] ? [` -${ps} ${caps[key]}`] : [])).join('')}; $env:CC_MACHINE_TOKEN = $null`;
}

/** The same for a Linux PC (tools/worker/install-worker.sh), in a bash terminal. * @param {string} url
 * @param {string} token
 * @param {Partial<MachineWorkerCaps>} caps
 */
export function machineSetupWorkerLinux(url, token, caps) {
  const u = url.replace(/\/$/, '');
  return `u='${u}'; f=$(mktemp) && curl -fsSL "$u/worker-setup/install-worker.sh" -o "$f" && sudo CC_MACHINE_TOKEN='${token}' bash "$f" "$u"${capFlags(caps)}`;
}

/** Each cap, its citadel-worker flag and its install-worker.ps1 parameter. @type {[keyof MachineWorkerCaps, string, string][]} */
const CAP_KEYS = [
  ['workers', 'workers', 'Workers'],
  ['threads', 'threads', 'Threads'],
  ['memory_gb', 'memory', 'MemoryGB'],
  ['disk_gb', 'disk', 'DiskGB'],
];
/** The flags of the caps given, each after a space. @param {Partial<MachineWorkerCaps>} caps */
const capFlags = (caps) => CAP_KEYS.flatMap(([key, flag]) => (caps[key] ? [` --${flag} ${caps[key]}`] : [])).join('');

/** A `citadel-worker` command on the worker's own PC: its sign-ins and its caps. * @param {boolean | null | undefined} wsl
 * @param {string} rest
 */
export const workerCommand = (wsl, rest) => (wsl ? `wsl -d citadel-workers -u root --exec /usr/local/bin/citadel-worker ${rest}` : `sudo citadel-worker ${rest}`);
/** @param {boolean | null | undefined} wsl @param {MachineWorkerCaps} caps */
export const workerCapsCommand = (wsl, caps) => workerCommand(wsl, `caps${capFlags(caps)}`);
