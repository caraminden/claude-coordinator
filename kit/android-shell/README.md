# @citadel/android-shell

Citadel's shared Android shell (#1138): one Capacitor plugin that every contraption's Android app pins, so the parts
every app needs are written and fixed once. How an app adopts it, its settings and the page's calls are in the
`citadel:android-app` skill, "Shared shell". This file is for changing the shell itself.

## What it does

- **Citadel links** (`Links`, from Mandate #127): Citadel's host stays in the WebView only for sign-in; its other pages
  and other apps open outside, in Citadel's app or the browser.
- **Offline page** (`ShellWebViewClient`): only a gateway error (502, 503, 504) shows the app's `errorPath` page, so
  Citadel's own answers ("you don't have this app") show as they are.
- **Load watchdog** (`LoadWatchdog`, from Voice #64): a load that paints nothing for 20 s opens the offline page
  rather than a black screen.
- **Update prompt** (`Updates`, `UpdateCheck`): on launch, and on resume after 30 min, reads the feed Citadel
  publishes (`android/latest.json` beside the page) and asks with a native dialog. Later holds per build.
- **Push** (`ShellPlugin.enablePush`, `ShellMessagingService`, `ShellInit`): Citadel is the sender for every app
  (`POST /api/contraptions/push`, src/fcm.ts). The page calls `enablePush()` when it wants push; the shell asks for
  the permission, registers the phone at `/apps/_citadel/push/<app>`, shows each push's notification and opens its
  page on a tap, and hands the push's own data to the app's `PushHandler`.

## Versions

`version` in `package.json` is what apps pin. Raise it with every change that apps should take (patch for a fix,
minor for something new, major for a change an app must act on), and note it below. An app moves when its scheme
runs `android-shell.mjs install` again and ships the build; nothing moves an app on its own.

- 1.0.0 (2026-11-19): links, offline page, watchdog, update prompt, push. First app: Voice.

## Testing a change

The JVM tests (`android/src/test/`) aren't in the packed copy. Run them from an app clone whose Gradle points at this
folder, with the shared toolchain (the `citadel:android-app` skill):

```bash
# in a clone of an app that pins the shell, from its Android project:
sed -i "s|new File('../node_modules/@citadel/android-shell/android')|new File('<this repo>/kit/android-shell/android')|" capacitor.settings.gradle
citadel-heavy --here ./gradlew :citadel-android-shell:testDebugUnitTest :app:assembleDebug
```

Then delete `android/build/` here. Try it on the shared emulator with a debug build of that clone
(`citadel-android`), and check links, the offline page, the update prompt (point `updateFeed` at a test feed) and
`enablePush()`'s permission prompt.
