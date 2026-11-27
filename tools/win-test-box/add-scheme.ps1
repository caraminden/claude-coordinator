<#
.SYNOPSIS
  Gives one scheme's repo a place on the test box (#369): a read-only deploy key, a clone in
  C:\work\<name>, its toolchain from mise, and a workspace in Citadel's machine agent with two tasks
  minions call with a command line. Then adds the screen-lock hooks to every desktop runner here.

.DESCRIPTION
  Run in the box (Hyper-V Manager, Connect), in PowerShell as administrator. Safe to run again.
  The workspace's tasks, both `powershell.exe -Command <the minion's command line>` in the clone:
    run    takes the box's screen lock: tests that open windows, or the app itself (then screenshot,
           then stop_job). Waits its turn with CI desktop jobs.
    build  doesn't: builds and tests that need no screen, which go on beside a CI desktop job.
    run-gpu  once the box has its GPU (gpu-host.ps1): like run, with the GPU on while it runs.
  Behind `mise exec --` when the repo has a mise.toml, so its pinned tools are on PATH.

.EXAMPLE
  C:\citadel-box\add-scheme.ps1 -Repo caraminden/peek-auras
#>
param(
  [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')][string]$Repo,
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$')][string]$Workspace = ($Repo -split '/')[1]
)
# Not 'Stop': Windows PowerShell 5.1 turns git/ssh/mise stderr (progress, warnings) into terminating
# errors under it, even with 2>$null. Every native step checks $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
function Say([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
$folder = "C:\work\$Workspace"
$keys = 'C:\citadel-box\keys'
$key = "$keys\$($Repo -replace '/', '-')"
$sshKey = $key -replace '\\', '/'
$ssh = "ssh -i $sshKey -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
$url = "git@github.com:$Repo.git"
foreach ($tool in 'git', 'node') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool isn't on PATH. Did guest-setup.ps1 finish? Open a new PowerShell window after it did." }
}

Say "A read-only deploy key for $Repo"
New-Item -ItemType Directory -Force $keys | Out-Null
if (-not (Test-Path $key)) {
  # Start-Process passes -N "" as written; Windows PowerShell drops an empty argument otherwise.
  $p = Start-Process ssh-keygen -ArgumentList "-q -t ed25519 -N `"`" -C `"citadel-test-vm $Repo`" -f `"$key`"" -NoNewWindow -Wait -PassThru
  if ($p.ExitCode) { throw "ssh-keygen failed ($($p.ExitCode))" }
}
while ($true) {
  & git -c "core.sshCommand=$ssh" ls-remote $url HEAD 2>$null | Out-Null
  if (-not $LASTEXITCODE) { Write-Host '  GitHub lets this key read the repo.'; break }
  Write-Host @"
  Add this key on GitHub: https://github.com/$Repo/settings/keys/new
  Title: citadel-test-vm. Leave "Allow write access" off.

$(Get-Content "$key.pub")

"@
  Read-Host '  Press Enter once it is added' | Out-Null
}

Say "The clone in $folder"
if (-not (Test-Path "$folder\.git")) {
  & git -c "core.sshCommand=$ssh" clone $url $folder
  if ($LASTEXITCODE) { throw "git clone failed ($LASTEXITCODE)" }
}
& git -C $folder config core.sshCommand $ssh
$mise = [bool](Get-ChildItem $folder -Force -Name | Where-Object { $_ -in 'mise.toml', '.mise.toml', '.tool-versions' })
if ($mise) {
  Say 'Its tools, from mise (a Rust toolchain takes a few minutes)'
  Push-Location $folder
  try {
    & mise trust
    & mise install
    if ($LASTEXITCODE) { throw "mise install failed ($LASTEXITCODE)" }
  } finally { Pop-Location }
}

Say 'The workspace in the machine agent'
$config = "$env:USERPROFILE\coordinator-agent\machine-agent.json"
$env:CC_BOX_WORKSPACE = @'
const fs = require('fs');
const path = require('path');
const [file, name, folder, mise] = process.argv.slice(1);
let c = {};
try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
c.screen_lock = 'C:\\citadel-box\\screen.lock';
c.screenshots = true;
c.workspaces = c.workspaces || {};
const ps = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command'];
const run = mise === '1' ? ['mise', 'exec', '--', ...ps] : ps;
const old = c.workspaces[name] || {};
c.workspaces[name] = { ...old, path: folder, tasks: {
  ...old.tasks,
  run: { run, args: true, about: 'a PowerShell command line, given as one argument, with the screen: tests that open windows, or the app (then screenshot, then stop_job)' },
  build: { run, args: true, screen: false, about: 'a PowerShell command line, given as one argument, that needs no screen: builds and plain tests' },
} };
// The box has its GPU once gpu-host.ps1 has run (README.md); its -Install writes the same task.
if (fs.existsSync('C:\\citadel-box\\gpu.ps1')) c.workspaces[name].tasks['run-gpu'] = { run: [...run.slice(0, -ps.length), 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\citadel-box\\gpu.ps1', '-Run'], args: true, about: 'like run, with the GPU on (real Direct3D hardware) while it runs; run draws in software' };
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(c, null, 2));
'@
& node -e 'eval(process.env.CC_BOX_WORKSPACE)' $config $Workspace $folder $(if ($mise) { '1' } else { '0' })
$code = $LASTEXITCODE
Remove-Item Env:CC_BOX_WORKSPACE
if ($code) { throw "Could not write $config" }
Write-Host "  $config has workspace $Workspace (tasks run and build, and run-gpu once the box has its GPU). The agent reads it again by itself."

Say 'Screen-lock hooks for the desktop runners here'
& C:\citadel-box\screen-lock.ps1 -Install

Say 'Next'
Write-Host @"
  - If this scheme's desktop runner isn't in the box yet: add it with the scheme's own runner setup
    (README.md, step 7), then run this script again for the hooks and restart the box.
  - On Citadel's Machines page: the box's machine is lent to this scheme and its Workspace tools
    switch is on.
"@
