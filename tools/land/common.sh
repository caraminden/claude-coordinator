# shellcheck shell=bash
# Common helpers: the retro log, phase times, and every gh call counted (#2099).
# Sourced by tools/land.sh up front: definitions only (#2099).

# A line in the scheme's retro log: day's land.md, best effort (failures swallowed).
retro_log() (
  set +e
  [ -n "${COORDINATOR_SHARED_DIR:-}" ] || exit 0
  dir=$COORDINATOR_SHARED_DIR/retro-log/$(date -u +%F)
  mkdir -p "$dir" || exit 0
  [ -e "$dir/land.md" ] || printf '%s\n\n' '# Retro log: land.sh' 'Written by tools/land.sh, tools/run-tests.sh and the queued restart in tools/deploy.sh (no session id, so one file per day). One line per rebase conflict, per landing that fell back from CI to the suite on perigee, per test file that failed in a land or deploy run and passed alone (flake), and per fresh CI run after a red of flakes only (flake rerun: green, red, no answer or not started), a `broken test` line per file tools/known-flakes.ts calls a broken test, not a flake (#1487), and per fresh CI run after one cut off before any test failed (cut-off rerun, the same results), and a `bisect run` line per CI run of a red train'"'"'s bisect that gave a verdict. A `smoke` line per landing the smoke check refused before the line (#1012: what failed, its seconds; no timing line for it). Phase times in whole seconds (#565), - for a phase never reached: a `timing` line per landing that got in line, landed or not (line: waiting for the deploy lock; rebase; ci-queue: until a runner took the job; ci-run; fallback: the wait for a CI that gave no answer + the suite on perigee; deploy: pull, boot check and tests if any, until the restart was queued or the front end reloaded; live: from then until the deploy saw it live, the restart'"'"'s settle check included), and a `restart` line per queued restart (idle-wait: for the turns it would cut off and the lock; backup: the database copy; healthy: restart to the first healthy answer; settle: the check after it; then restart or handover: how the new server took over, #1170; then the outcome, and held <n> s for a starved box when it waited for one, #1417).' >>"$dir/land.md"
  printf -- '- %sZ · %s\n' "$(date -u +%T)" "$1" >>"$dir/land.md"
) >/dev/null 2>&1 || true

# Phase times for the timing line (#565): "<name> <epoch seconds> [<phase a refusal from here on is at>]" lines in $times,
# a file of this process's own so the rebased copy keeps them; deploy.sh adds "queued" and "live".
land_mark() { { echo "$1 $(date +%s) ${2:-}" >>"$times"; } 2>/dev/null || true; }

# One line when the landing ends, however it ends (each EXIT trap calls it; only the first call finds $times). Best effort.
land_timing() (
  set +eu
  [ -e "$times" ] || exit 0
  declare -A t
  rc=$1 now=$(date +%s) phase='?'
  while read -r k v p; do
    [ -n "${t[$k]}" ] || t[$k]=$v
    [ -z "$p" ] || phase=$p
  done <"$times"
  span() { if [ -n "$1" ]; then echo $((${2:-$now} - $1)); else echo -; fi; } # <start> [<end>, else now]; - if it never started
  if [ -n "${t[fallback]}" ]; then
    ciq=- cir=- fb="$(span "${t[ci]}" "${t[gate]}")+$(span "${t[fallback]}" "${t[deploy]}")"
  else
    fb=- ciq=$(span "${t[ci]}" "${t[cirun]:-${t[gate]}}") cir=$(span "${t[cirun]}" "${t[gate]}")
  fi
  if [ -n "${t[merged]}" ]; then out=merged
  elif [ -n "${t[landed]}" ]; then out=landed; [ -n "${t[live]}" ] || out="landed, not live yet"
  elif [ "$rc" = 1 ]; then out="refused at $phase"
  else out="stopped at $phase"; [ "$rc" = 0 ] || out="$out (exit $rc)"; fi # a kill before the signal traps can end it with 0
  [ -z "${retried:-}" ] || [ ! -e "$times" ] || case $out in
    landed*) retro_log "retry in place · $branch · $retried · landed" ;;
    refused*) retro_log "retry in place · $branch · $retried · refused" ;;
    *) retro_log "retry in place · $branch · $retried · stopped" ;;
  esac
  if [ -n "${t[live]}" ]; then live=$((${t[live]} - ${t[queued]:-${t[live]}})); else live=-; fi
  if [ "$mode" = into ]; then # only its own test files: no CI, no deploy
    retro_log "timing · $label · line $(span "${t[start]}" "${t[lock]}") · rebase $(span "${t[lock]}" "${t[tests]}") · tests $(span "${t[tests]}" "${t[gate]}") · $out"
  else
    retro_log "timing · $label · line $(span "${t[start]}" "${t[lock]}") · rebase $(span "${t[lock]}" "${t[ci]}") · ci-queue $ciq · ci-run $cir · fallback $fb · deploy $(span "${t[deploy]}" "${t[queued]}") · live $live${early_ahead:+ · ci early ${early_ahead}s} · $out"
    # A landing that asked CI (#1722): its counted gh calls and the login's hour left. No GitHub call: EXIT trap, lock held.
    [ -z "${t[quota]}" ] || retro_log "github · $label · $(awk -v b="$branch" -v s="${t[start]:-0}" '$1 >= s && $2 == b' "$state/gh-calls" 2>/dev/null | wc -l) gh calls · left ${t[quota]} as CI began"
  fi
  rm -f "$times" ${claims_flag:+"$claims_flag"}
) >/dev/null 2>&1

