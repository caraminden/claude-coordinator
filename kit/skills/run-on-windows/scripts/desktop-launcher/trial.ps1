# The kit desktop launcher's trial rules on real Windows (#1396): probation, the roll back after a crash inside it,
# one more try before a build is refused, no try while a copy runs (#1522), and a roll back on the feed dropping the
# waiting build (#1942). Each scenario is a made-up install folder under %TEMP%\launcher-trial with state.json written by
# hand and builds already unpacked. 1 to 6 need no feed (the feed URL refuses at once); the rest read one served here.
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

$offline = 'http://127.0.0.1:9/feed.json'

function Set-Feed([string]$Dir, [string]$Url) {
    Set-Content -Path (Join-Path $Dir 'launcher.json') -Value ('{"app":"trialapp","feed":"' + $Url + '","title":"Trial app"}') -Encoding ASCII
}

function New-Install([string]$Name, [string]$State, [hashtable]$Builds, [string]$Feed = $offline) {
    $dir = Join-Path $root $Name
    New-Item -ItemType Directory -Path $dir | Out-Null
    Copy-Item (Join-Path $root 'bin\launcher.exe') (Join-Path $dir 'app.exe')
    Set-Feed $dir $Feed
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
    if (-not (Test-Path $log)) { return '' }
    # Shared read: the launcher may be writing it right now.
    $f = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
    try { return (New-Object IO.StreamReader($f)).ReadToEnd() } finally { $f.Dispose() }
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

# A feed at $feedRoot\<name>.json, served on localhost: a <file>.wait beside a file holds the seconds its answer takes.
function Start-Feed {
    $probe = New-Object System.Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 0)
    $probe.Start(); $script:feedPort = $probe.LocalEndpoint.Port; $probe.Stop()
    New-Item -ItemType Directory -Path $feedRoot | Out-Null
    $serve = Join-Path $root 'bin\serve.ps1'
    Set-Content -Path $serve -Encoding ASCII -Value @'
param([int]$Port, [string]$Dir)
$l = New-Object Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
while ($true) {
    $c = $l.GetContext()
    try {
        $f = Join-Path $Dir ([IO.Path]::GetFileName($c.Request.Url.AbsolutePath))
        if (Test-Path "$f.wait") { Start-Sleep -Seconds ([int](Get-Content "$f.wait")) }
        $b = [IO.File]::ReadAllBytes($f)
        $c.Response.ContentLength64 = $b.Length
        $c.Response.OutputStream.Write($b, 0, $b.Length)
    } catch { $c.Response.StatusCode = 404 }
    try { $c.Response.Close() } catch { $null = $_ }
}
'@
    $script:feed = Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $serve, '-Port', $feedPort, '-Dir', $feedRoot -WindowStyle Hidden -PassThru
    # Up once the port answers.
    $until = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $until) {
        try { (New-Object Net.Sockets.TcpClient).Connect('localhost', $feedPort); return } catch { Start-Sleep -Milliseconds 250 }
    }
    throw 'the feed server did not start'
}

function New-Feed([string]$Name, [int]$Build, [int]$Wait = 0, [string]$Zip = '', [int]$ZipWait = 0) {
    $f = @{ app = 'trialapp'; build = $Build; exe = 'App.exe'; started = 'file'; zip = "none.zip"; sha256 = ('0' * 64); size = 1 }
    if ($Zip) {
        $f.zip = Split-Path $Zip -Leaf
        $f.sha256 = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()
        $f.size = (Get-Item $Zip).Length
        if ($ZipWait) { Set-Content -Path "$Zip.wait" -Value $ZipWait -Encoding ASCII }
    }
    $at = Join-Path $feedRoot "$Name.json"
    [IO.File]::WriteAllText($at, ($f | ConvertTo-Json -Compress))
    if ($Wait) { Set-Content -Path "$at.wait" -Value $Wait -Encoding ASCII }
    return "http://localhost:$feedPort/$Name.json"
}

function Close-App([string]$Dir) {
    Get-Process -Name App -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [void]$_.CloseMainWindow() }
}

if (Test-Path $root) { Stop-Install $root; Remove-Item -Recurse -Force $root }  # a run cut short may have left its apps up
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
Start-Process -FilePath (Join-Path $d 'versions\6\App.exe') -WorkingDirectory (Join-Path $d 'versions\6')
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

# 7. Rolled back on the feed (#1942): the waiting build isn't tried, and it is dropped.
$feedRoot = Join-Path $root 'feed'
Start-Feed
$d = New-Install 'rollback' ($good6 + ',"pending":{"id":11,"exe":"App.exe","started":"file"}}') @{ 5 = 'good'; 6 = 'good'; 11 = 'good' } (New-Feed 'rollback' 6)
$l = Start-Launcher $d
Test-That 'rollback: 6 starts' (Wait-Log $d 'starting build 6' 45)
Test-That 'rollback: the launcher leaves without a probation watch' ($l.WaitForExit(30000))
Test-That 'rollback: 11 is never tried' (-not ((Get-Log $d) -match 'trying build 11'))
Stop-Install $d
$s = Get-State $d
Test-That 'rollback: 6 is current, 11 no longer waits, nothing struck' ($s.current.id -eq 6 -and -not $s.pending -and -not ($s.failed -contains 11) -and -not ($s.struck -contains 11))
Test-That "rollback: 11's folder is gone, 6's is whole" ((-not (Test-Path (Join-Path $d 'versions\11'))) -and (Test-Path (Join-Path $d 'versions\6\App.exe')))
Show-Install $d

