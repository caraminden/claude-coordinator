# shellcheck shell=bash
# A ship's own check (#1567: fix A of #1549's report, reports/ship-stalls-2026-11-21.md in the scheme's shared folder;
# Cara, 2026-11-22, on #1549's card: A "Gated, after C and B"). tools/land.sh sources this and calls own_check for a
# plain land after the smoke check, before it joins the line. Its branch, rebased onto main in a scratch worktree, runs
# the whole of tests.yml (burn-in, full suite, reruns alone) on Cara's desktop, on the one runner with the check label,
# so a ship red on its own goes back to its minion without holding the line or a ship train. Gated, so the desktop
# never runs more than one check at a time, beside at most one land's run:
#   - only while someone else is in the line: with nobody ahead, its run in line starts as soon as a check would;
#   - only with a runner labelled citadel-ci-linux-check online (tools/ci-runner/README.md); none, no check;
#   - only on an idle CI desktop (ci_busy, land.sh) while the CI hold is on: one Citadel job at a time (#1906);
#   - one check at a time (<state>/own-check.lock): a ship that would wait more than LAND_OWN_CHECK_WAIT (120 s) for the
#     check running, going by the last check's time, gets the light check instead (tools/light-check.sh, #1620): its
#     own and affected test files on CI's side runner. With the CI hold on a running check is a busy desktop (above), so
#     that ship joins the line unchecked.
# Verdicts:
#   green          joins the line. Its rebase goes to <state>/own-checked ("<main> <branch tip> <commit>"), which the
#                  rebase in line takes (stacked_of), so when main hasn't moved and nobody rides with it, ci_gate finds
#                  this run on that commit and takes it as its own: no second run.
#   red, its own   refused before the line: a burn-in red, or test files that failed again alone in CI and, run alone
#                  here (niced, at most LAND_OWN_CHECK_FILES of them), fail on its commit and pass on main.
#   anything else  joins the line, where CI decides as before: flakes only, a run cut off, main's own red, a setup step
#                  that failed, a run no runner started within LAND_OWN_CHECK_START (180 s) or that didn't end within
#                  LAND_OWN_CHECK_LIMIT (900 s) of starting, GitHub not answering.
# Each check says "own check:" lines and logs one retro line ("own check · <branch> · <verdict> · <s>"), which is how its
# cost and catch are counted. Off: LAND_OWN_CHECK=0, or for every landing, touch <state>/own-check-off.
# shortcut: no guard tests on the check's commit (land.sh defines them past the line); guards() runs them in line.
# shortcut: no phase on the Releases page while it runs, since the ship has no ticket yet; its land.sh lines say it.

# shellcheck source=tools/light-check.sh
. "$tools/light-check.sh" # what a ship turned away by a busy check runner gets instead (#1620)

