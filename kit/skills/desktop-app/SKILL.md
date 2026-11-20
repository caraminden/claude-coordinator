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
2. Downloads a build the feed names that it doesn't have and that never failed on this PC. It checks the
   size and SHA-256 against the feed, throws away a mismatch and keeps nothing half-written.
3. On the next start it tries that build. The build must say it started within 30 s (below). If it
   crashes or stays silent, the launcher kills it, marks it failed on this PC (it's never tried again)
   and starts the old build. The last two builds stay on disk.
4. Takes a newer launcher the same way. It must pass `--selftest` (read this folder and print its
   version) before it replaces the old one, and the old one is kept beside it. If the new one fails
   before the app starts, the old one comes back.

`launcher.log` beside the exe says what happened.

## Making an app ready

- **Start signal.** The launcher sets `CITADEL_STARTED_FILE` (and `CITADEL_BUILD`) for the app. Once
  its window is up and it got past its own setup, the app writes any text to that file. That is
  `started: "file"`, the default. An app you can't change uses `started: "alive"`: still running (or
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
  PCs go back to it on their next start but one.

Builds are kept under `<DATA_DIR>/projects/<id>/desktop/<app>/`: the newest three. The feed is open
(no login) on the tailnet, like the app itself.

## Changing the launcher

Edit `kit/desktop-launcher/Launcher.cs` and raise `Program.Version`. Citadel builds the exe with
perigee's .NET SDK (`~/.dotnet/dotnet build`), keyed by the source's hash. Once the change is live,
every feed offers it. Prove a change on real Windows first (`citadel:run-on-windows`). The kit's test
app (`kit/desktop-launcher/testapp`, broken on purpose when a `broken.txt` sits beside it) is the app
to try it with. A dev copy only reaches the test box on ports 8000-8999 of perigee's tailnet address.
