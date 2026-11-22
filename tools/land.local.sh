# shellcheck shell=bash
# Citadel's settings and hooks for the kit's core (tools/land-core.sh, a link to kit/skills/scheme-setup/templates/land.sh),
# which runs Citadel's ships once tools/land.sh's switch is on (SHIP_CORE=1, or LAND_CORE=1 for one ship; #1323).
# Not ready yet: land*.test.ts don't pass against it, and the core still lacks hooks it needs (the handoff in the shared
# folder, handoffs/handoff-ship-core-4b-port-the-land-tests.md). Leave the switch off until that work ships.
# The core sources this under set -euo pipefail before its state is set up, and CI_STATUS sources it again in a fresh
# bash, so nothing at the top level may need the core. Each hook's header in the core says when it runs.
# Parts, in order: the deploy and its line (deploy.sh's lock and queue); what runs before CI (smoke, guards, preflight,
# the numbers merge and renumbers); CI's side (the hub, a quiet perigee, the fallback, flakes); a red batch (main's red, the guess).

# fd 5: lines the server reads even when a SMOKE_CMD or GUARD_CMD that passed has its output dropped.
exec 5>&2

# --- The deploy, its recovery and taken-back commits (#1323) ---------------------------------------------------------
# The line, its lock and its queue are tools/deploy.sh's (tools/deploy-queue.sh), so a deploy by hand and a ship wait
# in the same line. Main is pushed to GitHub by deploy.sh once live, never by the core.
LIVE=${DEPLOY_LIVE:-$HOME/claude-coordinator}
STATE=$LIVE/.git/cc-deploy
LOCK_FILE=$STATE/lock
QUEUE_DIR=$STATE/queue
PUSH_MAIN=0
# This copy's tools (the branch's own, as land.sh ran $here/tools/deploy.sh): the hooks run in the main checkout.
CITADEL_TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# "<commit> <branch>" for each branch main moves to with <commit> (the head's own first, then its batch's members).
# shortcut: reads the core's batch arrays (B_SHA, B_LABEL, GI) and $tip, $branch, which land_deploy inherits as the
# core's subshell; if the core renames them, only the head is named and the members' release rows wait for their branches.
citadel_members() {
  local i
  echo "${tip:-$1} ${branch:-?}"
  [ -z "${BATCH:-}" ] || for ((i = 2; i <= ${GI:-0}; i++)); do echo "${B_SHA[i]} ${B_LABEL[i]}"; done
}

# land_deploy <commit>: in the main checkout, which the core just moved to <commit>, holding the line's lock.
# Takes the restart lock first (a restart still being judged has its verdict first), then runs tools/deploy.sh under
# both, as land.sh did. Its last line: live (the front end reloaded, or last-good has it) or restart (queued).
land_deploy() {
  local to=$1 old note=() ntip mark rc=0 tested=$1 c b
  # shellcheck source=tools/deploy-queue.sh
  . "$CITADEL_TOOLS/deploy-queue.sh"
  DEPLOY_QUEUE_TICKET=${QUEUE_TICKET:-}
  restart_lock "$STATE" || return 1
  deploy_unchecked_back "$STATE" "$LIVE"
  # The restart ahead was rolled back while this waited for it: what it shipped came off the live checkout, and this
  # batch sits on it. Main goes back (the core does that on a failure), and the next landing takes that ship off main.
  if [ -s "$STATE/moving" ]; then
    mapfile -t note <"$STATE/moving" || true
    read -r _ ntip <<<"${note[0]:-}" || true
    if [ -n "$ntip" ] && [ "$ntip" != "$to" ] && git merge-base --is-ancestor "$ntip" "$to" 2>/dev/null &&
      ! git -C "$LIVE" merge-base --is-ancestor "$ntip" HEAD 2>/dev/null && ! git -C "$LIVE" merge-base --is-ancestor "$ntip" last-good 2>/dev/null; then
      say "the restart ahead (${note[1]:-?}, ${ntip:0:12}) was rolled back while this waited for its verdict, and $(git rev-parse --short=12 "$to") sits on it: nothing deployed, so run this again once main is back without it"
      return 1
    fi
    rm -f "$STATE/moving"
  fi
  mark=$(git rev-parse --absolute-git-dir)/land-deploy/$to
  read -r _ _ old _ <"$mark" 2>/dev/null || old=''
  [[ $old =~ ^[0-9a-f]{40,}$ ]] || { say "land_deploy: no word from the core on where main moved from ($mark), so nothing deployed"; return 1; }
  # What a kill from here on leaves (tools/deploy-queue.sh's main_moving_back reads it at the next landing).
  { echo "$old $to"; citadel_members "$to" | sed -n 1p | cut -d' ' -f2-; citadel_members "$to" | sed 1d; } >"$STATE/moving"
  # The release row finds each ship by its branch's tip (src/releases.ts landedIn); a member moves its own branch only
  # once this ends, so it is named here until then. Only this batch's names: the last batch's members have moved.
  git for-each-ref --format='%(refname)' refs/shipping/ | while read -r c; do git update-ref -d "$c"; done
  while read -r c b; do
    [[ $c =~ ^[0-9a-f]{40,}$ ]] && git check-ref-format "refs/shipping/$b" && git update-ref "refs/shipping/$b" "$c" || true
  done < <(citadel_members "$to")
  [ "${lane:-full}" != light ] || tested='' # the light lane ran no CI: deploy.sh decides for itself
  DEPLOY_LOCKED=core DEPLOY_TESTED="$tested" "$CITADEL_TOOLS/deploy.sh" || rc=$?
  if [ "$rc" != 0 ]; then
    # The checkout kept it (the restart was queued and is still being judged): main keeps it too, as land.sh did.
    if git -C "$LIVE" merge-base --is-ancestor "$to" HEAD 2>/dev/null; then
      say "the deploy failed (exit $rc) after the live checkout took $(git rev-parse --short=12 "$to"), so main keeps it; the deploy's lines above say why"
      echo restart
      return 0
    fi
    while read -r c b; do taken_back "$STATE" "$c" "$b"; done < <(citadel_members "$to" | tac)
    rm -f "$STATE/moving"
    return "$rc"
  fi
  [ "$(head -n 1 "$STATE/moving" 2>/dev/null)" != "$old $to" ] || ! git -C "$LIVE" merge-base --is-ancestor "$to" last-good 2>/dev/null || rm -f "$STATE/moving"
  if git -C "$LIVE" merge-base --is-ancestor "$to" last-good 2>/dev/null; then echo live; else echo restart; fi
}

# land_recover <main's commit>: at the front, holding the line's lock, after the core's deploy_stale. What a landing or
# deploy killed outright left half done (#553) goes back, unless a restart is still being judged (#566): then
# land_deploy does it with both locks.
land_recover() {
  local note=() old tip
  # shellcheck source=tools/deploy-queue.sh
  . "$CITADEL_TOOLS/deploy-queue.sh"
  # A head killed after deploy.sh queued its restart: deploy_stale took main back, but the live checkout runs it.
  if [ -s "$STATE/moving" ]; then
    mapfile -t note <"$STATE/moving" || true
    read -r old tip <<<"${note[0]:-}" || true
    if [ -n "$tip" ] && [ "$1" = "$old" ] && git -C "$LIVE" merge-base --is-ancestor "$tip" HEAD 2>/dev/null &&
      git merge -q --ff-only "$tip" 2>/dev/null; then
      say "the landing before this one was stopped after the live checkout took $(git rev-parse --short=12 "$tip") (${note[1]:-?}), so main is back on it"
    fi
  fi
  exec 7>"$STATE/restart.lock"
  if flock -n 7; then
    deploy_unchecked_back "$STATE" "$LIVE"
    main_moving_back "$STATE" "$LIVE" "$PWD"
  fi
}

# land_under <commit> <branch>: the newest commit under <commit> that came off main again (a rolled-back restart took
# its ship out, <state>/taken-back), so the rebase replays only <branch>'s own commits above it.
land_under() {
  local t b u=''
  while read -r t b; do
    [ "$b" != "$2" ] && git merge-base --is-ancestor "$t" "$1" 2>/dev/null && ! git merge-base --is-ancestor "$t" "refs/heads/${BRANCH:-main}" 2>/dev/null || continue
    { [ -n "$u" ] && git merge-base --is-ancestor "$t" "$u"; } || u=$t
  done < <(cat "$STATE/taken-back" 2>/dev/null || true)
  [ -z "$u" ] || echo "$u"
}

# frag-pregate.sh: what Citadel's tools/land.sh runs before CI, on the core's hooks. Needs LIVE, STATE and
# `exec 5>&2` above it (fd 5: lines the server reads even when SMOKE_CMD/GUARD_CMD pass and their output is dropped).

# Citadel land.sh 126: a container turn has no host locks or deploy; the land tool runs land.sh on the host.
if [ "${COORDINATOR_CONTAINER:-}" = 1 ]; then
  refuse "this turn runs in a container: call the land tool (mcp__thread) instead, which runs land.sh on the host"
fi
# Citadel land.sh 127: under citadel-heavy it would hold a heavy slot while it waits in line.
if [ -n "${CITADEL_HEAVY_HELD:-}" ]; then
  refuse "run it on its own, not under citadel-heavy: it would hold a heavy slot other schemes need while it waits for the deploy lock"
fi

# Citadel's rerere conflict prep (#1325, land.sh 169-171): on, with the same off switches.
CONFLICT_PREP=${LAND_PREP:-1}
if [ -e "$STATE/prep-off" ]; then CONFLICT_PREP=0; fi
# Citadel stacks two deep (one-ship-batching §5b).
CI_STACK=${LAND_STACK_DEPTH:-2}
# The ship train (#1166) as batches of 6, with the train's off switches.
CI_BATCH=${LAND_BATCH:-6}
if [ "${LAND_TRAIN:-1}" = 0 ] || [ -e "$STATE/train-off" ]; then CI_BATCH=1; fi
# Citadel's own pipeline list (land.sh pipeline_touch, same format: a path, or a folder ending /).
PIPELINE_FILES=${LAND_PIPELINE_FILES:-tools/pipeline-files.txt}
# No in-line check: Citadel runs the guards there (GUARD_CMD) and leaves the suite to CI (its fallback: land_fallback).
CHECK=''
# Citadel's early check is the merge-tree trial, which the core's smoke always does; it has no light check to run.
EARLY_CHECK=0
# Citadel land.sh 929-939: a feeder's --into runs the test files it names, without the always-tests.
CHECK_FILE_CMD='CITADEL_TEST_ALWAYS=/dev/null tools/citadel-test --timeout "${DEPLOY_TEST_TIMEOUT:-600}" {file}'
# Citadel land.sh smoke(): parse check, stale docs, always-tests and changed tests, flake retry (citadel_smoke).
SMOKE_CMD=citadel_smoke
# citadel-test's own limit (LAND_SMOKE_TIMEOUT) decides first; this outer one only covers the flake reruns after it.
SMOKE_TIMEOUT=$(( ${LAND_SMOKE_TIMEOUT:-300} * 3 ))
# Citadel land.sh guards() (#1240): schema, prompt budget, one-until and UI contract tests on the rebased commit.
GUARD_CMD=citadel_guards
GUARD_TIMEOUT=$(( ${LAND_GUARD_TIMEOUT:-120} + 30 ))
# Citadel numbers_git (#1221) and the prompt budget's sums: ship-time merges in place of a stopped rebase.
MERGES='src/db.ts hook
src/db.ts append ^const\ MIGRATIONS
test/prompt-budget.test.ts sum ^const\ (BUDGET|KIT_BUDGET|TOOLS_BUDGET)\ =
test/prompt-baseline.json main'

