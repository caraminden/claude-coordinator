---
name: android-app
description: Build, sign and ship an Android app (a Capacitor shell or plain Gradle) on perigee's shared Android toolchain. Use when a turn runs gradlew, changes compileSdk, the Android Gradle Plugin or build-tools, makes a release APK, wires an app's update banner, or tries an APK or a page on the shared emulator (citadel-android), its microphone included.
---

# Android app

One Android SDK serves every scheme: `~/.local/share/android-sdk`, with JDK 21 from mise. Citadel's
`tools/android/install-sdk.sh` installs it on the host. Every turn gets `ANDROID_HOME`,
`ANDROID_SDK_ROOT` and `JAVA_HOME` (`java` and `keytool` are on PATH). In a container turn the SDK
is **read-only**.

## Build

- From the app's `android/` folder (Capacitor: `npx cap sync android` first):
  `citadel-heavy ./gradlew assembleDebug`. Always through citadel-heavy: a cold build takes every
  core it can get and 2–3 GB of RAM.
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
  2. `citadel-heavy ./gradlew assembleRelease`.
  3. Sign with `apksigner` from `$ANDROID_HOME/build-tools/36.1.0/`, then verify:
     `apksigner sign --ks <jks> --ks-pass file:<pass> --out <app>.apk app-release-unsigned.apk`,
     then `apksigner verify <app>.apk`.
- Before signing a Capacitor shell, check the merged release manifest
  (`AndroidManifest.xml` under `app/build/intermediates/merged_manifests/release/`) with
  `grep -rE 'allowBackup|usesCleartextTraffic|debuggable'`: none may be `true`. `capacitor.config`
  has no `server.url` or `server.cleartext`, and `allowNavigation` lists only hosts we control
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
- **The update banner is Citadel UI's `update.js`**: in the web layer,
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

One headless emulator for every scheme: the `citadel` AVD (Android 36, Google APIs, x86_64, a
1080×2400 phone), driven by `citadel-android`, which is on every turn's PATH, host and container
alike. It runs on Cara's desktop, behind a tunnel to perigee (Citadel's
`deploy/desktop/android/README.md`); the commands, the serial `emulator-5554` and the adb server on
perigee are the same as when it ran here:

```
citadel-android up                 # boot it (10-15s; a few minutes the first boot after an update) and wait until it's ready
citadel-android install app/build/outputs/apk/debug/app-debug.apk
citadel-android open https://citadel.zip/c/                                   # in Chrome (an app: https://<name>.citadel.zip/, the short link people get)
citadel-android shot "$TMPDIR/shot.png"                                    # then Read the PNG
citadel-android offline on         # airplane mode; `offline off` to undo
citadel-android sms +15551234567 'Your code is 1234'                      # an incoming text
citadel-android tone 1000 3 "$TMPDIR/tone.wav"                             # a test tone (hz, seconds, file, [rate])
citadel-android mic "$TMPDIR/tone.wav" 10 &                                 # the phone's microphone hears it once an app records
citadel-android mic-check                                                  # smoke check: Chrome records the mic and finds a tone
citadel-android down               # when you're done
```

- **Install and launch only through `citadel-android`, never raw `adb install`.** Its screen lease
  covers only `citadel-android`'s own calls, so a raw install can land mid-way through someone
  else's test. `install` is `-r -t`, an upgrade in place. On `INSTALL_FAILED_UPDATE_INCOMPATIBLE` it
  prints a hint: uninstall only a build that is yours.
