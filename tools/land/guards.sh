# shellcheck shell=bash
# The guard tests and main's boot check, run on the rebased branch before CI.
# Sourced by tools/land.sh up front: definitions only (#2099).

# <state>/bad: "<commit> <last-good> <when> <what it restarted on>", left by tools/deploy.sh when it rolled <commit>'s deploy
# back (" rollback" after it: a Roll back to last green, #1016). While main holds it every deploy is rolled back too
# (#553), so only its fix may land: a branch changing a file that deploy changed, or LAND_FIX=1.
bad_check() {
  local bad good rest
  # <state>/rolling-back: "<from> <to> <when>", while a Roll back's restart waits (#1271): a deploy would undo it, the fix's too.
  if [ -s "$state/rolling-back" ]; then
    read -r _ good _ <"$state/rolling-back" || true
    if systemctl --user is-active -q "${DEPLOY_UNIT:-cc-restart-when-idle}" 2>/dev/null; then
      refuse "a member pressed Roll back to last green, and its restart onto $(git log -1 --format='%h "%s"' "$good" 2>/dev/null || echo "${good:0:7}") waits to go live (for running turns a restart would cut off). Nothing landed. Ship again once it is live (the Releases page shows it)"
    fi
    rm -f "$state/rolling-back" # left by a roll back that was killed
  fi
  [ -s "$state/bad" ] || return 0
  read -r bad good rest <"$state/bad" || true
  git -C "$SOURCE" merge-base --is-ancestor "$bad" main 2>/dev/null || { rm -f "$state/bad"; return 0; }
  [ -z "${LAND_FIX:-}" ] || return 0
  [ -z "$(comm -12 <(git diff --name-only "$good" "$bad" | sort) <(git diff --name-only main HEAD | sort))" ] || return 0
  local why="the restart on it failed: its report is in the chat of the minion that deployed it"
  [ "${rest##* }" != rollback ] || why="a member pressed Roll back to last green on Releases"
  refuse "main holds $(git log -1 --format='%h "%s"' "$bad"), whose deploy was rolled back ($why), and $branch changes none of the files that deploy changed, so its deploy would be rolled back too. Nothing landed. Land the fix for it first (or its revert); if $branch is that fix, run LAND_FIX=1 tools/land.sh (from a turn in a container: the land tool with fix: true)"
}

# The deploy's boot check, before a CI run is spent (#646), only while <state>/refusing ("<when> <why>", set by deploy.sh
# when its boot check fails) is there. Off: LAND_PREFLIGHT=0, or touch <state>/preflight-off.
# A ship failing it while main fails too is not the cause (#1564): a plain land lets go of the lock, holds as "held: main
# is broken" and goes on from its rebase once main boots again. Past LAND_HOLD_MAX it is refused.
# [<epoch>]: main's own boot check (exit code), shared by every ship: run again once main moves, after LAND_HOLD_RECHECK s,
# or for a pass from before <epoch> (this ship's check began): the box may have broken since (#1864).
main_boot() {
  local from=${1:-0} m sha rc at d
  m=$(git -C "$SOURCE" rev-parse main)
  (
    flock 4
    read -r sha rc at 2>/dev/null <"$state/boot-main" || true
    if [ "${sha:-}" = "$m" ] && [[ ${at:-} =~ ^[0-9]+$ ]] && [ $(($(date +%s) - at)) -lt "${LAND_HOLD_RECHECK:-900}" ] && { [ "$rc" != 0 ] || [ "$at" -ge "$from" ]; }; then echo "$rc"; exit 0; fi
    d=$(mktemp -d "${TMPDIR:-/tmp}/land-main-boot.XXXXXX")
    # No copy, no verdict: the ship is judged alone.
    git -C "$SOURCE" archive "$m" | tar -x -C "$d" || { rm -rf "${d:?}"; echo 0; exit 0; }
    rc=0
    timeout -k 10 "${DEPLOY_BOOT_TIMEOUT:-600}" "$d/tools/citadel-node" "$d/tools/boot-check.ts" "$d" "${DEPLOY_DB:-$HOME/.local/share/claude-coordinator/coordinator.db}" >"$state/boot-main.log" 2>&1 9>&- 7>&- 6>&- 4>&- || rc=$?
    rm -rf "${d:?}"
    echo "$m $rc $(date +%s)" >"$state/boot-main"
    echo "$rc"
  ) 4>"$state/boot-main.lock"
}