# Citadel retro_log (land.sh 79-86), verbatim: one best-effort line in the day's retro-log/land.md.
citadel_retro_log() (
  set +e
  [ -n "${COORDINATOR_SHARED_DIR:-}" ] || exit 0
  dir=$COORDINATOR_SHARED_DIR/retro-log/$(date -u +%F)
  mkdir -p "$dir" || exit 0
  [ -e "$dir/land.md" ] || printf '%s\n\n' '# Retro log: land.sh' 'Written by tools/land.sh, tools/run-tests.sh and the queued restart in tools/deploy.sh (no session id, so one file per day). One line per rebase conflict, per landing that fell back from CI to the suite on perigee, per test file that failed in a land or deploy run and passed alone (flake), and per fresh CI run after a red of flakes only (flake rerun: green, red, no answer or not started), a `broken test` line per file tools/known-flakes.ts calls a broken test, not a flake (#1487), and per fresh CI run after one cut off before any test failed (cut-off rerun, the same results), and a `bisect run` line per CI run of a red train'"'"'s bisect that gave a verdict. A `smoke` line per landing the smoke check refused before the line (#1012: what failed, its seconds; no timing line for it). Phase times in whole seconds (#565), - for a phase never reached: a `timing` line per landing that got in line, landed or not (line: waiting for the deploy lock; rebase; ci-queue: until a runner took the job; ci-run; fallback: the wait for a CI that gave no answer + the suite on perigee; deploy: pull, boot check and tests if any, until the restart was queued or the front end reloaded; live: from then until the deploy saw it live, the restart'"'"'s settle check included), and a `restart` line per queued restart (idle-wait: for the turns it would cut off and the lock; backup: the database copy; healthy: restart to the first healthy answer; settle: the check after it).' >>"$dir/land.md"
  printf -- '- %sZ · %s\n' "$(date -u +%T)" "$1" >>"$dir/land.md"
) >/dev/null 2>&1 || true

# Citadel's say() from inside SMOKE_CMD/GUARD_CMD: to fd 5, which reaches the server even when their output is dropped.
citadel_tell() { { printf 'land: %s\n' "$*" >&5; } 2>/dev/null || printf 'land: %s\n' "$*" >&2; }

# Citadel's $label for retro lines: the branch (the core's land-branch file names it while the worktree is detached),
# with "· lands build/<n>" for a build minion's land (its branch's tip is the build's, as the core's --build requires).
citadel_label() {
  local br b
  br=$(git branch --show-current 2>/dev/null)
  [ -n "$br" ] || br=$(head -n 1 "$(git rev-parse --absolute-git-dir)/land-branch" 2>/dev/null)
  [ -n "$br" ] || { git rev-parse --short HEAD; return; }
  b=$(git for-each-ref --points-at "refs/heads/$br" --format='%(refname:lstrip=2)' 'refs/heads/build/' 2>/dev/null | head -n 1)
  echo "$br${b:+ · lands $b}"
}

