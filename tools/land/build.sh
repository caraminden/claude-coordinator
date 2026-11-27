# shellcheck shell=bash
# Build branches (--into build/<n>): claims, the build's lock and the merge into it.
# Sourced by tools/land.sh up front: definitions only (#2099).

# Build claims (#1159): build-claims.md on build/<n> names the files each feeder writes ("#<n>: <paths>"; a path ending
# in / is a folder, longest match wins), the files any feeder may add to ("shared: <paths>") and the build minion
# ("build: #<n>"). A feeder's --into is refused when it writes a file another feeder claimed or merged in first, the
# claims file, or, in a shared file, lines another feeder merged in. Who merged a commit: build/<n>'s reflog
# ("land.sh --into <branch>"), else a "#<n>" starting its subject. Runs at --check and after the rebase. No file, no check.
claims_check() {
  local trunk=$1 claims me boss mb merged f who m a b why
  claims=$(git show "refs/heads/$build:build-claims.md" 2>/dev/null) || return 0
  me=$(sed -nE 's#^ticket/([0-9]+)(-.*)?$#\1#p' <<<"$branch")
  boss=$(sed -nE 's/^build:[[:space:]]*#?([0-9]+).*/\1/p' <<<"$claims" | head -n 1)
  [ -n "$boss" ] || { say "warning: $build's build-claims.md has no line build: #<n> naming its build minion, so its claims aren't checked"; return 0; }
  { [ -n "$me" ] && [ "$me" != "$boss" ]; } || return 0 # the build minion's own branch, or one with no minion number
  [ "$mode" != full ] || refuse "--full is the build minion's (#$boss): a feeder merges in with tools/land.sh --into $build <test files>. Nothing merged"
  mb=$(git merge-base "refs/heads/$build" HEAD) || return 0
  # "<commit> <minion>" for each commit a feeder's --into brought in, newest reflog entry first.
  merged=$(git reflog show --format='%H %gs' "refs/heads/$build" 2>/dev/null | awk 'NR > 1 { print $1, prev } { prev = $0 }' |
    while read -r old new tool flag who; do
      [ "$tool $flag" = "land.sh --into" ] || continue
      m=$(sed -nE 's#^ticket/([0-9]+)(-.*)?$#\1#p' <<<"$who")
      [ -z "$m" ] || git rev-list "$old..$new" 2>/dev/null | sed "s/\$/ $m/"
    done)
  # The minion that wrote a commit of the build, or nothing for main's commits and the build minion's.
  writer() {
    git merge-base --is-ancestor "$1" "refs/heads/$trunk" 2>/dev/null && return 0
    local m
    m=$(awk -v c="$1" '$1 == c { print $2; exit }' <<<"$merged")
    [ -n "$m" ] || m=$(git log -1 --format=%s "$1" | sed -nE 's/^#([0-9]+)([^0-9].*)?$/\1/p')
    [ "$m" = "$boss" ] || echo "$m"
  }
  why=$(while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ "$f" = build-claims.md ]; then
      echo "$f is the build minion's plan, so only it changes a claim"
      continue
    fi
    # A list mark, backticks and commas are read as spaces: "- #4: `a.ts`, `b.ts`" claims both.
    who=$(awk -v f="$f" '{ l = $0; sub(/^[-*][ \t]+/, "", l); gsub(/[`,]/, " ", l) } match(l, /^(#[0-9]+|shared):/) {
        w = substr(l, 1, RLENGTH - 1); sub(/^#/, "", w); n = split(substr(l, RLENGTH + 1), p, /[ \t]+/)
        for (i = 1; i <= n; i++) if (p[i] != "" && (p[i] == f || (p[i] ~ /\/$/ && index(f, p[i]) == 1)) && length(p[i]) > best) { best = length(p[i]); out = w }
      } END { print out }' <<<"$claims")
    if [ "$who" = shared ]; then
      # Each run of lines this branch changes or removes, blamed at the merge-base: any another feeder wrote refuses.
      git -c core.quotePath=false diff -U0 --no-renames "$mb" HEAD -- "$f" | sed -nE 's/^@@ -([0-9]+)(,([0-9]+))? .*/\1 \3/p' | while read -r a b; do
        [ "${b:-1}" != 0 ] || continue
        git blame --porcelain -L "$a,+${b:-1}" "$mb" -- "$f" 2>/dev/null | awk 'length($1) >= 40 && $1 ~ /^[0-9a-f]+$/ { print $1 }' | sort -u | while read -r c; do
          m=$(writer "$c")
          [ -z "$m" ] || [ "$m" = "$me" ] || echo "$f (shared) changes or removes lines #$m merged in (line $a): only add to a shared file"
        done
      done | sort -u
    elif [ -n "$who" ]; then
      [ "$who" = "$me" ] || echo "$f is #$who's in the claims"
    else
      for c in $(git rev-list --reverse "refs/heads/$trunk..refs/heads/$build" -- "$f"); do
        m=$(writer "$c")
        [ -n "$m" ] || continue
        [ "$m" = "$me" ] || echo "$f is unclaimed, but #$m merged it in first, so it is #$m's"
        break
      done
    fi
  done < <(git -c core.quotePath=false diff --name-only --no-renames "$mb" HEAD))
  [ -n "$why" ] || return 0
  why="$branch writes outside its claim in $build's build-claims.md, so nothing merged: $(sed ':a;N;$!ba;s/\n/; /g' <<<"$why"). A late need goes through the build minion: ask #${boss:-?} (message_minion) to move the claim, or leave those files to their owners, then run this again"
  [ -z "$check" ] || { say "$why"; exit 3; } # hand_off_land's early check: exit 3 stops the hand-off with this text
  refuse "$why"
}

