# shellcheck shell=bash
# The ship train's blame: which ship a red belongs to (sourced by land.sh).
# Sourced by tools/land.sh up front: definitions only (#2099).

# The real failures in $failed, one test file a line: those that failed again alone, hung, or whose rerun stopped at
# CI's deadline. A file not rerun, or whose rerun was killed from outside (#1393), may be load or real, so it names no suspect: if it is real, the train without the
# pulled ships is red on it, and the next round sees it. Fails when there are none, or the log doesn't label every failed file.
train_real() {
  local out
  [ -z "$burn_red" ] || { burn_lines | sed 's/: failed in .*//' | grep .; return; } # each burn-in red file is a real failure (#1443)
  out=$(train_labels) || return 1
  out=$(sed -n 's/^\(failed again alone\|hung when rerun alone\|rerun alone stopped\) //p' <<<"$out")
  [ -n "$out" ] && echo "$out"
}

# Each failed file in $failed with run-tests.sh's label for its rerun alone, "<label> <file>" a line. Fails when the log
# doesn't label every failed file.
train_labels() {
  local at n out
  at=$(grep -n 'run-tests: [0-9][0-9]* test file(s) failed; rerunning each alone' <<<"$failed" | tail -n 1 | cut -d: -f1)
  [[ $at =~ ^[0-9]+$ ]] || return 1
  n=$(sed -n "${at}s/.*run-tests: \\([0-9][0-9]*\\) test file(s) failed.*/\\1/p" <<<"$failed")
  out=$(tail -n "+$at" <<<"$failed" | sed -n 's/.*run-tests: \([^ ]*\): \(failed in the full run, passed alone\|failed again alone\|hung when rerun alone\|rerun alone stopped\|not rerun\|killed (exit [0-9]*) when rerun alone\).*/\2 \1/p' | sort -u -k2)
  [[ $n =~ ^[1-9][0-9]*$ ]] && [ -n "$out" ] && [ "$(wc -l <<<"$out")" = "$n" ] || return 1
  echo "$out"
}

# <file>: the repo paths it imports by a relative path, as the train's top has it.
train_imports() {
  local p
  git show "$tip:$1" 2>/dev/null | grep -oE "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"]\.\.?/[^'\"]+['\"]" |
    sed -E "s/.*['\"](\.[^'\"]+)['\"]$/\1/" | while read -r p; do realpath -ms --relative-to="$PWD" "$PWD/$(dirname "$1")/$p"; done | sort -u
}

# <test file>: the train members (0: this one, 1 on: its riders) its failure is pinned on, nearest first. Reads chg.
train_suspects_of() {
  local live
  # set -e as before #1484 ($( ) drops it), so a step that fails still ends the guess with no suspects.
  live=$(set -e; train_guess "$1")
  [ -z "$live" ] || echo "$live"
}

