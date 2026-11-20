#!/usr/bin/env bash
# Builds the desktop app's Windows zip (#1186): Electron's own win32-x64 release, pinned by checksum, with this folder as
# its app (resources/app) and electron.exe renamed Citadel.exe. The zip is what #1148's feed takes (publish_desktop,
# exe "Citadel.exe", started "file"). Runs on Linux with curl, unzip and zip; nothing is compiled.
#   desktop/build.sh [out.zip]     (default: $TMPDIR/citadel-desktop.zip)
# shortcut: Citadel.exe keeps Electron's icon in Explorer (the window and taskbar use icon.png); changing the exe's own
# icon needs rcedit, a Windows tool, so do it if people mind the icon on the shortcut.
set -euo pipefail
VERSION=45.4.1
SHA256=2ba6223afa9121f42831fefe92c434334907540165294fc56697449d12e7cfe9
here=$(cd "$(dirname "$0")" && pwd)
out=$(realpath -m "${1:-${TMPDIR:-/tmp}/citadel-desktop.zip}")
cache=${XDG_CACHE_HOME:-$HOME/.cache}/citadel-desktop
dist=$cache/electron-v$VERSION-win32-x64.zip
mkdir -p "$cache"
if ! echo "$SHA256  $dist" | sha256sum -c --status 2>/dev/null; then
  curl -fsSL -o "$dist.part" "https://github.com/electron/electron/releases/download/v$VERSION/electron-v$VERSION-win32-x64.zip"
  echo "$SHA256  $dist.part" | sha256sum -c --status || { echo "electron zip checksum mismatch" >&2; rm -f "$dist.part"; exit 1; }
  mv "$dist.part" "$dist"
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
unzip -q "$dist" -d "$work/Citadel"
mv "$work/Citadel/electron.exe" "$work/Citadel/Citadel.exe"
rm -f "$work/Citadel/resources/default_app.asar"
mkdir "$work/Citadel/resources/app"
cp "$here"/{main.cjs,route.cjs,preload.cjs,package.json,icon.png} "$work/Citadel/resources/app/"
rm -f "$out"
(cd "$work" && zip -qr -X "$out" Citadel)
echo "$out ($(du -h "$out" | cut -f1))"
