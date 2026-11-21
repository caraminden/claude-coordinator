#!/usr/bin/env bash
# Builds the desktop app's Windows zip (#1186): Electron's own win32-x64 release, pinned by checksum, with this folder as
# its app (resources/app) and electron.exe renamed Citadel.exe. The zip is what #1148's feed takes (publish_desktop,
# exe "Citadel.exe", started "file"). Runs on Linux with curl, node and python3, whose zipfile packs and unpacks
# (the CI runner has no unzip or zip); nothing is compiled.
#   desktop/build.sh [out.zip]     (default: $TMPDIR/citadel-desktop.zip)
# A change under desktop/ that ships is built by .github/workflows/desktop.yml, which keeps the zip in the CI store as a
# release; Citadel's "desktop" target (citadel-app.json) publishes it to the feed. PCs pick it up on their next start but
# one; the page itself updates with every deploy. publish_desktop is only for a build made by hand.
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
python3 -I -m zipfile -e "$dist" "$work/Citadel"
# Citadel's icon and name on the exe itself (Explorer, the taskbar, Task Manager), by resedit-cli, a pure-JS resource editor.
# It drops Electron's signature, which no longer matches once the exe changes.
npm exec --yes --package=resedit-cli@3.1.1 -- resedit --in "$work/Citadel/electron.exe" --out "$work/Citadel/Citadel.exe" \
  --ignore-signed --icon "1,$here/icon.ico" --product-name Citadel --file-description Citadel --internal-name Citadel \
  --original-filename Citadel.exe --product-version "$VERSION.0" --file-version "$VERSION.0"
rm "$work/Citadel/electron.exe"
rm -f "$work/Citadel/resources/default_app.asar"
mkdir "$work/Citadel/resources/app"
cp "$here"/{main.cjs,route.cjs,keys.cjs,preload.cjs,package.json,icon.ico} "$work/Citadel/resources/app/"
rm -f "$out"
# Deflated, sorted, with directory entries and no extra fields, like zip -r -X made it.
python3 -I - "$work" "$out" <<'PY'
import os, sys, zipfile
work, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(os.path.join(work, "Citadel")):
        dirs.sort()
        z.write(root, os.path.relpath(root, work))
        for f in sorted(files):
            z.write(os.path.join(root, f), os.path.relpath(os.path.join(root, f), work))
PY
echo "$out ($(du -h "$out" | cut -f1))"
