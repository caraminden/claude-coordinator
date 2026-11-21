# The kit desktop launcher's trial rules on real Windows (#1396): probation, the roll back after a crash inside it,
# one more try before a build is refused, and no try while a copy runs (#1522). Each scenario is a made-up install folder under %TEMP%\launcher-trial with
# state.json written by hand and builds already unpacked, so no feed is needed (the feed URL refuses at once).
# -From is a URL folder serving launcher.exe (built from kit/desktop-launcher) and testapp.exe (kit/desktop-launcher/testapp).
# Prints PASS or FAIL per check and exits with the number failed. While it waits (-Pause seconds) after a roll back, the
# launcher's one-line notice is on screen for a screenshot.
param(
    [Parameter(Mandatory = $true)] [string]$From,
    [int]$Pause = 12
)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP 'launcher-trial'
$script:failed = 0

function Test-That([string]$Name, [bool]$Ok) {
    if ($Ok) { Write-Output "PASS $Name" } else { Write-Output "FAIL $Name"; $script:failed++ }
}

function Stop-Install([string]$Dir) {
    Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

function New-Install([string]$Name, [string]$State, [hashtable]$Builds) {
    $dir = Join-Path $root $Name
    New-Item -ItemType Directory -Path $dir | Out-Null
    Copy-Item (Join-Path $root 'bin\launcher.exe') (Join-Path $dir 'app.exe')
    Set-Content -Path (Join-Path $dir 'launcher.json') -Value '{"app":"trialapp","feed":"http://127.0.0.1:9/feed.json","title":"Trial app"}' -Encoding ASCII
    Set-Content -Path (Join-Path $dir 'state.json') -Value $State -Encoding ASCII
    foreach ($id in $Builds.Keys) {
        $v = Join-Path $dir "versions\$id"
        New-Item -ItemType Directory -Path $v | Out-Null
        Copy-Item (Join-Path $root 'bin\testapp.exe') (Join-Path $v 'App.exe')
        Set-Content -Path (Join-Path $v 'label.txt') -Value "$id ($($Builds[$id]))" -Encoding ASCII
        if ($Builds[$id] -eq 'broken') { Set-Content -Path (Join-Path $v 'broken.txt') -Value 'x' -Encoding ASCII }
        if ($Builds[$id] -eq 'crashy') { Set-Content -Path (Join-Path $v 'crash-after.txt') -Value '5' -Encoding ASCII }
    }
    return $dir
}

function Start-Launcher([string]$Dir) {
    return Start-Process -FilePath (Join-Path $Dir 'app.exe') -WorkingDirectory $Dir -PassThru
}

function Get-Log([string]$Dir) {
    $log = Join-Path $Dir 'launcher.log'
    if (Test-Path $log) { return [IO.File]::ReadAllText($log) } else { return '' }
}

function Wait-Log([string]$Dir, [string]$Pattern, [int]$Seconds = 60) {
    $until = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $until) {
        if ((Get-Log $Dir) -match $Pattern) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Get-State([string]$Dir) {
    return [IO.File]::ReadAllText((Join-Path $Dir 'state.json')) | ConvertFrom-Json
}

function Show-Install([string]$Dir) {
    Write-Output "--- $(Split-Path $Dir -Leaf): state.json"
    Write-Output ([IO.File]::ReadAllText((Join-Path $Dir 'state.json')))
    Write-Output "--- launcher.log"
    Write-Output (Get-Log $Dir)
}

function Wait-Notice($Launcher) {
    $until = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $until) {
        $Launcher.Refresh()
        if ($Launcher.HasExited) { return $false }
        if ($Launcher.MainWindowTitle -eq 'Trial app') { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Close-App([string]$Dir) {
    Get-Process -Name App -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [void]$_.CloseMainWindow() }
}

if (Test-Path $root) { Remove-Item -Recurse -Force $root }
New-Item -ItemType Directory -Path (Join-Path $root 'bin') | Out-Null
Invoke-WebRequest -Uri "$From/launcher.exe" -OutFile (Join-Path $root 'bin\launcher.exe') -UseBasicParsing
Invoke-WebRequest -Uri "$From/testapp.exe" -OutFile (Join-Path $root 'bin\testapp.exe') -UseBasicParsing
$good6 = '{"current":{"id":6,"exe":"App.exe","started":"file"},"previous":{"id":5,"exe":"App.exe","started":"file"},"failed":[4]'

# 1. Launcher 1's state.json reads as it is: its current build is good, so it just starts and the launcher leaves.
$d = New-Install 'old-state' ($good6 + '}') @{ 5 = 'good'; 6 = 'good' }
$l = Start-Launcher $d
Test-That 'old state: build 6 starts' (Wait-Log $d 'starting build 6' 30)
Test-That 'old state: the launcher leaves without a probation watch' ($l.WaitForExit(30000))
Test-That 'old state: no probation in the log' (-not ((Get-Log $d) -match 'probation'))
Show-Install $d
Stop-Install $d

# 2. A crash inside probation rolls back with one line, and the build gets one more try; a second crash refuses it.
$d = New-Install 'crash' ($good6 + ',"pending":{"id":7,"exe":"App.exe","started":"file"}}') @{ 5 = 'good'; 6 = 'good'; 7 = 'crashy' }
$l = Start-Launcher $d
Test-That 'crash: build 7 starts on probation' (Wait-Log $d 'build 7 started: it is now current, on probation' 45)
Test-That 'crash: the launcher stays to watch' (-not $l.HasExited)
Test-That 'crash: the crash is caught and rolled back to 6' (Wait-Log $d 'build 7 crashed on probation \(exit code 3\).*rolling back to build 6' 30)
Test-That 'crash: build 6 starts again by itself' (Wait-Log $d 'starting build 6' 10)
Test-That 'crash: the one-line notice is up' (Wait-Notice $l)
Start-Sleep -Seconds $Pause
Stop-Install $d
$s = Get-State $d
Test-That 'crash: 6 is current, 7 waits for one more try' ($s.current.id -eq 6 -and $s.pending.id -eq 7 -and -not ($s.failed -contains 7) -and $s.struck -contains 7)
$l = Start-Launcher $d
Test-That 'crash: second try of 7 crashes again' (Wait-Log $d 'its second failure, so it is refused; rolling back to build 6' 60)
[void](Wait-Notice $l)
Stop-Install $d
$s = Get-State $d
Test-That 'crash: 7 is refused, 6 stays current' ($s.current.id -eq 6 -and -not $s.pending -and $s.failed -contains 7)
Test-That "crash: 7's folder is gone" (-not (Test-Path (Join-Path $d 'versions\7')))
Show-Install $d

# 3. A build that fails its start gets one more try on the next start, then it is refused.
$d = New-Install 'broken' ($good6 + ',"pending":{"id":8,"exe":"App.exe","started":"file"}}') @{ 5 = 'good'; 6 = 'good'; 8 = 'broken' }
$l = Start-Launcher $d
Test-That 'broken: the failed start keeps 8 for one more try' (Wait-Log $d 'build 8 failed its start .*it gets one more try on the next start; rolling back to build 6' 60)
Test-That 'broken: the one-line notice is up' (Wait-Notice $l)
Stop-Install $d
$s = Get-State $d
Test-That 'broken: 8 still pending, not refused' ($s.pending.id -eq 8 -and -not ($s.failed -contains 8) -and (Test-Path (Join-Path $d 'versions\8')))
$l = Start-Launcher $d
Test-That 'broken: the second failed start refuses 8' (Wait-Log $d 'build 8 failed its start .*its second failure, so it is refused' 60)
[void](Wait-Notice $l)
Stop-Install $d
$s = Get-State $d
Test-That 'broken: 8 refused' (-not $s.pending -and $s.failed -contains 8 -and $s.current.id -eq 6)
Show-Install $d

# 4. A clean exit inside probation makes the build good, but not one within the 30 s start grace (a hand-off proves nothing).
$d = New-Install 'clean' ($good6 + ',"pending":{"id":9,"exe":"App.exe","started":"file"}}') @{ 5 = 'good'; 6 = 'good'; 9 = 'good' }
$l = Start-Launcher $d
Test-That 'clean: build 9 on probation' (Wait-Log $d 'build 9 started: it is now current, on probation' 45)
Start-Sleep -Seconds 3
Close-App $d
Test-That 'clean: closing it 3 s in leaves it on probation' (Wait-Log $d 'build 9 exited cleanly \d+ s after it started, too soon' 20)
Test-That 'clean: the launcher leaves after the early close' ($l.WaitForExit(10000))
Test-That 'clean: 9 still on probation' ((Get-State $d).probation -eq 9)
$l = Start-Launcher $d
Test-That 'clean: the next start watches 9 again' (Wait-Log $d 'starting build 9: still on probation' 30)
Start-Sleep -Seconds 32
Close-App $d
Test-That 'clean: closing it after the grace passes probation' (Wait-Log $d 'build 9 passed probation \(exited with code 0' 20)
Test-That 'clean: the launcher leaves' ($l.WaitForExit(10000))
$s = Get-State $d
Test-That 'clean: 9 current and good, 6 kept to go back to' ($s.current.id -eq 9 -and -not $s.probation -and $s.previous.id -eq 6)
Show-Install $d
Stop-Install $d

# 5. A probation cut short (the launcher was closed) is watched again on the next start.
$d = New-Install 'cut' ($good6 + ',"pending":{"id":10,"exe":"App.exe","started":"file"}}') @{ 5 = 'good'; 6 = 'good'; 10 = 'good' }
$l = Start-Launcher $d
Test-That 'cut: build 10 on probation' (Wait-Log $d 'build 10 started: it is now current, on probation' 45)
Stop-Process -Id $l.Id -Force
Start-Sleep -Seconds 1
$s = Get-State $d
Test-That 'cut: still on probation after the launcher was closed' ($s.current.id -eq 10 -and $s.probation -eq 10 -and $s.previous.id -eq 6)
$l = Start-Launcher $d
Test-That 'cut: the next start watches it again' (Wait-Log $d 'starting build 10: still on probation' 30)
Start-Sleep -Seconds 32
Close-App $d
Test-That 'cut: closing it passes probation' (Wait-Log $d 'build 10 passed probation' 20)
Show-Install $d
Stop-Install $d

# 6. A waiting "file" build isn't tried while a copy of the app runs (a new start would hand off to it, #1522): no strike,
# and it is tried on the first start with nothing running.
$d = New-Install 'copy' ($good6 + ',"pending":{"id":11,"exe":"App.exe","started":"file"}}') @{ 5 = 'good'; 6 = 'good'; 11 = 'good' }
$copy = Start-Process -FilePath (Join-Path $d 'versions\6\App.exe') -WorkingDirectory (Join-Path $d 'versions\6') -PassThru
Start-Sleep -Seconds 2
$l = Start-Launcher $d
Test-That 'copy: build 11 waits while a copy runs' (Wait-Log $d 'build 11 waits: a copy of Trial app is already running' 30)
Test-That 'copy: build 6 starts instead' (Wait-Log $d 'starting build 6' 10)
[void]$l.WaitForExit(30000)
Stop-Install $d
$s = Get-State $d
Test-That 'copy: 11 still waits, with no strike' ($s.current.id -eq 6 -and $s.pending.id -eq 11 -and -not ($s.struck -contains 11) -and -not ($s.failed -contains 11))
$l = Start-Launcher $d
Test-That 'copy: with nothing running, 11 is tried' (Wait-Log $d 'build 11 started: it is now current, on probation' 45)
Show-Install $d
Stop-Install $d

if ($script:failed -eq 0) { Write-Output 'all passed' } else { Write-Output "$($script:failed) failed" }
exit $script:failed
