# Proves dev-drive.ps1's Move, Back and Cleanup on a made-up runner layout (#1344): no services, no Dev Drive, no
# Defender. Run it on any Windows box: powershell -NoProfile -ExecutionPolicy Bypass -File dev-drive-test.ps1
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'dev-drive.ps1'
$t = "C:\dd-test-$PID"; $b = "$t\actions-runner-peek-auras"; $r = "$t\R\"; $f = "$b-2"; $d = "$t\R\peek-auras-2"
function Invoke-Step([string]$do) { & $script -Do $do -Runner DESKTOP-G248IJ8-2 -Base $b -DriveRoot $r -Test | Out-Host }
function Assert-That([bool]$ok, [string]$what) { if (-not $ok) { throw "FAIL: $what" }; "ok: $what" }
try {
  New-Item -ItemType Directory -Force "$f\_work\peek-auras\target", "$f\cargo", "$f\rustup", "$f\mise\installs\rust\1.0", $b | Out-Null
  'x' | Set-Content "$f\_work\peek-auras\target\a.rlib"
  'tool' | Set-Content "$f\mise\installs\rust\1.0\rustc.txt"
  # an absolute link inside, as mise makes: after the move it resolves through the new junction to the live copy
  New-Item -ItemType Junction -Path "$f\mise\installs\rust\latest" -Target "$f\mise\installs\rust\1.0" | Out-Null

  Invoke-Step Move
  Assert-That ((Get-Item "$f\_work" -Force).LinkType -eq 'Junction') 'move: _work is a junction'
  Assert-That ((Get-Content "$f\_work\peek-auras\target\a.rlib") -eq 'x') 'move: files read through the junction'
  Assert-That (Test-Path "$f\_work.pre-devdrive\peek-auras\target\a.rlib") 'move: the old copy stays'
  Assert-That ((Get-Item "$d\mise\installs\rust\latest" -Force).LinkType -eq 'Junction') 'move: a link inside is copied as a link'
  Assert-That (-not (Test-Path "$b\_work")) 'move: runner 1 untouched'
  Invoke-Step Move
  Assert-That ((Get-Item "$f\_work" -Force).LinkType -eq 'Junction') 'move again: nothing changes'

  cmd /c rmdir "$f\cargo"
  Invoke-Step Move
  Assert-That ((Get-Item "$f\cargo" -Force).LinkType -eq 'Junction') 'move: links a folder left renamed but unlinked'

  'new' | Set-Content "$f\_work\peek-auras\target\b.rlib"
  Invoke-Step Back
  Assert-That (-not (Get-Item "$f\_work" -Force).LinkType) 'back: _work is a real folder again'
  Assert-That (-not (Test-Path "$f\_work.pre-devdrive")) 'back: no .pre-devdrive left'
  Assert-That ((Get-Content "$f\mise\installs\rust\1.0\rustc.txt") -eq 'tool') 'back: the old files are back'
  Assert-That (Test-Path "$d\_work\peek-auras\target\b.rlib") 'back: the Dev Drive copy is untouched'
  Invoke-Step Back

  Invoke-Step Move
  Invoke-Step Cleanup
  Assert-That (-not (Test-Path "$f\mise.pre-devdrive")) 'cleanup: the old copy is gone'
  Assert-That ((Get-Content "$f\mise\installs\rust\1.0\rustc.txt") -eq 'tool') 'cleanup: the link inside the old copy was not followed into live files'
  Assert-That ((Get-Content "$f\_work\peek-auras\target\b.rlib") -eq 'new') 'cleanup: live files intact'

  $refused = $false
  try { Invoke-Step Back } catch { $refused = "$_" -match 'gone' }
  Assert-That $refused 'back after cleanup refuses'
  Assert-That ((Get-Item "$f\_work" -Force).LinkType -eq 'Junction') 'back after cleanup: the junctions stay'

  Rename-Item "$f\_work" '_work.keep'; New-Item -ItemType Directory "$f\_work", "$f\_work.pre-devdrive" | Out-Null
  $refused = $false
  try { Invoke-Step Cleanup } catch { $refused = "$_" -match 'keeping' }
  Assert-That ($refused -and (Test-Path "$f\_work.pre-devdrive")) 'cleanup keeps an old copy whose junction is missing'
  'dev-drive-test: all passed'
} finally { cmd /c rmdir /s /q $t }
