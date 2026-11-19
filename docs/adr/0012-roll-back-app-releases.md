# Roll back app releases: last green, out to devices

Status: accepted, 2026-11-19 (#1036's grilling rounds; built in #1036).

ADR 0010's "Roll back to last green" covers what can redeploy an older commit: a contraption and Citadel's server.
Fast mode (ADR 0011) lets an untested build reach people's devices too: an Android APK through its contraption's
update banner, a desktop build through its app's updater. Cara, 2026-11-19, on the Taskmaster's card about guarding
releases before fast mode, picked "Accept the risk" and added: "Cant we make something that quick releases an old
version as the next version? or a way to go back to the old version? or something (depends on the kind of app)".

What each kind does today (found for this ADR):

- **A perigee-built APK** (#837, TWIReader, VoiceAnalyzer): after each deploy Citadel builds the live commit, numbers it
  by commit count, signs it with the app's key in `~/.config/citadel-android` and writes `latest.json`. The banner
  offers a strictly higher versionCode, and Android refuses a downgrade, so an old APK file can't go back out as it is.
  Rolling the app back today leaves the APK where it was: its build refuses a commit count below the published one.
- **A CI-signed APK** (Mandate): `android-release.yml` signs main's hand-bumped versionCode on CI, and the Releases
  card's publish step copies it from the CI store into the feed. Same downgrade rule.
- **A CI package with its own updater** (Peek Auras' Windows build): its companion offers PCs the newest green
  `windows.yml` run on main, numbered by run number, when the PC's number is lower. The PC itself takes whatever build
  it's offered, older or not.

## Decisions

- **Rebuild old as next, main untouched** (Q1, Cara, 2026-11-19: "Rebuild old as next"): no undo commit on main. A
  target goes back to its scheme's last green and is pinned there, held until main has a newer green commit, as in
  ADR 0010. Where a device refuses an older number, last green's code is built again numbered one past what is
  published.
- **An Android app and its web app go back together** (Q2: "Yes, together"): the Android card's button and the app's
  card's button are one roll back. The app deploys last green, and its APK build, which follows the live commit, builds
  it numbered one past the published APK. Its pin is the app's, so the APK is held with it.
- **Desktop: a feed, no rebuild** (Q3, asked again after Cara's "Would Citadel serving the feed mean we wouldnt need to
  rebuild": "Feed, no rebuild"): a CI package's roll back pins it at last green's existing build in the CI store. Its
  card shows that build as current, and Citadel serves the scheme's pins to its apps, so an app with its own updater
  hands that build out even though its number is older. The CI store keeps each scheme's last green builds and the
  pinned ones, so the file is there to hand out. The app's updater reads the pins: Peek Auras needs that change, in
  its own scheme.
- **CI-signed APKs too, now** (Q4: "Yes, now"): Citadel points a branch it owns (`citadel/rollback`) at last green and
  starts the app's release workflow there with a `version_code` input one past the published APK, then publishes the
  signed run as any other. The app's release workflow needs to take that input (Mandate, in its own scheme); until last
  green's copy of the workflow has it, the button says so.

## Not covered

- **file** targets (builds a minion handed people as files): they aren't tied to commits, so there is no last green to
  go back to.
- A break the full suite doesn't catch passes it, so last green can be the broken build itself (ADR 0010's limit).
