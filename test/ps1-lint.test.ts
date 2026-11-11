import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const files = [...ps1s('tools/ci-runner'), ...ps1s(kit)];
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', lint, ...files, bad, broken], { encoding: 'utf8' });
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
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', lint, join(dir, '*.ps1')], { encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 2, out);
    assert.match(out, /lint-ps1: couldn't run: no \.ps1 files matched/);
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
