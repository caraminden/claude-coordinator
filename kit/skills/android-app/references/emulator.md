# The shared emulator

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