preflight() {
  local at why since rc=0 mrc ref m l from began
  [ -s "$state/refusing" ] || return 0
  { [ "${LAND_PREFLIGHT:-1}" != 0 ] && [ ! -e "$state/preflight-off" ]; } || return 0
  read -r at why <"$state/refusing" || true
  [[ $at =~ ^[0-9]+$ ]] || return 0
  since=$(date -d "@$at" '+%b %-d %H:%M %Z')
  say "deploy has been refusing since $since ($why): running its boot check on $short before a CI run is spent on it"
  queue_phase "boot check before CI since $(date +%H:%M)"
  land_mark preflight preflight
  began=$(date +%s)
  # As deploy.sh runs it: the commit's own check, an outside time limit, not as `node`, without the locks' fds.
  timeout -k 10 "${DEPLOY_BOOT_TIMEOUT:-600}" "$here/tools/citadel-node" "$here/tools/boot-check.ts" "$here" "${DEPLOY_DB:-$HOME/.local/share/claude-coordinator/coordinator.db}" >/dev/null 9>&- 7>&- 6>&- || rc=$?
  if [ "$rc" = 0 ]; then
    say "the boot check passes on $short, so this landing goes on"
    return 0
  fi
  # 124 or 137 (timeout's KILL): stopped at the limit, not a verdict on the change.
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
    say "the boot check hung on $short here too (stopped after ${DEPLOY_BOOT_TIMEOUT:-600} s): running it on main, to tell a broken main from a broken change"
  else
    say "$short fails the same check here (its output is above): running it on main, to tell a broken main from a broken change"
  fi
  mrc=$(main_boot "$began") || mrc=0
  if [ "$mrc" != 0 ] && [ "$mode" = land ] && [ -n "${DEPLOY_QUEUE_TICKET:-}" ] && [ -e "$DEPLOY_QUEUE_TICKET" ]; then
    retro_log "preflight hold · $label · refusing since $since ($why)"
    say "main fails it too (exit $mrc; its output: $state/boot-main.log), so main or the box is broken, not $branch: held in its place in line without the lock, and it goes on from its rebase once main boots again (a fix ships, or the box is fixed). No CI run was spent and $untouched"
    m=$(git -C "$SOURCE" rev-parse main) ref=$(cat "$state/refusing" 2>/dev/null) from=$SECONDS
    mapfile -t l <"$DEPLOY_QUEUE_TICKET"
    flock -u 9
    while :; do
      QUEUE_TRAIN='' QUEUE_YIELD=yield queue_write "$DEPLOY_QUEUE_TICKET" "${l[0]}" 0 "${l[2]}" "held: main is broken ($(((SECONDS - from) / 60)) min)"
      sleep "${LAND_HOLD_POLL:-30}"
      [ "$(cat "$state/refusing" 2>/dev/null)" = "$ref" ] || { say "the deploy's note changed (a deploy ran)"; break; }
      [ "$(git -C "$SOURCE" rev-parse main)" = "$m" ] || { say "main moved"; break; }
      [ "$(main_boot)" != 0 ] || { say "main's boot check passes again"; break; }
      [ $((SECONDS - from)) -lt "${LAND_HOLD_MAX:-28800}" ] || refuse "held $(((SECONDS - from) / 60)) min while main failed the boot check (refusing since $since: $why), the most a ship holds, so it is refused and $untouched; $branch keeps the rebased work. Landings are blocked until main boots again: tell the Taskmaster"
    done
    say "back in line after $(((SECONDS - from) / 60)) min held: it starts over from its rebase at the front"
    queue_wait_check() { { train_verdict && prep_check; } || true; }
    QUEUE_KEEP=$DEPLOY_QUEUE_TICKET queue_lock "$state" "$branch" || { land_timing 1; exit 1; }
    unset -f queue_wait_check
    train_verdict held
    LAND_REBASED=1 LAND_RETRY_NOW=1 LAND_PRE=$pre LAND_RETRIED=$retried LAND_FLAKE_KEPT=$flake_kept LAND_ASIDE=$aside exec bash "$tools/land.sh" "${args[@]}"
  fi
  retro_log "preflight refusal · $label · refusing since $since ($why)"
  [ "$rc" != 124 ] && [ "$rc" != 137 ] || refuse "deploy has been refusing since $since: $why, and the boot check hung on $short here too (stopped after ${DEPLOY_BOOT_TIMEOUT:-600} s), so no CI run was spent and $untouched; $branch keeps the rebased work. A hang is not a verdict on the change: run it again, and if it hangs again tell the Taskmaster, since landings are blocked until that is fixed"
  refuse "deploy has been refusing since $since: $why, and $short fails the same check here (its output is above) while main passes it, so the cause is in your change: no CI run was spent and $untouched; $branch keeps the rebased work. Fix it and land again"
}

