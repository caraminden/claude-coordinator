# shellcheck shell=bash
# The gate: the checks before CI, the CI or perigee run, and the verdict switch on it (sourced by land.sh).
# Sourced by tools/land.sh up front: definitions only (#2099).

land_checks() {
  tip=$(git rev-parse HEAD)
  short=$(git rev-parse --short HEAD)
  # The lane (#753, tools/lanes as main has it): light runs no CI, only the tests that read its paths (light_guards), and
  # deploy.sh restarts nothing for it; kit runs CI as usual. Lands into a build stay full.
  lane=full
  if [ "$mode" = land ]; then
    read -r lane lane_why < <(git diff --no-renames --name-only "$old" "$tip" | "$tools/lane.sh" "$old") || lane=full
    [ "$lane" = full ] || say "lane: $lane (tools/lanes; the path that decided it: $lane_why)"
  fi

  # A light land deploys without the boot check, so a refusing deploy doesn't hold it up.
  [ "$mode" = into ] || [ "$mode" = full ] || [ "$lane" = light ] || preflight

  # <words>: sets the phase, and moves it on every LAND_PHASE_EVERY s until phase_ticker_end: the line behind gives up on
  # one unchanged for DEPLOY_QUEUE_STALL (15 min), and a long step (a fallback suite, the guard tests, #1864) can take
  # longer. Once anything else sets the phase, it is theirs. Gone with land.sh: it looks for it at each tick.
  ticker=''

  # The guard tests, on the rebased commit before a CI run is spent (#1240). Each checks the repo's files against what main
  # already holds (a schema number, the prompts' budget, the UI contract, size limits), so a branch clean alone can break
  # one only together with main. Only the ones the repo has; --into skips them as it skips CI, and its build's land runs them.
  guard_set=(test/schema-compat.test.ts test/prompt-budget.test.ts test/one-until.test.ts test/ui-contract.test.ts test/size-budget.test.ts)
  front_guards='' # guards()'s answer on this ship's own commit
  if [ "$mode" = into ]; then :
  elif [ "$lane" != light ]; then guards
  elif [ -f tools/affected.ts ]; then light_guards
  fi

  # A feeder's merge into a build runs only the test files it touched (Cara's pick, specs/build-branches.md): no CI.
  if [ "$mode" = into ]; then
    land_mark tests tests
    if [ ${#files[@]} -gt 0 ]; then
      say "running ${files[*]} on $short"
      guard=()
      [ -r test/leak-guard.ts ] && guard=(--test-global-setup=test/leak-guard.ts)
      timeout -k 30 "${DEPLOY_TEST_TIMEOUT:-600}" "$tools/citadel-node" --test --test-force-exit "${guard[@]}" "${files[@]}" >&2 9>&- 6>&- || refuse "tests failed on the rebased branch (output above), so $build is untouched; $branch keeps the rebased work"
    else
      say "a docs-only change: no tests to run"
    fi
    land_mark gate
    merge_into
  fi
  return 0
}

land_gate() {
  fellback=
  rc=0
  failed=''
  reran=''
  land_mark ci ci
  if [ "$lane" = light ]; then
    rc=light
    early_gate
  else
    # No answer from CI: the suite runs here only on a quiet perigee (#1254). Until then CI is asked again at every look
    # (a runner may come back); busy_wait refuses once perigee has been busy QUIET_LIMIT s. The train's retest and bisect
    # wait the same way, on the commit they test. Runs of a train lost or cut off every time may be a rider's doing: the
    # caller drops the riders, and this one goes on alone (#1864).
    busy_gate() {
      local at=${1:-$tip}
      while [ "$rc" = 2 ] && ! quiet; do
        [ "$no_verdicts" -lt "$NO_VERDICT_MAX" ] || [ ${#train_n[@]} = 0 ] || break
        busy_wait "$why"
        sleep "$QUIET_POLL"
        rc=0
        gate "$at" || rc=$?
      done
      no_verdicts=0
    }
    if [ -n "${quick_go:-}" ]; then train_only=$quick_only; else early_look; pull_look; quick_alone; fi # quick_go: a quick train's front (tools/land/quick.sh)
    # shellcheck disable=SC2086 # ticket numbers
    train_build $train_only
    # None of a pulled front's kept ships rides now: a run of this one by itself says nothing of the held.
    [ ${#train_n[@]} -gt 0 ] || [ -z "${train_only// /}" ] || [ -n "${quick_go:-}" ] || train_release
    train_guards
    if quick_gate; then quick_pick=''; return 0; fi
    [ -z "${quick_go:-}" ] || quick_pick='' quick_go='' train_only=''
    top_say
    early_gate
    top_gate || rc=$?
    # A train keeps its riders while it waits (#1361): they go back only once the gate gives up for good, to run here.
    busy_gate
    [ "$rc" != 1 ] || train_main_red || [ ${#train_n[@]} = 0 ] || train_suspects || [ ${#train_n[@]} = 0 ] || train_bisect
    train_end
    if [ "$rc" = 2 ] && [ ${#train_n[@]} -gt 0 ]; then
      say "the ship train goes back in line, since CI gave no answer ($why): $branch goes on alone"
      train_drop
      tip=$own short=$(git rev-parse --short "$own")
      top_say
      busy_gate
    fi
  fi
  return 0
}

land_verdict() {
  land_mark gate
  if [ "$rc" = light ]; then
    say "no CI: the server reads nothing in this change (tools/lanes)"
    tested=$tip
  elif [ "$rc" = quick ]; then
    say "no CI run: a quick train, green on its quick check on CI's side runner (tools/land/quick.sh)"
    tested=$tip
  elif [ "$rc" = 0 ]; then
    ci_done
    tested=$tip # CI ran the commit and nothing else, so a stray file in this worktree was never part of it
  elif [ "$rc" = 1 ]; then
    burn_said=$(burn_lines | paste -sd';' - | sed 's/;/; /g')
    if [ -n "$main_red_mine" ]; then
      refuse "tests failed in CI ($ci_url) in $main_red, which fails on main's own tip too (run alone here), and $branch changed $main_red_mine or what it imports, yet it still fails: main is red and this change doesn't make it pass, so $untouched${main_red_other:+. The run was also red on $main_red_other}. If it is meant to fix it, look into why, re-test, commit, then run this again; if not, run this again once main is green"
    elif [ -n "$main_red" ]; then
      [ "$main_red_riders" = 0 ] || retry_in_place "red on main too: $main_red" # alone, a retry would only run CI on it again
      refuse "tests failed in CI ($ci_url) in $main_red, which fails on main's own tip too (run alone here): main is red, not this change, so $untouched${main_red_other:+. The run was also red on $main_red_other, which may be yours}. Run this again once main is green (a fix for $main_red has shipped)"
    fi
    [ -z "$reran" ] || [ -n "$suspect_tests$burn_said" ] || flake_keep # kept in line, it is no bad ship
    [ -z "$split_of" ] || retro_log "ship train red · $split_of · $branch · $ci_url"
    split_over
    # shellcheck disable=SC2046 # file names
    pulled_out $(train_real || train_failing)
    [ -z "$suspect_new" ] || refuse "a new or changed test failed its burn-in in CI on its ship train ($ci_url): $burn_said, in $suspect_tests, and $branch adds the test case that failed, which main doesn't have, so it is the cause: the ships behind it went back in line, so $untouched. $(burn_advice), then run this again"
    [ -z "$suspect_tests" ] || [ -z "$burn_said" ] || refuse "a new or changed test failed its burn-in in CI on its ship train ($ci_url): $burn_said, in $suspect_tests, and run alone on perigee it passed on main and failed with $branch on it, so it is the cause: the ships behind it went back in line, so $untouched. $(burn_advice), then run this again"
    [ -z "$suspect_tests" ] || refuse "tests failed in CI on its ship train ($ci_url) in $suspect_tests, and run alone on perigee it passed on main and failed with $branch on it, so it is the cause: the ships behind it went back in line, so $untouched. Fix it, re-test, commit, then run this again"
    [ -z "$burn_said" ] || refuse "a new or changed test failed its burn-in in CI ($ci_url): $burn_said, so it never reached the full suite and $untouched. $(burn_advice), then run this again. This is the ship's own red, never a known flake"
    [ -z "$reran" ] || refuse "tests failed on the rebased branch in CI again ($ci_url), on the one fresh run after a red whose files all passed alone ($reran), so $untouched. A second red refuses whatever its labels say"
    refuse "tests failed on the rebased branch in CI ($ci_url), so $untouched"
  else
    ci_done
    fellback=$why
    say "=========================================================================="
    say "CI FALLBACK: $why. Running the full suite on perigee instead."
    say "BURN-IN SKIPPED: new and changed tests were not run as 10 copies at once, since that runs only on CI, never on perigee (#1443)"
    say "=========================================================================="
    # Once it asked GitHub; asked again only if it answered then, so an outage isn't waited on twice.
    retro_log "ci fallback · $branch · $why${ci_quota:+ · GitHub calls left: $([ "$ci_quota" = unknown ] && echo unknown || gh_quota)}"
    say "running the tests"
    started=$(date +%H:%M)
    land_mark fallback fallback
    # A file the tests saw that isn't in the commit (never git-added, or ignored) means deploy.sh tests it again.
    # node_modules is no stray: run-tests.sh runs on one that matches the commit's lockfile, or not at all (#1863).
    [ -z "$(git status --porcelain --ignored -- . ':(exclude)node_modules')" ] && tested=$tip || tested=
    log="$state/land-test.log"
    trc=0
    # In citadel-heavy's slot on perigee (nice 19, idle IO) at half run-tests.sh's usual concurrency, so it yields (#1254).
    # Its CPU weight is the embedder's 20, so turns outrank it. A job that took the slot since quiet() looked holds it
    # up no longer than the busy limit's rest: then citadel-heavy gives up (75), and this refuses.
    # --heavy: the suite is CPU work for minutes, so with no past runs to judge by it still takes the slot (#1629).
    half=$(( ( ($(nproc 2>/dev/null || echo 2) + 1) / 2 + 1) / 2 ))
    fallback_limit=$((half < 10 ? 6000 / half : 600)) # run-tests.sh's 600 s is for half the cores; 6 of 9 fallbacks at a quarter of them hit it (#1863)
    [ "$fallback_limit" -le 1800 ] || fallback_limit=1800
    left=$((QUIET_LIMIT - $(busy_waited)))
    # The wait for a slot and then the suite can take longer than the line waits; the reruns set a phase of their own.
    phase_ticker "running the tests since $started"
    CITADEL_HEAVY_WHAT="land.sh's suite for $branch (CI fallback)" CITADEL_HEAVY_MAX_WAIT=${LAND_HEAVY_MAX_WAIT:-$((left > 60 ? left : 60))} \
      CITADEL_TEST_CONCURRENCY=${CITADEL_TEST_CONCURRENCY:-$half} DEPLOY_TEST_CPU_WEIGHT=${DEPLOY_TEST_CPU_WEIGHT-20} \
      DEPLOY_TEST_TIMEOUT=${DEPLOY_TEST_TIMEOUT:-$fallback_limit} \
      "$tools/citadel-heavy" --here --heavy "$tools/run-tests.sh" "$log" 9>&- 6>&- || trc=$? # without the lock's fd: a run that outlives a killed land.sh must not hold it
    phase_ticker_end
    [ "$trc" != 75 ] || retry_in_place "perigee's heavy slot was taken"
    [ "$trc" != 75 ] || refuse "CI and perigee both busy, try again: CI: $why; perigee's heavy slot was taken just before the suite could start, and stayed taken (citadel-heavy's lines above), so no test ran. So $untouched"
    [ "$trc" != 3 ] || refuse "no test ran: the test run could not write its files (the run-tests line above says which), so $untouched"
    [ "$trc" != 4 ] || retry_in_place "the test packages could not be installed on perigee"
    [ "$trc" != 4 ] || refuse "no test ran: the packages the tests import could not be installed here (the run-tests line above says why), so $untouched. Run this again"
    if [ "$trc" != 0 ]; then
      tail -n 40 "$log" >&2
      # The shared log is the next landing's within a second (#553 M6): a red one is kept under the branch's name, for two weeks.
      find "$state" -maxdepth 1 -name 'land-red-*.log' -mtime +14 -delete 2>/dev/null || true
      kept="$state/land-red-${branch//\//-}.log"
      cp "$log" "$kept" 2>/dev/null || kept=$log
      failed=$(cat "$kept" 2>/dev/null) || failed=''
      if ! flakes=$(flake_only) || ! known_flakes "$flakes"; then
        [ -z "$flakes" ] || retry_in_place "failed in the full run but passed alone on perigee: $flakes"
        # Killed from outside before any test failed (#1393): no verdict on the change, so it goes again once, as flakes do.
        if cut_off; then
          retry_in_place "the suite on perigee was killed from outside before any test failed"
          refuse "the suite on perigee was killed from outside before any test failed (full log: $kept): that says nothing about $branch, but it is no answer either, so $untouched. Run this again"
        fi
        # Stopped at its limit: only a file that fails alone here and passes on main is this ship's (#1863).
        if grep -q '^run-tests: the tests ran past' "$kept"; then
          queue_phase "running the stopped suite's suspects alone since $(date +%H:%M)"
          mapfile -t own < <("$tools/test-alone.sh" stopped "$kept" "$tip" "$old" 2>"$state/train-pin.log" 9>&- 7>&- 6>&-)
          [ ${#own[@]} -gt 0 ] || retry_in_place "the suite on perigee ran out of its time limit"
          [ ${#own[@]} -gt 0 ] || refuse "the suite on perigee ran out of its time limit and no test is known to be $branch's own failure (full log: $kept): that is no answer, so $untouched. Run this again"
          refuse "tests failed on the rebased branch: the suite ran out of time, and ${own[*]} fails alone here and passes on main (full log: $kept), so $untouched"
        fi
        refuse "tests failed on the rebased branch (full log: $kept), so $untouched"
      fi
      say "only known flakes failed on perigee: $known_why, so this goes on as green"
      retro_log "known flake · $branch · $known_why · on perigee"
      known_by[$tip]=$known_why
    fi
  fi
  return 0
}

# GitHub can't take the ship's run (#2209): cancel it and start tests.yml on the desktop. Fails, with $why, when it can't.
ci_to_desk() {
  read -r online registered <<<"$(ci_online)"
  # Slow to start, no runner awake: GitHub's run beats waking a desktop that may be off.
  if [ "$online" = 0 ] && [ "$ci_gh" = 1 ] && [ -n "$ci_id" ] && [ "$ci_status" != completed ]; then
    say "$gh_why, and no $CI_LABEL runner is online, so this keeps waiting on GitHub's run ($ci_url)"
    ci_gh=done gh_why='' && return
  fi
  [ -z "$ci_id" ] || [ "$ci_status" = completed ] || hub gh api -X POST "repos/$ci_slug/actions/runs/$ci_id/cancel" >/dev/null 2>&1 || true
  ci_stale=${ci_id:-$ci_stale} ci_id='' ci_status='' ci_taken='' limit=$CI_LIMIT rerun_wait='' burn_wait=''
  [ -n "$online" ] || { why="$gh_why, and GitHub didn't say which desktop runners are online$(ci_said)"; return 1; }
  [ "${registered:-0}" -gt 0 ] || { why="$gh_why, and no $CI_LABEL runner is registered"; return 1; }
  hub gh api -X POST "repos/$ci_slug/actions/workflows/${CI_WORKFLOW##*/}/dispatches" -f ref="$CI_REF" -f 'inputs[where]=desktop' \
    >/dev/null 2>"$state/ci.err" ||
    { why="$gh_why, and starting the run on the desktop failed$(ci_said)"; return 1; }
  say "$gh_why, so the run goes to Cara's desktop instead$([ "$online" -gt 0 ] || echo " (asleep: the job wakes one)")"
  retro_log "ci to desktop · $branch · $gh_why"
  ci_gh='' gh_why='' started=$SECONDS online_at=$SECONDS told=''
}
