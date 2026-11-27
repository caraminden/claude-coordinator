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