- `install`, `open`, `offline` and `sms` boot it first if needed.
- **Fake texts with `sms`, never `adb emu sms send`.** The console wants a token turns can't read, so
  plain `adb emu` answers "KO: unknown command". `sms` hands the text to the emulator's service on the
  host, which sends it. The sender is digits with an optional leading `+` (up to 20); the text is one
  line of up to 500 characters. To see it arrive (logcat has no clear line for it):
  `adb -s emulator-5554 shell content query --uri content://sms/inbox --projection address,body`.
  If it says the service didn't answer, the service still runs older code: `down`, then try again; if that doesn't help, ask your Taskmaster (perigee's `citadel-android-adb.service` needs a restart). Run your app with
  `adb -s emulator-5554 shell monkey -p <applicationId> 1`; plain `adb -s emulator-5554 ...` works
  for anything else (logcat, input), from containers too.
- **Other console and shell traps.** `adb emu` exits 0 even when it prints `KO: ...`, and a refused
  `cmd notification` can print usage and exit 0: read the reply, not the exit code. `sms` is
  accepted before it reaches the inbox, so poll. There is no MMS or RCS, and the sender isn't
  validated. `adb shell cmd notification post` posts as `com.android.shell` on channel `shell_cmd`,
  so a listener filtering by your package won't match; read back with `cmd notification list`.
  `cmd notification allow_listener <pkg>/<service>` grants listener access. To tap without
  coordinates: `adb -s emulator-5554 exec-out uiautomator dump /dev/tty`, then tap the centre of the
  node's `bounds` (`exec-out` avoids a shared temp file). One app's log:
  `adb -s emulator-5554 logcat -d --pid=$(adb -s emulator-5554 shell pidof <pkg>)`.
- **Take the lease before a test session** (#1128): `citadel-android lease [minutes] ["what for"]` (20 minutes
  unless you say, at most 60; call it again to renew). Other turns' steps then wait, saying who holds it and for
  what, however long you pause between your steps. `citadel-android release` gives it back (so does `down`, and so
  does your turn ending); a turn that dies loses it at its time. `citadel-android status` says who has it, and the
  Machines page shows it. Without a lease you still keep the screen 2 minutes after each step.
- **One screen.** Each call takes the screen lock, and you keep the screen for 2 minutes after each
  call, so your install, open and shot run back to back. Anyone else waits, and it says whose turn
  holds it. Don't work around a wait: it ends when the holder's lease runs out or it runs `down`.
- **Run `down` when you're done**, unless the emulator was already up when you started (someone
  else's session may use it). It also stops itself after 15 minutes with no `citadel-android` call.
  Its RAM is the desktop's, not perigee's.
- **Every boot starts clean** (#943): no app another session installed, no tabs, no logins. While it
  stays up it keeps everyone's state, so uninstall what you need gone. After an `up` that booted it
  (it says "starting the emulator"), install your APK again.
- It's a Citadel page or app without its cookie, so expect a sign-in page.
- **"the emulator's desktop isn't connected"**: Cara's PC is asleep, restarting or logged off, so
  there is no emulator right now. Nothing on perigee fixes it and nothing falls back; it returns by
  itself when the PC does. Say so in your reply and go on with what doesn't need a phone; don't
  wait in a loop.
- **Reach a dev server on perigee with `adb reverse`**:
  `adb -s emulator-5554 reverse tcp:<port> tcp:<port>`, then `http://127.0.0.1:<port>` in the phone.
  `10.0.2.2` inside the phone is the desktop, not perigee.
- **The rail hides itself in a wrapper** (#935). A shell that loads the contraption (`server.url`) needs
  nothing set: the kit's rail.js sees `window.Capacitor.isNativePlatform()` and draws no switcher rail, swipe
  handle or Alt+` there. Only a non-Capacitor shell sets `CitadelApp` in its WebView's user agent
  (Capacitor's own option is `appendUserAgent`). Check it on the emulator: the page shows no left panel.
- **A Capacitor shell's WebView.** The page's console is in logcat under the tags `Capacitor` and
  `Capacitor/Console`; a debug build's WebView also shows in `chrome://inspect/#devices`. Replay a
  permission flow without reinstalling: `adb -s emulator-5554 shell pm revoke <appId>
  android.permission.<NAME>`, then `pm grant` to undo it. When phones behave differently, note the
  WebView version: `adb -s emulator-5554 shell dumpsys webviewupdate`.
- **Synthetic microphone** (`mic`, #843). It feeds a WAV into the phone's microphone, so a recording
  flow (getUserMedia, an AudioWorklet, an upload) runs end to end with audio whose answer you know.
  - **Synthetic audio only**: tones, sweeps or noise made with code (`tone`, or your own generator),
    never a recording of a real voice. The WAV must be 16-bit PCM, mono or stereo, 8 to 48 kHz.
  - **`mic` waits up to 2 minutes for an app to open the mic**, then plays the file, looped to fill
    `[seconds]`, at most 600; it never plays into a phone where nothing records, because that crashes
    this emulator. So start it in the background, then make the app record.
  - **Chrome grants the mic and camera without a prompt,** and runs an AudioContext without a tap. A
    Capacitor shell needs the permission first (`adb -s emulator-5554 shell pm grant <appId>
    android.permission.RECORD_AUDIO`), and its WebView may hold an AudioContext until a tap: start
    recording with a real tap (`adb -s emulator-5554 shell input tap <x> <y>`).
  - **The phone records at 48 kHz.** That is the trap the mic exists to catch: code that assumes
    44.1 kHz. Read the rate from the AudioContext or the track's settings, and turn off
    `echoCancellation`, `noiseSuppression` and `autoGainControl` for analysis. `mic-check` prints
    both, and a pure tone with them left on can come back quieter or reshaped. The emulator has no
    processing of its own, so it can't show what a real phone's does: test that on a real phone.
  - **"only silence came through"**: the emulator's computer was too busy to keep its sound card fed,
    and Android filled in silence. Try again later.
  - **"no emulator microphone"**: the desktop hasn't been set up again since the mic arrived
    (Citadel's `deploy/desktop/android/README.md`, "Adding the mic port"). Ask your Taskmaster.
- It renders in software (ANGLE on SwiftShader, `-gpu swangle_indirect`, no GPU) with guest Vulkan off: fine for screenshots and
  flows, not for frame rates or graphics bugs. Test those on a real phone.

## Icons: one SVG feeds them all

Don't hand-make icons. Keep one SVG (`web/public/icon.svg`, or the path in `citadel-app.json`'s `icon.source`) and run
`node "${CLAUDE_PLUGIN_ROOT}/skills/android-app/scripts/gen-icons.mjs"` in the app's repo. It writes the web icons
(`favicon-32.png`, `icon-192.png`, `icon-512.png`, next to the SVG) and, when `android/` exists, the adaptive
foreground and monochrome layers, round and legacy PNGs and the splash. Citadel shows the same SVG as the scheme's icon.
Needs `rsvg-convert`; its art is paths on a full-size background `<rect>` (other shapes reach the PNGs but not Android's vector layers).

A scheme overrides any use by naming its own SVG; whatever isn't named is made from the source:

```json
"icon": { "source": "web/public/icon.svg", "background": "#0a6b6b",
  "overrides": { "small": "art/glyph-32.svg", "monochrome": "art/mono.svg" } }
```

Roles: `scheme` (what Citadel shows), `small` (the 32 px favicon), `foreground`, `monochrome`, `legacy`, `round`, `splash`.
The run writes `.citadel-icons.sha256`; `gen-icons.mjs --check` exits 1 when the committed icons no longer match their
SVGs, so put it in the app's test or build and they can't drift (it needs no rsvg-convert). Commit the output.
