# shellcheck shell=bash
# The full run behind each quick train (quick train piece 4, #2244; Josh, 2026-11-24, on #1910's card: "Plan approved:
# build it this way."; specs/quick-train.md in the shared folder, "Behind it"; docs/adr/0035-quick-train.md). Sourced by
# tools/land.sh up front: definitions only (#2099).
#
# A quick train ships on its quick check alone, so the full suite owes its top one verdict. land.sh keeps what is owed in
# <state>/quick-behind, a line per quick train shipped:
#   "<epoch> <base> <top> <ship top>:<#N, or -> ... [red=<file>,<file>]"
# its ships in the order they were stacked on <base> (the full train's top it went on), the last one's top being <top>.
# The server (src/fast-mode.ts, the quick scheme) reads it and does the rest: one `tools/land.sh --verify` run on <top>,
# and on a red, the failing files run alone on <base> and each ship's top, oldest first, to find whose ship broke them.
# The next full train's own run counts (the spec: "the next full train's own run counts, else one run starts at once"):
#   - shipped green over <top> (behind_landed), the line goes: the whole suite passed over it.
#   - red on a file that fails alone on main's tip too (train_main_red, behind_red), with main's tip at <top>, the line
#     gets red=<those files>, and the server pins them with no run of its own. That red refuses no full ship: it is main's
#     own red (#1478), and the ships through it are judged as before (#2212).
# Off (the gap train off, tools/land/quick.sh): no quick train ships, so no line is written and every function here does
# nothing. test/land-quick-behind.test.ts proves it.

