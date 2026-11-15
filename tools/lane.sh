#!/usr/bin/env bash
# The land lane of a change (#753):  git diff --name-only A B | tools/lane.sh <rev>
# Prints `<lane> <path>`: the change's lane and the path that decided it. The map is tools/lanes as <rev> has it
# (main's: a change can't loosen its own lane), from the repo in the current directory.
#   light  every path is light
#   kit    kit paths, and light ones if any
#   full   anything else: a path the map doesn't list or puts in another lane, tools/lanes or this file, no path at
#          all, or a map that can't be read
set -uo pipefail
map=$(git show "${1:?usage: tools/lane.sh REV, with the changed paths on stdin}:tools/lanes" 2>/dev/null) || { echo "full (no tools/lanes at $1)"; exit 0; }
mapfile -t lines < <(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' <<<"$map")

# The lane of one path, from the first map line that matches it.
lane_of() {
  local line pat pats
  for line in "${lines[@]}"; do
    read -r -a pats <<<"$line" # read -a: the patterns stay patterns, never globbed against the disk
    for pat in "${pats[@]:1}"; do
      # shellcheck disable=SC2053 # unquoted on purpose: a pattern
      [[ $1 == $pat ]] && { echo "${pats[0]}"; return; }
    done
  done
  echo full
}

rank() { case $1 in light) echo 0 ;; kit) echo 1 ;; *) echo 2 ;; esac }
lane=light why='' seen=''
while IFS= read -r path; do
  [ -n "$path" ] || continue
  seen=1
  case $path in
    tools/lanes | tools/lane.sh) this=full ;;
    *) this=$(lane_of "$path") ;;
  esac
  [ "$(rank "$this")" -gt "$(rank "$lane")" ] || { [ -n "$why" ] || why=$path; continue; }
  lane=$this why=$path
  [ "$(rank "$lane")" != 2 ] || break
done
[ -n "$seen" ] || { echo "full (nothing changed)"; exit 0; }
[ "$(rank "$lane")" != 2 ] || lane=full
echo "$lane $why"
