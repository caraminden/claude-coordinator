# shellcheck shell=bash
# Main's own red and the known flakes (sourced by land.sh).
# Sourced by tools/land.sh up front: definitions only (#2099).

train_main_red() {
  local f i wt r n=0 real=() reds=() other=() chg=() hits=() mine=() touched=()
  [ -z "$burn_red" ] || return 1 # a burn-in red is the ship's own new or changed test (#1443)
  mapfile -t real < <(train_real) || true
  for f in "${real[@]}"; do git cat-file -e "$old:$f" 2>/dev/null && n=1; done
  [ "$n" = 1 ] || return 1
  wt=$(mktemp -d "${TMPDIR:-/tmp}/land-main.XXXXXX") && git worktree add -q --detach "$wt" "$old" 2>/dev/null || { [ -z "${wt:-}" ] || rm -rf "${wt:?}"; return 1; }
  say "red on main?: running ${real[*]} alone on main's tip ($(git rev-parse --short "$old")) here before blaming a ship"
  : >"$state/main-red.log"
  n=0
  phase_ticker "running the red tests alone on main since $(date +%H:%M)"
  for f in "${real[@]}"; do
    r=0
    if [ $((n++)) -lt 6 ] && [ -e "$wt/$f" ]; then # shortcut: at most 6 files, so a badly red main costs minutes, not an hour
      "$tools/test-alone.sh" run "$wt" "$f" >"$state/main-red.one" 2>&1 9>&- 7>&- 6>&- </dev/null || r=$?
      cat "$state/main-red.one" >>"$state/main-red.log"
      [ "$r" != 1 ] || ! grep -q 'test timed out after' "$state/main-red.one" || r=timeout
    fi
    if [ "$r" = 1 ]; then reds+=("$f"); else other+=("$f"); fi
  done
  phase_ticker_end
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
  [ ${#reds[@]} -gt 0 ] || return 1
  # Failed files with no verdict (not rerun, or the rerun killed) may be the train's own: they count as its other reds.
  mapfile -t -O "${#other[@]}" other < <(train_labels | sed -n 's/^\(not rerun\|killed (exit [0-9]*) when rerun alone\) //p') || true
  train_chg
  for f in "${reds[@]}"; do
    mapfile -t hits < <(train_suspects_of "$f")
    [[ " ${hits[*]} " != *' 0 '* ]] || mine+=("$f")
    for i in "${hits[@]}"; do [ "$i" = 0 ] || [[ " ${touched[*]} " == *" ${train_br[$((i - 1))]} "* ]] || touched+=("${train_br[$((i - 1))]}"); done
  done
  main_red=$(sed 's/ /, /g' <<<"${reds[*]}") main_red_other=$(sed 's/ /, /g' <<<"${other[*]}") main_red_mine=$(sed 's/ /, /g' <<<"${mine[*]}") main_red_riders=${#train_n[@]}
  local who="this train's" more flakes
  [ ${#train_n[@]} -gt 0 ] || who="this ship's"
  # Passed-alone files go by #1419's rule: a known flake no ship changed is excused; a new one may be the train's own, and
  # the leak guard's red is never a flake. Either counts as another red: no ship through.
  flakes=$(train_labels | sed -n 's/^failed in the full run, passed alone //p' | paste -sd, - | sed 's/,/, /g') || true
  if [ -n "$main_red_other$main_red_mine" ] || [ ${#touched[@]} -gt 0 ]; then
    :
  elif grep -qE 'The tests left [0-9]+ process\(es\) running' <<<"$failed"; then
    main_red_other='the leak guard (the tests left processes running)'
  elif skipped_tests >/dev/null; then
    main_red_other='a skipped test'
  elif [ -n "$flakes" ] && ! known_flakes "$flakes"; then
    main_red_other="$flakes (passed alone, but no known flake)"
  fi
  if [ -z "$main_red_other" ] && [ -z "$main_red_mine" ] && [ ${#touched[@]} = 0 ]; then
    through_by[$tip]=$main_red rc=0
    [ -z "$flakes" ] || known_by[$tip]=$known_why
    say "=========================================================================="
    say "SHIPPING THROUGH MAIN'S RED: $main_red fails run alone on main's tip $(git rev-parse --short "$old") here too, and it is the only real failure of $who CI run ($ci_url): no ship on it changed $main_red or what it imports, and its other failed files, if any, are known flakes (#1419). So it is no worse than main and ships as green$([ ${#train_n[@]} = 0 ] || echo ", all $((${#train_n[@]} + 1)) ships"). Main still needs a fix for $main_red, which ships separately; until then a new break in $main_red goes unseen"
    say "=========================================================================="
    retro_log "shipped through main's red · $label · $main_red · $ci_url"
    return 0
  fi
  more="no ship on the train is to blame and none is refused: the ${#train_n[@]} riders go back in line"
  [ ${#train_n[@]} -gt 0 ] || more="$branch isn't to blame"
  if [ -n "$main_red_mine" ] && [ ${#train_n[@]} = 0 ]; then
    more="$branch changed $main_red_mine or what it imports and it still fails, so its change doesn't make it pass"
  elif [ -n "$main_red_mine" ]; then
    more+=", though the front, $branch, changed $main_red_mine or what it imports and it still fails, so it is refused"
  fi
  [ ${#touched[@]} = 0 ] || more+=" (${touched[*]} changed $main_red or what it imports, so the train doesn't ship through main's red)"
  say "red on main too: not $who: $main_red fails run alone on main's tip $(git rev-parse --short "$old") here, so $more${main_red_other:+ (its other failures, $main_red_other, cannot be pinned on a ship while every run is red on the main ones, so it does not ship through)}. Main needs a fix for $main_red"
  retro_log "red on main too: not $who · $label · $main_red · $ci_url${main_red_other:+ · also red: $main_red_other}"
  train_drop
  return 0
}

# Known flakes (#1419, ADR 0006). <files, comma-separated>, each of which passed alone: whether every one is a known flake
# (tools/known-flakes.ts: sightings on other branches, an open fix minion, not a broken test) that no ship on the train changed,
# nor what it imports. Says why not; on yes, sets $known_why ("<file> (<why>), ..."). Anything it can't tell keeps a fresh run.
known_flakes() {
  local files=() f m out hits=() chg=() ok=1 who
  known_why=''
  [ -f "$tools/known-flakes.ts" ] || return 1
  # The leak guard fails a run on its own, beside the files (test/leak-guard.ts): that is no flake.
  ! grep -qE 'The tests left [0-9]+ process\(es\) running' <<<"$failed" || { say "the run also left processes running (the leak guard), so no flake is excused"; return 1; }
  IFS=, read -ra files <<<"${1//, /,}"
  out=$(LAND_FLAKE_DB=${DEPLOY_DB:-$HOME/.local/share/claude-coordinator/coordinator.db} \
    "$tools/citadel-node" --no-warnings "$tools/known-flakes.ts" "$branch ${train_br[*]}" "${files[@]}" 2>/dev/null) || ok=''
  [ -n "$out" ] || { say "couldn't tell whether $1 are known flakes (tools/known-flakes.ts gave no answer)"; return 1; }
  # A broken test (#1487) is said in known-flakes.ts's words and logged, so its fix minion moves to the front (src/flake-fixes.ts).
  [ -n "$ok" ] || { while read -r f; do
    if [[ $f == 'broken test, not a flake: '* ]]; then
      say "$f"
      m=${f#broken test, not a flake: }
      retro_log "broken test · ${m%% *} · ${m#* } · $branch"
    elif [[ $f == *'(not seen on another branch'* ]]; then say "$f is no known flake"; fi
  done <<<"$out"; return 1; }
  train_chg
  for f in "${files[@]}"; do
    mapfile -t hits < <(train_suspects_of "$f")
    [ ${#hits[@]} -gt 0 ] || continue
    who=''
    for m in "${hits[@]}"; do who+="${who:+ and }$(train_label "$m")"; done
    say "$f is a known flake, but $who changed it or what it imports, so it isn't excused"
    ok=''
  done
  [ -n "$ok" ] || return 1
  known_why=$(sed ':a;N;$!ba;s/\n/, /g' <<<"$out")
}
