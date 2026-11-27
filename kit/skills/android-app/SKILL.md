---
name: android-app
description: Build, sign and ship an Android app (a Capacitor shell or plain Gradle) on perigee's shared Android toolchain. Use when a turn runs gradlew, changes compileSdk, the Android Gradle Plugin or build-tools, makes a release APK, wires an app's shared shell or push, or tries an APK or a page on the shared emulator (citadel-android), its microphone included.
---

# Android app

One Android SDK serves every scheme: `~/.local/share/android-sdk`, with JDK 21 from mise. Citadel's
`tools/android/install-sdk.sh` installs it on the host. Every turn gets `ANDROID_HOME`,
`ANDROID_SDK_ROOT` and `JAVA_HOME` (`java` and `keytool` are on PATH). In a container turn the SDK
is **read-only**.

## Build

- From the app's `android/` folder (Capacitor: `npx cap sync android` first):
  `citadel-heavy --heavy --back app/build/outputs/apk/debug/app-debug.apk ./gradlew assembleDebug`. Always through citadel-heavy:
  a cold build takes every core it can get and 2–3 GB of RAM (`--heavy`: a first build counts as heavy before its past runs say).
  `--back` names what you need here: the build may run on another machine with the Builds role (perigee when none has room),
  and only those paths come back, into the same folders. Without it a scheme with CI sends the build to CI and no APK arrives.
  What goes there is the checkout as git sees it, plus a Capacitor project's synced web files and plugin packages; never a
  release key.
- The APK lands in `app/build/outputs/apk/debug/app-debug.apk`.
- The Gradle daemon is off (`~/.gradle/gradle.properties`, copied into container homes). Don't pass
  `--daemon` or override it in the project's `gradle.properties`. After the build,
  `pgrep -u "$USER" -f '[G]radleDaemon'` should print nothing.