# <test file>: train_suspects_of's answer.
train_guess() {
  local f=$1 text reach lvl m c hits named
  text=$(git show "$tip:$f" 2>/dev/null) || text=''
  # A guard's failure message names the file behind it ("loop-lag.test.ts:22 … 5 sleep hits", #1451): the ship that
  # changed that file is the suspect, before any guess from what the guard reads or imports.
  named=$({ grep -oE '[A-Za-z0-9_./-]+\.test\.ts:[0-9]+' <<<"$failed" || true; } | sed 's/:[0-9]*$//' | sort -u | while read -r c; do
    [[ $c == */* ]] || c=test/$c
    [ "$c" = "$f" ] || echo "$c"
  done)
  # A judge-replay red (test/judges.test.ts, #1503) names the pinned code that changed: "(pinned code: src/a.ts src/b.ts)".
  # The ship that changed that code is the suspect, not the one that only edited the test or its record (#1538).
  [ "$f" != test/judges.test.ts ] || named+=$'\n'$({ grep -oE 'pinned code: [^)]*' <<<"$failed" || true; } | sed 's/^pinned code: //' | tr ' ' '\n' | grep . | sort -u || true)
  named=$(grep . <<<"$named" || true)
  if [ -n "$named" ]; then
    hits=$(for ((m = 0; m < ${#chg[@]}; m++)); do
      while read -r c; do
        [ -n "$c" ] || continue
        if grep -qxF -- "$c" <<<"$named"; then echo "$m"; break; fi
      done <<<"${chg[$m]}"
    done)
    [ -z "$hits" ] || { echo "$hits"; return 0; }
  fi
  reach=$f
  for lvl in 0 1 2; do
    [ "$lvl" = 0 ] || reach=$(while read -r c; do [ -z "$c" ] || train_imports "$c"; done <<<"$reach" | sort -u) ||
      return 0 # the last file imports nothing by a relative path: no suspects (set -e stopped here before #1484)
    hits=$(for ((m = 0; m < ${#chg[@]}; m++)); do
      while read -r c; do
        [ -n "$c" ] || continue
        if grep -qxF -- "$c" <<<"$reach" || { [ "$lvl" = 1 ] && grep -qF -- "$c" <<<"$text"; }; then echo "$m"; break; fi
      done <<<"${chg[$m]}"
    done)
    [ -z "$hits" ] || { echo "$hits"; return 0; }
  done
}

# Sets chg (the caller's local): each train member's own changed files, 0 being this ship's.
train_chg() {
  local m
  chg=()
  for ((m = 0; m <= ${#train_n[@]}; m++)); do
    if [ "$m" = 0 ]; then chg[0]=$(git diff --no-renames --name-only "$old" "$own"); else chg[m]=$(git diff --no-renames --name-only "$(train_at $((m - 1)))" "$(train_at "$m")"); fi
  done
}

# <member>: its #N, or its branch when that names no ticket.
train_label() {
  local t
  if [ "$1" = 0 ]; then t=$branch; else t=${train_br[$(($1 - 1))]}; fi
  [[ ! $t =~ ^ticket/([0-9]+)- ]] || t="#${BASH_REMATCH[1]}"
  echo "$t"
}

# <scratch worktree> <commit> <test file>: 0 when the file passes run alone at that commit here, or the commit hasn't
# got it; 1 when it fails (a test past its own 60 s timeout too). Niced, one file, without the lock's fds; a run stopped
# at LAND_PIN_LIMIT s, a checkout that fails or a missing package is no answer (any other code): test-alone.sh.
train_alone() {
  git -C "$1" checkout -q --detach "$2" 2>/dev/null || return 2
  "$tools/test-alone.sh" run "$1" "$3" >>"$state/train-pin.log" 2>&1 9>&- 7>&- 6>&- </dev/null
}

# <test file> <scratch worktree>: the train member (0: this one, 1 on: its riders) that turns it red run alone here: it
# fails at the train's top and passes on main, so the train's prefixes are bisected with that one file, and the answer
# is run once more on each side (red with it, green just before it) so one load failure can't pin an innocent ship.
# Nothing when it passes at the top here (a test only CI's machine fails), fails on main too, a step gives no answer, or
# the recheck disagrees: the files decide then. The caller adds and removes the worktree, one at a time.
train_pin() {
  local f=$1 wt=$2 lo=-1 hi=${#train_n[@]} mid r=0 before
  [ -n "$wt" ] || return 0
  train_alone "$wt" "$tip" "$f" || r=$?
  if [ "$r" = 1 ]; then
    r=0
    train_alone "$wt" "$old" "$f" || r=$?
    while [ "$r" = 0 ] && [ $((hi - lo)) -gt 1 ]; do
      mid=$(((lo + hi) / 2))
      train_alone "$wt" "$(train_at "$mid")" "$f" || r=$?
      if [ "$r" = 0 ]; then lo=$mid; elif [ "$r" = 1 ]; then hi=$mid r=0; fi
    done
    if [ "$r" = 0 ]; then
      if [ "$hi" = 0 ]; then before=$old; else before=$(train_at $((hi - 1))); fi
      train_alone "$wt" "$(train_at "$hi")" "$f" || r=$?
      if [ "$r" = 1 ]; then r=0 && train_alone "$wt" "$before" "$f" && echo "$hi"; fi
    fi
  fi
}

# Every file the full run failed in $failed, whatever its rerun showed (a held ship's test not rerun is no pass).
train_failing() {
  local at
  [ -z "$burn_red" ] || { burn_lines | sed 's/: failed in .*//' | sort -u; return; }
  at=$(grep -n 'run-tests: [0-9][0-9]* test file(s) failed; rerunning each alone' <<<"$failed" | tail -n 1 | cut -d: -f1)
  [[ $at =~ ^[0-9]+$ ]] || return 0
  tail -n "+$at" <<<"$failed" | sed -n 's/.*run-tests: \([^ ]*\): \(failed in the full run, passed alone\|failed again alone\|hung when rerun alone\|rerun alone stopped\|not rerun\|killed (exit [0-9]*) when rerun alone\).*/\1/p' | sort -u
}

# A red train (#1918; Josh, 2026-11-24: "we bisect out the likely failures and run 1, 2, 4, 6, 7 if they are green they
# get shipped and we send 5 and 3 back to debug their failures. If they are still red and we guess 1 is the issue based on
# the failure, then we take it out and run 2, 4, 6, 7 then we finally get a green and ship those 4"; he approved the plan
# at 11:24 PM PST). Every likely ship of the red's failing tests is pulled at once, this one at the front included: the
# one a test's runs on the train's prefixes here name (train_pin) and each one the files name (train_suspects_of). Each of
# those is run alone on main first (train_solo): red alone, it goes back to its minion with that; another ship pulled for
# the same test red alone, it waits for the next train (or stays on, when the prefixes name the one red alone); no ship pulled for it red alone, it is held, and all of them go back once
# the train without them passes the test. The train is built again from what is left, with nothing from the line in the
# empty seats (train_only); one that can't be rebuilt without the pulled ones goes back in line, blamed for nothing.
# Still red, on the same test or not, the new failure names the next pull. A file no ship can be named for rides on
# while others are pulled. With nobody named, or every ship on the train and none of them red alone: train_bisect.
# All of a round's files are judged before anyone is pulled (#1564, Cara 2026-11-21, C "Go").
train_suspects() {
  local f i m t v n x line held_line sure_line rest kind real=() hits=() keep=() was=() chg=() open=()
  local -A sus=() sure=() next=() pins=() pin=() guess=() how=() added=() new=()
  local new_line
  while :; do
    mapfile -t real < <(train_real) || true
    if [ ${#real[@]} = 0 ]; then
      train_release
      [ -z "$reran" ] || flake_keep # #1864 (LB4): red twice of flakes only, which no ship on it touched: nobody's fault
      say "suspects: CI's log doesn't say which tests really failed, so the bisect looks for the ship"
      return 1
    fi
    # shellcheck disable=SC2046 # file names
    train_settle $(train_failing)
    sus=() sure=() next=() pins=() pin=() guess=() how=() open=() kind=burn
    train_chg
    added=() new=()
    while read -r m f; do
      new[$f]=1 added[$m]=1 sure[$m]+="${sure[$m]:+, }$f" sus[$m]+="${sus[$m]:+, }$f"
    done < <(burn_new)
    if [ -z "$burn_red" ]; then # a burn-in red names the file a ship added or changed itself (#1443), so no bisect of it here
      kind=likely
      say "suspects: running ${real[*]} alone on the train's commits here, ${LAND_PIN_JOBS:-3} at a time, to find the ship that turns each red"
      train_each train_pin 'which ship turns each red'
    fi
    line=''
    for f in "${real[@]}"; do
      [ -z "${new[$f]:-}" ] || continue # the ship that adds the failing case is known
      m=${pins[$f]:-}
      pin[$f]=$m
      mapfile -t hits < <({ [ -z "$m" ] || echo "$m"; train_suspects_of "$f"; } | awk '!seen[$0]++')
      guess[$f]=${hits[*]}
      if [ ${#hits[@]} = 0 ]; then open+=("$f"); else line+="${line:+; }$f: $(for m in "${hits[@]}"; do train_label "$m"; done | paste -sd, | sed 's/,/, /g')"; fi
    done
    if [ -n "$line" ]; then
      say "suspects: running the tests alone on main's tip ($(git rev-parse --short "$old")) here with each likely ship ($line)"
      train_each train_solo 'each likely ship by itself on main'
      for f in "${real[@]}"; do
        [ -n "${guess[$f]:-}" ] || continue
        hits=(${pins[$f]})
        if [ "${hits[0]:-}" = main ]; then open+=("$f"); continue; fi
        for m in ${guess[$f]}; do
          if [[ " ${hits[*]} " == *" $m "* ]]; then
            sure[$m]+="${sure[$m]:+, }$f" sus[$m]+="${sus[$m]:+, }$f"
            continue
          fi
          x=unrun
          [[ " ${hits[*]} " != *" -$m "* ]] || x=alone
          [ "$m" != "${pin[$f]}" ] || x=joined
          if [[ ! " ${hits[*]}" =~ \ [0-9] ]]; then sus[$m]+="${sus[$m]:+, }$f"
          elif [[ " ${hits[*]} " != *" ${pin[$f]:-none} "* ]]; then next[$m]+="${next[$m]:+, }$f"
          else continue; fi
          # The least said of it by any of its tests: not run by itself, then red on the train's prefixes.
          { [ "${how[$m]:-}" != unrun ] && [ "$x" != alone ]; } || [ -z "${how[$m]:-}" ] && how[$m]=$x
        done
      done
    fi
    for m in "${!sure[@]}"; do sus[$m]=${sure[$m]}; done # sent back for what it failed alone, not for the others' guesses
    for m in "${!sus[@]}"; do unset "next[$m]"; done
    n=$((${#sus[@]} + ${#next[@]}))
    # Nothing left to test with every ship pulled, so only the proven leave; and this one steps aside three times at most.
    for m in "${!sus[@]}" "${!next[@]}"; do
      [ "$n" -gt ${#train_n[@]} ] || { [ "$m" = 0 ] && [ "$aside" -ge 3 ]; } || continue
      [ -z "${sure[$m]:-}" ] || continue
      for f in ${sus[$m]:-}; do f=${f%,}; [[ " ${open[*]} " == *" $f "* ]] || open+=("$f"); done
      unset "sus[$m]" "next[$m]"
    done
    if [ ${#sus[@]} = 0 ]; then
      train_release
      if [ "$n" -gt 0 ] && [ "$n" -le ${#train_n[@]} ]; then say "suspects: only $branch is likely, and it has stepped aside $aside times already, so the bisect looks for the ship"
      elif [ "$n" = 0 ]; then say "suspects: no ship on the train touched ${open[0]} or what it imports, so the bisect looks for the ship"
      else say "suspects: the files name every ship there is to pull for $(sed 's/ /, /g' <<<"${open[*]}") and none of them failed alone, so the bisect looks for the ship"; fi
      return 1
    fi
    [ ${#open[@]} = 0 ] || say "suspects: no ship could be pinned on $(sed 's/ /, /g' <<<"${open[*]}"), so they stay on the train while the likely causes leave"
    line='' sure_line='' new_line='' held_line='' rest=''
    for m in $(printf '%s\n' "${!sus[@]}" "${!next[@]}" | sort -n); do
      t=$(train_label "$m")
      if [ -n "${added[$m]:-}" ]; then
        line+="${line:+, }$t (${sus[$m]}; adds the failing case: sent back)" new_line+="${new_line:+, }$t"
      elif [ -n "${sure[$m]:-}" ]; then
        line+="${line:+, }$t (${sus[$m]}; failed alone: sent back)" sure_line+="${sure_line:+, }$t"
      elif [ -n "${sus[$m]:-}" ]; then
        line+="${line:+, }$t (${sus[$m]}; a guess: waits for the verdict)" held_line+="${held_line:+, }$t"
      elif [ "${how[$m]}" = unrun ]; then line+="${line:+, }$t (${next[$m]}; not run alone: waits for the next train)" rest+="${rest:+, }$t"
      else line+="${line:+, }$t (${next[$m]}; passed alone: waits for the next train)" rest+="${rest:+, }$t"; fi
    done
    say "suspects: $line: CI is red on the ship train ($ci_url) in those tests, so they leave the train at once.${new_line:+ $new_line adds the test case that failed, so that is the cause: back to its minion with the failure.}${sure_line:+ Run alone on main here, the tests failed with $sure_line and passed without, so that is the cause: back to its minion with the failure.}${held_line:+ $held_line: not red alone here, so the files are only a guess: they go back in line once the train has a verdict without them, to ship alone unless it is red on those tests again.}${rest:+ $rest: not red alone here, and another ship was: the next train.} The train runs again with the ships that are left, and none from the line takes their places"
    retro_log "ship train suspects · $label · $(sed 's/; [^)]*)/)/g' <<<"$line")${new_line:+ · adds the failing case: $new_line}${sure_line:+ · failed alone here: $sure_line}${held_line:+ · pulled on a guess, not red alone here: $held_line}${rest:+ · not red alone here while another ship was: $rest} · $ci_url"
    [ -z "$sure_line$new_line" ] || split_over
    keep=()
    for ((i = 0; i < ${#train_n[@]}; i++)); do
      m=$((i + 1)) v=${sus[$((i + 1))]:-}
      if [ -n "${next[$m]:-}" ]; then
        train_held_tips+=" ${train_was[$i]}"
      elif [ -z "$v" ]; then
        keep+=("$i")
      elif [ -n "${sure[$m]:-}" ]; then
        x=pinned
        [ -z "${added[$m]:-}" ] || x=new
        train_say "$i" "refused $branch $ci_url $kind ${v//, /,} $x" "$(train_tail "$failed")"
        train_refused+="${train_n[$i]} " train_refused_tips+=" ${train_was[$i]}"
      else
        train_say "$i" "riding $branch pulled ${v//, /,}"
        train_hold "${train_n[$i]}" "${train_br[$i]}" "${train_was[$i]}" "${v//, /,}" "$ci_url" "$kind" "${how[$m]}" "$(train_tail "$failed")"
        train_held_tips+=" ${train_was[$i]}"
      fi
    done
    if [ -n "${sus[0]:-}${next[0]:-}" ]; then # this one: the next front among the ships that are left runs them (pull_look)
      v=${sus[0]:-}
      [ -z "$v" ] || [ -n "${sure[0]:-}" ] || train_hold "${DEPLOY_QUEUE_TICKET##*/}" "$branch" "$own" "${v//, /,}" "$ci_url" "$kind" "${how[0]}" "$(train_tail "$failed")"
      was=("${keep[@]}") keep=()
      for i in "${was[@]}"; do # the next front would bring the pulled one's commits along with a ship built on it
        for x in "$pre" "$own" $train_refused_tips $train_held_tips; do
          ! sits_on "${train_was[$i]}" "$x" || { say "${train_br[$i]} goes back in line: it sits on a ship this train pulled"; continue 2; }
        done
        keep+=("$i")
      done
      pull_say "${keep[@]}"
      if [ -n "${sure[0]:-}" ]; then # it failed alone here, so it is refused below
        suspect_tests=$v suspect_new=${added[0]:-}
        tip=$own short=$(git rev-parse --short "$own") rc=1
        return 0
      fi
      aside=$((aside + 1))
      say "$branch steps aside: the next ship in line runs the train with what is left of it"
      requeue "back at the front after it was pulled off its train: starting over from the rebase"
    fi
    queue_phase "testing the train again without its likely causes"
    was=("${train_n[@]}")
    for ((i = 0; i < ${#keep[@]}; i++)); do keep[$i]=${train_n[${keep[$i]}]}; done
    train_tip=() train_br=() train_n=() train_was=()
    tip=$own short=$(git rev-parse --short "$own")
    train_only=" ${keep[*]} " train_left=1
    train_build "${keep[@]}"
    [ ${#train_n[@]} -gt 0 ] || [ ${#keep[@]} = 0 ] || train_release # as for a pulled front's kept ships: this one's own run says nothing of the held
    train_guards
    top_say
    for t in "${was[@]}"; do # a rider the train no longer takes (it no longer rebases onto it, say): back in line
      [[ " ${train_n[*]} " != *" $t "* ]] && [[ " ${held_n[*]} " != *" $t "* ]] && read -r v _ 2>/dev/null <"$train_dir/$t" && [ "$v" = riding ] && rm -f "$train_dir/$t"
    done
    rc=0
    top_gate || rc=$?
    busy_gate
    [ "$rc" != 1 ] || train_main_red || [ ${#train_n[@]} = 0 ] || continue
    return 0
  done
}

# A red train whose failing tests name no ship to pull (train_suspects, #1918), and only that. #1899's rule (Josh,
# 2026-11-24: "keep splitting and any green section gets shipped, until the bad change is found
# and then pulled out to be fixed and full train starts over"). The part at its front (split_cut) is tested; green, it ships at once
# (that commit is tested and main hasn't moved, so it needs no further run) and the ships behind it go back in line,
# nobody refused; red, its own first half is next. <state>/split holds the ships the red may be (split_say), so the next
# front among them tests half of what is left (split_look, train_build), down to one ship tested by itself: only a red
# there, on main as it then is, refuses it; but a burn-in red on a case one ship adds (burn_new, #2019) ends the split,
# and that step is judged as a red train of its own (train_suspects). So two ships red only together ship the first and send back the second, and a
# flake refuses nobody. That found, the rest and the line form a full train again. A no-answer: the train goes back in
# line, this one falls back on its own, and the split stays.
# Each step past this one's own commit runs the guard tests first (#1479): red there is the step's answer, with no CI run.
train_bisect() {
  local hi=${#train_n[@]} lo g n back
  n=$((hi + 1)) split_of=${split_of:-$label}
  say "CI is red on the ship train ($ci_url): finding the first ship that turned it red"
  queue_phase "finding the ship that turned the train red"
  while [ "$hi" -gt 0 ]; do
    split_say "$hi"
    lo=$(split_cut "$((hi + 1))")
    # The Releases page shows this step (#1368, src/land-news.ts): train_at "$lo" holds the leader and $lo riders.
    say "bisect: testing the first $((lo + 1)) of $n ships"
    g=0
    [ "$lo" = 0 ] || guard_at "$(train_at "$lo")" || g=$?
    if [ "$g" = 1 ]; then
      hi=$lo
      say "the guard tests failed on the train up to ${train_br[$((lo - 1))]} ($(git rev-parse --short "$(train_at "$lo")")), so that step needs no CI run"
      continue
    fi
    rc=0
    gate "$(train_at "$lo")" || rc=$?
    [ "$rc" = 2 ] || retro_log "bisect run · $branch · $lo of ${#train_br[@]}" # a run without a timing line: tools/known-flakes.ts counts it
    busy_gate "$(train_at "$lo")"
    if [ "$rc" = 2 ]; then return; fi
    if [ "$rc" = 1 ]; then
      if [ -n "$(burn_new "$lo")" ]; then # the step's red names its ship (#2019): judged as a red train of its own, no more steps
        split_over
        train_drop "$lo"
        train_suspects || [ ${#train_n[@]} = 0 ] || train_bisect
        return
      fi
      hi=$lo
      continue
    fi
    back=${train_br[*]:$lo}
    say "bisect: the first $((lo + 1)) of $n ships tested green, so they ship now; back in line with nobody refused: $back; the red may be: ${train_br[*]:$lo:$((hi - lo))}"
    retro_log "ship train green section · $label · $((lo + 1)) of $n ships · back in line: $back · $ci_url"
    train_drop "$lo"
    tip=$(train_at "$lo") short=$(git rev-parse --short "$(train_at "$lo")") rc=0
    top_say
    return
  done
  say "the bisect found $branch itself red, so the ships behind it go back in line"
  train_drop
  tip=$own short=$(git rev-parse --short "$own") rc=1
  train_main_red || true # this red is its own run's: main's red still blames nobody
}

split_say() {
  local i
  {
    echo "$split_of"
    echo "${DEPLOY_QUEUE_TICKET##*/} $branch"
    for ((i = 0; i < $1; i++)); do echo "${train_n[$i]} ${train_br[$i]}"; done
  } >"$state/split.tmp$$" && mv -f "$state/split.tmp$$" "$state/split"
}

# <ships>: the last ship, from 0, of the part to test next: the first half.
split_cut() { echo "$((($1 - 2) / 2))"; }

# Is this front one of them? Then split_of names their train and split_rest holds the tickets of those behind it there
# and still in line; else split_rest holds all of them, which ride in no other train while the split goes on.
split_look() {
  local l=() i n b
  split_of='' split_rest=' '
  mapfile -t l 2>/dev/null <"$state/split" || return 0
  for ((i = 1; i < ${#l[@]}; i++)); do
    read -r n b _ <<<"${l[$i]}" # a split begun before #1918 has a third word on some lines, for where to cut
    if [ "$n" = "${DEPLOY_QUEUE_TICKET##*/}" ] && [ "$b" = "$branch" ]; then
      split_of=${l[0]} split_rest=' '
    elif [ -e "$state/queue/$n" ]; then
      split_rest+="$n "
    fi
  done
}

# The bad change is found (or the search is over): the next front builds a full train again.
split_over() {
  [ -n "$split_of" ] || return 0
  rm -f "$state/split"
  split_of='' split_rest=' '
}
