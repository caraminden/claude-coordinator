---
name: android-app
description: Build, sign and ship an Android app (a Capacitor shell or plain Gradle) on perigee's shared Android toolchain. Use when a turn runs gradlew, changes compileSdk, the Android Gradle Plugin or build-tools, makes a release APK, wires an app's update banner, or tries an APK or a page on the shared emulator (citadel-android).
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
- The first build in a home downloads Gradle and its dependencies, about 1 GB in `~/.gradle`.

## Pinned versions

Installed: `platforms;android-36`, `build-tools` 36.1.0 and 35.0.0 (the Android Gradle Plugin
8.13's default, which Capacitor 8 uses), and `platform-tools`.

- Keep `compileSdk` at 36. Don't bump compileSdk, the Android Gradle Plugin or `buildToolsVersion`
  to a version that isn't installed.
- **"The SDK directory is not writable"** means the build wants a package that isn't installed.
  Gradle can't install it inside a container. Don't work around it with a private SDK copy:
  1. Add the package to `PACKAGES` in Citadel's `tools/android/install-sdk.sh`.
  2. Have it run on the host. A host turn runs the script itself; a container turn asks its
     Taskmaster.

## Release signing

- Cara makes each app's keystore once: `~/.config/citadel-android/<app>-release.jks`, with its
  password in `<app>-release.pass` beside it. Both are mode 600.
- Never copy either into a repo, the shared folder, a chat or a log. Container homes don't have
  `~/.config/citadel-android`, so release builds run in a host turn.
- For each release:
  1. Bump `versionCode` (and `versionName`) in `app/build.gradle`.
  2. `citadel-heavy ./gradlew assembleRelease`.
  3. Sign with `apksigner` from `$ANDROID_HOME/build-tools/36.1.0/`, then verify:
     `apksigner sign --ks <jks> --ks-pass file:<pass> --out <app>.apk app-release-unsigned.apk`,
     then `apksigner verify <app>.apk`.
- A lost keystore means every friend uninstalls (losing local data) and reinstalls, so never
  delete or regenerate one. If it's missing, stop and ask Cara.

## Delivery

- The app serves the signed APK and `android/latest.json` (`{ "versionCode": N, "apk": "<url>" }`)
  under a contraption **open path** (its `open_paths`), so the phone's browser downloads them
  without Citadel's cookie. The tailnet keeps them private.
- The web layer compares `App.getInfo().build` with `latest.json`. When it's behind, it shows
  "Update the app", which opens the APK URL in the system browser, and Android's installer takes
  it from there. A web-only change needs no new APK.
- The first install needs "Install unknown apps" allowed for the friend's browser.

## Emulator

One headless emulator for every scheme: the `citadel` AVD (Android 36, Google APIs, x86_64, a
1080×2400 phone), driven by `citadel-android`, which is on every turn's PATH, host and container
alike:

```
citadel-android up                 # boot it (quick boot ~6s, cold ~25s) and wait until it's ready
citadel-android install app/build/outputs/apk/debug/app-debug.apk
citadel-android open https://cara.apps.webplatformisbestplatform.net/c/   # in Chrome
citadel-android shot "$TMPDIR/shot.png"                                    # then Read the PNG
citadel-android offline on         # airplane mode; `offline off` to undo
citadel-android sms +15551234567 'Your code is 1234'                      # an incoming text
citadel-android down               # when you're done
```

- `install`, `open`, `offline` and `sms` boot it first if needed.
- **Fake texts with `sms`, never `adb emu sms send`.** The console wants a token turns can't read, so
  plain `adb emu` answers "KO: unknown command". `sms` hands the text to the emulator's service on the
  host, which sends it. The sender is digits with an optional leading `+` (up to 20); the text is one
  line of up to 500 characters. To see it arrive (logcat has no clear line for it):
  `adb -s emulator-5554 shell content query --uri content://sms/inbox --projection address,body`.
  If it says the service didn't answer, the service still runs older code: `down`, then try again. Run your app with
  `adb -s emulator-5554 shell monkey -p <applicationId> 1`; plain `adb -s emulator-5554 ...` works
  for anything else (logcat, input), from containers too.
- **One screen.** Each call takes the screen lock, and you keep the screen for 2 minutes after each
  call, so your install, open and shot run back to back. Anyone else waits, and it says whose turn
  holds it. Don't work around a wait: it ends when the holder's lease runs out or it runs `down`.
- **Run `down` when you're done.** It holds about 4 GB of RAM while up. It also stops itself after
  15 minutes with no `citadel-android` call.
- The phone keeps its state between boots (apps, Chrome tabs, logins), from every scheme that used
  it. Don't rely on a clean device; uninstall what you need gone.
- It's a Citadel page or app without its cookie, so expect a sign-in page.
- **"nothing listens on 127.0.0.1:18590"** or **"can't start citadel-android.service"**: the host's
  units aren't installed. Ask your Taskmaster; Cara installs them (Citadel's `deploy/`).
- It renders in software (SwiftShader, no GPU) with guest Vulkan off: fine for screenshots and
  flows, not for frame rates or graphics bugs. Test those on a real phone.