- **Debug builds sign with one committed debug keystore** (public, `android`/`androiddebugkey`, in the
  app's repo), not the home's `~/.android/debug.keystore`. Every home has its own, so builds from
  different homes can't update each other on the shared emulator. With the shared key they upgrade
  over each other. Never `adb uninstall` another build to get past a signature error. An app that
  moves from per-home keys to the shared one still has the old-key build installed: that build can't
  be updated in place, so its owner uninstalls it once (local data goes) before the first
  shared-key install.
- The first build in a home downloads Gradle and its dependencies, about 1 GB in `~/.gradle`.

## Shared shell

Every Capacitor app on Citadel runs the same native shell, `kit/android-shell` (a Capacitor
plugin, `@citadel/android-shell`): Citadel's pages other than sign-in open outside the app, only a
gateway error (502/503/504) or a load that shows nothing for 20 s opens the bundled offline page
(`webDir`'s `offline.html`, Capacitor's `server.errorPath`), a native "Update available" dialog reads
the app's `android/latest.json`, and push comes through Citadel. A new Capacitor app starts on it;
an app with its own copies of these moves onto it (deletes them; MainActivity goes back to a plain
`BridgeActivity`). Its README has the version history.

- **Adopt or move to a newer shell:** from the repo root,
  `node <kit>/skills/android-app/scripts/android-shell.mjs install` (`<kit>` is this skill's kit;
  `status` says whether the app's pin is behind). It packs the kit's shell into
  `<android>/citadel-shell/`, pins it in the Capacitor root's `package.json` and runs `cap sync`.
  Commit the `.tgz` with `package.json` and its lock file: each app builds from its own pinned copy,
  so a shell change reaches an app only when it re-pins, builds and tries it.
- **Config**, in `capacitor.config.json` under `plugins.CitadelShell` (all optional):
  `updateFeed` (default `<server.url>/android/latest.json`; a debug build checks only when it's set),
  `updates: false` (no update dialog), `citadelHost` (default: the app's host minus its first label),
  and `firebase: { projectId, applicationId, apiKey, senderId }` for push (Firebase starts from
  these, no `google-services.json`; the values are public identifiers, not secrets).
- **The page's side**, `Capacitor.Plugins.CitadelShell`: `enablePush()` (asks for notification
  permission, then registers the phone with Citadel; call it when the person turns push on, never on
  load), `disablePush()`, `pushStatus()` → `{ enabled, available, permission }`, and
  `checkUpdate()` (shows the dialog now, even after Later).
- **Push** is sent by the app's server through Citadel, `POST /api/contraptions/push` (the
  `citadel:contraption-ui` API reference, "Push to a person's phone"). Tapping a notification opens
  its `open` page in the app. Data keys beyond the notification go to the app's own handler: a class
  implementing `zip.citadel.shell.PushHandler`, named in the app's manifest as
  `<meta-data android:name="zip.citadel.shell.push_handler" android:value="<class>"/>`. A
  monochrome notification icon goes in `zip.citadel.shell.notification_icon` (a drawable resource).
  Each app's package needs adding to Citadel's Firebase project once (a person's console step).
- Trying a change to the shell itself: its README, "Testing a change".

## Pinned versions

Installed: `platforms;android-36`, `build-tools` 36.1.0 and 35.0.0 (the Android Gradle Plugin
8.13's default, which Capacitor 8 uses), and `platform-tools`.

- Keep `compileSdk` at 36. Don't bump compileSdk, the Android Gradle Plugin or `buildToolsVersion`
  to a version that isn't installed.
- Moving a project to AGP 9 (once the packages above are installed): read `references/agp-9.md`.
- **"The SDK directory is not writable"** means the build wants a package that isn't installed.
  Gradle can't install it inside a container. Don't work around it with a private SDK copy:
  1. Add the package to `PACKAGES` in Citadel's `tools/android/install-sdk.sh`.
  2. Have it run on the host. A host turn runs the script itself; a container turn asks its
     Taskmaster.

## Release signing

- Each app has one keystore: `~/.config/citadel-android/<app>-release.jks`, with its password in
  `<app>-release.pass` beside it. Both are mode 600. Citadel makes it on the server (#837): a
  Capacitor contraption with none gets a **Make release key** button on its Releases card, and the
  `make_release_key` tool posts a card any member of its scheme approves. Neither ever replaces a key
  that exists. Never run keytool for one yourself.
- Every key and its password go off-box nightly (`deploy/offbox.sh`, `keys/` on Cara's desktop).
- Never copy either into a repo, the shared folder, a chat or a log, and never read the .pass file. Container homes don't have
  `~/.config/citadel-android`, so release builds run in a host turn.
- A Capacitor app's releases build themselves (Delivery below). Its release build type has no
  `signingConfig`, so Gradle writes `app-release-unsigned.apk` and Citadel signs it with the key.
- A hand release (a plain Gradle app, or a one-off):
  1. Bump `versionCode` (and `versionName`) in `app/build.gradle`.
  2. `citadel-heavy --here --heavy ./gradlew assembleRelease` (`--here`: a hand release stays on perigee, beside its key).
  3. Sign with `apksigner` from `$ANDROID_HOME/build-tools/36.1.0/`, then verify:
     `apksigner sign --ks <jks> --ks-pass file:<pass> --out <app>.apk app-release-unsigned.apk`,
     then `apksigner verify <app>.apk`.
- Before signing a Capacitor shell, check the merged release manifest
  (`AndroidManifest.xml` under `app/build/intermediates/merged_manifests/release/`) with
  `grep -rE 'allowBackup|usesCleartextTraffic|debuggable'`: none may be `true`. `capacitor.config`'s
  `server.url` is the app's own https address (`https://<name>.citadel.zip/apps/<name>/`, what the shell loads), never a dev machine;
  it has no `server.cleartext`, and `allowNavigation` lists only hosts we control
  (each one can call the app's native plugins). Checklist after Cap-go/capgo-skills @e82217b (MIT),
  in our words.
- A lost keystore means every friend uninstalls (losing local data) and reinstalls, so never
  delete or regenerate one. Citadel can't tell a lost key from one never made: use
  `make_release_key` only for an app that never had one. If an app that had a key is told it has
  none, or half of one, stop: it's restored from the desktop's `keys\` backup
  (`deploy/desktop/README.md`, "Restoring"), so ask Cara.

## Delivery

- **A Capacitor contraption publishes itself after every deploy** (every ship to main deploys it).
  Once the deploy is live, Citadel checks whether `android/`, `capacitor.config.*` or the
  Capacitor `webDir` changed since the published APK. If so, it builds a release APK in its own
  checkout (`~/.cache/citadel-apk/<app>/`, log in `build.log` there), signs it with the app's
  release key and publishes it. A change elsewhere (the server, a web layer loaded from
  `server.url`) builds nothing. A `webDir` the deploy builds (a gitignored `dist/`) is copied
  from the live slot, and then every deploy with a new commit builds an APK.
  - **versionCode is the commit count on main** (`git rev-list --count HEAD`), or one past the
    published APK when that is higher (a roll back to an older commit), set at build time
    by Citadel's Gradle init script (`-Pcitadel.versionCode=N`). Leave `versionCode` in
    `build.gradle` alone; `versionName` is read from it.
  - The Gradle step runs on a machine with the Builds role when one has room (job "<title> APK build"), ahead of minions'
    builds; the unsigned APK comes back and perigee signs it. With none, or if that build fails there, perigee builds it
    itself; `build.log` says which.
  - Needs: the app's release key (above), `npm ci` in its `citadel-app.json` build steps (the
    build uses the live slot's `node_modules`), and a release build type with no `signingConfig`.
  - **Capacitor project not at the checkout's root?** Name it in `citadel-app.json`:
    `"capacitor": {"root": "android", "android": "android/native"}`. `root` is the folder holding
    `capacitor.config.json`/`.ts` (`webDir` is relative to it); `android` is the folder holding
    `app/build.gradle` (default `<root>/android`). Both are paths inside the checkout. A contraption
    with a release key but no Capacitor project found tells its Taskmaster once, naming this field.
  - A failed build tells the scheme's Taskmaster once per commit, and a missing key once until
    it's made; neither publishes anything. A risky release manifest flag (above) is told but still publishes.
  - Each build shows on the Releases page. An app whose `apk:` release target has a CI workflow
    (Mandate) keeps that path instead.
- The feed is in the contraption's `DATA_DIR/android/`: `latest.json` and the newest three
  `<app>-<N>.apk`. `latest.json` is `{ "versionCode": N, "apk": "<app>-N.apk", "versionName": "1.2",
  "commit": "<sha>" }`, `apk` relative to the feed. The app serves that folder under a contraption
  **open path** (its `open_paths`, e.g. `android/(<app>-\d+\.apk|latest\.json)`), so the phone's
  browser downloads them without Citadel's cookie. The tailnet keeps them private.
- A signed APK built in CI reaches perigee through Citadel's CI store, not a GitHub artifact: the
  release workflow uploads it as kind `release` (the `citadel:ci-store` skill).
- A release workflow on self-hosted runners adds `citadel-heavy-apk` to its build job's `runs-on`
  (a job with no `needs:`: Citadel sees a heavy job only while its run is queued),
  and copies the last step "tell Citadel its room is free" from the kit's `citadel-heavy.yml`
  template (with `id-token: write`): Citadel then hands the job to a PC with room for an 8-thread
  build, in its owner's order, and holds that room until the step runs (#2120).
- **Roll back to last green** on the Releases card puts last green on phones as the next version,
  since Android refuses a lower versionCode (ADR 0012). A Capacitor app's APK rolls back with its
  app: one button, the build numbered one past the published one. A CI-signed app's roll back
  points the branch `citadel/rollback` at last green and starts its release workflow there with
  the input `version_code` (published + 1): the workflow has to take that optional input and build
  as that versionCode (rewrite it in `build.gradle` before Gradle runs), or the button refuses.
  After one, the published versionCode is above main's, so the next release bumps past the
  published one, not main's.
- Publish a CI or hand-built APK into the contraption's feed with the `publish_release` tool (from
  any turn, container ones too) or the Deploy button on its card on the Releases page, not by
  copying files. Both refuse an APK signed with a different key from the published one, and
  record who published it.
- **An app on the shared shell (above) gets the native update dialog and needs no banner**; `mountUpdate()`
  steps aside there. Otherwise **the update banner is Citadel UI's `update.js`**: in the web layer,
  `import { mountUpdate } from '/apps/_citadel/ui/update.js'; mountUpdate();` (with base.css).
  Inside the Android app only, it compares `App.getInfo().build` (`@capacitor/app`) with
  `latest.json`. When it's behind, it shows "Update the app", which opens the APK in the system
  browser through `@capacitor/browser` (or `open: (url) => …` for a plugin of the app's own), and
  Android's installer takes it from there. `checkUpdate()` returns the update without drawing
  anything. A web-only change needs no new APK.
- The first install needs "Install unknown apps" allowed for the friend's browser.
- A plain Gradle app with no contraption: copy the signed `.apk` into the folder your prompt names
  for files you show people, and link it in chat (`[App 1.3](<path>.apk)`). The card downloads it,
  and a phone offers to install it.

## Emulator

Trying an APK or page on the shared emulator (`citadel-android`, microphone included): read `references/emulator.md` first;
install and launch only through `citadel-android`, take a lease before a session, run `down` when done.

## Icons: one SVG feeds them all

Don't hand-make icons. Keep one SVG (`web/public/icon.svg`, or the path in `citadel-app.json`'s `icon.source`) and run
`node <kit>/skills/android-app/scripts/gen-icons.mjs` in the app's repo. It writes the web icons
(`favicon-32.png`, `icon-192.png`, `icon-512.png`, next to the SVG) and, in a repo with an Android app (`citadel-app.json`'s
`capacitor.android`, else `android/`; `icon.androidRes` overrides), the adaptive foreground and monochrome layers, round and
legacy PNGs and the splash. It refuses a res folder with no `AndroidManifest.xml` beside it. Citadel shows the same SVG as the scheme's icon.
Needs `rsvg-convert`; its art is paths on a full-size background `<rect>` (other shapes reach the PNGs but not Android's vector layers), with only
`fill`, `stroke`, `stroke-width` and `stroke-linecap`: Android's layers refuse a `transform`, `opacity` or other attribute.

A scheme overrides any use by naming its own SVG; whatever isn't named is made from the source:

```json
"icon": { "source": "web/public/icon.svg", "background": "#0a6b6b",
  "overrides": { "small": "art/glyph-32.svg", "monochrome": "art/mono.svg" } }
```

Roles: `scheme` (what Citadel shows), `small` (the 32 px favicon), `foreground`, `monochrome`, `legacy`, `round`, `splash`.
The run writes `.citadel-icons.sha256`; `gen-icons.mjs --check` exits 1 when the committed icons no longer match their
SVGs or one is missing, so put it in the app's test or build and they can't drift (it needs no rsvg-convert). Commit the output.
