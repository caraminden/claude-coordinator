import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';

// The .ps1 lint (#370): Citadel's runner scripts and the Windows CI kit's own scripts must parse and lint clean, since
// they first run on Cara's PC. One pwsh run also lints a script with known mistakes, so a lint that went quiet (a rule
// PSScriptAnalyzer dropped, a profile it couldn't load) fails here instead of passing everything.
// It needs pwsh and PSScriptAnalyzer (installed for cara on perigee through mise); a container turn without them skips it.
const root = join(import.meta.dirname, '..');
const kit = 'kit/skills/scheme-setup/templates/windows-ci';
const lint = join(root, kit, 'lint-ps1.ps1');
const ps1s = (dir: string) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.ps1')).map((f) => join(root, dir, f));

const planted = `using namespace System.Text
$op = [Net.SecurityProtocolType]::Tls12x
$tls = [Net.SecurityProtocolTypo]::Tls12
[System.Collections.Generic.List[Strng]]$list = $null
Get-Error
$sb = [StringBuilder]::new()
Add-Type -TypeDefinition 'public static class MadeHere { public static int One() { return 1; } }'
Write-Output $op $tls $list $sb ([MadeHere]::One())
`;

const found = spawnSync('pwsh', ['-NoProfile', '-Command', 'if (Get-Module -ListAvailable PSScriptAnalyzer) { exit 0 } else { exit 3 }'], { encoding: 'utf8' });
const skip = found.error ? 'no pwsh on PATH' : found.status !== 0 ? 'no PSScriptAnalyzer module' : false;

