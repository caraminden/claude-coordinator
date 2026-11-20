// keep-runners.ps1's ship squeeze (#1268), run in pwsh with its job calls faked: which share each runner's slot gets
// while a ship runs and after, how it reads ships.json, and how it names a runner. Job objects themselves only exist
// on Windows: `keep-runners.ps1 -Prove` checks those on the PC.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = join(import.meta.dirname, '..', 'tools', 'ci-runner', 'keep-runners.ps1');
const found = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']);
const skip = found.error ? 'no pwsh on PATH' : false;

/** Runs `body` in pwsh after the script's own functions, with [CitadelCiJob]::SetRate recording "<job>=<rate>". */
function pwsh(body: string, dir: string) {
  const file = join(dir, 'run.ps1');
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
Add-Type 'public static class CitadelCiJob { public static System.Collections.Generic.List<string> Calls = new System.Collections.Generic.List<string>(); public static void SetRate(System.IntPtr job, int r) { Calls.Add(job.ToInt64() + "=" + r); } }'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$t, [ref]$e)
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($f.Extent.Text)) }
$CpuPercent = 75; $SqueezePercent = 30; $said = ''; $identity = @{}
$shipsFile = '${join(dir, 'ships.json')}'
${body}`);
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!);
}

test('while a ship runs, every other slot shares 30% of the PC among those running a job; after, the shared cap alone', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'keep-runners-'));
  try {
    const out = pwsh(`
$slots = @{
  'C:\\a' = @{ Key = 'caraminden/claude-coordinator|desktop-g248ij8'; Job = [IntPtr]1; Rate = -1; Busy = $true; Inside = $true }
  'C:\\b' = @{ Key = 'caraminden/peek-auras|desktop-g248ij8'; Job = [IntPtr]2; Rate = -1; Busy = $true; Inside = $true }
  'C:\\c' = @{ Key = 'caraminden/peek-auras|desktop-g248ij8-2'; Job = [IntPtr]3; Rate = -1; Busy = $true; Inside = $true }
  'C:\\d' = @{ Key = 'caraminden/gamedevtest|desktop-g248ij8'; Job = [IntPtr]4; Rate = -1; Busy = $false; Inside = $true }
  'C:\\e' = @{ Key = 'caraminden/mandate|desktop-g248ij8'; Job = [IntPtr]5; Rate = -1; Busy = $true; Inside = $false }
}
# As the loop gets it from Read-Ship: one ship comes back a lone string, and no ship comes back as nothing.
$ships = 'caraminden/claude-coordinator|desktop-g248ij8'
Set-SlotRate
$squeezed = @([CitadelCiJob]::Calls | Sort-Object)
[CitadelCiJob]::Calls.Clear()
Set-SlotRate
$again = @([CitadelCiJob]::Calls)
$ships = $null
Set-SlotRate
$lifted = @([CitadelCiJob]::Calls | Sort-Object)
@{ squeezed = $squeezed; again = $again; lifted = $lifted } | ConvertTo-Json -Compress`, dir);
    // Three others run a job (b, c, e), so 10% of the PC each: inside the 75% shared job that is 10/75 of its cap
    // (1333 hundredths); e hangs in another job, so its 10% is of the PC (1000). The ship's slot has no cap of its own.
    assert.deepEqual(out.squeezed, ['1=0', '2=1333', '3=1333', '4=1333', '5=1000']);
    assert.deepEqual(out.again, [], 'an unchanged share is not set again');
    // Lifted: inside slots back to no cap of their own; e back to the 75% it had on its own.
    assert.deepEqual(out.lifted, ['2=0', '3=0', '4=0', '5=7500']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ships.json counts until its expiry, and a missing, broken or expired file names no ship', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'keep-runners-'));
  try {
    const later = Date.now() + 60_000;
    const out = pwsh(`
$none = @(Read-Ship).Count
Set-Content -LiteralPath $shipsFile -Value '{"until": ${later}, "ships": [{"repo": "CaraMinden/Peek-Auras", "runner": "DESKTOP-G248IJ8"}, {"repo": "caraminden/peek-auras", "runner": "desktop-g248ij8"}]}'
$live = @(Read-Ship)
Set-Content -LiteralPath $shipsFile -Value '{"until": 1, "ships": [{"repo": "a/b", "runner": "r"}]}'
$expired = @(Read-Ship).Count
Set-Content -LiteralPath $shipsFile -Value '{"until": '
$broken = @(Read-Ship).Count
Set-Content -LiteralPath $shipsFile -Value '{"until": ${later}, "ships": []}'
$empty = @(Read-Ship).Count
@{ none = $none; live = $live; expired = $expired; broken = $broken; empty = $empty } | ConvertTo-Json -Compress`, dir);
    assert.deepEqual(out, { none: 0, live: ['caraminden/peek-auras|desktop-g248ij8'], expired: 0, broken: 0, empty: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a runner is named from its .runner file (BOM and all) as Citadel names a ship\'s runner; an unconfigured one is not', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'keep-runners-'));
  try {
    writeFileSync(join(dir, '.runner'), '\uFEFF{"agentName": "DESKTOP-G248IJ8-2", "gitHubUrl": "https://github.com/CaraMinden/Peek-Auras", "workFolder": "_work"}');
    const out = pwsh(`@{ named = (Get-RunnerKey '${dir}'); missing = (Get-RunnerKey '${join(dir, 'nope')}') } | ConvertTo-Json -Compress`, dir);
    assert.deepEqual(out, { named: 'caraminden/peek-auras|desktop-g248ij8-2', missing: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