# [<worktree>]: the repo's guard tests in that worktree (default this one). 0: passed, 1: failed (output in $guard_out),
# 2: couldn't decide (citadel-test's exit in $guard_rc), 3: none.
guard_run() {
  local dir=${1:-.} tests=() f
  guard_out='' guard_rc=0
  for f in "${guard_set[@]}"; do [ ! -f "$dir/$f" ] || tests+=("$f"); done
  [ -x "$dir/tools/citadel-test" ] && [ ${#tests[@]} -gt 0 ] || return 3
  [ -n "${1:-}" ] || land_mark guards guards
  guard_out=$(cd "$dir" && CITADEL_TEST_FILES=0 CITADEL_TEST_ALWAYS=/dev/null tools/citadel-test --timeout "${LAND_GUARD_TIMEOUT:-120}" "${tests[@]}" 2>&1 9>&- 7>&- 6>&- </dev/null) || guard_rc=$?
  case $guard_rc in 0) return 0 ;; 2 | 124 | 137) return 2 ;; *) return 1 ;; esac
}

guard_files() { sed -nE 's/^✖ ([^ :]+\.test\.ts).*/\1/p' <<<"$guard_out" | sort -u | paste -sd, -; }

# <commit>: guard_run on it in a scratch worktree (a train's top or a bisect step, #1479).
guard_at() {
  local wt rc=0
  wt=$(mktemp -d "${TMPDIR:-/tmp}/land-guard.XXXXXX") && git worktree add -q --detach "$wt" "$1" >/dev/null 2>&1 || { guard_out='' guard_rc=2; return 2; }
  guard_run "$wt" || rc=$?
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
  return "$rc"
}

guards() {
  local t0=$SECONDS rc=0
  guard_run || rc=$?
  front_guards=$rc
  case $rc in
    3) ;;
    0) say "guard tests passed on $short in $((SECONDS - t0)) s" ;;
    2) say "the guard tests couldn't run or ran past ${LAND_GUARD_TIMEOUT:-120} s (exit $guard_rc), so they don't decide: $([ "$lane" = light ] && echo "no CI runs on a light ship, so main's own decides" || echo "CI runs them")" ;;
    *)
      grep -v '^full output: ' <<<"$guard_out" | tail -n 60 | sed 's/^/land: guard: /' >&2
      retro_log "guard · $label · $(guard_files) · $((SECONDS - t0))s"
      [ ! -f "$state/split" ] || ! grep -qF "${DEPLOY_QUEUE_TICKET##*/} $branch" "$state/split" || rm -f "$state/split"
      refuse "guard tests failed on $short, the branch rebased onto ${build:-main} (output above), so no CI run was spent and $untouched; $branch keeps the rebased work. Run citadel-test on that file, fix it, commit, then run this again" ;;
  esac
}

# A light ship gets no CI, so its guards are the tests the affected map picks for its paths (#1864): a README line or
# a rule file can break a test that reads it, and main would go red with nothing between.
light_guards() {
  local aff
  if ! aff=$("$tools/citadel-node" --no-warnings tools/affected.ts --root . --base "$old" 2>/dev/null); then
    say "the affected map couldn't answer, so no test that reads these paths ran: main's own CI decides"
    return 0
  fi
  mapfile -t guard_set < <(sed -nE $'s/^run\t([^\t]+)\t.*/\\1/p' <<<"$aff")
  guards
}