# Every gh call is counted in $state/gh-calls (epoch seconds, branch, endpoint; no tokens) so a rate-limit run-out can be traced (#1655).
# Called at top level by hub() and own-check.sh's own_hub; gh_quota's rate_limit read is not counted (#1722).
gh_count() { [ "$1" != gh ] || printf '%s %s %s\n' "$(date +%s)" "${branch:-?}" "${2:-} ${3:-}" >>"$state/gh-calls" 2>/dev/null || true; }

# As the box's own gh login (#182), whoever's turn this is; never holding the lock.
hub() { gh_count "$@"; env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh" GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 timeout 30 "$@" 9>&- 7>&- 6>&-; }

# What is left of the login's hour (#1722), logged at each CI wait: "<left>/<limit>, resets in <n> min", or "unknown".
# Free: GitHub doesn't count the rate_limit read, and gh_count skips it (timeout 10).
gh_quota() {
  local l='' m='' r=''
  read -r l m r < <(hub timeout 10 gh api rate_limit --jq '.resources.core | "\(.remaining) \(.limit) \(.reset)"' 2>/dev/null) || true
  if [[ $l =~ ^[0-9]+$ && $m =~ ^[0-9]+$ ]]; then
    [[ $r =~ ^[0-9]+$ ]] && r=", resets in $(((r - $(date +%s) + 59) / 60)) min" || r=''
    echo "$l/$m$r"
  else echo unknown; fi
}

# A burn-in red's advice (#2141): a file red in every copy ran once alone on CI (burn-in.sh), and red alone is no race.
burn_list() { paste -sd, | sed 's/,/, /g'; }
burn_advice() {
  local p u o r="fix the race (a shared path, a fixed port, a timing assumption), not the wait"
  set -- "${1-$failed}" # a rider passes its own log
  p=$(sed -n 's/.*burn-in: \(refused: \)\{0,1\}\([^ ]*\): alone: failed.*/\2/p' <<<"$1" | sort -u)
  u=$(sed -n 's/.*burn-in: \(refused: \)\{0,1\}\([^ ]*\): alone: no time left.*/\2/p' <<<"$1" | sort -u)
  o=$(sed -n 's/.*burn-in: \([^ ]*\): failed in [0-9]* of [0-9]* copies.*/\1/p' <<<"$1" | sort -u | grep -vxF -f <(echo "$p") || true)
  if [ -z "$p" ] && [ -n "$u" ] && [ "$o" = "$u" ]; then
    echo "$(burn_list <<<"$u") failed in every copy and CI had no time left to run it alone, so it may be a plain red or a race:" \
      "run it alone with citadel-test (red there is a plain red, green a race) and fix that"
  elif [ -z "$p" ]; then
    echo "A file that fails when run as copies at once is racy (its output is above): $r"
  else
    echo "$(burn_list <<<"$p") failed in every copy, and run once by itself on CI it fails alone too: a plain red or a CI-only" \
      "environment fault (a temp path, git identity, a missing tool), not a race. Read its output above and fix that${o:+;" \
      "$(burn_list <<<"$o") failed only as copies at once, so it is racy: $r}"
  fi
}

phase_ticker() {
  queue_phase "$1"
  (
    exec 9>&- 7>&- 6>&-
    trap 'exit 0' TERM
    t0=$SECONDS
    while :; do
      read -rt "${LAND_PHASE_EVERY:-300}" <> <(:) || [ $? -gt 128 ] || exit 0 # a sleep with no child left behind: only a timeout ticks
      kill -0 $$ 2>/dev/null || exit 0
      mapfile -t l 2>/dev/null <"${DEPLOY_QUEUE_TICKET:-/dev/null}" || exit 0
      [[ ${l[3]:-} == "$1"* ]] || exit 0
      queue_phase "$1, $(((SECONDS - t0) / 60)) min so far"
    done
  ) &
  ticker=$!
}

phase_ticker_end() {
  [ -n "$ticker" ] || return 0
  kill "$ticker" 2>/dev/null || true
  wait "$ticker" 2>/dev/null || true
  ticker=''
}

# <what it says once back>: this ship lets go of the lock, keeps its ticket and lets the next one go first; back at the
# front it starts over from its rebase.
requeue() {
  train_drop
  train_release # none after pull_say, which hands them over
  top_done
  early_end # its background stack must not outlive this run's hold on the lock (#1864, LA6)
  ci_done
  trap 'land_timing $? || true; queue_done' EXIT
  queue_wait_check() { { train_verdict && prep_check; } || true; }
  flock -u 9
  QUEUE_KEEP=$DEPLOY_QUEUE_TICKET QUEUE_YIELD=yield queue_lock "$state" "$branch" || { land_timing 1; exit 1; }
  unset -f queue_wait_check
  train_verdict held
  say "$1"
  LAND_REBASED=1 LAND_RETRY_NOW=1 LAND_PRE=$pre LAND_RETRIED=$retried LAND_FLAKE_KEPT=$flake_kept LAND_ASIDE=$aside exec bash "$tools/land.sh" "${args[@]}"
}

# A finished red run's facts, from GitHub: a call it doesn't answer is asked three times, as no answer says nothing
# about a ship (#1864). Fails when it never answers.
ci_fact() {
  local n out
  for n in 1 2 3; do
    out=$(hub gh "$@" 2>"$state/ci.err") && [ -n "$out" ] && { printf '%s\n' "$out"; return 0; }
    [ "$n" = 3 ] || sleep "$CI_POLL"
  done
  return 1
}
