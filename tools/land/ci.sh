# shellcheck shell=bash
# Waiting on CI: the run for a ship, its reruns, burn-in, flakes and the quiet fallback here.
# Sourced by tools/land.sh up front: definitions only (#2099).

# 0 when perigee is quiet; else 1, with what is busy in $busy.
quiet() {
  local line load cores total avail
  busy=''
  cores=$(nproc 2>/dev/null || echo 2)
  if ! { line=$(grep -m 1 '^some ' "$QUIET_PROC/pressure/cpu" 2>/dev/null) && [[ $line =~ avg60=([0-9]+) ]]; }; then busy+="no CPU pressure reading, "
  elif [ "$((10#${BASH_REMATCH[1]}))" -ge "$QUIET_PSI" ]; then busy+="CPU pressure ${BASH_REMATCH[1]}% (quiet is under $QUIET_PSI%), "; fi
  # In hundredths, so 2.75 on 5 cores is busy.
  if ! { read -r load _ 2>/dev/null <"$QUIET_PROC/loadavg" && [[ $load =~ ^([0-9]+)\.([0-9]{2}) ]]; }; then busy+="no load reading, "
  elif [ $((10#${BASH_REMATCH[1]}${BASH_REMATCH[2]} * 2)) -ge $((cores * 100)) ]; then busy+="load $load on $cores cores (quiet is under half), "; fi
  total=$(sed -n 's/^MemTotal: *\([0-9]*\) kB/\1/p' "$QUIET_PROC/meminfo" 2>/dev/null) avail=$(sed -n 's/^MemAvailable: *\([0-9]*\) kB/\1/p' "$QUIET_PROC/meminfo" 2>/dev/null)
  if ! [[ $total =~ ^[0-9]+$ && $avail =~ ^[0-9]+$ ]] || [ "$total" -le 0 ]; then busy+="no memory reading, "
  elif [ $((avail * 100 / total)) -lt "$QUIET_MEM" ]; then busy+="$((avail * 100 / total))% of memory free (quiet is $QUIET_MEM% or more), "; fi
  # Only looked at, not held: a job taking it first makes the run wait, no longer than the busy limit.
  if [ -e "$heavy_dir/slot-0" ] && ! flock -n "$heavy_dir/slot-0" true 2>/dev/null; then busy+="perigee's heavy slot is taken ($(head -c 120 "$heavy_dir/slot-0.who" 2>/dev/null || echo '?')), "; fi
  if [ -e "$heavy_dir/queue" ] && ! flock -n "$heavy_dir/queue" true 2>/dev/null; then busy+="jobs are in line for that slot, "; fi
  busy=${busy%, }
  [ -z "$busy" ]
}

# A refusal by the pipeline, not the ship's own change (#1360): CI and perigee busy, the heavy slot taken, or a perigee red of
# flakes only. Once per hand-off a plain land keeps its ticket: it yields the lock (deploy-queue.sh, QUEUE_YIELD), the next ship
# takes it on its train as first rider, and this one starts over from its rebase. Only a green run ships it (ADR 0006).
# <why>: returns when it can't (a second time, or not a plain land); the caller refuses. <why> flake: flake_keep's, not counted.
retry_in_place() {
  [ -n "${2:-}" ] || [ -z "$retried" ] || { say "refused by the pipeline again ($1), after its one retry in place ($retried), so it is refused this time"; return 0; }
  [ "$mode" = land ] && [ -n "${DEPLOY_QUEUE_TICKET:-}" ] && [ -e "$DEPLOY_QUEUE_TICKET" ] || return 0
  if [ -n "${2:-}" ]; then
    flake_kept=$((flake_kept + 1))
    say "refused on flakes only ($1), not your change: keeping its place in line and riding the next train ($flake_kept of $FLAKE_KEEP_MAX)"
    retro_log "flake keep · $branch · $1 · $flake_kept of $FLAKE_KEEP_MAX"
  else
    say "refused by the pipeline ($1), not your change: keeping its place in line and riding the next train, once"
    retried=$1
  fi
  requeue "back at the front after its retry in place: starting over from the rebase"
}

flake_keep() {
  local again f hits=() chg=()
  again=$(flake_free) || return 0
  train_chg
  for f in ${again//, / }; do
    mapfile -t hits < <(train_suspects_of "$f")
    [ ${#hits[@]} = 0 ] || return 0
  done
  [ "$flake_kept" -lt "$FLAKE_KEEP_MAX" ] || { say "only flakes failed again ($again), but it has kept its place $flake_kept times already, so $([ ${#train_n[@]} = 0 ] && echo "it is refused this time" || echo "the bisect looks for the ship")"; return 0; }
  retry_in_place "$reran, then $again on the fresh run" flake
}

# Perigee is busy: say so (first, then every 5 min) and refuse after QUIET_LIMIT s busy. $1: why CI didn't answer.
# Busy time adds up only from one call to the next (#1361): ci_gate clears busy_last while a runner is online, so waiting on
# a busy desktop never counts; runs lost or cut off before a verdict count apart (#1864).
busy_waited() { if [ -n "$busy_last" ]; then echo $((busy_spent + SECONDS - busy_last)); else echo "$busy_spent"; fi; }

busy_wait() {
  local waited over='' lost=''
  waited=$(busy_waited)
  busy_spent=$waited busy_last=$SECONDS
  if [ "$no_verdicts" -ge "$NO_VERDICT_MAX" ]; then over="CI's runs were lost or cut off $no_verdicts times, and perigee is busy" lost=" (its runs were lost or cut off $no_verdicts times)"
  elif [ "$waited" -ge "$QUIET_LIMIT" ]; then over="CI and perigee both busy for $((waited / 60)) min"; fi
  [ -z "$over" ] || retry_in_place "$over"
  [ -z "$over" ] || refuse "CI and perigee both busy, try again: CI: $1$lost; perigee for $((waited / 60)) min: $busy. So $untouched"
  # Every 5 min, a new phase too: the line behind counts an unchanged one as stuck after DEPLOY_QUEUE_STALL.
  if [ -z "$busy_told" ] || [ $((SECONDS - busy_told)) -ge 300 ]; then
    say "waiting for CI or a quiet perigee: CI: $1, but perigee is busy ($busy), so this keeps asking CI and runs the suite here only once perigee is quiet (refused after $((QUIET_LIMIT / 60)) min, $((waited / 60)) min so far)"
    queue_phase "waiting for CI or a quiet perigee, $((waited / 60)) min so far"
    busy_told=$SECONDS
  fi
}

# [<file>]: what gh or git said on stderr ($state/ci.err default), as " (<first lines>)" for a reason (#553 F12d); nothing if silent.
ci_said() {
  local s
  s=$(grep -v -e '^[[:space:]]*$' -e '^To ' "${1:-$state/ci.err}" 2>/dev/null | head -n 4 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed ':a;N;$!ba;s/\n/; /g' | cut -c1-300) || true
  [ -z "$s" ] || echo " ($s)"
}

# The newest run of the workflow on this commit, into ci_*; nothing when none. Fails when GitHub gives no answer.
ci_run() {
  local run
  run=$(hub gh api "repos/$ci_slug/actions/runs?head_sha=$tip&per_page=20" --jq "[.workflow_runs[] | select(.path | startswith(\"$CI_WORKFLOW\"))][0] // empty | [.id, .status, .conclusion // \"-\", .html_url] | @tsv" 2>"$state/ci.err") || return 1
  [ -z "$run" ] || [[ $run =~ ^[0-9]+$'\t' ]] || { echo "it sent something that isn't a run: $(head -c 100 <<<"$run")" >"$state/ci.err"; return 1; }
  read -r ci_id ci_status ci_result ci_url <<<"$run" || true
}

# Leaves nothing behind on GitHub: a run nobody waits for is cancelled, and the scratch branch goes.
ci_done() {
  [ "$ci_id" != "$ci_stale" ] || ci_id='' # a stop between a poll's answer and ci_gate passing over the old run
  [ -z "$ci_pushed" ] || [ -n "$ci_id" ] || ci_late
  [ -z "$ci_id" ] || [ "$ci_status" = completed ] || hub gh api -X POST "repos/$ci_slug/actions/runs/$ci_id/cancel" >/dev/null 2>&1 || true
  [ -z "$ci_pushed" ] || hub git push -q "$REMOTE" ":refs/heads/$CI_REF" ":refs/heads/$CI_BASE_REF" >/dev/null 2>&1 || true
  ci_id='' ci_pushed='' ci_pushed_at='' ci_stale=''
}

# 0 when the run's full suite step failed and it has a rerun step (#1374), in any state (an ended run is read next look).
# A first pass still going, no rerun step, or GitHub not answering is no.
ci_rerunning() {
  local steps
  steps=$(hub gh api "repos/$ci_slug/actions/runs/$ci_id/jobs" --jq "[.jobs[].steps[] | select(.name == \"$CI_STEP\" or .name == \"$CI_RERUN_STEP\") | [.name, .status, .conclusion // \"-\"] | @tsv] | .[]" 2>/dev/null) || return 1
  grep -qxF "$CI_STEP"$'\t'completed$'\t'failure <<<"$steps" || return 1
  grep -q "^$CI_RERUN_STEP"$'\t' <<<"$steps"
}

# 0, with its seconds in $burned (CI_BURN at most), when the run has a burn-in step that took time (#1443). Skipped, absent or
# no answer is no.
ci_burned() {
  local st a b
  read -r st a b < <(hub gh api "repos/$ci_slug/actions/runs/$ci_id/jobs" --jq "[.jobs[].steps[] | select(.name == \"$CI_BURN_STEP\" and .conclusion != \"skipped\") | [.status, .started_at // \"-\", .completed_at // \"-\"] | @tsv][0] // empty" 2>/dev/null) || : # no answer leaves st empty
  case $st in
    in_progress) burned=$CI_BURN ;;
    completed) a=$(date -d "$a" +%s 2>/dev/null) && b=$(date -d "$b" +%s 2>/dev/null) || return 1; burned=$((b - a)) ;;
    *) return 1 ;;
  esac
  [ "$burned" -le "$CI_BURN" ] || burned=$CI_BURN
  [ "$burned" -gt 0 ]
}

# Only when no runner is online, GitHub errors (#1361) or a runner's clock is off (#900): a slow run says nothing about the next ship.
ci_down() { printf '%s %s\n' "$(date +%s)" "$why" >"$state/ci-down" 2>/dev/null || true; }

# How many runners with the label are online (its own query, a page of 100).
ci_online() {
  local n
  n=$(hub gh api "repos/$ci_slug/actions/runners?per_page=100" --jq "[.runners[] | select(.status == \"online\" and any(.labels[]; .name == \"$CI_LABEL\"))] | length" 2>"$state/ci.err") || return 1
  [[ $n =~ ^[0-9]+$ ]] || { echo "it sent: $(head -c 100 <<<"$n")" >"$state/ci.err"; return 1; }
  echo "$n"
}

# 0: green on this commit. 1: red ($ci_lost: its runner was lost, so no verdict). 2: no answer, with the reason in $why.
ci_gate() {
  local url online='' online_at='' started=$SECONDS waited ci_taken='' taken_at='' nap down n told='' limit=$CI_LIMIT rerun_wait='' burn_wait='' ran
  local ci_gh='' gh_why='' gh_n gh_miss=0
  ci_lost='' ci_step=''
  [ "${LAND_CI:-1}" != 0 ] || { why="LAND_CI=0 was set"; return 2; }
  { [ -n "$REMOTE" ] && url=$(git remote get-url "$REMOTE" 2>/dev/null); } || { why="this repo has no ${REMOTE:-GitHub} remote"; return 2; }
  ci_slug=${url#*github.com[:/]} ci_slug=${ci_slug%.git}
  # A CI outage is paid once (#553): a landing that waited out a limit leaves a note; the next minutes go straight to the run here.
  local down_at='' down_why='' now
  now=$(date +%s)
  read -r down_at down_why 2>/dev/null <"$state/ci-down" || true
  # While perigee is busy the note doesn't count: this landing asks CI itself.
  if [[ $down_at =~ ^[0-9]+$ ]] && [ $((now - down_at)) -lt "$CI_DOWN" ] && quiet; then
    why="CI gave no answer to a landing $((now - down_at)) s ago ($down_why), so this one doesn't wait for it (it is asked again from $(date -d "@$((down_at + CI_DOWN))" +%H:%M))"
    return 2
  fi
  # After the outage note (#553): no GitHub ask at all.
  ci_quota=$(gh_quota)
  ci_stale=''
  # A tests.yml with the shard job sends a ship's push to GitHub's runners, 20 ways (#2209); the desktop is the fallback.
  [[ $CI_REF != land/* ]] || ! git show "$tip:$CI_WORKFLOW" 2>/dev/null | grep -q '^  shard:' || ci_gh=1
  { echo "quota ${ci_quota%%,*}" >>"$times"; } 2>/dev/null || true # the github line's figure (#1722)
  ci_run || { why="GitHub didn't answer$(ci_said)"; return 2; }
  # A run of this commit that is green or still going (a landing stopped and started again) will do; otherwise a new one.
  if [ -z "$ci_id" ] || { [ "$ci_status" = completed ] && [ "$ci_result" != success ]; }; then
    ci_stale=$ci_id ci_id='' ci_status='' ci_result='' # its verdict isn't this run's, if GitHub misses the next ask (LB9)
    # The desktop's runners, for its run or as GitHub's fallback, which is all a run on GitHub needs of them.
    online=$(hub gh api "repos/$ci_slug/actions/runners" --jq "[.runners[] | select(.status == \"online\" and any(.labels[]; .name == \"$CI_LABEL\"))] | length" 2>"$state/ci.err") || { [ -n "$ci_gh" ] || { why="GitHub didn't say which runners are online$(ci_said)"; return 2; }; }
    [[ $online =~ ^[0-9]+$ ]] || [ -n "$ci_gh" ] || { why="GitHub didn't say which runners are online (it sent: $(head -c 100 <<<"$online"))"; return 2; }
    [ -n "$ci_gh" ] || [ "$online" -gt 0 ] || { why="no $CI_LABEL runner is online (they run only while Cara is logged on to her desktop)"; return 2; }
    ci_pushed=$tip ci_pushed_at=$SECONDS # before the push: a stop can end it once GitHub has it
    # Forced on purpose: land/ and land-base/ branches are scratch only this script writes. Atomic: the burn-in needs the base.
    hub git push -q --atomic "$REMOTE" "+$tip:refs/heads/$CI_REF" "+$old:refs/heads/$CI_BASE_REF" 2>"$state/ci.err" || { why="pushing $short to GitHub failed$(ci_said)"; ci_pushed_at=''; return 2; }
  fi
  [ -z "$ci_gh" ] ||
    say "waiting for CI on $short: the full suite on GitHub's runners, 20 ways (on Cara's desktop if they haven't all started in ${CI_GH_START}s)"
  [ -n "$ci_gh" ] || say "waiting for CI on $short: the full suite on Cara's desktop (up to $((CI_START_ONLINE / 60)) min for a runner to start it while one is online, then at most $((CI_LIMIT / 60)) min for the run; past that it runs here once perigee is quiet). GitHub calls left this hour: $ci_quota"
  queue_phase "waiting for CI since $(date +%H:%M)"
  while :; do
  while :; do
    if [ -n "$gh_why" ] && ! ci_to_desk; then
      if quiet; then return 2; fi # no ci-down note: the next ship tries GitHub again
      busy_wait "$why"
      sleep "$QUIET_POLL"
      continue
    fi
    # One missed answer is no verdict; a run of them is: ci_status is stale, so the limits say GitHub didn't answer (#1655).
    if ci_run; then ci_fail_n=0; else ci_fail_n=$((ci_fail_n + 1)); [ "$ci_fail_n" -gt 1 ] || ci_fail_at=$(date +%H:%M); fi
    [ "$ci_id" != "$ci_stale" ] || ci_id='' ci_status=''
    if [ -z "$ci_taken" ] && { [ "$ci_status" = in_progress ] || [ "$ci_status" = completed ]; }; then # a runner took it
      ci_taken=1 taken_at=$SECONDS
      land_mark cirun
      # Not `[ = completed ] ||`: a stop that lands in the $(date) after a failed test would read as a refusal (exit 1).
      if [ "$ci_status" != completed ]; then queue_phase "waiting for CI: running since $(date +%H:%M)"; fi
    fi
    [ "$ci_status" != completed ] || break
    waited=$((SECONDS - started))
    # Every shard started on GitHub within CI_GH_START, or the desktop takes the run: GitHub is down or its 20 slots are taken.
    if [ "$ci_gh" = 1 ] && [ "$waited" -ge "$CI_GH_START" ]; then
      if [ -z "$ci_id" ]; then gh_why="GitHub listed no run within ${CI_GH_START}s"
      # "<desktop jobs not skipped> <shards> <shards not started>"
      elif gh_n=$(hub gh api "repos/$ci_slug/actions/runs/$ci_id/jobs?per_page=100" --jq '(.jobs | map(select(.name | startswith("shard ("))))
        as $s | "\(.jobs | map(select(.name == "test" and .conclusion != "skipped")) | length) \($s | length) \($s | map(select(.status
        != "in_progress" and .status != "completed")) | length)"' 2>"$state/ci.err") && [[ $gh_n =~ ^[0-9]+\ [0-9]+\ [0-9]+$ ]]; then
        case $gh_n in
          [1-9]*) ci_gh='' ;; # the desktop's job after all (the repo variable CI_RUNNER=desktop)
          *' 0 '*) gh_why="GitHub hadn't started the run's shards within ${CI_GH_START}s" ;;
          *' 0') ci_gh=done ;;
          *) read -r _ gh_n n <<<"$gh_n"
            gh_why="GitHub started only $((gh_n - n)) of $gh_n shards within ${CI_GH_START}s (its slots are taken, or it is having trouble)" ;;
        esac
      else
        gh_miss=$((gh_miss + 1))
        [ "$gh_miss" -lt 3 ] || gh_why="GitHub didn't say whether the run's shards had started ($gh_miss asks)$(ci_said)"
      fi
      [ -z "$gh_why" ] || continue
    fi
    # Past a limit the suite runs here, but only on a quiet perigee (busy_wait) until then.
    why='' down=''
    if [ -n "$ci_taken" ]; then
      ran=$((SECONDS - taken_at))
      if [ "$ran" -ge "$limit" ] && [ "$ci_fail_n" -gt 1 ]; then
        why="GitHub didn't answer since $ci_fail_at ($ci_fail_n polls failed in a row)$(ci_said), so it isn't known whether CI finished${ci_url:+ ($ci_url)}" down=1
      elif [ "$ran" -ge "$limit" ]; then
        if [ -z "$burn_wait" ] && ci_burned; then
          burn_wait=1 limit=$((limit + burned))
          say "CI's burn-in of new and changed tests took ${burned}s before its full suite, so this waits that much more ($ci_url)"
        elif [ -z "$rerun_wait" ] && ci_rerunning; then
          rerun_wait=1 limit=$((ran + CI_RERUN))
          say "CI's full run ended red and it is rerunning the failed files alone to tell flakes from real failures, so this waits up to $((CI_RERUN / 60)) min $((CI_RERUN % 60)) s more for them instead of falling back at ${CI_LIMIT}s ($ci_url)"
          queue_phase "waiting for CI's reruns alone since $(date +%H:%M)"
        else
          why="CI didn't finish within ${limit}s of starting${rerun_wait:+, its reruns alone included}"
        fi
      fi
    elif [ -z "$ci_gh" ] && [ "$waited" -ge "$CI_START" ]; then
      # Not started: is a runner online? Asked past CI_START, then every CI_ONLINE_POLL s; a missed answer keeps the last.
      if [ -z "$online_at" ] || [ $((SECONDS - online_at)) -ge "$CI_ONLINE_POLL" ]; then
        if n=$(ci_online); then online=$n online_at=$SECONDS; fi
      fi
      if [ -z "$online" ]; then why="GitHub didn't say which runners are online$(ci_said)" down=1
      elif [ "$online" = 0 ]; then why="no runner started the job within ${CI_START}s, and no $CI_LABEL runner is online (they run only while Cara is logged on to her desktop)" down=1
      elif [ "$waited" -ge "$CI_START_ONLINE" ]; then why="no runner started the job within ${CI_START_ONLINE}s, though a $CI_LABEL runner is online"
      elif [ -z "$told" ] || [ $((SECONDS - told)) -ge 300 ]; then
        # Every 5 min, a new phase too (DEPLOY_QUEUE_STALL).
        say "a $CI_LABEL runner is online but hasn't started the job (busy with another run, most likely), so this waits for it: up to $((CI_START_ONLINE / 60)) min, $((waited / 60)) min so far"
        queue_phase "waiting for CI: a busy runner, $((waited / 60)) min so far"
        told=$SECONDS
      fi
    fi
    # A run on GitHub past a limit tries the desktop before perigee.
    if [ -n "$ci_gh" ] && [ -n "$why" ]; then gh_why=$why why='' && continue; fi
    nap=$CI_POLL
    # GitHub failing: each failed poll in a row waits a poll longer, up to CI_BACKOFF s.
    if [ "$ci_fail_n" -gt 0 ]; then nap=$(awk -v p="$CI_POLL" -v n="$ci_fail_n" -v m="$CI_BACKOFF" 'BEGIN { v = p * (1 + n); print (v > m ? (m > p ? m : p) : v) }'); fi
    # On a busy perigee it asks every QUIET_POLL s, not CI_POLL s.
    if [ -n "$why" ]; then
      if quiet; then [ -z "$down" ] || ci_down; return 2; fi
      busy_wait "$why"
      nap=$QUIET_POLL
    else
      busy_last='' # a runner is online and CI hasn't given up on it: this time isn't perigee's busy time (#1361)
    fi
    sleep "$nap"
  done
  # A run on GitHub that ended with no verdict on the tests (a setup step failed, cancelled) goes to the desktop too.
  if [ -n "$ci_gh" ] && [ "$ci_result" != success ] && [ "$ci_result" != timed_out ]; then
    # Every shard's failed steps: one that isn't a test step left its files unrun, whatever the others say.
    ci_step=$(ci_fact api "repos/$ci_slug/actions/runs/$ci_id/jobs?per_page=100" \
      --jq '[.jobs[].steps[]? | select(.conclusion == "failure") | .name] | unique | if length == 0 then "-" else join("\t") end') || ci_step=-
    while IFS= read -r ci_step; do
      case $ci_step in "$CI_STEP" | "$CI_BURN_STEP" | "$CI_RERUN_STEP") ;; -) gh_why="GitHub's run ended as $ci_result, with no failed step" ;;
        *) gh_why="GitHub's run failed in its step \"$ci_step\", before its tests ran ($ci_url)" && break ;; esac
    done < <(tr '\t' '\n' <<<"$ci_step")
    [ -z "$gh_why" ] || continue
  fi
  break
  done
  case $ci_result in
    success) rm -f "$state/ci-down"; say "CI passed on $short in $((SECONDS - started))s ($ci_url)" ;;
    failure)
      # Red only when tests ran: a failed setup, or a runner gone (no failed step, #1864), says nothing about this commit.
      ci_step=$(ci_fact api "repos/$ci_slug/actions/runs/$ci_id/jobs?per_page=100" --jq '[.jobs[].steps[]? | select(.conclusion == "failure") | .name][0] // (if (.jobs | length) == 0 then "no jobs" else "no failed step" end)') || {
        why="GitHub didn't say which step of the red CI run failed ($ci_url)$(ci_said), so it isn't known whether its tests are red"; return 2; }
      [ "$ci_step" != 'no failed step' ] || { ci_lost=1; return 1; }
      [ "$ci_step" != 'no jobs' ] || return 1 # a workflow file GitHub can't run, not a lost runner
      # A skewed clock (#900) lasts hours: the note spares the next landings a run each.
      [ "$ci_step" != "$CI_CLOCK_STEP" ] || { why="runner clock: the CI runner's clock stayed skewed for 2 min, so no test ran ($ci_url); a systemd-timesyncd in a WSL distro on Cara's desktop must be masked (tools/ci-runner/README.md)"; ci_down; return 2; }
      [ "$ci_step" != "$CI_BURN_STEP" ] || { burn_red=1; return 1; } # the ship's own red (#1443)
      # It runs only after a green suite and measures the PC (LB6); main's daily run still goes red on it.
      if [ "$ci_step" = "$CI_PORTS_STEP" ]; then
        say "CI's full suite passed on $short, and then its check of the PC's own ports went red (\"$CI_PORTS_STEP\"), which says nothing about this ship: it counts as green ($ci_url). WSL is leaking Windows ports again: tools/ci-runner/README.md"
        retro_log "CI ports red · $branch · counted as green · $ci_url"
        return 0
      fi
      [ "$ci_step" = "$CI_STEP" ] || { why="the CI run failed in its setup step \"$ci_step\", before any test ran ($ci_url): the runner needs fixing"; return 2; }
      return 1 ;;
    timed_out) return 1 ;;
    *) why="the CI run ended as $ci_result, not as a verdict on the tests"; return 2 ;;
  esac
}

# A red run's failed log into $failed, its last lines on stderr, and run-tests.sh's flake labels into the retro log. Fails, with
# $why, when GitHub sends no log of a red suite: flake, cut-off and real failure can't be told apart without it (#1864).
ci_failed() {
  local f load
  failed=''
  [ -z "$ci_lost" ] || return 0
  [ "$ci_step" != 'no jobs' ] || { failed="the CI run failed before any job started (a workflow file or account problem): $ci_url"; tail -n 40 <<<"$failed" >&2; return 0; }
  if ! failed=$(ci_fact run view "$ci_id" --repo "$ci_slug" --log-failed); then
    failed=''
    [ -z "$burn_red" ] || return 0 # the burn-in step ran and failed: red whatever its log says
    why="GitHub didn't send the red CI run's log ($ci_url)$(ci_said), so a flake, a cut-off run and a real failure can't be told apart"
    return 1
  fi
  tail -n 40 <<<"$failed" >&2
  [ -z "$burn_red" ] || return 0 # a burn-in's log may quote run-tests.sh's lines (test/land.test.ts does): no flakes from it
  if f=$(skipped_tests); then
    say "$(skipped_said "$f"). A skipped test is a real failure, never a flake: its check didn't run, so no flake excuses this run and it gets no fresh one. Make the test run in CI, or give the runner what it needs"
    retro_log "skipped test · $branch${train_br[*]:+ · with ${train_br[*]}} · ${f//$'\n'/; } · $ci_url"
  fi
  while read -r f load; do
    retro_log "flake · $f · load $load · $branch · in CI${train_br[*]:+ · with ${train_br[*]}}" # riders: one run (#1419)
    say "flake: $f · in CI" # the server counts these (src/flakes.ts)
  done < <(sed -n 's/.*run-tests: \(.*\): failed in the full run, passed alone.*load \([0-9.]*\)).*/\1 \2/p' <<<"$failed")
}

# The burn-in's verdict in $failed (#1443): "<file>: failed in <n> of <N> copies at once" for each red file; nothing otherwise.
burn_lines() { sed -n 's/.*burn-in: \([^ ]*: failed in [0-9]* of [0-9]* copies at once\).*/\1/p' <<<"$failed" | sort -u; }

# The failed files, comma-separated, when $failed says every one passed alone (#769); fails otherwise. Counts on run-tests.sh's
# "<n> test file(s) failed; rerunning each alone…" line and the labels after it only (a test can quote one); none: no flake.
# Nor is a run that skipped a test (#1914).
flake_only() {
  local files
  ! skipped_tests >/dev/null || return 1
  files=$(each_job flake_one) || return 1
  sort -u <<<"$files" | sed ':a;N;$!ba;s/\n/, /g'
}

# Whether $failed is a run cut off from outside before any test failed (#1377): Node's "Interrupted while running:" with no
# hang stop by run-tests.sh. #1393: so is a kill from outside (exit 137, out-of-memory): run-tests.sh's "were killed" line, or
# GitHub's exit 137 line alone. With no Node summary, "no test failed" means no ✖ in the log; an earlier failure stays red.
cut_off() {
  ! grep -qF 'run-tests: the tests ran past' <<<"$failed" || return 1
  if grep -qE '(^|[[:space:]])Interrupted while running:' <<<"$failed" && ! grep -qF '✖ failing tests:' <<<"$failed"; then return 0; fi
  grep -qE 'run-tests: the tests were killed \(exit [0-9]+\)|Process completed with exit code 137\.' <<<"$failed" && ! grep -qF '✖' <<<"$failed"
}

# <commit>: the gate on it. 0: green, 1: red (its log in $failed, its run in $ci_url; $reran when it was the one fresh
# run after a red of flakes only), 2: no answer ($why).
gate() {
  local rc=0
  ci_done
  ci_status='' # a run before this gate's says nothing of it, if GitHub doesn't answer its first ask
  CI_REF=land/$branch CI_BASE_REF=land-base/$branch
  # A counted early run is the first gate's, on its own scratch branches, which are this landing's to delete however it ends.
  [ "$1" != "$early_top" ] || CI_REF=early/$branch CI_BASE_REF=early-base/$branch ci_pushed=$1
  early_top=''
  tip=$1 short=$(git rev-parse --short "$1") failed='' reran='' burn_red=''
  ci_gate || rc=$?
  # One fresh run for a red of flakes only (#769). The scratch branch goes first (pushing an existing commit starts no run); ci_gate
  # then passes the red one as stale. A no-answer falls back to the run here, which must be green too. If the branch won't go,
  # it stays red, not a wait read as CI down. A cut-off run (#1377) gets the same one rerun; a red of known flakes only (#1419) is green.
  local cut='' ended='' early_ref='' how='was cut off before any test failed'
  [[ $CI_REF != early/* ]] || early_ref=1
  if [ "$rc" = 1 ] && ! ci_failed; then rc=2; fi
  if [ "$rc" = 1 ]; then
    if [ -n "$burn_red" ]; then
      retro_log "burn-in red · $branch${train_br[*]:+ · with ${train_br[*]}} · $(burn_lines | paste -sd';' -) · $ci_url"
    elif [ -n "$ci_lost" ]; then
      cut=$ci_url how='lost its runner before any step failed'
    elif cut_off; then
      cut=$ci_url
    elif ! reran=$(flake_only); then
      reran=''
    elif known_flakes "$reran"; then
      say "only known flakes failed in CI ($ci_url): $known_why, so this goes on as green, with no fresh run"
      retro_log "known flake · $branch · $known_why · $ci_url"
      known_by[$1]=$known_why reran='' rc=0
    fi
    if [ -z "$cut$reran" ]; then
      :
    elif ! hub git push -q "$REMOTE" ":refs/heads/$CI_REF" ${early_ref:+":refs/heads/$CI_BASE_REF"} 2>"$state/ci.err"; then
      if [ -n "$cut" ]; then
        why="the CI run $how ($cut), and deleting $CI_REF on GitHub to start a fresh run failed$(ci_said)"
        retro_log "cut-off rerun · $branch · $cut · not started"
        rc=2
      else
        say "failed in the full run but passed alone ($reran), but deleting $CI_REF on GitHub to start a fresh run failed$(ci_said), so this stays red"
        retro_log "flake rerun · $branch · $reran · not started"
        reran=''
      fi
    else
      if [ -n "$cut" ]; then say "the CI run on $short $how ($cut), so it says nothing about this commit: running CI once more"
      else say "failed in the full run but passed alone ($reran); running CI once more on $short, the land needs a fully green run"; fi
      ci_id='' ci_status='' ci_pushed='' ci_pushed_at='' CI_REF=land/$branch CI_BASE_REF=land-base/$branch # a counted early run's fresh run goes with the lands'
      rc=0
      ci_gate || rc=$?
      if [ "$rc" = 1 ] && ! ci_failed; then rc=2; fi
      if [ "$rc" = 1 ] && [ -z "$burn_red" ]; then
        if [ -n "$ci_lost" ]; then
          rc=2 ended=1 why="CI's one fresh run lost its runner before any step failed ($ci_url), after one that $how ($cut)"
          [ -n "$cut" ] || why="CI's one fresh run after a red of flakes only ($reran) lost its runner before any step failed ($ci_url)"
        elif cut_off; then
          rc=2 ended=1 why="CI was cut off twice before any test failed ($cut, $ci_url)"
          [ -n "$cut" ] || why="CI's one fresh run after a red of flakes only ($reran) was cut off before any test failed ($ci_url)"
        fi
      fi
      case $rc in 0) result=green ;; 1) result=red ;; *) result='no answer' ;; esac
      if [ -n "$cut" ]; then retro_log "cut-off rerun · $branch · $cut · $result"; else retro_log "flake rerun · $branch · $reran · $result"; fi
    fi
  fi
  [ "$rc" != 0 ] || greens="$greens$1 "
  # Gates whose run was lost or cut off, up to the first with a verdict: past NO_VERDICT_MAX of them the wait is over.
  if [ "$rc" != 2 ]; then no_verdicts=0; elif [ -n "$cut$ended" ]; then no_verdicts=$((no_verdicts + 1)); fi
  return "$rc"
}

# flake_only's answer, and nothing when leftover processes were in it too: those are no flake.
flake_free() {
  ! grep -qE 'The tests left [0-9]+ process\(es\) running' <<<"$failed" || return 1
  flake_only
}

# The run this landing's push started, when no poll has read its id yet (#1894): a stop in the seconds after the push
# left it running. Only one of the pushed commit on this landing's own scratch branch.
ci_late() {
  local run
  while :; do
    run=$(hub gh api "repos/$ci_slug/actions/runs?head_sha=$ci_pushed&per_page=20" --jq "[.workflow_runs[] | select((.path | startswith(\"$CI_WORKFLOW\")) and .head_branch == \"$CI_REF\")][0] // empty | [.id, .status] | @tsv" 2>/dev/null) || run=''
    if [[ $run =~ ^([0-9]+)$'\t'([a-z_]+) ]] && [ "${BASH_REMATCH[1]}" -gt "${ci_stale:-0}" ]; then ci_id=${BASH_REMATCH[1]} ci_status=${BASH_REMATCH[2]}; return 0; fi
    [ -n "$ci_pushed_at" ] && [ $((SECONDS - ci_pushed_at)) -lt "$CI_LATE" ] || return 0
    sleep "$CI_LATE_POLL"
  done
}

# The tests CI's suite skipped (#1914): the count, then up to 5 names, a line each; fails when it skipped none. Only
# CI's own lines count ("<job>\t<step>\t<time> ℹ skipped 1": node's summary, each job's last one): a test's quoted output is
# indented, and perigee's suite always skips the Biome tests it has no Biome for, so its log (no prefix) never matches.
skipped_tests() {
  local pre=$'^[^\t]+\t[^\t]+\t[^ \t]+' n
  # Each job's last summary, added up: a run on GitHub has one a shard (#2209).
  n=$(sed -nE "s/^([^\t]+)\t[^\t]+\t[^ \t]+ ℹ skipped ([0-9]+)\$/\\1\t\\2/p" <<<"$failed" | awk -F '\t' '{ v[$1] = $2 } END { for (j in v) s += v[j]; print s + 0 }')
  [[ $n =~ ^[1-9][0-9]*$ ]] || return 1
  echo "$n"
  sed -nE "s/$pre +﹣ (.*) \([0-9.]+ms\).*/\\1/p" <<<"$failed" | sort -u | sed -n 1,5p
}

# skipped_tests' answer in words: "a test was skipped in CI (<run>): <names>".
skipped_said() {
  local n=${1%%$'\n'*} names=''
  [ "$n" = "$1" ] || names=": $(sed '1d' <<<"$1" | paste -sd';' - | sed 's/;/; /g')"
  if [ "$n" = 1 ]; then echo "a test was skipped in CI ($ci_url)$names"; else echo "$n tests were skipped in CI ($ci_url)$names"; fi
}
