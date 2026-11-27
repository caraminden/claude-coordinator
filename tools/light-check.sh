# shellcheck shell=bash
# The light check (#1620; Cara, 2026-11-22, on #1620's card: "Fill #1567's gap"). tools/own-check.sh sources this and
# calls light_check when a ship would join the line unchecked because the check runner is busy with another ship's
# check. In its place, the ship's own and affected test files (citadel-test --affected against main) run once on CI's
# side runner (citadel-ci-linux-side), on its branch rebased onto main, and each file that fails is run alone there on
# its commit and on main (tools/light-check-run.sh). A red there that is the ship's own is refused before the line, as
# an own check's is; everything else joins the line, where CI decides as before. Where it runs (#2242):
#   - a public repo: GitHub's own runners (free there, never busy with the desktop's optional work, many at once, and
#     left alone by the CI hold). One GitHub doesn't start within LAND_LIGHT_CHECK_QUEUE (360 s: a ship's 20 shards can
#     fill the account's jobs for about 5 min) is no runner, and the ship joins the line unchecked, saying so;
#   - else CI's side runner, only online and idle (a heavy job on it, or none online: no light check), one at a time;
#   - LAND_LIGHT_CHECK_LIMIT (720 s) for the whole of it, the runner's queue included; past it, no verdict.
# Each says "light check:" lines and logs one retro line ("light check · <branch> · <verdict> · <s>[ · runner after
# <s>]"), the last part how long it waited for a runner.
# Off: LAND_LIGHT_CHECK=0, or for every landing, touch <state>/light-check-off.
# shortcut: it runs heavy-ci.ts (CITADEL_HEAVY_SHIP=1, so it doesn't wait behind the ships' runs it is there to spare);
# its output comes back only when the run ends. LAND_LIGHT_CHECK_HEAVY stands in for that command in tests.

LIGHT_CHECK_LABEL=citadel-ci-linux-side