# A quick train shipped (quick_landed, rc=quick): what the full suite owes it.
behind_mark() {
  local line i n
  n=$([[ $branch =~ ^ticket/([0-9]+)- ]] && echo "${BASH_REMATCH[1]}" || echo -)
  line="$(date +%s) $old $tip $own:$n"
  for ((i = 0; i < ${#train_n[@]}; i++)); do
    n=$([[ ${train_br[$i]} =~ ^ticket/([0-9]+)- ]] && echo "${BASH_REMATCH[1]}" || echo -)
    line+=" ${train_tip[$i]}:$n"
  done
  { echo "$line" >>"$state/quick-behind"; } 2>/dev/null || say "quick train: couldn't note the full run it owes (the server runs it from $state/quick-behind)"
  return 0
}

# A full ship (quick_landed, not quick nor light): its CI run was green over every line's top under it, unless it shipped
# through main's red (through_by), whose files behind_red already marked. Lines whose top isn't on main any more (a roll
# back) go too.
behind_landed() {
  local at base top rest
  [ -s "$state/quick-behind" ] || return 0
  [ -z "${through_by[$tip]:-}" ] || return 0
  while read -r at base top rest; do
    [ -n "$top" ] || continue
    git merge-base --is-ancestor "$top" "$tip" 2>/dev/null && continue
    git merge-base --is-ancestor "$top" "$(git -C "$SOURCE" rev-parse main 2>/dev/null)" 2>/dev/null || continue
    echo "$at $base $top $rest"
  done <"$state/quick-behind" >"$state/quick-behind.$$" 2>/dev/null || { rm -f "$state/quick-behind.$$"; return 0; }
  if [ -s "$state/quick-behind.$$" ]; then mv -f "$state/quick-behind.$$" "$state/quick-behind"; else rm -f "$state/quick-behind.$$" "$state/quick-behind"; fi
  return 0
}

# <files>...: they failed in a full train's CI run and fail alone on main's tip ($old) too (train_main_red). With a quick
# train's top at main's tip and no verdict on it yet, they are that quick train's red: its line gets red=<files>.
behind_red() {
  local at base top rest f files='' hit=''
  [ -s "$state/quick-behind" ] && [ $# -gt 0 ] || return 0
  # A known flake blames nobody here either (behind_verify screens its own the same way).
  for f in "$@"; do
    if known_flakes "$f" >/dev/null 2>&1; then say "quick train: $f is a known flake ($known_why): no culprit"; else files+="${files:+,}$f"; fi
  done
  [ -n "$files" ] || return 0
  while read -r at base top rest; do
    [ -n "$top" ] || continue
    if [ "$top" = "$old" ] && [[ " $rest" != *' red='* ]]; then rest+=" red=$files" hit=1; fi
    echo "$at $base $top $rest"
  done <"$state/quick-behind" >"$state/quick-behind.$$" 2>/dev/null || { rm -f "$state/quick-behind.$$"; return 0; }
  mv -f "$state/quick-behind.$$" "$state/quick-behind"
  [ -n "$hit" ] || return 0
  say "quick train: ${files//,/, } fails on $(git rev-parse --short "$old"), the quick train's top, so Citadel finds which of its ships broke it"
  retro_log "quick train red behind · $(git rev-parse --short "$old") · $files · found by $branch's train"
  return 0
}

# tools/land.sh --verify, from a worktree at a commit already on main (src/fast-mode.ts's runs for the quick scheme): out of
# line, with no lock, no queue entry and no deploy. It prints "verify: green", or "verify: failing <file>" for each real
# failure and "verify: red", or "verify: no verdict"; exit 0, 1 or 75.
#   LAND_VERIFY_IDS empty: the full suite on CI (GitHub's 20 shards, the desktop as their fallback), never on perigee. A
#     file that failed and passed alone, or a known flake no ship since LAND_VERIFY_BASE changed, is no real failure: it
#     blames nobody (the spec: "Known flakes and "passed alone" blame nobody").
#   LAND_VERIFY_IDS: those files (one a line, LAND_VERIFY_MAX at most) each run alone here, niced (tools/test-alone.sh). Red
#     only when it fails twice: one red run alone is no culprit (Peek Auras' wrong blames). A run that gives no answer
#     names "the check", which src/fast-mode.ts runs again once.
# <file>: run alone here once, its output kept for the tail; prints test-alone's exit, or "timeout" for a test that hit its
# time limit, which is no answer (#1430: a loaded box's timeouts blame nobody, as train_main_red's).
behind_alone() {
  local r=0 one=${TMPDIR:-/tmp}/land-verify-one.$$
  "$tools/test-alone.sh" run "$here" "$1" >"$one" 2>&1 9>&- 7>&- 6>&- </dev/null || r=$?
  cat "$one" >>"${TMPDIR:-/tmp}/land-verify-alone.$$"
  [ "$r" != 1 ] || ! grep -q 'test timed out after' "$one" || r=timeout
  rm -f "$one"
  echo "$r"
}

behind_verify() {
  local want=${LAND_VERIFY_IDS:-} f r r2 ids=() none='' n=0 real flakes
  here=$(git rev-parse --show-toplevel) && cd "$here" || { echo "verify: no verdict"; exit 75; }
  state=$(git -C "$LIVE" rev-parse --absolute-git-dir)/cc-deploy
  mkdir -p -m 700 "$state"
  queue_phase() { :; } # out of line: no lock held and nobody waiting on it (ci_gate calls it)
  tip=$(git rev-parse HEAD) short=$(git rev-parse --short HEAD)
  old=$(git rev-parse -q --verify "${LAND_VERIFY_BASE:-HEAD^}^{commit}" 2>/dev/null) || old=$(git rev-parse -q --verify HEAD^) || old=$tip
  own=$tip branch=behind
  say "verify: $short"
  if [ -n "$want" ]; then
    : >"${TMPDIR:-/tmp}/land-verify-alone.$$"
    while read -r f; do
      [ -n "$f" ] || continue
      if [ $((n++)) -ge "${LAND_VERIFY_MAX:-6}" ]; then none=1; continue; fi # shortcut: as train_main_red's 6, minutes not an hour
      r=$(behind_alone "$f")
      if [ "$r" = 1 ]; then
        r2=$(behind_alone "$f")
        if [ "$r2" = 1 ]; then ids+=("$f") && say "verify: $f fails alone on $short, twice";
        elif [ "$r2" = 0 ]; then say "verify: $f failed alone on $short once and then passed: no culprit";
        else none=1; fi
      elif [ "$r" != 0 ]; then
        none=1 && say "verify: $f gave no answer run alone on $short (exit $r)"
      fi
    done <<<"$want"
    tail -n 40 "${TMPDIR:-/tmp}/land-verify-alone.$$" >&2 || true
    rm -f "${TMPDIR:-/tmp}/land-verify-alone.$$"
    [ -z "$none" ] || ids+=('the check')
  else
    land_settings
    CI_REF=land/behind CI_BASE_REF=land-base/behind
    times=$(mktemp "${TMPDIR:-/tmp}/land-verify-times.XXXXXX") || times=/dev/null
    r=0
    ci_gate || r=$?
    [ "$r" != 1 ] || [ -z "$ci_lost" ] || { why="its CI runner was lost, so no test verdict"; r=2; }
    if [ "$r" = 1 ] && ! ci_failed; then r=2; fi
    ci_done
    [ "$times" = /dev/null ] || rm -f "$times"
    case $r in
      0) ;;
      1)
        real=$(train_real) || real=''
        flakes=$(train_labels 2>/dev/null | sed -n 's/^failed in the full run, passed alone //p' | paste -sd, - | sed 's/,/, /g') || flakes=''
        [ -z "$flakes" ] || say "verify: $flakes failed in the full run and passed alone: no culprit"
        while read -r f; do
          [ -n "$f" ] || continue
          if known_flakes "$f" >/dev/null 2>&1; then say "verify: $f is a known flake ($known_why): no culprit"; else ids+=("$f"); fi
        done <<<"$real"
        # The leak guard and a skipped test are reds of their own, never flakes (train_main_red's rule): "CI", naming nobody.
        if grep -qE 'The tests left [0-9]+ process\(es\) running' <<<"$failed"; then
          say "verify: the run left processes running (the leak guard)" && ids+=('CI')
        fi
        if f=$(skipped_tests); then say "verify: $(skipped_said "$f")" && ids+=('CI'); fi
        # Red with no file to name (the log unlabelled): "CI" too.
        [ ${#ids[@]} -gt 0 ] || [ -n "$flakes" ] || [ -n "$real" ] || ids+=('CI')
        ;;
      *)
        say "verify: no verdict on $short: $why"
        echo "verify: no verdict"
        exit 75
        ;;
    esac
  fi
  if [ ${#ids[@]} = 0 ]; then echo "verify: green"; exit 0; fi
  printf 'verify: failing %s\n' "${ids[@]}" | sort -u
  echo "verify: red"
  exit 1
}