# <worktree> <onto> <branch> <base> <tip>: what a ship at the front gets after its rebase (adr_commit, the prompt baseline,
# the commit titles), for one rebased onto <onto> in a scratch worktree (#1864). Fails with the reason in skip, the worktree put back clean.
train_steps() {
  local n=${3#ticket/} renamed
  [ -e "$1/node_modules" ] || [ ! -d node_modules ] || ln -s "$PWD/node_modules" "$1/node_modules" # typescript
  if ! (
    cd "$1" || exit 1
    n=${n%%-*}
    git diff --quiet "$2" HEAD -- docs/adr || adr_commit "$2" "$3" "the ship train" || exit 1
    if [ -f test/prompt-budget.test.ts ] && ! git diff --quiet "$4" "$5" -- test/prompt-baseline.json; then
      PROMPT_BASELINE=write "$tools/citadel-node" --no-warnings --test test/prompt-budget.test.ts >/dev/null 2>&1 </dev/null || true
      git add test/prompt-baseline.json && { git diff --cached --quiet || git commit -q -m "${n:+#$n: }test/prompt-baseline.json measured again at ship time"; } || exit 1
    fi
    if [ -f tools/typecheck.ts ] && ! git diff --quiet "$4" "$5" -- test/typecheck-baseline.json; then
      CITADEL_TEST_FILES=0 "$tools/citadel-node" --no-warnings tools/typecheck.ts --update >/dev/null 2>&1 </dev/null ||
        { git checkout -q -- test/typecheck-baseline.json; exit 1; }
      git add test/typecheck-baseline.json || exit 1
      git diff --cached --quiet || git commit -q -m "${n:+#$n: }test/typecheck-baseline.json measured again at ship time" || exit 1
    fi
  ); then
    skip="renumbering its ADRs or measuring its prompt baseline on the train failed"
  elif [ -x "$tools/commit-titles.sh" ] && ! (cd "$1" && "$tools/commit-titles.sh" "$2") >/dev/null 2>&1; then
    skip="a commit of it lost its #N: title"
  else return 0; fi
  git -C "$1" reset -q --hard >/dev/null 2>&1 || true
  git -C "$1" clean -fdq >/dev/null 2>&1 || true
  return 1
}

train_guards_run() {
  local t0 lo hi mid i rc out files keep was t v k room ahead
  while [ ${#train_n[@]} -gt 0 ]; do
    t0=$SECONDS rc=0
    guard_at "$tip" || rc=$?
    [ "$rc" = 1 ] || { [ "$rc" != 0 ] || say "guard tests passed on the ship train's top $short in $((SECONDS - t0)) s"; return 0; }
    out=$guard_out lo=0 hi=${#train_n[@]}
    while [ $((hi - lo)) -gt 1 ]; do
      mid=$(((lo + hi) / 2)) rc=0
      guard_at "$(train_at "$mid")" || rc=$?
      if [ "$rc" = 1 ]; then hi=$mid out=$guard_out; elif [ "$rc" = 0 ]; then lo=$mid; else break; fi
    done
    [ "$rc" -lt 2 ] || { say "the guard tests failed on the ship train's top ($short) but couldn't decide on a step before it (exit $guard_rc), so they name no ship: CI runs them"; return 0; }
    if [ "$hi" = 1 ] && [ "$front_guards" = 2 ]; then # this one never passed them (#1864): the first rider isn't the cause unless it does now
      rc=0
      guard_at "$own" || rc=$?
      [ "$rc" != 1 ] || { say "the guard tests failed on the ship train's top ($short), but $branch's own run of them didn't decide and fails now too, so they name no ship: CI runs them"; return 0; }
      [ "$rc" = 0 ] || { say "the guard tests failed on the ship train's top ($short), but $branch's own run of them didn't decide, then or now (exit $guard_rc), so they name no ship: CI runs them"; return 0; }
      front_guards=0
    fi
    i=$((hi - 1)) guard_out=$out files=$(guard_files) room=''
    # A size red (#2139): how far over, and the ships on the train before it that used the room, each by its own step.
    if [[ ,$files, == *,test/size-budget.test.ts,* ]] && [ -f "$tools/size-room.ts" ]; then
      ahead=(--ahead "$branch=$(git merge-base main "$own")..$own")
      for ((k = 0; k < i; k++)); do ahead+=(--ahead "${train_br[$k]}=$(train_at "$k")..$(train_at $((k + 1)))"); done
      ahead+=(--self "${train_br[$i]}=$(train_at "$i")..$(train_at "$hi")")
      room=$("$tools/citadel-node" --no-warnings "$tools/size-room.ts" "${ahead[@]}" 2>/dev/null | grep ' over its limit ') || : # exit 1: over
    fi
    say "the guard tests failed on the ship train's top ($short) in ${files:-the guard tests}, and on the train first with ${train_br[$i]} on it, so it is refused before any CI run and the train is built again without it"
    [ -z "$room" ] || say "$room"
    retro_log "guard · ${train_br[$i]} · on $label's train · $files · $((SECONDS - t0))s"
    train_say "$i" "refused $branch guard-tests guard ${files:-guards}" "$(grep -v '^full output: ' <<<"$out" | tail -n 40)" ${room:+"$room"}
    train_refused+="${train_n[$i]} " train_refused_tips+=" ${train_was[$i]}"
    keep=("${train_n[@]:0:$i}" "${train_n[@]:$hi}") was=("${train_n[@]}")
    train_tip=() train_br=() train_n=() train_was=()
    tip=$own short=$(git rev-parse --short "$own")
    [ -n "$train_left" ] || train_only='' # its early run had the refused rider, so it won't count: the next in line may ride (#1864)
    train_build "${keep[@]}"
    for t in "${was[@]}"; do # a rider the train no longer takes: back in line
      [[ " ${train_n[*]} " != *" $t "* ]] && read -r v _ 2>/dev/null <"$train_dir/$t" && [ "$v" = riding ] && rm -f "$train_dir/$t"
    done
  done
  return 0 # the loop's last test can read a refused rider's verdict, and land.sh runs under set -e
}

# A burn-in red's failing cases that one train member added (#2019): "<member> <file>" a line (0: this ship, 1 on: its
# riders). A case main and the ships before one don't have can only be that ship's. The log names each as
# "test at <file>:<line>:<col>", then "✖ <case> (<ms>)". A case already on main, one a ship only edited, or one whose
# file a later ship changes too, is left to the guess. [<riders>]: only the train up to that rider (all by default).
burn_new() {
  local f name i j red last=${1:-${#train_n[@]}}
  [ -n "$burn_red" ] || return 0
  red=$(burn_lines | sed 's/: failed in .*//')
  while IFS=$'\t' read -r f name; do
    grep -qxF -- "$f" <<<"$red" && ! has_case "$old" "$f" "$name" || continue
    for ((i = 0; i <= last; i++)); do
      has_case "$(train_at "$i")" "$f" "$name" || continue
      for ((j = i + 1; j <= last; j++)); do
        git diff --quiet "$(train_at $((j - 1)))" "$(train_at "$j")" -- "$f" || continue 3 # a later ship edits it: a guess
      done
      echo "$i $f"
      break
    done
  done < <(awk 'match($0, /test at [^ ]+:[0-9]+:[0-9]+/) { f = substr($0, RSTART + 8, RLENGTH - 8); sub(/:[0-9]+:[0-9]+$/, "", f); next }
    f != "" { if (i = index($0, "✖ ")) { n = substr($0, i + length("✖ ")); sub(/ \([0-9.]+ms\).*$/, "", n); print f "\t" n } f = "" }' <<<"$failed" | sort -u) | sort -u
}

# <commit> <file> <case>: the file there has the case, named in quotes (a name built at run time is never found, so guessed).
# git grep, with no pipe: under pipefail a `git show | grep -q` fails on a file over 64 KB that has the case.
has_case() { git grep -qF -e "'$3'" -e "\"$3\"" -e "\`$3\`" "$1" -- "$2" 2>/dev/null; }
