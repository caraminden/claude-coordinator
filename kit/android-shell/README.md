# @citadel/android-shell

Citadel's shared Android shell (#1138): one Capacitor plugin that every contraption's Android app pins, so the parts
every app needs are written and fixed once. How an app adopts it, its settings and the page's calls are in the
`citadel:android-app` skill, "Shared shell". This file is for changing the shell itself.

## What it does

- **Citadel links** (`Links`, from Mandate #127): Citadel's host stays in the WebView only for sign-in; its other pages
  and other apps open outside, in Citadel's app or the browser.
- **Offline page** (`ShellWebViewClient`, `Gateway`): only a gateway error (502, 503, 504) shows the app's `errorPath`
  page, so Citadel's own answers ("you don't have this app") show as they are. Its own 503 page ("the app's keys don't
  open") carries `X-Citadel-Page` (src/apps.ts) and shows too; its 502 for an app that is down doesn't.
- **Load watchdog** (`LoadWatchdog`, from Voice #64): a load that paints nothing for 20 s opens the offline page
  rather than a black screen. A download, or a link opened outside, leaves the page on screen as it is: the shell's
  `DownloadListener` only settles the load and saves nothing.
- **Update prompt** (`Updates`, `UpdateCheck`): on launch, and on resume after 30 min, reads the feed Citadel
  publishes (`android/latest.json` beside the page) and asks with a native dialog. Later holds per build.
- **Push** (`ShellPlugin.enablePush`, `ShellMessagingService`, `ShellInit`): Citadel is the sender for every app
  (`POST /api/contraptions/push`, src/fcm.ts). The page calls `enablePush()` when it wants push; the shell asks for
  the permission, registers the phone at `/apps/_citadel/push/<app>`, shows each push's notification and opens its
  page on a tap, and hands the push's own data to the app's `PushHandler`. A tap's page opens once (`OpenedPushes`): the
  intent carries the push's id, since Android hands it back from Recents and after the process died. Push follows
  the person signed in (`PushOwner`, as each page loads): a login change re-registers the phone, signing out ends the
  old person's push, and a turn-off made offline is sent again. The rule for a push's `open` page is the server's
  (`openOk` in src/fcm.ts); `push-open-cases.txt` in the tests' resources is run against both.

## Versions

`version` in `package.json` is what apps pin. Raise it with every change that apps should take (patch for a fix,
minor for something new, major for a change an app must act on), and note it below. An app moves when its scheme
runs `android-shell.mjs install` again and ships the build; nothing moves an app on its own.

- 1.0.1 (2026-11-25): a notification's page doesn't open again from Recents; downloads leave the page alone; push
  ends on a login change and after an offline turn-off; a push's `open` may carry an address in its query;
  Citadel's own 503 page shows. Nothing an app must change.
- 1.0.0 (2026-11-19): links, offline page, watchdog, update prompt, push. First app: Voice.

## Testing a change

The JVM tests (`android/src/test/`) aren't in the packed copy. Run them from an app clone whose Gradle points at this
folder, with the shared toolchain (the `citadel:android-app` skill):

```bash
# in a clone of an app that pins the shell, from its Android project:
sed -i "s|new File('../node_modules/@citadel/android-shell/android')|new File('<this repo>/kit/android-shell/android')|" capacitor.settings.gradle
citadel-heavy --here --heavy ./gradlew :citadel-android-shell:testDebugUnitTest :app:assembleDebug
```

Then delete `android/build/` here. Try it on the shared emulator with a debug build of that clone
(`citadel-android`), and check links, the offline page, the update prompt (point `updateFeed` at a test feed) and
`enablePush()`'s permission prompt.
