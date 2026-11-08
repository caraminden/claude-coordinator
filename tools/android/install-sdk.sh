#!/usr/bin/env bash
# The shared Android toolchain on perigee (#379), installed once on the host as cara, no root.
# Re-runnable: each step skips what is already there. Adding an SDK package is one line in PACKAGES.
# Container turns see the SDK read-only (TOOL_DIRS in src/claude-link.ts), so a new package or
# version is always installed here, on the host, never by Gradle inside a container.
set -euo pipefail

SDK="${ANDROID_HOME:-$HOME/.local/share/android-sdk}"
JDK='java@temurin-21'
# Names as `android sdk list --all` prints them.
PACKAGES=(
  'platform-tools'
  'build-tools/36.1.0'
  'build-tools/35.0.0' # the Android Gradle Plugin 8.13's default (Capacitor 8): unpinned projects ask for it
  'platforms/android-36'
)
# The bootstrap cmdline-tools, from Google's repository2-3.xml (cmdline-tools;latest, revision 23.0),
# unpacked as cmdline-tools/latest. From 23.0 its `android` CLI replaces sdkmanager (now a deprecated
# wrapper round it) and needs no separate licence step; it unpacks itself into ~/.android/cli on first run.
BOOT_ZIP='commandlinetools-linux-16111833_latest.zip'
BOOT_SHA1='e025545c62a8e64c7559119566a569fb1dec5f60'

[ "$(id -u)" != 0 ] || { echo 'Run as cara, not root.' >&2; exit 1; }
[ ! -e /run/.containerenv ] || { echo 'Run on the host: in a container the SDK folder is read-only.' >&2; exit 1; }

echo "== JDK 21 ($JDK, through mise)"
mise use -g "$JDK" >/dev/null
JAVA_HOME="$(mise where "$JDK")"
export JAVA_HOME
"$JAVA_HOME/bin/java" -version 2>&1 | head -1

echo "== cmdline-tools in $SDK"
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fL --progress-bar -o "$tmp/$BOOT_ZIP" "https://dl.google.com/android/repository/$BOOT_ZIP"
  echo "$BOOT_SHA1  $tmp/$BOOT_ZIP" | sha1sum -c --quiet
  unzip -q "$tmp/$BOOT_ZIP" -d "$tmp"
  mkdir -p "$SDK/cmdline-tools"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
fi
android=("$SDK/cmdline-tools/latest/bin/android" --no-metrics "--sdk=$SDK")

echo "== packages: ${PACKAGES[*]}"
"${android[@]}" sdk install "${PACKAGES[@]}"
"${android[@]}" sdk list

echo '== Gradle defaults (~/.gradle/gradle.properties)'
# No daemon: Gradle's idles for 3 hours holding about 1 GB, after citadel-heavy has freed its slot.
# Container turns get a copy of this file in their own ~/.gradle (ClaudeLink.start, src/claude-link.ts).
props="$HOME/.gradle/gradle.properties"
mkdir -p "$(dirname "$props")"
touch "$props"
setprop() {
  if grep -q "^$1=" "$props"; then sed -i "s|^$1=.*|$1=$2|" "$props"; else echo "$1=$2" >>"$props"; fi
}
setprop org.gradle.daemon false
setprop kotlin.compiler.execution.strategy in-process
setprop org.gradle.jvmargs -Xmx2g
setprop org.gradle.workers.max 4
cat "$props"

echo '== disk'
du -sh "$SDK" "$JAVA_HOME" 2>/dev/null