# Citadel smoke() past the merge-tree trial (land.sh 420-468). Runs under `bash -c` with its output kept only on a
# failure, so the lines the server reads on a pass go through citadel_tell; the core prints "land: smoke: " before the
# rest. 0 passed, 1 refuses, 124 doesn't decide (the core says so; a fast land refuses on it).
citadel_smoke() {
  local t0=$SECONDS out rc=0 tests=() failed=() still=() f mb label build
  label=$(citadel_label)
  # The core's --build: a build minion's branch at its build's tip. Like Citadel's non-plain lands: no stale docs, no changed tests.
  build=$(git for-each-ref --points-at HEAD --format='%(refname:lstrip=2)' 'refs/heads/build/' | head -n 1)
  mb=$(git merge-base main HEAD) || mb=main
  citadel_smoke_fail() {
    citadel_retro_log "smoke · $label · $1 · $((SECONDS - t0))s"
    echo "$1"
    exit 1
  }
  if [ -f tools/parse-check.ts ]; then
    out=$(tools/citadel-node --no-warnings tools/parse-check.ts 2>/dev/null) || true
    if [ -n "$out" ]; then echo "$out"; citadel_smoke_fail "a .ts file does not parse"; fi
  fi
  # Instruction files naming a gone path (#1395): only the dead paths this branch adds; a missing or erroring tool is skipped.
  if [ -x tools/stale-docs ] && [ -z "$build" ]; then
    out=$(tools/citadel-node tools/stale-docs refs --new-since "$mb" 2>/dev/null) && rc=0 || rc=$?
    if [ "$rc" = 1 ]; then
      echo "$out"
      citadel_smoke_fail "an instruction file names a path that is not in the repo (tools/stale-docs refs: fix the line, or allow-list it in .stale-docs-allow with a reason)"
    fi
    rc=0
  fi
  if [ -x tools/citadel-test ] && [ -f tools/always-tests.txt ]; then
    mapfile -t tests < <(grep -vE '^[[:space:]]*(#|$)' tools/always-tests.txt; [ -n "$build" ] || git diff --name-only --diff-filter=d "$mb" HEAD -- 'test/*.test.ts')
    # The route test by the affected map (#1544); a map that can't answer runs it, never skips it.
    if [ -f tools/affected.ts ]; then
      if out=$(tools/citadel-node --no-warnings tools/affected.ts --root . --base "$mb" 2>/dev/null); then
        if grep -q $'^run\ttest/access-matrix\\.test\\.ts\t' <<<"$out"; then tests+=(test/access-matrix.test.ts); fi
      else
        citadel_tell "smoke: the affected map couldn't answer, so the route test runs"
        tests+=(test/access-matrix.test.ts)
      fi
    fi
    if [ ${#tests[@]} -gt 0 ]; then
      citadel_tell "smoke: running ${#tests[@]} test files"
      out=$(tools/citadel-test --timeout "${LAND_SMOKE_TIMEOUT:-300}" "${tests[@]}" 2>&1) || rc=$?
      if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
        citadel_tell "smoke: the tests ran past ${LAND_SMOKE_TIMEOUT:-300} s, so they don't decide: getting in line, and CI runs them all"
        exit 124
      elif [ "$rc" = 2 ]; then # citadel-test couldn't start them, which says nothing about the branch
        citadel_tell "smoke: citadel-test couldn't run the tests ($(grep -m1 '^citadel-test: ' <<<"$out" || echo exit 2)), so they don't decide: getting in line"
        exit 124
      elif [ "$rc" != 0 ]; then
        # Each failed file once more alone (ADR 0006): one that passes alone is a likely flake from load and doesn't decide.
        mapfile -t failed < <(sed -nE 's/^✖ ([^ :]+\.test\.ts)(:[0-9]+)? › .*/\1/p' <<<"$out" | sort -u)
        for f in "${failed[@]}"; do
          CITADEL_TEST_ALWAYS=/dev/null tools/citadel-test --timeout "${LAND_SMOKE_TIMEOUT:-300}" "$f" >/dev/null 2>&1 || still+=("$f")
        done
        if [ ${#failed[@]} -gt 0 ] && [ ${#still[@]} -eq 0 ]; then
          for f in "${failed[@]}"; do citadel_retro_log "flake · $f · smoke · $label"; citadel_tell "flake: $f · smoke"; done
          citadel_tell "smoke: ${failed[*]} failed, then passed alone: likely load, not your change, so it doesn't decide: getting in line"
        else
          grep -v '^full output: ' <<<"$out" | tail -n 55
          citadel_smoke_fail "tests failed (exit $rc)"
        fi
      fi
    fi
  fi
  exit 0
}

# Citadel guard_run + guards (land.sh 888-918) as GUARD_CMD: output goes to the core's log, shown only on a failure.
# 0 passed or none, 1 failed, 2 couldn't decide (citadel-test's 2, or its own time limit).
citadel_guards() {
  local t0=$SECONDS tests=() f out rc=0 short
  for f in test/schema-compat.test.ts test/prompt-budget.test.ts test/one-until.test.ts test/ui-contract.test.ts; do
    if [ -f "$f" ]; then tests+=("$f"); fi
  done
  if [ ! -x tools/citadel-test ] || [ ${#tests[@]} -eq 0 ]; then exit 0; fi
  short=$(git rev-parse --short HEAD)
  out=$(CITADEL_TEST_ALWAYS=/dev/null tools/citadel-test --timeout "${LAND_GUARD_TIMEOUT:-120}" "${tests[@]}" 2>&1) || rc=$?
  case $rc in
    0) citadel_tell "guard tests passed on $short in $((SECONDS - t0)) s"; exit 0 ;;
    2 | 124 | 137) echo "$out"; exit 2 ;;
  esac
  grep -v '^full output: ' <<<"$out" | tail -n 38 | sed 's/^/land: guard: /'
  citadel_retro_log "guard · $(citadel_label) · $(sed -nE 's/^✖ ([^ :]+\.test\.ts).*/\1/p' <<<"$out" | sort -u | paste -sd, -) · $((SECONDS - t0))s"
  echo "land: guard tests failed on $short, the branch rebased onto main (output above), so no CI run was spent. Run citadel-test on that file, fix it, commit, then run this again"
  exit 1
}
export -f citadel_retro_log citadel_tell citadel_label citadel_smoke citadel_guards

# Citadel bad_check (land.sh 802-825, #553, #1271): while main holds a commit whose deploy was rolled back, only its
# fix lands. Returns 1 after saying why, for land_preflight.
citadel_bad_check() {
  local bad good rest why
  if [ -s "$STATE/rolling-back" ]; then
    read -r _ good _ <"$STATE/rolling-back" || true
    if systemctl --user is-active -q "${DEPLOY_UNIT:-cc-restart-when-idle}" 2>/dev/null; then
      say "a member pressed Roll back to last green, and its restart onto $(git log -1 --format='%h "%s"' "$good" 2>/dev/null || echo "${good:0:7}") waits to go live (for running turns a restart would cut off). Nothing landed. Ship again once it is live (the Releases page shows it)"
      return 1
    fi
    rm -f "$STATE/rolling-back" # left by a roll back that was killed
  fi
  [ -s "$STATE/bad" ] || return 0
  read -r bad good rest <"$STATE/bad" || true
  git merge-base --is-ancestor "$bad" "refs/heads/$BRANCH" 2>/dev/null || { rm -f "$STATE/bad"; return 0; }
  [ -z "${LAND_FIX:-}" ] || return 0
  # Against the commit it was rebased onto, so a stacked landing isn't credited with the changes of the ones ahead.
  [ -z "$(comm -12 <(git diff --name-only "$good" "$bad" | sort) <(git diff --name-only "${base:-refs/heads/$BRANCH}" HEAD | sort))" ] || return 0
  why="the restart on it failed: its report is in the chat of the minion that deployed it"
  [ "${rest##* }" != rollback ] || why="a member pressed Roll back to last green on Releases"
  say "main holds $(git log -1 --format='%h "%s"' "$bad"), whose deploy was rolled back ($why), and $branch changes none of the files that deploy changed, so its deploy would be rolled back too. Nothing landed. Land the fix for it first (or its revert); if $branch is that fix, run LAND_FIX=1 tools/land.sh (from a turn in a container: the land tool with fix: true)"
  return 1
}

# Citadel preflight (land.sh 853-877, #646): while deploys refuse, the deploy's boot check on this commit before CI.
citadel_boot_preflight() {
  local at why since rc=0 short
  [ -s "$STATE/refusing" ] || return 0
  { [ "${LAND_PREFLIGHT:-1}" != 0 ] && [ ! -e "$STATE/preflight-off" ]; } || return 0
  read -r at why <"$STATE/refusing" || true
  [[ $at =~ ^[0-9]+$ ]] || return 0
  since=$(date -d "@$at" '+%b %-d %H:%M %Z')
  short=$(git rev-parse --short "$1")
  say "deploy has been refusing since $since ($why): running its boot check on $short before a CI run is spent on it"
  queue_phase "boot check before CI since $(date +%H:%M)"
  timeout -k 10 "${DEPLOY_BOOT_TIMEOUT:-420}" "$here/tools/citadel-node" "$here/tools/boot-check.ts" "$here" "${DEPLOY_DB:-$HOME/.local/share/claude-coordinator/coordinator.db}" >/dev/null || rc=$?
  if [ "$rc" = 0 ]; then
    say "the boot check passes on $short, so this landing goes on"
    return 0
  fi
  citadel_retro_log "preflight refusal · $(citadel_label) · refusing since $since ($why)"
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
    say "deploy has been refusing since $since: $why, and the boot check hung on $short here too (stopped after ${DEPLOY_BOOT_TIMEOUT:-420} s), so no CI run was spent and main is untouched; $branch keeps the rebased work. A hang is not a verdict on the change: run it again, and if it hangs again tell the Taskmaster, since landings are blocked until that is fixed"
  else
    say "deploy has been refusing since $since: $why, and $short fails the same check here (its output is above), so no CI run was spent and main is untouched; $branch keeps the rebased work. If the cause is in your change, fix it and land again. If it isn't, landings are blocked until the fix for it lands (that fix passes this check and lands as usual): tell the Taskmaster, and don't retry until then"
  fi
  return 1
}

# Core hook: the rolled-back-deploy check, then the boot check while deploys refuse (the core skips the light lane).
land_preflight() {
  citadel_bad_check || return 1
  citadel_boot_preflight "$1"
}

# Core hook (MERGES src/db.ts hook): Citadel's numbers_git driver, ship-numbers.ts merge; git's own merge without it.
land_merge() {
  if [ -f tools/ship-numbers.ts ]; then
    tools/citadel-node --no-warnings tools/ship-numbers.ts merge "$1" "$2" "$3" "$4"
  elif [ -z "${LAND_MERGE_DIFF3:-}" ]; then
    git merge-file "$3" "$2" "$4"
  else
    return 1
  fi
}

# Core hook, on the rebased branch: Citadel's --into docs-only rule (land.sh 251-253, which CHECK '' would skip), ADR
# numbers at ship time (#1221, land.sh 711-722) and the prompt baseline the MERGES `main` rule took from main.
land_rebased() {
  local onto=$1 name renamed n code
  name=${build:-$BRANCH} n=${branch#ticket/} n=${n%%-*}
  if [ "$mode" = into ] && [ ${#files[@]} -eq 0 ]; then
    code=$(git diff --name-only "$onto" HEAD | grep -vE '\.md$|^docs/' || true)
    if [ -n "$code" ]; then
      say "name the test files this change touched (tools/land.sh --into $build <test files>): only a docs-only change (*.md, docs/) merges in untested, and it changes $(head -n 3 <<<"$code" | sed ':a;N;$!ba;s/\n/, /g')$([ "$(wc -l <<<"$code")" -le 3 ] || echo ' and more'). Nothing merged"
      return 1
    fi
  fi
  if [ -f tools/ship-numbers.ts ]; then
    if ! renamed=$(tools/citadel-node --no-warnings tools/ship-numbers.ts adr "$onto" "$name"); then
      say "renumbering this branch's ADRs failed (see above), so nothing landed. Run git status, put back what it left, then this again"
      return 1
    fi
    if [ -n "$renamed" ]; then
      sed 's/^/land: /' <<<"$renamed" >&2
      git commit -q -m "${n:+#$n: }$(head -n 1 <<<"$renamed")" -m "Numbered at ship time by tools/land.sh (#1221):" -m "$renamed"
      if [ "$mode" = into ]; then claims_check "$BRANCH"; fi # its link rewrites may reach a file another feeder claims
    fi
  fi
  # The branch's own baseline lost to main's (MERGES `main`): measured again on the merged prompts.
  if [ -f test/prompt-budget.test.ts ] && ! git diff --quiet "$(git merge-base "$onto" "$pre")" "$pre" -- test/prompt-baseline.json; then
    PROMPT_BASELINE=write tools/citadel-node --no-warnings --test test/prompt-budget.test.ts >/dev/null 2>&1 || true
    git add test/prompt-baseline.json
    git diff --cached --quiet || git commit -q -m "${n:+#$n: }test/prompt-baseline.json measured again at ship time"
  fi
}

# frag-ci.sh: Citadel's land.local.sh, the CI side of the gate (#1323 spec §5b: hub, quiet, CI FALLBACK, ci_*, flakes).
# Settings and functions only: the core sources this under set -euo pipefail before state, MAIN or branch are set, and
# CI_STATUS sources it again in a fresh bash (where nothing of the core exists), so nothing here may need the core at
# top level. The hooks (land_ci_more, land_flaky, land_fallback) run in subshells of the core and may use its say,
# queue_phase, $tip, $branch, $state, $flaked; citadel_ci_status and what it calls may not.

# --- Settings ---------------------------------------------------------------------------------------------------------
# Ports CI_WORKFLOW/CI_LABEL/CI_*_STEP (land.sh 944-958): the one workflow and the step names Citadel's gate reads.
CITADEL_CI_WORKFLOW=.github/workflows/tests.yml
CITADEL_CI_LABEL=citadel-ci-linux
CITADEL_CI_STEP='the full suite'
CITADEL_CI_CLOCK_STEP="the runner's clock"
CITADEL_CI_RERUN_STEP='rerun failed files alone'
CITADEL_CI_BURN_STEP='burn in new and changed tests'
# Ports CI_START_ONLINE, CI_ONLINE_POLL, CI_RERUN (#1374, = tests.yml RERUN_WINDOW) and CI_BURN (#1443): land_ci_more's extra time.
CITADEL_CI_START_ONLINE=${LAND_CI_START_ONLINE:-900}
CITADEL_CI_ONLINE_POLL=${LAND_CI_ONLINE_POLL:-30}
CITADEL_CI_RERUN=${LAND_CI_RERUN:-180}
CITADEL_CI_BURN=${LAND_CI_BURN:-180}
# Ports CI_START/CI_LIMIT/CI_POLL/CI_DOWN: the core reads these LAND_* names at its line ~586, after this file.
# CI_LIMIT is 360 s from the push here (Citadel's counted from the runner taking the job): land_ci_more's "taken" key adds the queue time.
LAND_CI_START=${LAND_CI_START:-90}
LAND_CI_TIMEOUT=${LAND_CI_TIMEOUT:-360}
LAND_CI_POLL=${LAND_CI_POLL:-5}
LAND_CI_DOWN=${LAND_CI_DOWN:-600}
# Ports ci_gate as the core's CI_STATUS: the core runs it with `bash -c`, so it sources this file (absolute path) first.
citadel_self=$(realpath -- "${BASH_SOURCE[0]}")
CI_STATUS=". ${citadel_self@Q} && citadel_ci_status"
CI_WORKFLOWS=''
# Ports FLAKE_KEEP_MAX (#1419 part 2): one fresh run for any red of flakes only, then at most 2 more kept in line (land_flaky).
CITADEL_FLAKE_KEEP_MAX=2
FLAKE_RUNS=${LAND_FLAKE_RUNS:-$((1 + CITADEL_FLAKE_KEEP_MAX))}
# Ports retry_in_place (#1360): one pipeline refusal per hand-off asks again in place (land_fallback's 75 the first time).
PARK_RETRIES=${LAND_PARK_RETRIES:-1}
# Ports quiet()'s settings (#1254) and citadel-heavy's slot folder, LAND_QUIET_PROC for tests' fake /proc.
CITADEL_QUIET_PROC=${LAND_QUIET_PROC:-/proc}
CITADEL_QUIET_PSI=${LAND_QUIET_PSI:-20}
CITADEL_QUIET_MEM=${LAND_QUIET_MEM:-25}
CITADEL_QUIET_LIMIT=${LAND_QUIET_LIMIT:-1800}
CITADEL_QUIET_POLL=${LAND_QUIET_POLL:-30}
CITADEL_HEAVY_DIR_=${CITADEL_HEAVY_DIR:-$HOME/.local/share/claude-coordinator/projects/.heavy}

# --- Shared helpers -------------------------------------------------------------------------------------------------
# Ports hub(): GitHub as the box's own gh login (#182), never a turn's GH_TOKEN. The core's own hub (line 1329) can't be overridden.
citadel_hub() { env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh" GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 timeout 30 "$@" 9>&- 7>&- 6>&-; }

# Ports retro_log (land.sh 79-86), verbatim: the same function as frag-suspect's and frag-pregate's, kept once when assembled.

# Ports ci_gate's state ($state/ci.err, the per-landing ci_* variables): one folder in the common git dir, kept a day, shared by CI_STATUS and the hooks.
citadel_ci_dir() {
  local d
  d=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  mkdir -p "$d/land-ci" || return 1
  find "$d/land-ci" -mindepth 1 -mmin +1440 -delete 2>/dev/null || true
  echo "$d/land-ci"
}
# Ports ci_gate's slug: owner/repo from origin's URL.
citadel_slug() { local u; u=$(git remote get-url origin 2>/dev/null) || return 1; u=${u#*github.com[:/]}; echo "${u%.git}"; }
# Ports ci_online: how many citadel-ci-linux runners are online, asked at most every CITADEL_CI_ONLINE_POLL s (<dir>/online caches it).
citadel_online() {
  local slug=$1 dir=$2 at='' n='' now
  now=$(date +%s)
  read -r at n 2>/dev/null <"$dir/online" || true
  if [[ $at =~ ^[0-9]+$ && $n =~ ^[0-9]+$ ]] && [ $((now - at)) -lt "$CITADEL_CI_ONLINE_POLL" ]; then echo "$n"; return 0; fi
  n=$(citadel_hub gh api "repos/$slug/actions/runners?per_page=100" --jq "[.runners[] | select(.status == \"online\" and any(.labels[]; .name == \"$CITADEL_CI_LABEL\"))] | length" 2>/dev/null) || return 1
  [[ $n =~ ^[0-9]+$ ]] || return 1
  printf '%s %s\n' "$now" "$n" >"$dir/online" 2>/dev/null || true
  echo "$n"
}
# Ports quiet() (#1254) verbatim but for names: 0 when perigee is quiet, else 1 with what is busy in $citadel_busy.
citadel_busy=''
citadel_quiet() {
  local line load cores total avail d=$CITADEL_HEAVY_DIR_
  citadel_busy=''
  cores=$(nproc 2>/dev/null || echo 2)
  if ! { line=$(grep -m 1 '^some ' "$CITADEL_QUIET_PROC/pressure/cpu" 2>/dev/null) && [[ $line =~ avg60=([0-9]+) ]]; }; then citadel_busy+="no CPU pressure reading, "
  elif [ "$((10#${BASH_REMATCH[1]}))" -ge "$CITADEL_QUIET_PSI" ]; then citadel_busy+="CPU pressure ${BASH_REMATCH[1]}% (quiet is under $CITADEL_QUIET_PSI%), "; fi
  if ! { read -r load _ 2>/dev/null <"$CITADEL_QUIET_PROC/loadavg" && [[ $load =~ ^([0-9]+)\.([0-9]{2}) ]]; }; then citadel_busy+="no load reading, "
  elif [ $((10#${BASH_REMATCH[1]}${BASH_REMATCH[2]} * 2)) -ge $((cores * 100)) ]; then citadel_busy+="load $load on $cores cores (quiet is under half), "; fi
  total=$(sed -n 's/^MemTotal: *\([0-9]*\) kB/\1/p' "$CITADEL_QUIET_PROC/meminfo" 2>/dev/null) || total=''
  avail=$(sed -n 's/^MemAvailable: *\([0-9]*\) kB/\1/p' "$CITADEL_QUIET_PROC/meminfo" 2>/dev/null) || avail=''
  if ! [[ $total =~ ^[0-9]+$ && $avail =~ ^[0-9]+$ ]] || [ "$total" -le 0 ]; then citadel_busy+="no memory reading, "
  elif [ $((avail * 100 / total)) -lt "$CITADEL_QUIET_MEM" ]; then citadel_busy+="$((avail * 100 / total))% of memory free (quiet is $CITADEL_QUIET_MEM% or more), "; fi
  if [ -e "$d/slot-0" ] && ! flock -n "$d/slot-0" true 2>/dev/null; then citadel_busy+="perigee's heavy slot is taken ($(head -c 120 "$d/slot-0.who" 2>/dev/null || echo '?')), "; fi
  if [ -e "$d/queue" ] && ! flock -n "$d/queue" true 2>/dev/null; then citadel_busy+="jobs are in line for that slot, "; fi
  citadel_busy=${citadel_busy%, }
  [ -z "$citadel_busy" ]
}
# Ports flake_only (#769) on a log on stdin: the failed files, comma-separated, when every one passed alone after run-tests.sh's last "rerunning each alone" line.
citadel_flake_only() {
  local log at n files
  log=$(cat)
  at=$(grep -n 'run-tests: [0-9][0-9]* test file(s) failed; rerunning each alone' <<<"$log" | tail -n 1 | cut -d: -f1) || at=''
  [[ $at =~ ^[0-9]+$ ]] || return 1
  n=$(sed -n "${at}s/.*run-tests: \\([0-9][0-9]*\\) test file(s) failed.*/\\1/p" <<<"$log")
  [[ $n =~ ^[1-9][0-9]*$ ]] || return 1
  files=$(tail -n "+$at" <<<"$log" | sed -n 's/.*run-tests: \(.*\): failed in the full run, passed alone.*/\1/p' | sort -u)
  [ -n "$files" ] && [ "$(wc -l <<<"$files")" = "$n" ] || return 1
  sed ':a;N;$!ba;s/\n/, /g' <<<"$files"
}
# Ports cut_off (#1377, #1393) on a log on stdin: 0 when the run was cut off or killed from outside before any test failed.
citadel_cut_off() {
  local log
  log=$(cat)
  ! grep -qF 'run-tests: the tests ran past' <<<"$log" || return 1
  if grep -qE '(^|[[:space:]])Interrupted while running:' <<<"$log" && ! grep -qF '✖ failing tests:' <<<"$log"; then return 0; fi
  grep -qE 'run-tests: the tests were killed \(exit [0-9]+\)|Process completed with exit code 137\.' <<<"$log" && ! grep -qF '✖' <<<"$log"
}
# Ports burn_lines (#1443) on a log on stdin, joined: "<file>: failed in <n> of <N> copies at once"; frag-suspect's citadel_burn_lines reads $failed instead.
citadel_ci_burn_lines() { sed -n 's/.*burn-in: \([^ ]*: failed in [0-9]* of [0-9]* copies at once\).*/\1/p' | sort -u | paste -sd';' - | sed 's/;/; /g'; }
# Ports train_suspects_of's first two levels for a ship on its own: the file <commit>'s change (from main's fork point) touched that is <test file> or one it imports by a relative path.
citadel_ci_near() {
  local base chg text c stem
  base=$(git merge-base refs/heads/main "$2" 2>/dev/null) || return 1
  chg=$(git diff --no-renames --name-only "$base" "$2" 2>/dev/null) || return 1
  if grep -qxF -- "$1" <<<"$chg"; then echo "$1"; return 0; fi
  text=$(git show "$2:$1" 2>/dev/null) || return 1
  while IFS= read -r c; do
    stem=${c##*/} stem=${stem%.*}
    [ -n "$stem" ] || continue
    if grep -Eq "(from|import|require)[[:space:]]*\\(?[[:space:]]*['\"]\\.\\.?/([^'\"]*/)?${stem//./\\.}(\\.[a-z]+)?['\"]" <<<"$text"; then echo "$c"; return 0; fi
  done <<<"$chg"
  return 1
}
# Ports known_flakes (#1419, #1487): <files, comma-separated> <commit> <branch> <log>: prints known_why when each is a known flake its change didn't touch; says why not on stderr.
citadel_ci_known() {
  local files=() f m out ok=1 near t
  t=$(dirname "$citadel_self")
  [ -f "$t/known-flakes.ts" ] || return 1
  ! grep -qE 'The tests left [0-9]+ process\(es\) running' "$4" 2>/dev/null || { echo "land: the run also left processes running (the leak guard), so no flake is excused" >&2; return 1; }
  IFS=, read -ra files <<<"${1//, /,}"
  out=$(LAND_FLAKE_DB=${DEPLOY_DB:-$HOME/.local/share/claude-coordinator/coordinator.db} \
    "$t/citadel-node" --no-warnings "$t/known-flakes.ts" "$3" "${files[@]}" 2>/dev/null) || ok=''
  [ -n "$out" ] || { echo "land: couldn't tell whether $1 are known flakes (tools/known-flakes.ts gave no answer)" >&2; return 1; }
  if [ -z "$ok" ]; then
    while IFS= read -r f; do
      if [[ $f == 'broken test, not a flake: '* ]]; then
        echo "land: $f" >&2
        m=${f#broken test, not a flake: }
        citadel_retro_log "broken test · ${m%% *} · ${m#* } · $3"
      elif [[ $f == *'(not seen on another branch'* ]]; then echo "land: $f is no known flake" >&2; fi
    done <<<"$out"
    return 1
  fi
  for f in "${files[@]}"; do
    near=$(citadel_ci_near "$f" "$2") || continue
    echo "land: $f is a known flake, but this ship changed $near, so it isn't excused" >&2
    ok=''
  done
  [ -n "$ok" ] || return 1
  sed ':a;N;$!ba;s/\n/, /g' <<<"$out"
}
# Ports gate()'s "flake rerun" and "cut-off rerun" retro lines: <dir> <commit> <run id> <result>: logs the result of the fresh run asked for by an older run's red.
citadel_ci_rerun_said() {
  local k id what br
  br=$(git branch --show-current 2>/dev/null) || br=''
  for k in flake cut; do
    read -r id what 2>/dev/null <"$1/$k-$2" || continue
    [ "$id" != "$3" ] || continue
    rm -f "$1/$k-$2"
    if [ "$k" = flake ]; then citadel_retro_log "flake rerun · $br · $what · $4"; else citadel_retro_log "cut-off rerun · $br · $what · $4"; fi
  done
}
# Ports ci_failed: run <id>'s failed log, GitHub's "<job> <step> <time> " prefixes stripped, fetched once into <dir>/run-<id>.log; prints its path.
citadel_ci_log() {
  local slug=$1 id=$2 dir=$3 f=$3/run-$2.log
  if [ ! -e "$f" ]; then
    citadel_hub gh run view "$id" --repo "$slug" --log-failed 2>/dev/null |
      sed -E $'s/^[^\t]*\t[^\t]*\t(\xEF\xBB\xBF)?[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ?//' >"$f.$$" 2>/dev/null || true
    mv -f "$f.$$" "$f"
  fi
  echo "$f"
}
# Ports ci_failed's output for the core's $cilog: a header naming the run, the `land: flake:` lines src/flakes.ts counts (first, so they win), run-tests.sh's and the burn-in's lines, node's failing tests, the last 40 lines.
citadel_ci_digest() {
  local log=$1 id=$2 url=$3 kind=$4 f load
  echo "citadel-ci: run $id $url $kind"
  [ "$kind" != suite ] || while read -r f load; do echo "land: flake: $f · in CI"; done < <(sed -n 's/.*run-tests: \(.*\): failed in the full run, passed alone.*load \([0-9.]*\)).*/\1 \2/p' "$log" | sort -u)
  { grep -E 'run-tests: |burn-in: |The tests left [0-9]+ process|Interrupted while running:|exit code 137\.|^✖ failing tests:' "$log" || true; } | head -n 200
  { grep -A1 -E '^test at [^ ]+:[0-9]+:[0-9]+' "$log" || true; } | grep -v '^--$' | head -n 200
  echo "--- the failed log's last 40 lines:"
  tail -n 40 "$log"
}

# --- CI_STATUS ------------------------------------------------------------------------------------------------------
# Ports ci_run, ci_gate's verdict, ci_failed, cut_off's and known_flakes' parts of gate(): exit 0 green, 1 red, 2 running, 3 not started, 4 no verdict, 5 no answer (the core's codes).
citadel_ci_status() {
  local sha=$1 dir slug br run id status result url step log rc n files known why_f
  [ "${LAND_CI:-1}" != 0 ] || { echo "LAND_CI=0 was set"; return 5; }
  dir=$(citadel_ci_dir) || { echo "no git dir to keep CI's state in"; return 5; }
  why_f=$dir/why-$sha
  slug=$(citadel_slug) || { echo "this repo has no GitHub origin remote" | tee "$why_f"; return 5; }
  br=$(git branch --show-current 2>/dev/null) || br=''
  run=$(citadel_hub gh api "repos/$slug/actions/runs?head_sha=$sha&per_page=20" --jq "[.workflow_runs[] | select(.path | startswith(\"$CITADEL_CI_WORKFLOW\"))][0] // empty | [.id, .status, .conclusion // \"-\", .html_url] | @tsv" 2>"$dir/err.$$") || {
    echo "GitHub didn't answer ($(head -c 300 "$dir/err.$$" | tr '\n' ' '))" | tee "$why_f"; rm -f "$dir/err.$$"; return 5; }
  rm -f "$dir/err.$$"
  [ -z "$run" ] || [[ $run =~ ^[0-9]+$'\t' ]] || { echo "GitHub sent something that isn't a run: $(head -c 100 <<<"$run")" | tee "$why_f"; return 5; }
  IFS=$'\t' read -r id status result url <<<"$run" || true
  # The burn-in's base (#1443), once per commit while its run hasn't ended: the core pushes land/<branch> only.
  if [ "${status:-}" != completed ] && [ -n "$br" ] && [ ! -e "$dir/base-$sha" ]; then
    n=$(git merge-base refs/heads/main "$sha" 2>/dev/null) && citadel_hub git push -q --no-verify origin "+$n:refs/heads/land-base/$br" 2>/dev/null && : >"$dir/base-$sha" || true
  fi
  case ${status:-none} in
    none) echo "no run of $CITADEL_CI_WORKFLOW on ${sha:0:12} yet"; return 3 ;;
    in_progress) echo "citadel-ci: running ($url)"; return 2 ;;
    completed) ;;
    *)
      n=$(citadel_online "$slug" "$dir") || { echo "GitHub didn't say which runners are online" | tee "$why_f"; return 3; }
      if [ "$n" -gt 0 ]; then echo "citadel-ci: queued, a $CITADEL_CI_LABEL runner is online (busy with another run, most likely) ($url)"; return 2; fi
      echo "no runner started the job, and no $CITADEL_CI_LABEL runner is online (they run only while Cara is logged on to her desktop)" | tee "$why_f"
      return 3 ;;
  esac
  case $result in
    success) citadel_ci_rerun_said "$dir" "$sha" "$id" green; echo "CI passed on ${sha:0:12} ($url)"; return 0 ;;
    failure | timed_out) ;;
    *) echo "the CI run ended as $result, not as a verdict on the tests ($url)" | tee "$why_f"; return 4 ;;
  esac
  step=''
  [ "$result" != failure ] || step=$(citadel_hub gh api "repos/$slug/actions/runs/$id/jobs" --jq '[.jobs[].steps[] | select(.conclusion == "failure") | .name][0] // empty' 2>/dev/null) || step=''
  if [ "$step" = "$CITADEL_CI_CLOCK_STEP" ]; then
    echo "runner clock: the CI runner's clock stayed skewed for 2 min, so no test ran ($url); a systemd-timesyncd in a WSL distro on Cara's desktop must be masked (tools/ci-runner/README.md)" | tee "$why_f"
    printf '%s %s\n' "$(date +%s)" "$(cat "$why_f")" >"${dir%/land-ci}/ci-down" 2>/dev/null || true # ci_down: a skewed clock lasts hours (#900)
    return 4
  fi
  if [ -n "$step" ] && [ "$step" != "$CITADEL_CI_STEP" ] && [ "$step" != "$CITADEL_CI_BURN_STEP" ]; then
    echo "the CI run failed in its setup step \"$step\", before any test ran ($url): the runner needs fixing" | tee "$why_f"
    return 4
  fi
  log=$(citadel_ci_log "$slug" "$id" "$dir")
  if [ "$step" = "$CITADEL_CI_BURN_STEP" ]; then # the ship's own red (#1443): never a flake, a cut-off or a known flake
    citadel_ci_digest "$log" "$id" "$url" burn-in
    echo "land: a new or changed test failed its burn-in in CI ($url): $(citadel_ci_burn_lines <"$log"), so it never reached the full suite. A file that fails when run as copies at once is racy (its output is above): fix the race (a shared path, a fixed port, a timing assumption), not the wait. This is the ship's own red, never a known flake"
    ! mkdir "$dir/said-$id" 2>/dev/null || citadel_retro_log "burn-in red · $br · $(citadel_ci_burn_lines <"$log") · $url"
    citadel_ci_rerun_said "$dir" "$sha" "$id" red
    return 1
  fi
  if citadel_cut_off <"$log"; then # no verdict on the commit (#1377): the core runs it again once on 4; cut off twice is no answer
    if read -r n files 2>/dev/null <"$dir/cut-$sha" && [ "$n" != "$id" ]; then
      echo "CI was cut off twice before any test failed ($files, $url)" | tee "$why_f"
      citadel_ci_rerun_said "$dir" "$sha" "$id" "no answer"
    elif read -r n files 2>/dev/null <"$dir/flake-$sha" && [ "$n" != "$id" ]; then
      echo "CI's one fresh run after a red of flakes only ($files) was cut off before any test failed ($url)" | tee "$why_f"
      citadel_ci_rerun_said "$dir" "$sha" "$id" "no answer"
    else
      printf '%s %s\n' "$id" "$url" >"$dir/cut-$sha"
      echo "land: the CI run on ${sha:0:12} was cut off before any test failed ($url), so it says nothing about this commit: running CI once more" | tee "$why_f"
    fi
    return 4
  fi
  # run-tests.sh's flake labels into the retro log, once per run: they can't reach it from the desktop.
  if mkdir "$dir/said-$id" 2>/dev/null; then
    while read -r n files; do citadel_retro_log "flake · $n · load $files · $br · in CI"; done < <(sed -n 's/.*run-tests: \(.*\): failed in the full run, passed alone.*load \([0-9.]*\)).*/\1 \2/p' "$log" | sort -u)
  fi
  rc=1
  files=$(citadel_flake_only <"$log") || files=''
  # A red of known flakes only (#1419) is a green, with no fresh run. Said once per run; the core shows CI_STATUS's lines only on red, so <dir>/known-<commit> keeps it for the shipped line.
  if [ -n "${files:-}" ] && known=$(citadel_ci_known "$files" "$sha" "$br" "$log" 2>"$dir/known-why.$$"); then
    rm -f "$dir/known-why.$$"
    echo "land: only known flakes failed in CI ($url): $known, so this goes on as green, with no fresh run"
    if mkdir "$dir/said-$id-known" 2>/dev/null; then citadel_retro_log "known flake · $br · $known · $url"; echo "$known" >"$dir/known-$sha"; fi
    rc=0
  fi
  citadel_ci_digest "$log" "$id" "$url" suite
  [ ! -s "$dir/known-why.$$" ] || cat "$dir/known-why.$$"
  rm -f "$dir/known-why.$$"
  if [ "$rc" = 0 ]; then citadel_ci_rerun_said "$dir" "$sha" "$id" green; else citadel_ci_rerun_said "$dir" "$sha" "$id" red; fi
  return "$rc"
}

# --- Hooks ----------------------------------------------------------------------------------------------------------
# Ports ci_gate's limits past CI_LIMIT: a queued job behind a busy runner (CI_START_ONLINE), the queue time (Citadel's limit counted from taken), ci_burned (#1443), ci_rerunning (#1374). One key per call.
land_ci_more() {
  local sha=$1 keys=" ${2:-} " dir slug run id status created url now c n s jobs started st a b burned=0
  dir=$(citadel_ci_dir) || return 0
  slug=$(citadel_slug) || return 0
  run=$(citadel_hub gh api "repos/$slug/actions/runs?head_sha=$sha&per_page=20" --jq "[.workflow_runs[] | select(.path | startswith(\"$CITADEL_CI_WORKFLOW\"))][0] // empty | [.id, .status, .created_at, .html_url] | @tsv" 2>/dev/null) || return 0
  IFS=$'\t' read -r id status created url <<<"$run" || true
  [ -n "${id:-}" ] || return 0
  now=$(date +%s)
  c=$(date -d "$created" +%s 2>/dev/null) || return 0
  case $status in
    queued | waiting | pending | requested)
      [[ $keys != *" queued "* ]] || return 0
      n=$(citadel_online "$slug" "$dir") || return 0
      s=$((CITADEL_CI_START_ONLINE - (now - c)))
      [ "$n" -gt 0 ] && [ "$s" -gt 0 ] || return 0
      echo "$s queued a $CITADEL_CI_LABEL runner is online but hasn't started the job (busy with another run, most likely), so this waits for it: up to $((CITADEL_CI_START_ONLINE / 60)) min, $(((now - c) / 60)) min so far ($url)"
      return 0 ;;
    completed | in_progress) ;;
    *) return 0 ;;
  esac
  jobs=$(citadel_hub gh api "repos/$slug/actions/runs/$id/jobs" --jq "(.jobs[0].started_at // \"-\"), (.jobs[].steps[] | select(.name == \"$CITADEL_CI_BURN_STEP\" or .name == \"$CITADEL_CI_STEP\" or .name == \"$CITADEL_CI_RERUN_STEP\") | [.name, .status, .conclusion // \"-\", .started_at // \"-\", .completed_at // \"-\"] | join(\"|\"))" 2>/dev/null) || return 0
  started=$(head -n 1 <<<"$jobs")
  if [[ $keys != *" taken "* ]] && started=$(date -d "$started" +%s 2>/dev/null); then
    s=$((started - c - ${ci_more:-0}))
    if [ "$s" -gt 0 ]; then echo "$s taken a runner took the job $((started - c))s after the push, and CI's ${LAND_CI_TIMEOUT}s count from then ($url)"; return 0; fi
  fi
  if [[ $keys != *" burn-in "* ]]; then
    IFS='|' read -r _ st _ a b < <(grep -F "$CITADEL_CI_BURN_STEP|" <<<"$jobs" || true) || true
    case ${st:-} in
      in_progress) burned=$CITADEL_CI_BURN ;;
      completed) a=$(date -d "$a" +%s 2>/dev/null) && b=$(date -d "$b" +%s 2>/dev/null) && burned=$((b - a)) || burned=0 ;;
    esac
    [ "$burned" -le "$CITADEL_CI_BURN" ] || burned=$CITADEL_CI_BURN
    if [ "$burned" -gt 0 ]; then echo "$burned burn-in CI's burn-in of new and changed tests took ${burned}s before its full suite, so this waits that much more ($url)"; return 0; fi
  fi
  if [[ $keys != *" rerun "* ]] && grep -q "^$CITADEL_CI_STEP|completed|failure|" <<<"$jobs" && grep -q "^$CITADEL_CI_RERUN_STEP|" <<<"$jobs"; then
    echo "$CITADEL_CI_RERUN rerun CI's full run ended red and it is rerunning the failed files alone to tell flakes from real failures, so this waits up to $((CITADEL_CI_RERUN / 60)) min $((CITADEL_CI_RERUN % 60)) s more for them ($url)"
  fi
}

# Ports gate()'s one fresh run for a red of flakes only (#769) and flake_keep (#1419 part 2) as the core's FLAKE_RUNS: only CI's reds (citadel_ci_status's header), never a burn-in, a cut-off or a leak-guard red past the first.
land_flaky() {
  local head id url kind dir log files f near
  IFS= read -r head || return 1
  [[ $head =~ ^citadel-ci:\ run\ ([0-9]+)\ ([^ ]+)\ ([a-z-]+)$ ]] || return 1 # a check's red, or anything else: red is red
  id=${BASH_REMATCH[1]} url=${BASH_REMATCH[2]} kind=${BASH_REMATCH[3]}
  [ "$kind" = suite ] || return 1
  dir=$(citadel_ci_dir) || return 1
  log=$dir/run-$id.log
  [ -s "$log" ] || return 1
  files=$(citadel_flake_only <"$log") || return 1
  if [ "${flaked:-0}" -ge 1 ]; then # the fresh run was red on flakes only too: keep its place only if nothing points at the change
    ! grep -qE 'The tests left [0-9]+ process\(es\) running' "$log" || return 1
    for f in ${files//, / }; do
      if near=$(citadel_ci_near "$f" "$tip"); then echo "land: $f failed again, and this ship changed $near, so it is not kept in line" >&2; return 1; fi
    done
    echo "land: refused on flakes only ($files), not your change: keeping its place in line and running CI again in place ($flaked of $CITADEL_FLAKE_KEEP_MAX)" >&2
    citadel_retro_log "flake keep · $branch · $files · $flaked of $CITADEL_FLAKE_KEEP_MAX"
  fi
  printf '%s %s\n' "$id" "$files" >"$dir/flake-$tip"
  tr -d ' ' <<<"$files" | tr ',' '\n'
}

# Ports the CI FALLBACK section (land.sh 2096-2172) with busy_gate/busy_wait (#1254, #1361) and retry_in_place (#1360): 0 green, 1 red, 75 no verdict (asks again once, then parks).
land_fallback() {
  local sha=$1 dir why t at w out rc spent=0 last told='' log trc kept flakes known half left v
  t=$(dirname "$citadel_self")
  dir=$(citadel_ci_dir) || dir=''
  why=$(head -n 1 "$dir/why-$sha" 2>/dev/null) || why=''
  [ -n "$why" ] || why="CI gave no answer about ${sha:0:12}"
  [ -z "$dir" ] || citadel_ci_rerun_said "$dir" "$sha" - "no answer"
  # Citadel leaves a ci-down note only for no runner, GitHub errors and a skewed clock: a late start or a slow run says nothing about the next ship's.
  if read -r at w 2>/dev/null <"$state/ci-down" && [[ $w != 'runner clock:'* ]] && v=$(citadel_online "$(citadel_slug)" "$dir") && [ "$v" -gt 0 ]; then rm -f "$state/ci-down"; fi
  last=$SECONDS
  while ! citadel_quiet; do
    rc=0
    out=$(bash -c "$CI_STATUS \"\$@\"" _ "$sha" 2>&1) || rc=$?
    case $rc in
      0) grep '^land: ' <<<"$out" >&2 || true; say "CI passed on ${sha:0:12} after all, while perigee was busy"; return 0 ;;
      1)
        printf '%s\n' "$out" >&2
        if [ "${LAND_PARK_RETRIED:-0}" -lt "$PARK_RETRIES" ] && v=$(land_flaky <<<"$out"); then
          say "refused by the pipeline (CI's red was flakes only: ${v//$'\n'/, }), not your change: keeping its place in line and asking CI again in place, once"
          return 75
        fi
        return 1 ;;
      2) grep -q '^citadel-ci: running' <<<"$out" && last=$SECONDS || true ;; # a runner has the job: not perigee's busy time (#1361)
    esac
    spent=$((spent + SECONDS - last)) last=$SECONDS
    if [ "$spent" -ge "$CITADEL_QUIET_LIMIT" ]; then
      if [ "${LAND_PARK_RETRIED:-0}" -lt "$PARK_RETRIES" ]; then
        say "refused by the pipeline (CI and perigee both busy for $((spent / 60)) min), not your change: keeping its place in line and asking CI again in place, once"
      else
        say "CI and perigee both busy, try again: CI: $why; perigee for $((spent / 60)) min: $citadel_busy. So main is untouched"
      fi
      return 75
    fi
    if [ -z "$told" ] || [ $((SECONDS - told)) -ge 300 ]; then # every 5 min, a new phase too: the line behind calls an unchanged one stuck after 15 min
      say "waiting for CI or a quiet perigee: CI: $why, but perigee is busy ($citadel_busy), so this keeps asking CI and runs the suite here only once perigee is quiet (refused after $((CITADEL_QUIET_LIMIT / 60)) min, $((spent / 60)) min so far)"
      queue_phase "waiting for CI or a quiet perigee, $((spent / 60)) min so far"
      told=$SECONDS
    fi
    sleep "$CITADEL_QUIET_POLL"
  done
  say "=========================================================================="
  say "CI FALLBACK: $why. Running the full suite on perigee instead."
  say "BURN-IN SKIPPED: new and changed tests were not run as 10 copies at once, since that runs only on CI, never on perigee (#1443)"
  say "=========================================================================="
  citadel_retro_log "ci fallback · $branch · $why"
  say "running the tests"
  queue_phase "running the tests since $(date +%H:%M)"
  log="$state/land-test.log"
  trc=0
  # citadel-heavy's slot (nice 19, idle IO), half run-tests.sh's concurrency, CPU weight 20: it yields to turns (#1254).
  half=$(( ( ($(nproc 2>/dev/null || echo 2) + 1) / 2 + 1) / 2 ))
  left=$((CITADEL_QUIET_LIMIT - spent))
  CITADEL_HEAVY_WHAT="land.sh's suite for $branch (CI fallback)" CITADEL_HEAVY_MAX_WAIT=${LAND_HEAVY_MAX_WAIT:-$((left > 60 ? left : 60))} \
    CITADEL_TEST_CONCURRENCY=${CITADEL_TEST_CONCURRENCY:-$half} DEPLOY_TEST_CPU_WEIGHT=${DEPLOY_TEST_CPU_WEIGHT-20} \
    "$t/citadel-heavy" --here --heavy "$t/run-tests.sh" "$log" || trc=$?
  if [ "$trc" = 75 ]; then
    if [ "${LAND_PARK_RETRIED:-0}" -lt "$PARK_RETRIES" ]; then
      say "refused by the pipeline (perigee's heavy slot was taken), not your change: keeping its place in line and asking CI again in place, once"
    else
      say "CI and perigee both busy, try again: CI: $why; perigee's heavy slot was taken just before the suite could start, and stayed taken (citadel-heavy's lines above), so no test ran. So main is untouched"
    fi
    return 75
  fi
  [ "$trc" != 3 ] || { say "no test ran: the test run could not write its files (the run-tests line above says which), so main is untouched"; return 1; }
  [ "$trc" != 0 ] || { say "the full suite passed on perigee"; return 0; }
  tail -n 40 "$log" >&2
  find "$state" -maxdepth 1 -name 'land-red-*.log' -mtime +14 -delete 2>/dev/null || true
  kept="$state/land-red-${branch//\//-}.log"
  cp "$log" "$kept" 2>/dev/null || kept=$log
  if flakes=$(citadel_flake_only <"$kept") && known=$(citadel_ci_known "$flakes" "$sha" "$branch" "$kept"); then
    say "only known flakes failed on perigee: $known, so this goes on as green"
    citadel_retro_log "known flake · $branch · $known · on perigee"
    [ -z "$dir" ] || echo "$known" >"$dir/known-$sha"
    return 0
  fi
  if [ "${LAND_PARK_RETRIED:-0}" -lt "$PARK_RETRIES" ]; then
    if [ -n "${flakes:-}" ]; then
      say "refused by the pipeline (failed in the full run but passed alone on perigee: $flakes), not your change: keeping its place in line and asking CI again in place, once"
      return 75
    fi
    if citadel_cut_off <"$kept"; then
      say "refused by the pipeline (the suite on perigee was killed from outside before any test failed), not your change: keeping its place in line and asking CI again in place, once"
      return 75
    fi
  elif [ -z "${flakes:-}" ] && citadel_cut_off <"$kept"; then
    say "the suite on perigee was killed from outside before any test failed (full log: $kept): that says nothing about $branch, but it is no answer either, so main is untouched. Run this again"
    return 75
  fi
  say "tests failed on the rebased branch (full log: $kept), so main is untouched"
  return 1
}

# frag-suspect.sh: Citadel's land.local.sh, the red-batch side (#1323 spec §5b). tools/land.sh's train_main_red becomes
# the core's land_main_red, and its train_suspects the core's land_suspect (Cara, 2026-11-22: "Port it as a hook").
# Settings and functions only: the core sources this under set -euo pipefail before state, MAIN or branch are set.
# Both hooks read CI's failed log from the core's $cilog, so Citadel's CI_STATUS (not this fragment) must print
# run-tests.sh's lines and the burn-in's lines there, with no gh log prefixes, and the run's URL.

# Ports tools/land.sh's LAND_RULES (#1484, ADR 0020): the blame rules on trial; test/land-verdicts.test.ts reads this line.
: "${LAND_RULES:=hub=shadow walk=shadow}"

# Ports retro_log: the day's retro-log file, header and all, which src/flake-fixes.ts and the retros read.

# Ports ci_failed's $failed: CI's failed log, as CI_STATUS left it in the core's $cilog.
citadel_failed() { cat "$cilog" 2>/dev/null || true; }
# Ports the run's URL in the say and retro lines ($ci_url): the last Actions run link in $failed, else "-".
citadel_url() { { grep -oE 'https://[^ ]+/actions/runs/[0-9]+' <<<"$failed" || echo -; } | tail -n 1; }
# Ports burn_lines (#1443): the burn-in's "<file>: failed in <n> of <N> copies at once" lines; any means $burn_red.
citadel_burn_lines() { sed -n 's/.*burn-in: \([^ ]*: failed in [0-9]* of [0-9]* copies at once\).*/\1/p' <<<"$failed" | sort -u; }
# Ports train_labels: each failed file with run-tests.sh's label for its rerun alone, "<label> <file>"; fails unless every file is labelled.
citadel_labels() {
  local at n out
  at=$(grep -n 'run-tests: [0-9][0-9]* test file(s) failed; rerunning each alone' <<<"$failed" | tail -n 1 | cut -d: -f1)
  [[ $at =~ ^[0-9]+$ ]] || return 1
  n=$(sed -n "${at}s/.*run-tests: \\([0-9][0-9]*\\) test file(s) failed.*/\\1/p" <<<"$failed")
  out=$(tail -n "+$at" <<<"$failed" | sed -n 's/.*run-tests: \([^ ]*\): \(failed in the full run, passed alone\|failed again alone\|hung when rerun alone\|rerun alone stopped\|not rerun\|killed (exit [0-9]*) when rerun alone\).*/\2 \1/p' | sort -u -k2)
  [[ $n =~ ^[1-9][0-9]*$ ]] && [ -n "$out" ] && [ "$(wc -l <<<"$out")" = "$n" ] || return 1
  echo "$out"
}
# Ports train_real: the real failures (failed again alone, hung, rerun stopped), or each burn-in red file; fails when none.
citadel_real() {
  local out
  [ -z "$burn_red" ] || { citadel_burn_lines | sed 's/: failed in .*//' | grep .; return; }
  out=$(citadel_labels) || return 1
  out=$(sed -n 's/^\(failed again alone\|hung when rerun alone\|rerun alone stopped\) //p' <<<"$out")
  [ -n "$out" ] && echo "$out"
}
# Ports train_imports: <file>'s relative imports as repo paths, as $tip (the red commit) has it.
citadel_imports() {
  local p
  git show "$tip:$1" 2>/dev/null | grep -oE "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"]\.\.?/[^'\"]+['\"]" |
    sed -E "s/.*['\"](\.[^'\"]+)['\"]$/\1/" | while read -r p; do realpath -ms --relative-to="$PWD" "$PWD/$(dirname "$1")/$p"; done | sort -u
}
# Ports rule_on (#1484): whether <rule> is live in <rules>.
citadel_rule_on() { [[ " $2 " == *" $1=live "* ]]; }
# Ports train_suspects_of: the members (1 on, from the one on main up) <test file>'s failure is pinned on; logs shadow rules when rules_say is set.
citadel_suspects_of() {
  local live alt r
  live=$(set -e; citadel_guess "$1" "$LAND_RULES")
  for r in $LAND_RULES; do
    [ -n "${rules_say:-}" ] && [ "${r#*=}" = shadow ] || continue
    alt=$(set -e; citadel_guess "$1" "$LAND_RULES ${r%=*}=live")
    [ "$alt" = "$live" ] || citadel_rule_would "${r%=*}" "$1" "$live" "$alt"
  done
  [ -z "$live" ] || echo "$live"
}
# Ports rule_would (#1484): the retro log's "would refuse"/"would spare" line for a shadow rule that would decide otherwise.
citadel_rule_would() {
  local m now=" $(echo $3) " then=" $(echo $4) " add='' drop='' instead='no suspects, so the bisect'
  [ "$(wc -w <<<"$3")" = 1 ] || [ "$(wc -w <<<"$4")" = 1 ] || return 0
  for m in $4; do [[ $now == *" $m "* ]] || add+="${add:+, }$(citadel_member_label "$m")"; done
  for m in $3; do [[ $then == *" $m "* ]] || drop+="${drop:+, }$(citadel_member_label "$m")"; done
  [ -z "$4" ] || instead="suspects $(for m in $4; do citadel_member_label "$m"; done | paste -sd, | sed 's/,/, /g')"
  [ -z "$add" ] || citadel_retro_log "would refuse $add ($1) · $2 · $branch · $ci_url"
  [ -z "$drop" ] || citadel_retro_log "would spare $drop ($1): $instead · $2 · $branch · $ci_url"
  say "shadow rule $1, not deciding yet: on $2 it would ${add:+suspect $add}${add:+${drop:+ and }}${drop:+spare $drop}"
}
# Ports train_guess (with #1451's named guard file and #1538's pinned code): members whose change touched the test, a file it names or imports.
citadel_guess() {
  local f=$1 text reach lvl m c hits named p
  text=$(git show "$tip:$f" 2>/dev/null) || text=''
  named=$({ grep -oE '[A-Za-z0-9_./-]+\.test\.ts:[0-9]+' <<<"$failed" || true; } | sed 's/:[0-9]*$//' | sort -u | while read -r c; do
    [[ $c == */* ]] || c=test/$c
    [ "$c" = "$f" ] || echo "$c"
  done)
  [ "$f" != test/judges.test.ts ] || named+=$'\n'$({ grep -oE 'pinned code: [^)]*' <<<"$failed" || true; } | sed 's/^pinned code: //' | tr ' ' '\n' | grep . | sort -u || true)
  named=$(grep . <<<"$named" || true)
  if [ -n "$named" ]; then
    hits=$(for ((m = 1; m < ${#chg[@]}; m++)); do
      while read -r c; do
        [ -n "$c" ] || continue
        if grep -qxF -- "$c" <<<"$named"; then echo "$m"; break; fi
      done <<<"${chg[$m]}"
    done)
    [ -z "$hits" ] || { echo "$hits"; return 0; }
  fi
  reach=$f
  for lvl in 0 1 2; do
    [ "$lvl" = 0 ] || reach=$(while read -r c; do [ -z "$c" ] || citadel_imports "$c"; done <<<"$reach" | sort -u) ||
      citadel_rule_on walk "$2" || return 0
    if [ "$lvl" = 1 ] && citadel_rule_on hub "$2"; then
      for p in $reach; do ! citadel_is_hub "$p" || return 0; done
    fi
    hits=$(for ((m = 1; m < ${#chg[@]}; m++)); do
      while read -r c; do
        [ -n "$c" ] || continue
        if grep -qxF -- "$c" <<<"$reach" || { [ "$lvl" = 1 ] && grep -qF -- "$c" <<<"$text"; }; then echo "$m"; break; fi
      done <<<"${chg[$m]}"
    done)
    [ -z "$hits" ] || { echo "$hits"; return 0; }
  done
}
# Ports train_hub (#1484's hub rule): whether <repo file> outside test/ is named by a tenth or more of the test files at $tip.
citadel_is_hub() {
  local n all
  [[ $1 != test/* ]] || return 1
  n=$(git grep -lF -e "/${1##*/}'" -e "/${1##*/}\"" "$tip" -- 'test/*.test.ts' 2>/dev/null | wc -l)
  all=$(git ls-tree -r --name-only "$tip" -- test/ | grep -c '\.test\.ts$') || return 1
  [ $((n * 10)) -ge "$all" ]
}
# Ports train_chg: sets the caller's chg from its mem (main, then each member's commit): chg[m] is member m's own changed files.
citadel_chg() {
  local m
  chg=('')
  for ((m = 1; m < ${#mem[@]}; m++)); do chg[m]=$(git diff --no-renames --name-only "${mem[m - 1]}" "${mem[m]}"); done
}
# Ports train_label: member <m>'s #N from the core's B_LABEL (its branch), else its short commit.
citadel_member_label() {
  local t='' i shas=(${B_SHA[@]+"${B_SHA[@]}"}) labels=(${B_LABEL[@]+"${B_LABEL[@]}"})
  for ((i = 1; i < ${#shas[@]}; i++)); do [ "${shas[i]}" != "${mem[$1]}" ] || t=${labels[i]:-}; done
  [ -n "$t" ] || t=$(git rev-parse --short "${mem[$1]}")
  [[ ! $t =~ ^ticket/([0-9]+)- ]] || t="#${BASH_REMATCH[1]}"
  echo "$t"
}
# Ports known_flakes (#1419, #1487): whether every passed-alone file <files, comma-separated> is a known flake no member changed; sets known_why.
citadel_known_flakes() {
  local files=() f m out hits=() ok=1 who labels=(${B_LABEL[@]+"${B_LABEL[@]}"}) brs
  brs="$branch ${labels[*]:1}"
  known_why=''
  [ -f "$here/tools/known-flakes.ts" ] || return 1
  ! grep -qE 'The tests left [0-9]+ process\(es\) running' <<<"$failed" || { say "the run also left processes running (the leak guard), so no flake is excused"; return 1; }
  IFS=, read -ra files <<<"${1//, /,}"
  out=$(LAND_FLAKE_DB=${DEPLOY_DB:-$HOME/.local/share/claude-coordinator/coordinator.db} \
    "$here/tools/citadel-node" --no-warnings "$here/tools/known-flakes.ts" "$brs" "${files[@]}" 2>/dev/null) || ok=''
  [ -n "$out" ] || { say "couldn't tell whether $1 are known flakes (tools/known-flakes.ts gave no answer)"; return 1; }
  [ -n "$ok" ] || { while read -r f; do
    if [[ $f == 'broken test, not a flake: '* ]]; then
      say "$f"
      m=${f#broken test, not a flake: }
      citadel_retro_log "broken test · ${m%% *} · ${m#* } · $branch"
    elif [[ $f == *'(not seen on another branch'* ]]; then say "$f is no known flake"; fi
  done <<<"$out"; return 1; }
  for f in "${files[@]}"; do
    mapfile -t hits < <(citadel_suspects_of "$f")
    [ ${#hits[@]} -gt 0 ] || continue
    who=''
    for m in "${hits[@]}"; do who+="${who:+ and }$(citadel_member_label "$m")"; done
    say "$f is a known flake, but $who changed it or what it imports, so it isn't excused"
    ok=''
  done
  [ -n "$ok" ] || return 1
  known_why=$(sed ':a;N;$!ba;s/\n/, /g' <<<"$out")
}
# Ports train_alone: 0 when <file> passes run alone at <commit> in scratch worktree <wt> (or the commit hasn't got it), 1 when it fails; else no answer.
citadel_alone() {
  git -C "$1" checkout -q --detach "$2" 2>/dev/null || return 2
  [ -e "$1/$3" ] || return 0
  (cd "$1" && timeout -k 10 "${LAND_PIN_LIMIT:-120}" nice -n 19 "$here/tools/citadel-node" --test --test-force-exit --test-timeout=60000 "$3") >>"$state/train-pin.log" 2>&1 9>&- 7>&- 6>&- </dev/null
}
# Ports train_pin: the member that turns <file> red run alone here (red at the top, green on main, bisected, rechecked both sides); nothing if unsure.
citadel_pin() {
  local f=$1 lo=0 hi=$((${#mem[@]} - 1)) mid wt='' r=0
  wt=$(mktemp -d "${TMPDIR:-/tmp}/land-pin.XXXXXX") && git worktree add -q --detach "$wt" "$tip" 2>/dev/null || { [ -z "$wt" ] || rm -rf "${wt:?}"; return 0; }
  citadel_alone "$wt" "$tip" "$f" || r=$?
  if [ "$r" = 1 ]; then
    r=0
    citadel_alone "$wt" "${mem[0]}" "$f" || r=$?
    while [ "$r" = 0 ] && [ $((hi - lo)) -gt 1 ]; do
      mid=$(((lo + hi) / 2))
      citadel_alone "$wt" "${mem[mid]}" "$f" || r=$?
      if [ "$r" = 0 ]; then lo=$mid; elif [ "$r" = 1 ]; then hi=$mid r=0; fi
    done
    if [ "$r" = 0 ]; then
      citadel_alone "$wt" "${mem[hi]}" "$f" || r=$?
      if [ "$r" = 1 ]; then r=0 && citadel_alone "$wt" "${mem[hi - 1]}" "$f" && echo "$hi"; fi
    fi
  fi
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
}
# Ports train_main_red's run on main: whether <file> fails alone on main <m> (1), passes or is absent (0), or no answer (other), kept a day per main commit so the bisect's runs don't repeat it.
citadel_main_alone() {
  local m=$1 f=$2 d=$state/citadel-main-red key r=0
  key=$(printf '%s\n' "$m" "$f" | sha1sum) && key=${key%% *}
  if [ -s "$d/$key" ]; then return "$(cat "$d/$key")"; fi
  [ -n "$main_wt" ] || { main_wt=$(mktemp -d "${TMPDIR:-/tmp}/land-main.XXXXXX") && git worktree add -q --detach "$main_wt" "$m" 2>/dev/null; } || { [ -z "$main_wt" ] || rm -rf "${main_wt:?}"; main_wt=''; return 2; }
  [ "$((main_runs++))" -lt 6 ] || return 2 # shortcut: at most 6 files, so a badly red main costs minutes, not an hour
  [ -e "$main_wt/$f" ] || return 0
  (cd "$main_wt" && timeout -k 10 "${LAND_PIN_LIMIT:-120}" nice -n 19 "$here/tools/citadel-node" --test --test-force-exit --test-timeout=60000 "$f") >"$state/main-red.one" 2>&1 9>&- 7>&- 6>&- </dev/null || r=$?
  cat "$state/main-red.one" >>"$state/main-red.log"
  [ "$r" != 1 ] || ! grep -q 'test timed out after' "$state/main-red.one" || r=timeout
  case $r in 0 | 1) mkdir -p "$d" && find "$d" -type f -mmin +1440 -delete 2>/dev/null; echo "$r" >"$d/$key.$$" && mv -f "$d/$key.$$" "$d/$key" ;; *) return 2 ;; esac
  return "$r"
}
# <id> <file>: whether failure id <id> ("<path>[::<test>]", the path as CI's runner had it) is in repo file <file>.
citadel_id_in() { local p=${1%%::*}; [ "$p" = "$2" ] || [[ $p == */"$2" ]]; }

# Ports train_main_red (#1430, #1478) as the core's hook: the ids it waives are the real failures that fail alone on <main>
# too and that no change up to <commit> touched; with nothing else red but known flakes, every id, and it ships through.
land_main_red() {
  local old=$1 tip=$2 ids failed burn_red='' ci_url id f r ok=1 flakes='' known_why='' rules_say='' main_wt='' main_runs=0
  local real=() reds=() other=() hits=() touched=() chg=() mem=("$1" "$2") out=() list
  ids=$(cat)
  failed=$(citadel_failed) ci_url=$(citadel_url)
  [ -z "$(citadel_burn_lines)" ] || return 0 # a burn-in red is the ship's own new or changed test (#1443)
  # The check's or the smoke's output arrives here too: CI's labels in $cilog speak only for ids CI's log has.
  grep -qvxF -f <(land_failures <<<"$failed" | sed "s|^$here/||" | sort -u) <<<"$ids" && return 0
  mapfile -t real < <(citadel_real) || true
  for f in "${real[@]}"; do git cat-file -e "$old:$f" 2>/dev/null && r=x; done
  [ "${r:-}" = x ] || return 0
  say "red on main?: running ${real[*]} alone on main's tip ($(git rev-parse --short "$old")) here before blaming a ship"
  : >"$state/main-red.log"
  for f in "${real[@]}"; do
    r=0 && citadel_main_alone "$old" "$f" || r=$?
    if [ "$r" = 1 ]; then reds+=("$f"); else other+=("$f"); fi
  done
  [ -z "$main_wt" ] || git worktree remove --force "$main_wt" >/dev/null 2>&1 || true
  [ ${#reds[@]} -gt 0 ] || return 0
  mapfile -t -O "${#other[@]}" other < <(citadel_labels | sed -n 's/^\(not rerun\|killed (exit [0-9]*) when rerun alone\) //p') || true
  citadel_chg
  for f in "${reds[@]}"; do
    mapfile -t hits < <(citadel_suspects_of "$f")
    if [ ${#hits[@]} -gt 0 ]; then touched+=("$f"); else out+=("$f"); fi
  done
  list=$(sed 's/ /, /g' <<<"${out[*]}")
  [ ${#touched[@]} = 0 ] || say "red on main too, but the change up to $(git rev-parse --short "$tip") touched ${touched[*]} or what it imports and it still fails, so its change doesn't make it pass and that red isn't waived"
  flakes=$(citadel_labels | sed -n 's/^failed in the full run, passed alone //p' | paste -sd, - | sed 's/,/, /g') || true
  if [ ${#other[@]} -gt 0 ] || [ ${#touched[@]} -gt 0 ] || [ ${#out[@]} = 0 ]; then ok=''
  elif grep -qE 'The tests left [0-9]+ process\(es\) running' <<<"$failed"; then ok='' other=('the leak guard (the tests left processes running)')
  elif [ -n "$flakes" ] && ! citadel_known_flakes "$flakes"; then ok='' other=("$flakes (passed alone, but no known flake)")
  fi
  [ ${#out[@]} -gt 0 ] || return 0
  while IFS= read -r id; do # shipping through: every id, CI's own "ci:" ones too; else only the untouched main reds'
    [ -n "$id" ] || continue
    if [ -n "$ok" ]; then echo "$id"; continue; fi
    for f in "${out[@]}"; do ! citadel_id_in "$id" "$f" || { echo "$id"; break; }; done
  done <<<"$ids"
  if [ -n "$ok" ]; then
    say "=========================================================================="
    say "SHIPPING THROUGH MAIN'S RED: $list fails run alone on main's tip $(git rev-parse --short "$old") here too, and it is the only real failure of the CI run on $(git rev-parse --short "$tip") ($ci_url): no ship on it changed $list or what it imports, and its other failed files, if any, are known flakes (#1419). So it is no worse than main and ships as green. Main still needs a fix for $list, which ships separately; until then a new break in $list goes unseen"
    say "=========================================================================="
    [ -z "$flakes" ] || say "shipped past known flakes $known_why"
    say "shipped through main's red on $list"
    citadel_retro_log "shipped through main's red · $branch · $list · $ci_url"
  else
    say "red on main too: $list fails run alone on main's tip $(git rev-parse --short "$old") here, so it is waived on every CI run of this line until main's fix ships${other[0]:+; its other failures (${other[*]}) are not, so they decide}. Main needs a fix for $list"
    citadel_retro_log "red on main too: not this ship's · $branch · $list · $ci_url${other[0]:+ · also red: ${other[*]}}"
  fi
}

# Ports train_suspects' guess (#1403, #1443, #1451, #1538) as the core's hook: the member whose commit turns a real failure
# red run alone here (the lowest such), else for a burn-in red the lowest member that changed a red file, else the one
# member the files name. Its answer only steers the core's bisect: refusing on the pin alone and holding a guess off the
# batch are not ported (notes-suspect.md: they need the core).
land_suspect() {
  local tip=${!#} failed burn_red='' ci_url f m pin='' pick='' line='' sure_line='' open='' rules_say=1
  local mem=("$@") real=() hits=() chg=()
  local -A sus=() sure=()
  cat >/dev/null # the ids: CI's labels in $cilog say which of their files really failed
  failed=$(citadel_failed) ci_url=$(citadel_url)
  [ -z "$(citadel_burn_lines)" ] || burn_red=1
  mapfile -t real < <(citadel_real) || true
  [ ${#real[@]} -gt 0 ] || { say "suspects: CI's log doesn't say which tests really failed, so the bisect halves"; return 0; }
  citadel_chg
  : >"$state/train-pin.log"
  for f in "${real[@]}"; do
    pin=''
    if [ -z "$burn_red" ]; then # a burn-in red names the file a member added or changed itself (#1443): no run alone
      say "suspects: running $f alone on the batch's commits here to find the member that turns it red"
      pin=$(citadel_pin "$f")
    fi
    if [ -n "$pin" ]; then
      hits=("$pin") sure[$pin]=1
    else
      mapfile -t hits < <(citadel_suspects_of "$f")
      [ -z "$burn_red" ] || for m in "${hits[@]}"; do sure[$m]=1; done
    fi
    [ ${#hits[@]} -gt 0 ] || { open+="${open:+, }$f"; continue; }
    for m in "${hits[@]}"; do sus[$m]+="${sus[$m]:+, }$f"; done
  done
  if [ ${#sure[@]} -gt 0 ]; then
    pick=$(printf '%s\n' "${!sure[@]}" | sort -n | head -n 1)
  elif [ -n "$open" ]; then
    say "suspects: no member touched $open or what it imports, so the bisect halves"; return 0
  elif [ ${#sus[@]} -gt 1 ]; then
    say "suspects: the files name more than one member ($(for m in $(printf '%s\n' "${!sus[@]}" | sort -n); do citadel_member_label "$m"; done | paste -sd, | sed 's/,/, /g')), so the bisect halves"; return 0
  else
    pick=$(printf '%s\n' "${!sus[@]}")
  fi
  for m in $(printf '%s\n' "${!sus[@]}" | sort -n); do
    line+="${line:+, }$(citadel_member_label "$m") (${sus[$m]})"
    [ -z "${sure[$m]:-}" ] || sure_line+="${sure_line:+, }$(citadel_member_label "$m")"
  done
  say "suspects: $line, from CI's red on $(git rev-parse --short "$tip") ($ci_url).${sure_line:+ Run alone here, the tests failed with $sure_line and passed just before it.} The likeliest is $(citadel_member_label "$pick"): the bisect runs CI just below it, then on it"
  citadel_retro_log "ship train suspects · $branch · $line${sure_line:+ · failed alone here: $sure_line} · $ci_url"
  echo "${mem[pick]}"
}
