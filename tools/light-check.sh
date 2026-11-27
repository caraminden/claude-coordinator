# shellcheck shell=bash
# The light check (#1620; Cara, 2026-11-22, on #1620's card: "Fill #1567's gap"). tools/own-check.sh sources this and
# calls light_check when a ship would join the line unchecked because the check runner is busy with another ship's
# check. In its place, the ship's own and affected test files (citadel-test --affected against main) run once on CI's
# side runner (citadel-ci-linux-side), on its branch rebased onto main, and each file that fails is run alone there on
# its commit and on main (tools/light-check-run.sh). A red there that is the ship's own is refused before the line, as
# an own check's is; everything else joins the line, where CI decides as before. On CI's side runner, waited for rather than skipped
# (#2242, quick train piece 2):
#   - any side runner registered, asleep or online (none: no light check); one busy or asleep is queued for, up to
#     LAND_LIGHT_CHECK_QUEUE (360 s), then heavy-ci.ts cancels it as nothing ran and the ship joins the line, saying so;
#   - one at a time: another ship's light check is waited for, up to LAND_LIGHT_CHECK_LOCK_WAIT (300 s);
#   - LAND_LIGHT_CHECK_LIMIT (720 s) for the whole of it, both waits included; past it, no verdict.
#   Not GitHub's own runners: one there still running when the next ship pushes keeps a shard of its 20 from starting,
#   which sends that ship's tests to the desktop (ADR 0043).
# Each says "light check:" lines and logs one retro line ("light check · <branch> · <verdict> · <s>[ · runner after
# <s>]"), the last part how long it waited for a runner.
# Off: LAND_LIGHT_CHECK=0, or for every landing, touch <state>/light-check-off.
# shortcut: it runs heavy-ci.ts (CITADEL_HEAVY_SHIP=1, so it doesn't wait behind the ships' runs it is there to spare);
# its output comes back only when the run ends. LAND_LIGHT_CHECK_HEAVY stands in for that command in tests.

LIGHT_CHECK_LABEL=citadel-ci-linux-side

# <slug>. 1 with the refusal in $own_refusal; 0 to join the line.
light_check() {
  local slug=$1 m c wt lane_c n out v f pid heavy rc waited t1 lockwait t0=$SECONDS limit=${LAND_LIGHT_CHECK_LIMIT:-720}
  [ "${LAND_LIGHT_CHECK:-1}" != 0 ] && [ ! -e "$state/light-check-off" ] || return 0
  # The side runner: registered, asleep or online (the job's labels wake it, as own-check.sh's #2241). Busy is no reason to
  # skip (#2242): the job waits in its queue, LAND_LIGHT_CHECK_QUEUE at most, and later jobs queue behind it.
  n=$(own_hub gh api "repos/$slug/actions/runners?per_page=100" --jq "[.runners[] | select(any(.labels[]; .name == \"$LIGHT_CHECK_LABEL\"))] | length" 2>/dev/null) || n=''
  if ! [[ $n =~ ^[1-9][0-9]*$ ]]; then
    say "light check: CI's side runner $([ "$n" = 0 ] && echo "isn't registered" || echo "couldn't be read"), so this joins the line unchecked"
    [ "$n" != 0 ] || retro_log "light check · $label · skipped: no side runner registered"
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
  # One at a time on the side runner (<state>/light-check.lock, fd 4): another ship's is waited for, up to
  # LAND_LIGHT_CHECK_LOCK_WAIT (300 s), and the wait comes off the limit.
  t1=$SECONDS
  { exec 4>"$state/light-check.lock" && flock -w "${LAND_LIGHT_CHECK_LOCK_WAIT:-300}" 4; } || { exec 4>&-; light_check_done; say "light check: another ship's light check held the side runner for $((SECONDS - t1)) s, so this joins the line unchecked"; retro_log "light check · $label · skipped: another ship's light check held the side runner · $((SECONDS - t1))s"; return 0; }
  lockwait=$((SECONDS - t1)) limit=$((limit - SECONDS + t1))
  say "light check: its own and affected test files run now on CI's side runner instead, on $(git rev-parse --short "$c") (rebased onto main $(git rev-parse --short "$m")): up to $((limit / 60)) min"
  heavy=("$tools/citadel-node" "$tools/heavy-ci.ts")
  [ -z "${LAND_LIGHT_CHECK_HEAVY:-}" ] || read -ra heavy <<<"$LAND_LIGHT_CHECK_HEAVY"
  # In the background, so a stop of land.sh runs its trap at once: timeout passes the TERM on to heavy-ci.ts, which
  # cancels its CI run.
  (cd "$wt" && exec env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh" GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 \
    CITADEL_HEAVY_SHIP=1 CITADEL_HEAVY_CI_QUEUE="${LAND_LIGHT_CHECK_QUEUE:-360}" \
    CITADEL_HEAVY_FALLBACK_FILE="$wt.why" CITADEL_HEAVY_QUEUED_FILE="$wt.queued" CITADEL_HEAVY_WHAT="light check of $branch" CITADEL_HEAVY_WHO=land.sh \
    timeout -k 30 "$limit" "${heavy[@]}" bash tools/light-check-run.sh "$m") >"$wt.out" 2>&1 9>&- 7>&- 6>&- 5>&- 4>&- </dev/null &
  pid=$!
  trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"; light_check_done; exit 143' TERM INT HUP
  rc=0; wait "$pid" || rc=$?
  trap - TERM INT HUP
  exec 4>&-
  # No quote marks inside a "${f:-...}": bash reads one there as the start of a quote.
  out=$(cat "$wt.out" 2>/dev/null) f=$(head -n 1 "$wt.why" 2>/dev/null) waited=$(cat "$wt.queued" 2>/dev/null)
  # The wait for a runner: the other light check's lock, then the CI queue.
  [[ $waited =~ ^[0-9]+$ ]] || waited=0
  [ $((lockwait + waited)) = 0 ] && waited='' || waited=" · runner after $((lockwait + waited))s"
  light_check_done
  v=$(sed -n 's/^light check: //p' <<<"$out" | tail -n 1)
  # heavy-ci.ts's 120: nothing ran on CI (no runner took it in its queue limit, or a push or dispatch refused), with why.
  if [ -z "$v" ] && [ "$rc" = 120 ]; then
    say "light check: nothing ran on CI (${f:-no reason given}), so this joins the line unchecked"
    retro_log "light check · $label · skipped: nothing ran on CI (${f:-no reason given}) · $((SECONDS - t0))s"
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
      own_refusal="light check: $f failed on CI's side runner, on its commit rebased onto main, and run alone there fail with this branch and pass on main (or are new with it), so it didn't join the line and nobody waited on it. Fix it, re-test (citadel-test ${f//,/}), commit, then run this again"
      return 1 ;;
    '') v="no verdict: the run ended without one$(grep -q 'citadel-heavy' <<<"$out" && printf ' (%s)' "$(grep 'citadel-heavy' <<<"$out" | tail -n 1 | cut -c1-160)")" ;;
  esac
  say "light check: ${v#no verdict: }, so it joins the line, where CI decides"
  retro_log "light check · $label · $v · $((SECONDS - t0))s$waited"
  return 0
}