OWN_CHECK_LABEL=citadel-ci-linux-check
OWN_CHECK_WORKFLOW=.github/workflows/tests.yml
OWN_CHECK_BURN_STEP='burn in new and changed tests' OWN_CHECK_SUITE_STEP='the full suite' # tests.yml's step names
# GitHub as the box's own gh login, like land.sh's hub(), with the check's lock (fd 5) closed too.
own_hub() { gh_count "$@"; env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh" GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 timeout 30 "$@" 9>&- 7>&- 6>&- 5>&-; }

own_check() {
  local remote url slug l t n='' left start secs b='' wait=${LAND_OWN_CHECK_WAIT:-120} rc=0
  [ "$mode" = land ] && [ "${LAND_OWN_CHECK:-1}" != 0 ] && [ ! -e "$state/own-check-off" ] && [ "${LAND_CI:-1}" != 0 ] || return 0
  remote=${DEPLOY_REMOTE-origin}
  [ -n "$remote" ] && url=$(git remote get-url "$remote" 2>/dev/null) || return 0
  slug=${url#*github.com[:/]} slug=${slug%.git}
  # Someone else in the line: a ticket whose process still runs.
  for t in "$state"/queue/[0-9]*; do
    [[ ${t##*/} =~ ^[0-9]+$ ]] && read -r l 2>/dev/null <"$t" && [ -n "$l" ] || continue
    [ "$(queue_proc "${l%% *}")" != "$l" ] || { n=1; break; }
  done
  [ -n "$n" ] || return 0
  n=$(own_hub gh api "repos/$slug/actions/runners?per_page=100" --jq "[.runners[] | select(.status == \"online\" and any(.labels[]; .name == \"$OWN_CHECK_LABEL\"))] | length" 2>/dev/null) || n=''
  [[ $n =~ ^[1-9][0-9]*$ ]] || return 0
  if ci_busy own_hub "$slug"; then # one Citadel job at a time (#1906): its ship doesn't wait for an idle desktop
    say "own check: another Citadel job is on the CI desktop or queued, so this joins the line unchecked"
    retro_log "own check · $label · skipped: the CI desktop was busy"
    return 0
  fi
  exec 5>"$state/own-check.lock" || return 0
  if ! flock -n 5; then
    read -r start b 2>/dev/null <"$state/own-check-run" || true
    [[ $start =~ ^[0-9]+$ ]] || start=$(date +%s)
    secs=$(cat "$state/own-check-secs" 2>/dev/null) || secs=''
    [[ $secs =~ ^[0-9]+$ ]] || secs=420
    left=$((start + secs - $(date +%s)))
    if [ "$left" -gt "$wait" ]; then
      say "own check: ${b:-another ship}'s check has about $(((left + 59) / 60)) min to go, more than the ${wait} s a ship waits for it, so this one skips its own check"
      retro_log "own check · $label · skipped: the check runner was busy for ${left}s more"
      exec 5>&-
      light_check "$slug" || refuse "$own_refusal" # #1620: its own tests on the side runner instead
      return 0
    fi
    say "own check: waiting up to ${wait} s for ${b:-another ship}'s check to end, then this one's runs"
    if ! flock -w "$wait" 5; then
      say "own check: ${b:-another ship}'s check didn't end within ${wait} s, so this one skips its own check"
      retro_log "own check · $label · skipped: the check runner stayed busy past ${wait}s"
      exec 5>&-
      light_check "$slug" || refuse "$own_refusal"
      return 0
    fi
  fi
  echo "$(date +%s) $branch" >"$state/own-check-run"
  own_check_run "$slug" "$remote" || rc=$?
  rm -f "$state/own-check-run"
  exec 5>&-
  [ "$rc" = 0 ] || refuse "$own_refusal"
}

# <slug> <remote>: the check itself, holding its lock. 1 with the refusal in $own_refusal; 0 to join the line.
own_refusal=''
own_check_run() {
  local slug=$1 remote=$2 m c wt lane_c t0=$SECONDS taken='' run id='' st='' res='' link='' why='' step failed real f n=0 a b bad=() floor
  local pfail='' limit=${LAND_OWN_CHECK_LIMIT:-900} start_limit=${LAND_OWN_CHECK_START:-180} poll=${LAND_OWN_CHECK_POLL:-20}
  m=$(git rev-parse main)
  [ -z "$(under_of)" ] || { say "own check: $branch sits on a commit that came off main, so it joins the line unchecked"; return 0; }
  wt=$(mktemp -d "${TMPDIR:-/tmp}/land-own-check.XXXXXX") || return 0
  if git worktree add -q --detach "$wt" HEAD >/dev/null 2>&1 && { numbers_git ours -C "$wt" "${rr[@]}" rebase -q "$m" >/dev/null 2>&1 || rerere_on "$wt" numbers_git ours; }; then
    c=$(git -C "$wt" rev-parse HEAD)
  else
    git -C "$wt" "${rr[@]}" rebase --abort >/dev/null 2>&1 || true
    c=''
  fi
  own_check_done() {
    git worktree remove --force "$wt" >/dev/null 2>&1 || true
    rmdir "$wt" 2>/dev/null || true
    [ -z "$id" ] || [ "$st" = completed ] || own_hub gh api -X POST "repos/$slug/actions/runs/$id/cancel" >/dev/null 2>&1 || true
    own_hub git push -q "$remote" ":refs/heads/check/$branch" ":refs/heads/check-base/$branch" >/dev/null 2>&1 || true
    trap - TERM INT HUP
  }
  if [ -z "$c" ]; then
    git worktree remove --force "$wt" >/dev/null 2>&1 || true
    rmdir "$wt" 2>/dev/null || true
    say "own check: $branch doesn't rebase cleanly onto main, so it joins the line unchecked (its rebase there says why)"
    return 0
  fi
  read -r lane_c _ < <(git diff --no-renames --name-only "$m" "$c" | "$tools/lane.sh" "$m") || lane_c=full
  if [ "$lane_c" = light ]; then
    git worktree remove --force "$wt" >/dev/null 2>&1 || true
    rmdir "$wt" 2>/dev/null || true
    return 0 # it runs no CI
  fi
  # The same rebase for the line (stacked_of), the last 50 kept.
  { tail -n 49 "$state/own-checked" 2>/dev/null || true; echo "$m $(git rev-parse HEAD) $c"; } >"$state/own-checked.tmp$$" && mv -f "$state/own-checked.tmp$$" "$state/own-checked"
  # Runs GitHub already has on this commit (an earlier check or land of the same commit) are older than this one's: the
  # poll takes only a check/ run past the newest of them.
  floor=$(own_hub gh api "repos/$slug/actions/runs?head_sha=$c&per_page=20" --jq '[.workflow_runs[].id] | max // 0' 2>/dev/null) || floor=0
  [[ $floor =~ ^[0-9]+$ ]] || floor=0
  # A stop (a person's, or systemd's) mid-check still cancels its run and takes its worktree and branches away.
  trap 'own_check_done; rm -f "$state/own-check-run"; exit 143' TERM INT HUP
  # With its base, atomic, as ci_gate pushes a land's: the burn-in compares with it.
  if ! own_hub git push -q --atomic "$remote" "+$c:refs/heads/check/$branch" "+$m:refs/heads/check-base/$branch" >/dev/null 2>&1; then
    own_check_done
    say "own check: pushing $(git rev-parse --short "$c") to GitHub failed, so it joins the line unchecked"
    retro_log "own check · $label · no verdict: the push failed · $((SECONDS - t0))s"
    return 0
  fi
  say "own check: its CI runs now on the check runner, on $(git rev-parse --short "$c") (rebased onto main $(git rev-parse --short "$m")), before it joins the line: up to $((start_limit / 60)) min to start and $((limit / 60)) min to run"
  while :; do
    run=$(own_hub gh api "repos/$slug/actions/runs?head_sha=$c&per_page=20" --jq "[.workflow_runs[] | select((.path | startswith(\"$OWN_CHECK_WORKFLOW\")) and .head_branch == \"check/$branch\" and .id > $floor)][0] // empty | [.id, .status, .conclusion // \"-\", .html_url] | @tsv" 2>/dev/null) && pfail='' || { run=''; pfail=${pfail:-$(date +%H:%M)}; }
    [[ $run =~ ^[0-9]+$'\t' ]] && read -r id st res link <<<"$run" || true
    [ "$st" != completed ] || break
    [ -n "$taken" ] || [ "$st" != in_progress ] || taken=$SECONDS
    if [ -z "$taken" ] && [ $((SECONDS - t0)) -ge "$start_limit" ]; then why="no check runner started it within ${start_limit}s"; [ -z "$pfail" ] || why="GitHub didn't answer since $pfail, so it isn't known whether a check runner started it"; break; fi
    if [ -n "$taken" ] && [ $((SECONDS - taken)) -ge "$limit" ]; then why="it ran past ${limit}s"; [ -z "$pfail" ] || why="GitHub didn't answer since $pfail, so it isn't known whether it finished"; break; fi
    sleep "$poll"
  done
  if [ "$st" != completed ]; then
    own_check_done
    say "own check: $why${link:+ ($link)}, so it joins the line unchecked"
    retro_log "own check · $label · no verdict: $why · $((SECONDS - t0))s"
    return 0
  fi
  echo "$((SECONDS - t0))" >"$state/own-check-secs" # how long the next ship in would wait for this one
  case $res in
    success)
      own_check_done
      say "own check: green in $((SECONDS - t0)) s ($link), so it joins the line; if main hasn't moved and nobody rides with it, this run is its CI there"
      retro_log "own check · $label · green · $((SECONDS - t0))s"
      return 0 ;;
    failure) ;;
    *)
      own_check_done
      say "own check: the run ended as $res ($link), not a verdict on the tests, so it joins the line"
      retro_log "own check · $label · no verdict: $res · $((SECONDS - t0))s"
      return 0 ;;
  esac
  step=$(own_hub gh api "repos/$slug/actions/runs/$id/jobs" --jq '[.jobs[].steps[] | select(.conclusion == "failure") | .name][0] // empty' 2>/dev/null) || step=''
  failed=$(own_hub gh run view "$id" --repo "$slug" --log-failed 2>/dev/null) || failed=''
  if [ "$step" = "$OWN_CHECK_BURN_STEP" ]; then # a burn-in red is the ship's own (#1443), as in line
    own_check_done
    tail -n 40 <<<"$failed" >&2
    a=$(sed -n 's/.*burn-in: \([^ ]*: failed in [0-9]* of [0-9]* copies at once\).*/\1/p' <<<"$failed" | sort -u | sed ':a;N;$!ba;s/\n/; /g')
    retro_log "own check · $label · red: burn-in · $((SECONDS - t0))s"
    own_refusal="own check: a new or changed test failed its burn-in in CI on its own check, on its commit rebased onto main ($link)${a:+: $a}. A burn-in red is the ship's own, so it didn't join the line and nobody waited on it. Fix the race (its output is above), re-test (citadel-test), commit, then run this again"
    return 1
  fi
  if [ "${step:-$OWN_CHECK_SUITE_STEP}" != "$OWN_CHECK_SUITE_STEP" ]; then
    own_check_done
    say "own check: the run failed in its step \"$step\", not in the tests ($link), so it joins the line"
    retro_log "own check · $label · no verdict: failed in $step · $((SECONDS - t0))s"
    return 0
  fi
  # The files that failed again alone, or hung, in CI's reruns: only those are this commit's (run-tests.sh's labels,
  # as train_real reads them). Flakes, files never rerun and a run cut off name none.
  real=$(sed -n 's/.*run-tests: \([^ ]*\): \(failed again alone\|hung when rerun alone\).*/\1/p' <<<"$failed" | sort -u | head -n "${LAND_OWN_CHECK_FILES:-6}")
  if [ -z "$real" ]; then
    own_check_done
    say "own check: red, but no test file failed again alone ($link): flakes or a run cut off, so it joins the line, where CI runs it again"
    retro_log "own check · $label · red: no real failure · $((SECONDS - t0))s"
    return 0
  fi
  # Each one alone here, on its commit and on main, as train_alone does: red with it and green on main is its own.
  while read -r f; do
    [ -n "$f" ] || continue
    n=$((n + 1)) a=0 b=0
    own_alone "$wt" "$c" "$f" || a=$?
    [ "$a" = 1 ] || continue
    own_alone "$wt" "$m" "$f" || b=$?
    [ "$b" != 0 ] || bad+=("$f")
  done <<<"$real"
  own_check_done
  if [ ${#bad[@]} -eq 0 ]; then
    say "own check: red on $(sed ':a;N;$!ba;s/\n/, /g' <<<"$real") ($link), but run alone here none fails with this branch and passes on main, so it joins the line, where CI decides"
    retro_log "own check · $label · red: not pinned on it · $((SECONDS - t0))s"
    return 0
  fi
  tail -n 40 <<<"$failed" >&2
  a=$(printf '%s, ' "${bad[@]}") a=${a%, }
  retro_log "own check · $label · red: $a · $((SECONDS - t0))s"
  own_refusal="own check: $a failed in its own CI run on its commit rebased onto main ($link), and run alone here fail with this branch and pass on main, so it didn't join the line and nobody waited on it. Fix it, re-test (citadel-test ${bad[*]}), commit, then run this again"
  return 1
}

# <scratch worktree> <commit> <test file>: as land.sh's train_alone, its log in <state>/own-check-pin.log. 0: passes alone
# at that commit, or the commit hasn't got it; 1: fails; anything else (a checkout that failed, LAND_PIN_LIMIT s) is no answer.
own_alone() {
  git -C "$1" checkout -q --detach "$2" 2>/dev/null || return 2
  [ -e "$1/$3" ] || return 0
  (cd "$1" && timeout -k 10 "${LAND_PIN_LIMIT:-120}" nice -n 19 "$tools/citadel-node" --test --test-force-exit --test-timeout=60000 "$3") >>"$state/own-check-pin.log" 2>&1 9>&- 7>&- 6>&- 5>&- </dev/null
}