test('Citadel\'s .ps1 files lint clean, and the lint still finds planted mistakes', { skip, timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps1-lint-'));
  try {
    const bad = join(dir, 'planted.ps1');
    writeFileSync(bad, planted);
    const broken = join(dir, 'broken.ps1');
    writeFileSync(broken, "if ($true) { Write-Output 'x'\n");
    const files = [...ps1s('tools/ci-runner'), ...ps1s(kit), ...ps1s('kit/skills/run-on-windows/scripts/wco'), ...ps1s('public'), ...['gpu.ps1', 'gpu-host.ps1', 'add-scheme.ps1'].map((f) => join(root, 'tools/win-test-box', f))];
    const scratch = join(dir, 'scratch');
    mkdirSync(scratch);
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', lint, ...files, bad, broken], { encoding: 'utf8', env: { ...process.env, TMPDIR: scratch } });
    assert.deepEqual(readdirSync(scratch), [], 'lint-ps1 left its profile folder behind');
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 1, out);
    const lines = out.split('\n').filter((l) => /:\d+:\d+: /.test(l));
    assert.deepEqual(lines.filter((l) => !l.startsWith(bad) && !l.startsWith(broken)), [], 'Citadel\'s own scripts have findings');
    // Each finding as "line rule", so a reworded message doesn't break this.
    const rules = (file: string) => lines.filter((l) => l.startsWith(`${file}:`)).map((l) => l.slice(file.length).replace(/^:(\d+):\d+: (\w+):.*$/s, '$1 $2')).sort();
    assert.deepEqual(rules(bad), ['2 UnknownMember', '3 UnknownType', '4 UnknownType', '5 PSUseCompatibleCommands'], out);
    assert.deepEqual(rules(broken), ['1 ParseError'], out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A glob that matches nothing linted nothing: that's "couldn't run", not "clean" (#468 S14-10).
test('a path that matches no files is exit 2, not clean', { skip, timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps1-lint-'));
  try {
    // GetTempPath() reads TMPDIR: the profile folder it makes lands in `scratch`, where a leak shows (#1339: 84 of them filled /tmp).
    const scratch = join(dir, 'scratch');
    mkdirSync(scratch);
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', lint, join(dir, '*.ps1')], { encoding: 'utf8', env: { ...process.env, TMPDIR: scratch } });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 2, out);
    assert.match(out, /lint-ps1: couldn't run: no \.ps1 files matched/);
    assert.deepEqual(readdirSync(scratch), [], 'lint-ps1 left its profile folder behind');
    assert.doesNotMatch(out, /clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Not lint, but the same pwsh: list-runners.ps1 run on Linux with its two Windows cmdlets stood in for.
test("list-runners.ps1 lists a hand-made logon task with no folder as not Citadel's", { skip: found.error ? 'no pwsh on PATH' : false, timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps1-list-'));
  try {
    const stub = join(dir, 'stub.ps1');
    writeFileSync(stub, `function Get-CimInstance { }
function Get-ScheduledTask { [pscustomobject]@{ TaskName = 'GitHub runner by hand'; State = 'Ready'; Actions = @([pscustomobject]@{ WorkingDirectory = $null }); Principal = [pscustomobject]@{ UserId = 'cara' } } }
& $args[0]
`);
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', stub, 'tools/ci-runner/list-runners.ps1'], { encoding: 'utf8' });
    assert.match(r.stdout, /^GitHub runner by hand {2}session, Ready, for cara {4}\(not Citadel's\)$/m, r.stdout + r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// $PSHOME is PowerShell 7's own folder when a script is run from it, and that has no powershell.exe.
test('the Windows scripts start Windows PowerShell by its System32 path, not from $PSHOME', () => {
  for (const f of ps1s('tools/ci-runner')) assert.doesNotMatch(readFileSync(f, 'utf8'), /\$PSHOME/, f);
  for (const f of ['install-runner-agent.ps1', 'keep-runners.ps1']) assert.ok(readFileSync(join(root, 'tools/ci-runner', f), 'utf8').includes('"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"'), f);
});

// remove-runner.ps1 runs as SYSTEM, and a CI job can write its runner's folder (#476 B1): nothing in that folder is ever
// run. Here the real script runs under pwsh on Linux against a fake Citadel, with the Windows-only cmdlets and sc.exe
// stood in for and two of its lines changed: the admin check (a Windows API) and the drive it looks in.
// On Windows the same tests run it under Windows PowerShell 5.1, which is what a runner agent starts it with, on NTFS
// (a junction for the link, a real read-only file): `node --test test/ps1-lint.test.ts` on the test box.
const win = process.platform === 'win32';
const psRun = win ? ['powershell', '-ExecutionPolicy', 'Bypass'] : ['pwsh'];
// Every runner folder holds a config.cmd and a config.sh that write a canary.
const REPO = 'caraminden/peek-auras';

/** Runs remove-runner.ps1 over `root`'s folders; `refuse` is the runner name the fake Citadel won't delete. */
async function removeRunners(dir: string, root: string, services: { Name: string; PathName: string }[], task: { name: string; dir: string } | null, refuse = '', procs: { id: number; exe?: string; cmd?: string }[] = []) {
  const src = readFileSync(join(root0, 'tools/ci-runner/remove-runner.ps1'), 'utf8');
  const swapped = src.replace(/^\$admin = .*$/m, '$admin = $true').replace(/^\$root = 'C:\\'$/m, `$root = '${root}${sep}'`);
  assert.equal(swapped.split('\n').filter((l, i) => l !== src.split('\n')[i]).length, 2, 'the admin check and the root, and nothing else, were swapped');
  const script = join(dir, 'remove-runner.ps1');
  writeFileSync(script, swapped);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const stub = join(dir, 'stub.ps1');
  writeFileSync(stub, `$global:services = @(${services.map((s) => `[pscustomobject]@{ Name = '${s.Name}'; PathName = '${s.PathName}'; State = 'Running' }`).join(', ')})
function Note([string]$Line) { Add-Content -LiteralPath '${log}' -Value $Line }
function Get-CimInstance {
  param([string]$ClassName, [string]$Filter)
  if ($ClassName -eq 'Win32_Service') { $global:services | Where-Object { $_.Name -like ($Filter -replace "^Name\\s*(LIKE|=)\\s*'(.*)'$", '$2' -replace '%', '*') } }
  if ($ClassName -eq 'Win32_Process') { ${procs.map((x) => `[pscustomobject]@{ ProcessId = ${x.id}; ExecutablePath = ${x.exe ? `'${x.exe}'` : '$null'}; CommandLine = ${x.cmd ? `'${x.cmd}'` : '$null'} }`).join('; ')} }
}
function Stop-Process { param([int]$Id, [switch]$Force, $ErrorAction) Note "Stop-Process $Id" }
function sc.exe {
  Note "sc.exe $args"
  $verb, $name = $args
  if ($verb -eq 'stop') { $global:services | Where-Object { $_.Name -eq $name } | ForEach-Object { $_.State = 'Stopped' } }
  if ($verb -eq 'delete') { $global:services = @($global:services | Where-Object { $_.Name -ne $name }) }
  $global:LASTEXITCODE = 0
}
function Get-ScheduledTask { param([string]$TaskName, $ErrorAction) ${task ? `if ($TaskName -eq '${task.name}') { [pscustomobject]@{ TaskName = $TaskName; Actions = @([pscustomobject]@{ WorkingDirectory = '${task.dir}' }) } }` : ''} }
function Stop-ScheduledTask { param([string]$TaskName) Note "Stop-ScheduledTask $TaskName" }
function Unregister-ScheduledTask { param([string]$TaskName, [switch]$Confirm) Note "Unregister-ScheduledTask $TaskName" }
$script, $rest = $args
& $script @rest
exit $LASTEXITCODE
`);
  const asked: any[] = [];
  const citadel = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      const body = JSON.parse(text);
      asked.push({ auth: req.headers.authorization, url: req.url, ...body });
      const answer = (code: number, said: object) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(said));
      if (body.kind !== 'delete') return answer(200, { scheme: 'Peek Auras', repo: REPO, label: 'peek-auras-ci', token: body.mint ? 'AREMOVALTOKEN' : null, expires_at: null });
      if (body.name === refuse) return answer(502, { error: `GitHub said "Runner is currently running a job and cannot be deleted." (422)` });
      answer(200, { scheme: 'Peek Auras', repo: REPO, name: body.name, removed: true });
    });
  });
  await new Promise<void>((r) => citadel.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(citadel.address() as any).port}`;
    const child = spawn(psRun[0], [...psRun.slice(1), '-NoProfile', '-NonInteractive', '-File', stub, script, '-Scheme', 'Peek Auras', '-CitadelUrl', url, '-MachineToken', 'ccm_test'], { cwd: dir });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const status = await new Promise<number | null>((r) => child.on('close', r));
    return { status, out, asked, calls: readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean) };
  } finally {
    await new Promise((r) => citadel.close(r));
  }
}
const root0 = root;

/** A runner folder with a marker, a `.runner` naming `agent`, and a config.cmd and config.sh that write `canary`. */
function runnerFolder(dir: string, canary: string, agent: string, marker: object) {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, '.citadel-runner'), JSON.stringify({ repo: REPO, ...marker }));
  writeFileSync(join(dir, '.runner'), JSON.stringify({ agentId: 7, agentName: agent, gitHubUrl: `https://github.com/${REPO}` }));
  writeFileSync(join(dir, 'bin', 'RunnerService.exe'), '');
  for (const f of ['config.cmd', 'config.sh', 'run.cmd']) writeFileSync(join(dir, f), `#!/bin/sh\necho ran >> '${canary}'\n`, { mode: 0o755 });
}

const noPwsh = !win && found.error ? 'no pwsh on PATH' : false;
const svc = (name: string, dir: string) => ({ Name: `actions.runner.caraminden-peek-auras.${name}`, PathName: `"${join(dir, 'bin', 'RunnerService.exe')}"` });

test('remove-runner.ps1 runs nothing from a runner\'s folder: Citadel takes it off GitHub, then the service and folder go', { skip: noPwsh, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps1-remove-'));
  try {
    // A folder name with wildcard characters in it is still only itself.
    const root = join(dir, 'c[x]');
    const canary = join(dir, 'canary');
    const one = join(root, 'actions-runner-peek-auras');
    const long = join(root, 'actions-runner-peek-auras-3');
    const session = join(root, 'actions-runner-peek-auras-desktop');
    const delve = join(root, 'actions-runner');
    const plantedDir = join(root, 'actions-runner-planted');
    // A job wrote its own .runner to name another runner: the service's name, which an admin made, is the one used.
    runnerFolder(one, canary, 'SOMEONE-ELSES', { label: 'peek-auras-ci' });
    runnerFolder(session, canary, 'DESK-desktop', { label: 'peek-auras-desktop', mode: 'session' });
    // A service name of 80 characters may be one GitHub cut short: .runner names the runner, the label still says which kind.
    runnerFolder(long, canary, 'LONGNAME', { label: 'peek-auras-ci' });
    runnerFolder(delve, canary, 'DELVE', { label: 'peek-auras-ci' });
    runnerFolder(plantedDir, canary, 'PLANTED', { label: 'peek-auras-ci' });
    // A job left a link out of its folder: what it points at stays.
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    mkdirSync(join(one, '_work'));
    symlinkSync(outside, join(one, '_work', 'link'), 'junction');
    writeFileSync(join(one, '_work', 'readonly.txt'), 'x', { mode: 0o444 });

    const r = await removeRunners(dir, root, [svc('DESK', one), svc('L'.repeat(43), long), svc('DELVE', delve), { Name: 'actions.runner.caraminden-other.DESK', PathName: `"${join(plantedDir, 'bin', 'RunnerService.exe')}"` }], { name: 'GitHub runner peek-auras-desktop', dir: session }, '', [
      { id: 101, exe: `${one}\\bin\\Runner.Listener.exe` },
      { id: 102, cmd: `cmd.exe /c ${session}\\run.cmd` },
      // Not in a runner folder being removed: the folder "cx" that "c[x]" matches as a wildcard, Delve's, and a name that only starts the same.
      { id: 103, exe: `${join(dir, 'cx', 'actions-runner-peek-auras')}\\bin\\Runner.Listener.exe` },
      { id: 104, cmd: `cmd.exe /c ${join(dir, 'cx', 'actions-runner-peek-auras-desktop')}\\run.cmd` },
      { id: 105, exe: `${delve}\\bin\\Runner.Listener.exe` },
      { id: 106, exe: `${one}-9\\bin\\Runner.Listener.exe` },
    ]);
    assert.equal(existsSync(canary), false, `something in a runner folder was run:\n${r.out}`);
    // The planted folder (a marker, no service of this repo) is left alone and makes the run fail, as before.
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /actions-runner-planted has a marker .* left alone/);
    assert.match(r.out, /remove-runner: 1 runner folder\(s\) weren't removed; the lines above say why\./);
    // Each ask carries the label of the kind of runner being removed: the scheme's for a service, the logon task's for a session runner.
    assert.deepEqual(r.asked.filter((a) => a.kind === 'delete').map((a) => [a.url, a.auth, a.scheme, a.name, a.label]).sort(), [
      ['/api/machines/runner-token', 'Bearer ccm_test', 'Peek Auras', 'DESK', 'peek-auras-ci'],
      ['/api/machines/runner-token', 'Bearer ccm_test', 'Peek Auras', 'DESK-desktop', 'peek-auras-desktop'],
      ['/api/machines/runner-token', 'Bearer ccm_test', 'Peek Auras', 'LONGNAME', 'peek-auras-ci'],
    ]);
    assert.ok(r.asked.every((a) => a.mint !== true), 'no removal token is asked for any more');
    assert.deepEqual(r.calls, [
      'sc.exe stop actions.runner.caraminden-peek-auras.DESK',
      'sc.exe delete actions.runner.caraminden-peek-auras.DESK',
      'Stop-Process 101',
      `sc.exe stop actions.runner.caraminden-peek-auras.${'L'.repeat(43)}`,
      `sc.exe delete actions.runner.caraminden-peek-auras.${'L'.repeat(43)}`,
      'Stop-ScheduledTask GitHub runner peek-auras-desktop',
      'Stop-Process 102',
      'Unregister-ScheduledTask GitHub runner peek-auras-desktop',
    ]);
    assert.equal(existsSync(one), false, r.out);
    assert.equal(existsSync(session), false, r.out);
    assert.equal(existsSync(long), false, r.out);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep', 'a link in the folder was followed');
    assert.equal(existsSync(join(delve, 'config.cmd')), true, 'Delve\'s folder was touched');
    assert.equal(existsSync(join(plantedDir, 'config.cmd')), true, 'the planted folder was touched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remove-runner.ps1 leaves a runner Citadel couldn\'t take off GitHub as it was, and says why', { skip: noPwsh, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps1-remove-'));
  try {
    const root = join(dir, 'c');
    const canary = join(dir, 'canary');
    const one = join(root, 'actions-runner-peek-auras');
    const two = join(root, 'actions-runner-peek-auras-2');
    runnerFolder(one, canary, 'DESK', { label: 'peek-auras-ci' });
    runnerFolder(two, canary, 'DESK-2', { label: 'peek-auras-ci' });
    const r = await removeRunners(dir, root, [svc('DESK', one), svc('DESK-2', two)], null, 'DESK');
    assert.equal(existsSync(canary), false, r.out);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Citadel couldn't take the runner DESK off GitHub: GitHub said "Runner is currently running a job and cannot be deleted\." \(422\)/);
    assert.match(r.out, /remove-runner: 1 runner folder\(s\) weren't removed; the lines above say why\./);
    // The refused one keeps its service and folder, so a re-run finds it; the other still goes.
    assert.deepEqual(r.calls, ['sc.exe stop actions.runner.caraminden-peek-auras.DESK-2', 'sc.exe delete actions.runner.caraminden-peek-auras.DESK-2']);
    assert.equal(existsSync(join(one, '.citadel-runner')), true);
    assert.equal(existsSync(two), false, r.out);
    // Run again once GitHub lets it go: the one that stayed is found and removed, and the run is clean.
    const again = await removeRunners(dir, root, [svc('DESK', one)], null);
    assert.equal(again.status, 0, again.out);
    assert.deepEqual(again.asked.filter((a) => a.kind === 'delete').map((a) => a.name), ['DESK']);
    assert.equal(existsSync(one), false, again.out);
    assert.equal(existsSync(canary), false, again.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// What Linux can't show: no line of the script starts anything from the folder it is removing.
test('remove-runner.ps1 has no line that runs a file of the runner folder', () => {
  const code = readFileSync(join(root, 'tools/ci-runner/remove-runner.ps1'), 'utf8').replace(/<#[\s\S]*?#>/, '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /config\.(cmd|sh)|Invoke-Expression|\biex\b|Start-Process|Invoke-Command|Import-Module|Push-Location|Set-Location|^\s*\.\s+\S/m);
  // The call operator starts sc.exe and nothing else.
  assert.deepEqual([...new Set(code.match(/(?<!&)&\s*[^\s&]+/g))], ['& sc.exe']);
});