# One writer per build branch, on fd 6: a merge into it, its --full run or its land. Merges wait only for each other, not
# in the lands' line; --full and --build take it before that line, so a land never waits on a feeder's test run.
build_lock() {
  local lock=$state/build-${build#build/}.lock wait=${LAND_BUILD_WAIT:-3600}
  exec 6>"$lock" || { say "can't open $lock for writing, so nothing merged: a person needs to look at it"; return 1; }
  flock -n 6 && return 0
  say "waiting for the run on $build ahead of this one (a merge into it, its full run or its land) to end"
  flock -w "$wait" 6 && return 0
  say "waited $((wait / 60)) min for the run on $build ahead of this one, so nothing merged: run it again later, or look at what holds $lock"
  return 1
}

# The end of --into: build/<n> moves to what was tested unless something moved it meanwhile (compare-and-swap).
merge_into() {
  git update-ref -m "land.sh --into $branch" "refs/heads/$build" "$tip" "$base" || refuse "$build moved while this ran (not by land.sh, which holds its lock), so nothing merged: run it again"
  land_mark merged
  queue_done ok
  say "$build is now at $(git log -1 --format='%h "%s"' "$tip"); main and the live checkout are untouched"
  exit 0
}

# A claims merge in flight (#1684): the build minion's --into of a changed build-claims.md marks itself with
# <state>/build-<n>.claims.<pid> (its queue_proc identity); a mark whose process is gone counts for nothing.
# claims_inflight prints the pid of a live one other than this run (a dead one's goes).
claims_mark() { echo "$state/build-${build#build/}.claims"; }

claims_inflight() {
  local f
  for f in "$(claims_mark)".*; do
    [ -f "$f" ] && [ "${f##*.}" != $$ ] || continue
    [ "$(queue_proc "${f##*.}")" != "$(cat "$f" 2>/dev/null)" ] || { echo "${f##*.}"; return 0; }
    rm -f "$f"
  done
  return 1
}

# claims_check, unless a claims merge is in flight: the claims are about to change, so a feeder's hand-off (--check)
# goes ahead, and its run waits for that merge and is checked against the new plan. Under the build's lock claims_check
# runs again whatever happened here.
claims_gate() {
  local pid t=$SECONDS
  if pid=$(claims_inflight); then
    say "claims merge in flight on $build (the build minion's run, pid $pid), waiting for it to end; the claims are checked against the new plan after"
    [ -z "$check" ] || return 0
    while pid=$(claims_inflight); do
      [ $((SECONDS - t)) -lt "${LAND_BUILD_WAIT:-3600}" ] || refuse "waited ${LAND_BUILD_WAIT:-3600} s for the claims merge on $build (pid $pid) to end, so nothing merged: run it again later"
      sleep "$QUEUE_POLL"
    done
    say "the claims merge on $build ended: checking the claims"
  fi
  claims_check main
}
