---
name: desktop-app
description: Windows desktop apps on Citadel's update feed and the kit's launcher. Use when publishing a desktop build, wiring an app's start signal, or changing the launcher.
---

# Desktop app

Citadel hosts a Windows app's builds and update feed. A small launcher (`kit/desktop-launcher`, C# on
.NET Framework 4.8, which every Windows 10 and 11 PC has) runs it on each PC and updates it. Peek Auras
still has its own updater; this is for apps that adopt the launcher.

## What a PC gets

The first install is `<app>.zip` from `/api/desktop/<scheme id>/<app>/install.zip` on Citadel's
address. It holds an `<app>/` folder: the launcher as `<app>.exe`, `launcher.json` (the feed's URL),
`state.json` and the current build in `versions\<n>\`. People unzip it into `%LOCALAPPDATA%` and run
`<app>.exe`. Nothing in it is signed, so Windows' SmartScreen asks once ("More info", "Run anyway").

On every start the launcher:

1. Starts the current build at once, then reads `feed.json` in the background.
2. Downloads a build the feed names that it doesn't have and that this PC hasn't refused. It checks the
   size and SHA-256 against the feed, throws away a mismatch and keeps nothing half-written.
3. On the next start it tries that build. The build must say it started within 30 s (below). If it
   crashes or stays silent, the launcher kills it and starts the old build. A `file` build waits while
   a copy of the app is already running (a new start would only hand off to it), with no strike, and is
   tried on the first start with nothing running. So a build reaches a PC on its start after next.
   Before it tries the build, the launcher reads the feed, for 5 s at most: a build rolled back since it
   was downloaded is dropped and the current one starts. With no answer, the build is tried as if there were no feed.
4. A build that started is current but on probation: the launcher stays and watches it for 10 minutes.
   Running that long, or closing with exit code 0 first, makes it good; a clean exit within 30 s of the
   start proves nothing (it may have handed off to a copy already running), so the build stays on
   probation and the next start watches it again. A non-zero exit inside the 10 minutes is a crash: the launcher starts the last good build again by itself and shows one line on
   top ("My App build 7 crashed, so it went back to build 6. Build 7 gets one more try next time.").
   Windows shutting down or logging off isn't a crash, and a watch cut short (the launcher was closed)
   starts over on the next start. The feed is read beside the watch, so a download never holds up a roll
   back. A first build with nothing older to go back to stays current, on probation, after a crash.
5. A failed start or a crash on probation counts against the build: it gets one more try on the next
   start, and a second failure refuses it on this PC for good. A newer build in the feed is tried in
   place of the second go. The last good build stays on disk until the new one is good.
6. Takes a newer launcher the same way. It must pass `--selftest` (read this folder and print its
   version) before it replaces the old one, and the old one is kept beside it. If the new one fails
   before the app starts, the old one comes back.

`launcher.log` beside the exe says what happened. `state.json` holds `current`, `previous` (the build to
go back to), `pending`, `failed` (refused), `struck` (failed once) and `probation` (the current build's
id while it is on probation). Launcher 1 wrote no `struck` or `probation`, so its state reads as it is:
its current build is good and the builds it refused stay refused.

## Making an app ready

- **Start signal.** The launcher sets `CITADEL_STARTED_FILE` (and `CITADEL_BUILD`) for the app. Once
  its window is up and it got past its own setup, the app writes any text to that file. That is
  `started: "file"`, the default. On probation, a non-zero exit code is a crash, so quit with exit
  code 0 when the person closes the app, `started: "alive"` apps too. The feed's `exe` must be the app's
  own process: an exe that starts another and exits is never watched, so its build stays on probation
  and its crashes aren't caught. An app you can't change uses `started: "alive"`: still running (or
  exited 0) after 30 s counts as started. That is weaker: a build that hangs at a blank window passes.
- **Read-only build folder.** Each build lives in its own `versions\<n>\` folder, which goes away two
  builds later. Keep settings and saves elsewhere (`%APPDATA%\<app>`).
- **The build** is a `.zip` or `.tar.gz` of the app's folder (a lone top folder is stripped), with the
  exe at its top or named by `exe` ("bin/App.exe"). Links and special files are refused.

## Publishing

- **By hand:** `publish_desktop` with `app` (lower case, digits, dashes) and `path` (a build you made)
  or `ci_file` (a CI store id). It gets Citadel's next number and stands until CI publishes another
  run. The reply links the feed and the first-install zip.
- **From CI:** give the scheme's Windows ci target a `desktop` block in the repo's `citadel-app.json`,
  and upload the build to the CI store as `kind=release` (`citadel:ci-store`):

  ```json
  { "targets": [{ "id": "ci:release:windows", "desktop": { "app": "myapp", "exe": "MyApp.exe", "started": "file", "title": "My App" } }] }
  ```

  The live Citadel publishes each run of that target once it is released (shipped, and green on any
  `release.needs`), and tells the Taskmaster. A failed publish is reported, and PCs keep their build.
  The target's current release on the Releases page links the first-install zip.
- **Roll back:** a roll back on that ci target pins an older run. The feed names that build again, and
  PCs that run the newer one go back to it on their next start but one; a PC that only has the newer one
  downloaded doesn't start it, unless the feed doesn't answer in 5 s or the older run is past the newest
  three builds: that one is published again under a new number, so PCs try what waits first.

Builds are kept under `<DATA_DIR>/projects/<id>/desktop/<app>/`: the newest three. The feed is open
(no login) on the tailnet, like the app itself.

## Changing the launcher

Edit `kit/desktop-launcher/Launcher.cs` and raise `Program.Version`. The trial rules (probation,
roll back, strikes) are in `Trial.cs`, kept free of Windows so `test/desktop-launcher-trial.test.ts`
runs their tests (`kit/desktop-launcher/tests`) on perigee's .NET 8; a rule change starts with a red
test there. A new source file goes in `Launcher.csproj` and `LAUNCHER_SOURCES` in
`src/desktop-launcher.ts`. Citadel builds the exe with
perigee's .NET SDK (`~/.dotnet/dotnet build`), keyed by the source's hash. Once the change is live,
every feed offers it. Prove a change on real Windows first (`citadel:run-on-windows`). The kit's test
app (`kit/desktop-launcher/testapp`, broken on purpose when a `broken.txt` sits beside it) is the app
to try it with (`crash-after.txt` holding seconds makes it crash that long after it started), and
`run-on-windows`' `scripts/desktop-launcher/trial.ps1` runs the trial rules on the test box. A dev copy only reaches the test box on ports 8000-8999 of perigee's tailnet address.