# 8. The feed still names the waiting build, or a newer one: it is tried as before.
$d = New-Install 'named' ($good6 + ',"pending":{"id":11,"exe":"App.exe","started":"file"}}') @{ 5 = 'good'; 6 = 'good'; 11 = 'good' } (New-Feed 'named' 11)
$l = Start-Launcher $d
Test-That 'named: 11 is tried' (Wait-Log $d 'build 11 started: it is now current, on probation' 45)
Show-Install $d
Stop-Install $d

# 9. A feed that doesn't answer holds the app up by a few seconds at most, then the waiting build is tried as before.
$d = New-Install 'slow' ($good6 + ',"pending":{"id":11,"exe":"App.exe","started":"file"}}') @{ 5 = 'good'; 6 = 'good'; 11 = 'good' } (New-Feed 'slow' 6 12)
$at = Get-Date
$l = Start-Launcher $d
Test-That 'slow: 11 is tried' (Wait-Log $d 'trying build 11' 45)
$took = ((Get-Date) - $at).TotalSeconds
Test-That ('slow: within 10 s (took {0:n1})' -f $took) ($took -lt 10)
Test-That 'slow: 11 starts' (Wait-Log $d 'build 11 started: it is now current, on probation' 45)
Show-Install $d
Stop-Install $d

# 10. The waiting build is put off by a running copy, and the roll back is read beside it: a later start, offline, runs 6.
$d = New-Install 'copyrollback' ($good6 + ',"pending":{"id":11,"exe":"App.exe","started":"file"}}') @{ 5 = 'good'; 6 = 'good'; 11 = 'good' } (New-Feed 'copyrollback' 6)
Start-Process -FilePath (Join-Path $d 'versions\6\App.exe') -WorkingDirectory (Join-Path $d 'versions\6')
Start-Sleep -Seconds 2
$l = Start-Launcher $d
Test-That 'copyrollback: 11 waits while a copy runs' (Wait-Log $d 'build 11 waits: a copy of Trial app is already running' 30)
[void]$l.WaitForExit(45000)
Stop-Install $d
Test-That 'copyrollback: 11 no longer waits' (-not (Get-State $d).pending)
Set-Feed $d $offline
$l = Start-Launcher $d
[void]$l.WaitForExit(45000)
Test-That 'copyrollback: the next start, offline, runs 6 and not 11' (((Get-Log $d) -match 'starting build 6') -and -not ((Get-Log $d) -match 'trying build 11'))
Show-Install $d
Stop-Install $d

# 11. A build on probation crashes while the build the feed was rolled back to downloads: the running 6 keeps its files.
$z = Join-Path $root 'zip6'
New-Item -ItemType Directory -Path $z | Out-Null
Copy-Item (Join-Path $root 'bin\testapp.exe') (Join-Path $z 'App.exe')
Set-Content -Path (Join-Path $z 'label.txt') -Value '6 (downloaded again)' -Encoding ASCII
Compress-Archive -Path (Join-Path $z '*') -DestinationPath (Join-Path $feedRoot 'b6.zip')
$d = New-Install 'crashdownload' '{"current":{"id":7,"exe":"App.exe","started":"file"},"previous":{"id":6,"exe":"App.exe","started":"file"},"failed":[],"probation":7}' @{ 6 = 'good'; 7 = 'crashy' } (New-Feed 'crashdownload' 6 0 (Join-Path $feedRoot 'b6.zip') 15)
$l = Start-Launcher $d
Test-That 'crashdownload: 7 crashes and 6 starts' (Wait-Log $d 'build 7 crashed on probation.*rolling back to build 6' 45)
[void](Wait-Notice $l)
Start-Sleep -Seconds 25
Stop-Install $d
$s = Get-State $d
Test-That 'crashdownload: 6 is current and 7 no longer waits' ($s.current.id -eq 6 -and -not $s.pending)
Test-That "crashdownload: the running 6's files are untouched" ((Test-Path (Join-Path $d 'versions\6\App.exe')) -and (Test-Path (Join-Path $d 'versions\6\label.txt')) -and ((Get-Content (Join-Path $d 'versions\6\label.txt')) -eq '6 (good)'))
Show-Install $d
Stop-Process -Id $script:feed.Id -Force

if ($script:failed -eq 0) { Write-Output 'all passed' } else { Write-Output "$($script:failed) failed" }
exit $script:failed
