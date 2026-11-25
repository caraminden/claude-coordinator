#!/usr/bin/env bash
# The room one contraption's copy is screenshotted in (#1783): no network but its own loopback, a read-only disk, and an
# empty home, so a copy of an app can't read or write its live data, another scheme's folder, a key or a service.
#   sandbox.sh <out dir> <path to show, read-only>... -- <command> [args...]
# Run it under: unshare --map-current-user --keep-caps --net --mount (--pid --fork --kill-child --mount-proc where allowed)
# The home is an empty tmpfs holding only the paths named (at their own places) and <out dir>, the one writable folder.
set -euo pipefail
out=$1; shift
show=()
while [ "$1" != -- ]; do show+=("$1"); shift; done
shift
: "${HOME:?}"
if command -v ip >/dev/null; then ip link set lo up
else python3 -c 'import fcntl,socket,struct; s=socket.socket(); fcntl.ioctl(s,0x8914,struct.pack("16sH14x",b"lo",0x41))'
fi
mount --make-rprivate /
old=$(mktemp -d /tmp/app-shots-home.XXXXXX)
trap 'umount -l "$old" 2>/dev/null; rmdir "$old" 2>/dev/null' EXIT
mount --rbind "$HOME" "$old"
mount -t tmpfs -o mode=700,size=512m home "$HOME"
bind() { # <path> [ro]
  local from=$old/${1#"$HOME"/}
  [ -e "$from" ] || return 0
  case $1 in "$HOME"/*) ;; *) return 0 ;; esac
  if [ -L "$from" ]; then mkdir -p "$(dirname "$1")"; cp -P "$from" "$1"; return 0; fi
  if [ -d "$from" ]; then mkdir -p "$1"; else mkdir -p "$(dirname "$1")"; : >"$1"; fi
  mount --bind "$from" "$1"
  [ -z "${2:-}" ] || mount -o remount,bind,ro "$1"
}
for p in "${show[@]}"; do bind "$p" ro; done
bind "$out"
umount -l "$old"
rmdir "$old" || true
trap - EXIT
# /run holds the user bus and every service's socket, which a network namespace doesn't cut off.
mount -t tmpfs -o mode=755 run /run
tmp=$out/.tmp
mkdir -p "$tmp"
mount --bind "$tmp" /tmp
mount -t tmpfs -o mode=1777 shm /dev/shm
# Every other disk and folder mounted on the box, read-only too, each with the flags it has (dropping one isn't allowed).
# One that can't be, and that this user could write to, ends the run. Under the covered folders nothing is reachable but what was shown.
while read -r _ _ _ _ at opts _; do
  at=$(printf '%b' "$at")
  case $at in /proc | /proc/* | /sys | /sys/* | /dev | /dev/* | /run | /run/* | /tmp | /tmp/* | "$HOME" | "$HOME"/* | "$out") continue ;; esac
  case ,$opts, in *,ro,*) continue ;; esac
  keep=$(tr , '\n' <<<"$opts" | grep -xE 'nosuid|nodev|noexec|relatime|noatime|nodiratime' | paste -sd, || true)
  mount -o "remount,bind,ro${keep:+,$keep}" "$at" 2>/dev/null || [ ! -w "$at" ] || { echo "sandbox: $at stays writable" >&2; exit 1; }
done </proc/self/mountinfo
cd "$HOME"
exec "$@"
