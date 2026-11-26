# shellcheck shell=bash
# Common helpers: the retro log, phase times, and every gh call counted (#2099 moved them from land.sh; say and refuse stay there, used before the parts load).
# Sourced by tools/land.sh up front: definitions only (#2099).

# A line in the scheme's retro log. Best effort: land.sh has no session id, so it goes in the day's land.md, and any
# failure here is swallowed so the landing goes on as before.
retro_log() (
  set +e
  [ -n "${COORDINATOR_SHARED_DIR:-}" ] || exit 0
  dir=$COORDINATOR_SHARED_DIR/retro-log/$(date -u +%F)
  mkdir -p "$dir" || exit 0
  [ -e "$dir/land.md" ] || printf '%s\n\n' '# Retro log: land.sh' 'Written by tools/land.sh, tools/run-tests.sh and the queued restart in tools/deploy.sh (no session id, so one file per day). One line per rebase conflict, per landing that fell back from CI to the suite on perigee, per test file that failed in a land or deploy run and passed alone (flake), and per fresh CI run after a red of flakes only (flake rerun: green, red, no answer or not started), a `broken test` line per file tools/known-flakes.ts calls a broken test, not a flake (#1487), and per fresh CI run after one cut off before any test failed (cut-off rerun, the same results), and a `bisect run` line per CI run of a red train'"'"'s bisect that gave a verdict. A `smoke` line per landing the smoke check refused before the line (#1012: what failed, its seconds; no timing line for it). Phase times in whole seconds (#565), - for a phase never reached: a `timing` line per landing that got in line, landed or not (line: waiting for the deploy lock; rebase; ci-queue: until a runner took the job; ci-run; fallback: the wait for a CI that gave no answer + the suite on perigee; deploy: pull, boot check and tests if any, until the restart was queued or the front end reloaded; live: from then until the deploy saw it live, the restart'"'"'s settle check included), and a `restart` line per queued restart (idle-wait: for the turns it would cut off and the lock; backup: the database copy; healthy: restart to the first healthy answer; settle: the check after it; then restart or handover: how the new server took over, #1170; then the outcome, and held <n> s for a starved box when it waited for one, #1417).' >>"$dir/land.md"
  printf -- '- %sZ · %s\n' "$(date -u +%T)" "$1" >>"$dir/land.md"
) >/dev/null 2>&1 || true

# Phase times for the timing line (#565): "<name> <epoch seconds> [<the phase a refusal from here on is at>]" lines
# in $times, a file of this process's own, so the rebased copy (the exec in land.sh) keeps them. deploy.sh adds "queued"
# (the restart queued or the front end reloaded) and "live" lines to it, and "landed" comes once its deploy went through.
land_mark() { { echo "$1 $(date +%s) ${2:-}" >>"$times"; } 2>/dev/null || true; }

# One line when the landing ends, however it ends (each EXIT trap in land.sh calls it; only the first call finds $times). Best
# effort, like retro_log.
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
    # A landing that asked CI (#1722): its counted gh calls, and what was left of the login's hour as it began. No GitHub
    # call here: this runs in the EXIT trap with the lock held (#553 M14).
    [ -z "${t[quota]}" ] || retro_log "github · $label · $(awk -v b="$branch" -v s="${t[start]:-0}" '$1 >= s && $2 == b' "$state/gh-calls" 2>/dev/null | wc -l) gh calls · left ${t[quota]} as CI began"
  fi
  rm -f "$times" ${claims_flag:+"$claims_flag"}
) >/dev/null 2>&1

# Every gh call of any landing is counted in $state/gh-calls (epoch seconds, the landing's branch and the endpoint, no tokens), so
# the next time the 5,000 an hour run out, `cut -d" " -f2 "$state/gh-calls" | sort | uniq -c` says which landing asked how often (#1655).
# GitHub's rate_limit read costs none of them, so gh_quota's isn't counted (#1722).
# At the top level: hub() and own-check.sh's own_hub call it in every copy, the rebased one and --into too.
gh_count() { [ "$1" != gh ] || printf '%s %s %s\n' "$(date +%s)" "${branch:-?}" "${2:-} ${3:-}" >>"$state/gh-calls" 2>/dev/null || true; }

# As the box's own gh login, like deploy.sh's push of main (#182), whoever's turn this is; never holding the lock.
hub() { gh_count "$@"; env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh" GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 timeout 30 "$@" 9>&- 7>&- 6>&-; }

# What is left of the login's hour, as GitHub counts it (#1722): every login's calls draw on it, land.sh's, the server's and
# each turn's alike, so each CI wait logs it and the next "API rate limit exceeded" has numbers. "<left>/<limit>, resets
# in <n> min", or "unknown" when GitHub doesn't say. Free: GitHub doesn't count the rate_limit read itself, and gh_count,
# which counts only a bare gh, leaves out this one through timeout 10 (a short wait when GitHub hangs).
gh_quota() {
  local l='' m='' r=''
  read -r l m r < <(hub timeout 10 gh api rate_limit --jq '.resources.core | "\(.remaining) \(.limit) \(.reset)"' 2>/dev/null) || true
  if [[ $l =~ ^[0-9]+$ && $m =~ ^[0-9]+$ ]]; then
    [[ $r =~ ^[0-9]+$ ]] && r=", resets in $(((r - $(date +%s) + 59) / 60)) min" || r=''
    echo "$l/$m$r"
  else echo unknown; fi
}
