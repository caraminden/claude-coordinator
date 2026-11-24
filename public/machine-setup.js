// The line the Machines page drafts for a person to paste on their computer (#439): fetch the agent and run it
// in the background, with its token. What it lends is ticked on the page afterwards, from what the agent finds
// there; machine-agent.json beside it stays its owner's, and the app never stores it.

/**
 * For macOS and Linux: the agent installs itself as a launchd agent or a systemd user unit
 * (machine-agent.mjs --install), from its own folder, logging there. Any shell: fish too.
 */
export function machineSetupPosix(url, name, token) {
  return ['mkdir -p ~/coordinator-agent && cd ~/coordinator-agent &&', `curl -fsSLO ${url}/machine-agent.mjs &&`, `node machine-agent.mjs ${url} ${token} --config machine-agent.json --install ${name}`].join('\n');
}

/** Where a background agent logs, as the page shows it. */
export function agentLog(os, name) {
  return os === 'windows' ? `%USERPROFILE%\\coordinator-agent\\machine-agent-${name}.log` : `~/coordinator-agent/machine-agent-${name}.log`;
}

const psq = (s) => `'${s.replace(/'/g, "''")}'`;
const taskName = (name) => `Coordinator agent (${name})`;
// This machine's agent by its log file, which no other agent on the computer has.
const killAgent = (name) => `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like "*machine-agent-${name}.log*" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;

/**
 * The same for Windows PowerShell, as a task that starts now and at every logon (in that person's
 * own session, so it can reach an open Godot editor), started again within 5 minutes if it ever stops,
 * with no window to close (#309). No reboot needed.
 * One script block, so a missing Node or failed download stops it before a broken task is registered.
 */
export function machineSetupWindows(url, name, token) {
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
    psq(`Its output: ${help.watch}`),
    psq(`Stop it: ${help.stop}`),
    psq(`Start it again: ${help.start}`),
    psq(`Remove it: ${help.remove}`),
    '}',
  ].join('\n');
}

/** The CI runner agent's one-time install line (tools/ci-runner/README.md), for an admin PowerShell on Cara's desktop, with this app's machines address and the token filled in. */
export function machineSetupRunnerAgent(url, token) {
  const u = url.replace(/\/$/, '');
  return `$u = '${u}'; iwr "$u/ci-runner/install-runner-agent.ps1" -UseBasicParsing -OutFile "$env:TEMP\\install-runner-agent.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\install-runner-agent.ps1" -CitadelUrl $u -MachineToken '${token}'`;
}

/** The Linux runner agent's install line (#510, tools/ci-runner/README.md "Linux runners in WSL"), for a root shell in the WSL distro on Cara's desktop. */
export function machineSetupRunnerAgentLinux(url, token) {
  const u = url.replace(/\/$/, '');
  // A fresh file of root's own: a fixed /tmp name left by another user (an earlier try outside root) can't be
  // overwritten, even by root (fs.protected_regular), and curl fails with "(23) Failure writing output".
  return `u='${u}'; f=$(mktemp) && curl -fsSL "$u/ci-runner/install-runner-agent.sh" -o "$f" && CC_MACHINE_TOKEN='${token}' bash "$f" "$u"`;
}