# <slug>. 1 with the refusal in $own_refusal; 0 to join the line.
light_check() {
  local slug=$1 m c wt lane_c n out v f pid heavy rc waited t0=$SECONDS limit=${LAND_LIGHT_CHECK_LIMIT:-720} github='' where="CI's side runner"
  [ "${LAND_LIGHT_CHECK:-1}" != 0 ] && [ ! -e "$state/light-check-off" ] || return 0
  [ "$(own_hub gh api "repos/$slug" --jq .private 2>/dev/null)" != false ] || github=1 where="GitHub's own runners"
  # The side runner: online, and not busy with a heavy job or a run of its own.
  [ -n "$github" ] || n=$(own_hub gh api "repos/$slug/actions/runners?per_page=100" --jq "[.runners[] | select(.status == \"online\" and .busy == false and any(.labels[]; .name == \"$LIGHT_CHECK_LABEL\"))] | length" 2>/dev/null) || n=''
  if [ -z "$github" ] && ! [[ $n =~ ^[1-9][0-9]*$ ]]; then
    say "light check: CI's side runner isn't free, so this joins the line unchecked"
    [ "$n" != 0 ] || retro_log "light check · $label · skipped: no idle side runner"
    return 0
  fi
  m=$(git rev-parse main)
  [ -z "$(under_of)" ] || return 0
  wt=$(mktemp -d "${TMPDIR:-/tmp}/land-light-check.XXXXXX") || return 0
  if git worktree add -q --detach "$wt" HEAD >/dev/null 2>&1 && { numbers_git ours -C "$wt" "${rr[@]}" rebase -q "$m" >/dev/null 2>&1 || rerere_on "$wt" numbers_git ours; }; then
    c=$(git -C "$wt" rev-parse HEAD)
  else
    git -C "$wt" "${rr[@]}" rebase --abort >/dev/null 2>&1 || true
    c=''
  fi
  light_check_done() { git worktree remove --force "$wt" >/dev/null 2>&1 || true; rmdir "$wt" 2>/dev/null || true; rm -f "$wt.out" "$wt.why" "$wt.queued"; }
  [ -n "$c" ] || { light_check_done; return 0; } # own_check said why for its own rebase; this one is the same
  read -r lane_c _ < <(git diff --no-renames --name-only "$m" "$c" | "$tools/lane.sh" "$m") || lane_c=full
  [ "$lane_c" != light ] || { light_check_done; return 0; }
  # One at a time on the side runner (<state>/light-check.lock, fd 4): another ship's holds it. GitHub's take many.
  [ -n "$github" ] || { exec 4>"$state/light-check.lock" && flock -n 4; } || { exec 4>&-; light_check_done; say "light check: another ship's light check holds the side runner, so this joins the line unchecked"; retro_log "light check · $label · skipped: the side runner was busy"; return 0; }
  say "light check: its own and affected test files run now on $where instead, on $(git rev-parse --short "$c") (rebased onto main $(git rev-parse --short "$m")): up to $((limit / 60)) min"
  heavy=("$tools/citadel-node" "$tools/heavy-ci.ts")
  [ -z "${LAND_LIGHT_CHECK_HEAVY:-}" ] || read -ra heavy <<<"$LAND_LIGHT_CHECK_HEAVY"
  # In the background, so a stop of land.sh runs its trap at once: timeout passes the TERM on to heavy-ci.ts, which
  # cancels its CI run.
  (cd "$wt" && exec env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh" GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 \
    CITADEL_HEAVY_SHIP=1 CITADEL_HEAVY_GITHUB=$github CITADEL_HEAVY_CI_QUEUE=$([ -n "$github" ] && echo "${LAND_LIGHT_CHECK_QUEUE:-360}" || echo 180) \
    CITADEL_HEAVY_FALLBACK_FILE="$wt.why" CITADEL_HEAVY_QUEUED_FILE="$wt.queued" CITADEL_HEAVY_WHAT="light check of $branch" CITADEL_HEAVY_WHO=land.sh \
    timeout -k 30 "$limit" "${heavy[@]}" bash tools/light-check-run.sh "$m") >"$wt.out" 2>&1 9>&- 7>&- 6>&- 5>&- 4>&- </dev/null &
  pid=$!
  trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"; light_check_done; exit 143' TERM INT HUP
  rc=0; wait "$pid" || rc=$?
  trap - TERM INT HUP
  exec 4>&-
  # No quote marks inside a "${f:-...}": bash reads one there as the start of a quote.
  out=$(cat "$wt.out" 2>/dev/null) f=$(head -n 1 "$wt.why" 2>/dev/null) waited=$(cat "$wt.queued" 2>/dev/null)
  [[ $waited =~ ^[0-9]+$ ]] && waited=" · runner after ${waited}s" || waited=''
  light_check_done
  v=$(sed -n 's/^light check: //p' <<<"$out" | tail -n 1)
  # heavy-ci.ts's 120: nothing ran on CI (GitHub's queue full, a push refused): no runner, said as such.
  if [ -z "$v" ] && [ "$rc" = 120 ]; then
    say "light check: no runner on $where took it (${f:-no reason given}), so this joins the line unchecked"
    retro_log "light check · $label · skipped: no runner on $where (${f:-no reason given}) · $((SECONDS - t0))s"
    return 0
  fi
  case $v in
    green)
      say "light check: green in $((SECONDS - t0)) s, so it joins the line"
      retro_log "light check · $label · green · $((SECONDS - t0))s$waited"
      return 0 ;;
    red:\ *)
      tail -n 60 <<<"$out" >&2
      retro_log "light check · $label · $v · $((SECONDS - t0))s$waited"
      f=${v#red: }
      own_refusal="light check: $f failed on $where, on its commit rebased onto main, and run alone there fail with this branch and pass on main (or are new with it), so it didn't join the line and nobody waited on it. Fix it, re-test (citadel-test ${f//,/}), commit, then run this again"
      return 1 ;;
    '') v="no verdict: the run ended without one$(grep -q 'citadel-heavy' <<<"$out" && printf ' (%s)' "$(grep 'citadel-heavy' <<<"$out" | tail -n 1 | cut -c1-160)")" ;;
  esac
  say "light check: ${v#no verdict: }, so it joins the line, where CI decides"
  retro_log "light check · $label · $v · $((SECONDS - t0))s$waited"
  return 0
}
