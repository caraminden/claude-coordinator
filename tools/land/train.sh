# shellcheck shell=bash
# The ship train: who rides, its guards, its verdict and who is pulled or released.
# Sourced by tools/land.sh up front: definitions only (#2099).

# <test file>...: what CI refused this ship for; its next hand-off's smoke check runs them too (#1899).
pulled_out() {
  [ $# -gt 0 ] && mkdir -p "$state/pulled" || return 0
  find "$state/pulled" -type f -mtime +14 -delete 2>/dev/null || true # a branch that never came back
  printf '%s\n' "$@" >"$state/pulled/${branch//\//-}"
}

# <how>: what is known of a ship pulled on a guess (train_solo), said after its failing tests.
guess_how() {
  local x
  case $1 in
    joined) x="run alone on perigee it passed on the train up to the ship before $branch and failed with $branch on it" ;;
    unrun) x="it couldn't be run on perigee with $branch by itself on main" ;;
    *) x="run alone on perigee it did not stay red with $branch by itself on main" ;;
  esac
  echo "$([ "$1" = joined ] || echo ", which $branch changed or which imports what it changed"). It was pulled off the train on that guess: $x"
}

train_verdict() {
  local f=$train_dir/${DEPLOY_QUEUE_TICKET##*/} v a b c d e x lines=() at requeue=''
  # One read, no look first (#1914): the front may remove the file in between, and an unset v ended the ship under set -u.
  [ -z "${DEPLOY_QUEUE_TICKET:-}" ] || read -r v a b c d e 2>/dev/null <"$f" || true
  if [ -z "${v:-}" ]; then
    [ -z "$riding" ] || { riding=''; queue_phase waiting; say "back in line on its own: the ship train went without $branch"; }
    return 0
  fi
  at=$(git rev-parse HEAD)
  if [ -n "${1:-}" ]; then
    [ "$v" != riding ] || { rm -f "$f"; riding=''; return 0; }
    if [ "$v" = moving ] && [ -n "$d" ] && [ "$(queue_proc "$d")" = "$d $e" ]; then
      [ "$at" != "$c" ] || { train_reporter "$d" "$a"; git reset -q --keep "$a" || true; }
      queue_done
      flock -u 9
      requeue=1
      say "waiting outside the line for the restart of $b's ship train to be judged"
      while read -r v a b c d e 2>/dev/null <"$f" && [ "$v" = moving ] && [ "$(queue_proc "$d")" = "$d $e" ]; do sleep 1; done
      read -r v a b c d e 2>/dev/null <"$f" || v=''
      at=$(git rev-parse HEAD)
    fi
    [ "$v" != moving ] || { v=back x=$b b=$c c=$x; }
  fi
  case $v in
    riding)
      x="riding in $a's ship train"
      [ "$b" != pulled ] || x="pulled off $a's ship train on a guess, red in ${c//,/, }"
      [ "$riding" = "$x" ] || { riding=$x; queue_phase "$x"; say "$x: waiting for CI on the train${b:+ without it}"; }
      return 1 ;;
    moving)
      # Before its branch moves, which the front waits for: who its deploy's restart reports to too (#1865).
      [ "$at" != "$c" ] || { train_reporter "$d" "$a"; git reset -q --keep "$a" || true; }
      return 1 ;;
    alone)
      # Pulled on a guess nothing proved (#2098): back in line to ship by itself, so its own CI run decides. It rides no train and
      # takes no riders, through a re-exec too (LAND_TRAIN); its ticket says so before the verdict goes, so no front takes it between.
      export LAND_TRAIN=0
      QUEUE_TRAIN=''
      riding=''
      queue_phase waiting
      rm -f "$f"
      say "back in line to ship alone: $a's ship train was red in ${b//,/, }$(guess_how "$c"). The train without it passed, but no ship pulled for it failed it by itself on main, so that proves nothing, and its own CI run decides"
      [ -z "$requeue" ] || queue_lock "$state" "$branch" || { land_timing 1; exit 1; }
      return 0 ;;
    back)
      [ "$at" != "$a" ] || git reset -q --keep "$b" || true
      rm -f "$f"
      riding=''
      say "back in line on its own: ${c:-the front}'s ship train went without $branch"
      queue_phase waiting
      [ -z "$requeue" ] || QUEUE_TRAIN='' queue_lock "$state" "$branch" || { land_timing 1; exit 1; }
      return 0 ;;
    landed)
      mapfile -t lines < <(sed -n '2,$p' "$f" 2>/dev/null) || true
      rm -f "$f"
      [ "$at" = "$a" ] || { [ "$at" = "$d" ] && git reset -q --keep "$a"; } ||
        say "$branch moved after the train took it, so it stays as it is; what shipped of it is $(git rev-parse --short "$a")"
      say "shipped in $c's ship train of $e ships, with one CI run and one deploy for them all"
      say "main is now at $(git log -1 --format='%h "%s"' "$a"), in $c's ship train"
      for x in "${lines[@]}"; do [ -z "$x" ] || say "$x"; done
      land_mark lock
      land_mark landed
      if [ "$b" = live ]; then
        echo "deploy: live now: $c's ship train went live with it" >&2
        land_mark live
      else
        # An urgent fix riding the train lets the front's restart skip the starved-box hold (deploy.sh, #1417); a restart still held
        # says when it expects to go. Only while that restart waits: one left after it would be the next restart's.
        [ -z "${LAND_URGENT:-}${LAND_FIX:-}" ] || { [ ! -s "$state/hold" ] && { [ -n "$(queue_restart "$state")" ] || ! systemctl --user is-active -q "${DEPLOY_UNIT:-cc-restart-when-idle}" 2>/dev/null; }; } || touch "$state/urgent"
        if [ -s "$state/hold" ] && read -r x d <"$state/hold" 2>/dev/null && [[ $x =~ ^[0-9]+$ ]]; then
          echo "deploy: not live yet: the restart $c's ship train queued carries it; the box is starved ($d), so it waits for it to ease, live by about $(TZ=America/Los_Angeles date -d "@$((x + 60))" '+%H:%M %Z') at the latest, and reports here too" >&2
        else
          echo "deploy: not live yet: the restart $c's ship train queued carries it, and reports here too" >&2
        fi
      fi
      queue_done
      land_timing 0 || true
      exit 0 ;;
    refused)
      mapfile -t lines <"$f" || true
      queue_done # out of line before the verdict goes, so early_next never takes it for the next in line
      rm -f "$f"
      [ ${#lines[@]} -lt 2 ] || printf '%s\n' "${lines[@]:1}" >&2
      land_timing 1 || true
      # shellcheck disable=SC2086 # file names
      pulled_out ${d//,/ }
      x="$(guess_how "$e"). No ship pulled for it failed it by itself on main, and the train without them passed"
      [ "$c" != guard ] || refuse "the guard tests failed on $a's ship train in ${d//,/, } with $branch on it and passed on the train before it, so it is the cause, and it was taken off the train before any CI run on it (output above): nothing of it landed and $untouched; $branch is as it was. Run citadel-test on that file, fix it, commit, then run this again"
      [ "$c" != burn ] || refuse "a new or changed test failed its burn-in in CI on $a's ship train ($b): ${d//,/, }$(case $e in
        new) echo ", and $branch adds the test case that failed, which main and the ships ahead of it don't have, so it is the cause, and it was taken off the train" ;;
        pinned) echo ", and run alone on perigee it passed on main and failed with $branch by itself on main, so it is the cause, and it was taken off the train" ;;
        *) echo "$x" ;;
      esac): nothing of it landed and $untouched; $branch is as it was. $(burn_advice "$(printf '%s\n' "${lines[@]:1}")"), then run this again"
      [ "$c $e" != 'likely pinned' ] || refuse "tests failed in CI on $a's ship train ($b) in ${d//,/, }, and run alone on perigee it passed on main and failed with $branch by itself on main, so it is the cause, and it was taken off the train: nothing of it landed and $untouched; $branch is as it was. Fix it, re-test, commit, then run this again"
      [ "$c" != likely ] || refuse "tests failed in CI on $a's ship train ($b) in ${d//,/, }$x: nothing of it landed and $untouched; $branch is as it was. Look into it: fix it if it is yours, re-test, commit, then run this again"
      refuse "tests failed in CI on $a's ship train ($b), which was refused with $branch on it, so nothing of it landed and $untouched; $branch is as it was. Fix it, re-test, commit, then run this again" ;;
    *)
      rm -f "$f"
      [ -z "$requeue" ] || QUEUE_TRAIN='' queue_lock "$state" "$branch" || { land_timing 1; exit 1; } ;;
  esac
}

# <from> <to>: whether the change touches a path in tools/pipeline-files.txt (a path ending / is its folder).
pipeline_touch() {
  [ -f tools/pipeline-files.txt ] || return 1
  awk 'NR == FNR { if ($0 !~ /^[[:space:]]*(#|$)/) p[++n] = $0; next }
    { for (i = 1; i <= n; i++) if ($0 == p[i] || (p[i] ~ /\/$/ && index($0, p[i]) == 1)) { hit = 1; exit } }
    END { exit !hit }' tools/pipeline-files.txt <(git diff --no-renames --name-only "$1" "$2")
}

# <rider index> <lines>: its verdict, by a rename, so it never reads half of one.
train_say() { local n=${train_n[$1]}; shift; train_tell "$n" "$@"; }

# <ticket> <lines>: the same, for a ship by its ticket (one held off the train, #1403).
train_tell() {
  local f=$train_dir/$1
  shift
  printf '%s\n' "$@" >"$f.tmp$$" && mv -f "$f.tmp$$" "$f"
}

# [<index>]: the riders from there on (all by default) leave the train with no verdict: back in line as they were.
train_drop() {
  local i v x c
  for ((i = ${1:-0}; i < ${#train_n[@]}; i++)); do
    read -r v x c <"$train_dir/${train_n[$i]}" 2>/dev/null || continue
    case $v in
      riding) rm -f "$train_dir/${train_n[$i]}" ;;
      moving) # ended after main moved: landed if main still holds it and the deploy got it live or its restart queued
        if git -C "$SOURCE" merge-base --is-ancestor "${train_tip[$i]}" main 2>/dev/null && grep -qE '^(queued|live) ' "$times" 2>/dev/null; then
          train_landed "$i"
        else train_say "$i" "back ${train_tip[$i]} ${train_was[$i]} $branch"; fi ;;
    esac
  done
  train_tip=("${train_tip[@]:0:${1:-0}}") train_br=("${train_br[@]:0:${1:-0}}") train_n=("${train_n[@]:0:${1:-0}}") train_was=("${train_was[@]:0:${1:-0}}")
}

train_landed() { # <rider index>
  local kind=restart through=''
  ! grep -q '^live ' "$times" 2>/dev/null || kind=live
  [ -z "${through_by[$tip]:-}" ] || through="shipped through main's red on ${through_by[$tip]}" # (an apostrophe in a :+ word opens a quote)
  train_say "$1" "landed ${train_tip[$1]} $kind $branch ${train_was[$1]} $((${#train_n[@]} + 1))" "${known_by[$tip]:+shipped past known flakes ${known_by[$tip]}}" "$through"
}

# "<commit> <branch>" of each ship in the train but the top one, which is "$tip $train_owner": what came off main with
# it when main goes back (taken-back), so each branch on its train commit leaves the others' commits behind.
train_others() {
  local i
  [ ${#train_n[@]} -gt 0 ] || return 0
  echo "$own $branch"
  for ((i = 0; i + 1 < ${#train_n[@]}; i++)); do echo "${train_tip[$i]} ${train_br[$i]}"; done
}

# What the ships waiting behind test their conflict prep against (prep_check): <state>/train-top while this one's gate
# runs, by a rename. Line 1: "<top> <this branch> <pid>"; then "<commit> <branch>" for each ship on it, this one first.
# Only its own is removed (top_done): a front that let go of the line for its restart (#566) leaves the next one's.
top_say() {
  local i f=$state/train-top
  [ ${#rr[@]} -gt 0 ] || return 0
  { echo "$tip $branch $$"; echo "$own $branch"; for ((i = 0; i < ${#train_n[@]}; i++)); do echo "${train_tip[$i]} ${train_br[$i]}"; done; } >"$f.tmp$$" && mv -f "$f.tmp$$" "$f"
}

top_done() { local x _ p; read -r x _ p 2>/dev/null <"$state/train-top" && [ "$p" = $$ ] && rm -f "$state/train-top"; return 0; }

# <member>: the train's commit through that ship (0: this one's own, 1 on: its riders).
train_at() { if [ "$1" = 0 ]; then echo "$own"; else echo "${train_tip[$(($1 - 1))]}"; fi; }

# [<ticket>...]: those first, in that order, then the rest of the line in its order (what is left of a red train takes nobody else: train_only).
train_build() {
  local max=${LAND_TRAIN_MAX:-6} q=$state/queue t l b r base c cur=$own wt='' skip down_at='' down_why='' x half
  local -A tried=()
  [ "$mode" = land ] && [ "$lane" != light ] && [ "${LAND_TRAIN:-1}" != 0 ] && [ ! -e "$state/train-off" ] && [ "${QUEUE_TRAIN:-}" != hold ] || return 0
  [[ $max =~ ^[0-9]+$ ]] && [ "$max" -gt 0 ] || return 0
  [ ! -s "$state/bad" ] && [ ! -s "$state/refusing" ] || return 0
  [ "${LAND_CI:-1}" != 0 ] && [ -n "$REMOTE" ] && git remote get-url "$REMOTE" >/dev/null 2>&1 || return 0
  read -r down_at down_why 2>/dev/null <"$state/ci-down" || true
  ! [[ $down_at =~ ^[0-9]+$ ]] || [ $(($(date +%s) - down_at)) -ge "$CI_DOWN" ] || return 0
  ! pipeline_touch "$old" "$own" || return 0
  local -A QUEUE_RANK=()
  local QUEUE_OLD=() QUEUE_ORDER_BY='' QUEUE_HOLD=' ' QUEUE_PIN=0 regen_attrs='' # another ship's merges get no Regenerate files of this one's
  queue_order "$q"
  mkdir -p -m 700 "$train_dir"
  find "$train_dir" -maxdepth 1 -type f -mmin +1440 -delete 2>/dev/null || true # a killed rider's, or one never read
  split_look
  if [ -n "$split_of" ]; then # the part of the ships the red train is down to that train_bisect would test next
    x=($split_rest)
    half=0
    [ ${#x[@]} = 0 ] || half=$(split_cut "$((${#x[@]} + 1))")
    say "ship train: $branch is one of the $((${#x[@]} + 1)) ships $split_of's red train is down to, so this tests $([ "$half" -gt 0 ] && echo "the first $((half + 1))" || echo "it alone")"
    [ "$half" -gt 0 ] || return 0
    [ "$half" -ge "$max" ] || max=$half
  fi
  while read -r x t <&4; do # not on stdin, which git and perl below may read
    [ ${#train_n[@]} -lt "$max" ] || break
    [ "${t##*/}" != "${DEPLOY_QUEUE_TICKET##*/}" ] && [ -z "${tried[${t##*/}]:-}" ] && mapfile -t l 2>/dev/null <"$t" || continue
    tried[${t##*/}]=1
    # A waiting ship that holds the line (QUEUE_TRAIN=hold): nobody behind it rides ahead of it.
    { [ "${l[5]:-}" = hold ] || [ "${l[8]:-}" = hold ]; } && [ "${l[1]:-}" = 0 ] && [ -n "${l[0]:-}" ] && [ "$(queue_proc "${l[0]%% *}")" = "${l[0]}" ] && break
    read -r x _ 2>/dev/null <"$train_dir/${t##*/}" && [[ $x = moving || $x = refused || $x = alone ]] && continue # still on the train before this one, refused by this one, or sent to ship alone (#2098)
    [ -z "${early_memo:-}" ] || [ "$x" != riding ] || continue # early_next: on the train before this one
    [ -z "$train_only" ] || [[ $train_only == *" ${t##*/} "* ]] || continue # early_look: the riders its early run has; train_suspects, pull_look: what is left of a red train
    if [[ $split_rest == *" ${t##*/} "* ]]; then [ -n "$split_of" ] || continue; else [ -z "$split_of" ] || continue; fi # the split's ships ride together only
    [[ $train_refused != *" ${t##*/} "* ]] || continue # refused as a suspect, though its rider already read the verdict
    [ "${l[1]:-}" = 0 ] && [ "${l[5]:-}" = train ] && [ -n "${l[0]:-}" ] && [ "$(queue_proc "${l[0]%% *}")" = "${l[0]}" ] || continue
    [[ $(queue_state "${l[0]%% *}") != [Tt] ]] || continue
    b=${l[2]:-}
    [ -n "$b" ] && [ "$b" != "$branch" ] && [[ $b != build/* ]] && r=$(git rev-parse -q --verify "refs/heads/$b^{commit}") || continue
    skip=''
    base=$(git merge-base main "$r") || continue
    [ -z "$(git rev-list --merges "$base..$r")" ] || skip="it has merge commits"
    while read -r x c; do
      [ -z "$skip" ] && [ "$c" != "$b" ] && git merge-base --is-ancestor "$x" "$r" 2>/dev/null && ! git merge-base --is-ancestor "$x" main 2>/dev/null || continue
      skip="it sits on a commit that came off main"
    done < <(cat "$state/taken-back" 2>/dev/null || true)
    for x in $train_refused_tips $train_held_tips; do
      [ -z "$skip" ] && git merge-base --is-ancestor "$x" "$r" 2>/dev/null || continue
      skip="it sits on a ship this train just refused"
      [[ " $train_held_tips " != *" $x "* ]] || skip="it sits on a ship this train holds off as a likely cause"
    done
    if [ -z "$skip" ]; then
      if [ -z "$wt" ]; then
        wt=$(mktemp -d "${TMPDIR:-/tmp}/land-train.XXXXXX") && git worktree add -q --detach "$wt" "$cur" 2>/dev/null || { say "ship train: couldn't make a scratch worktree, so this ships alone"; wt=''; break; }
        regen_attrs=$(git -C "$wt" rev-parse --absolute-git-dir)/rider.attributes
        grep ' rider$' "$tools/ship-numbers.attributes" >"$regen_attrs" || true # a SCHEMA_HISTORY or baseline conflict waits for that ship's own front, so only the size lists merge there
      fi
      # Stacked already by the early next train (early_next), else rebased here.
      if { c=$(stacked_of "$cur" "$r") && git -C "$wt" checkout -q --detach "$c" 2>/dev/null; } ||
        { git -C "$wt" checkout -q --detach "$r" 2>/dev/null && { numbers_git ours -C "$wt" "${rr[@]}" rebase -q --onto "$cur" "$base" >/dev/null 2>&1 || { rerere_on "$wt" numbers_git ours && retro_log "train prep replayed · $b onto $branch's train ($(git rev-parse --short "$cur"))"; }; }; }; then
        c=$(git -C "$wt" rev-parse HEAD)
        if [ "$c" = "$cur" ]; then skip="main already has all of it"
        elif ! train_steps "$wt" "$cur" "$b" "$base" "$r"; then :
        elif c=$(git -C "$wt" rev-parse HEAD); pipeline_touch "$cur" "$c"; then skip="it changes the ship pipeline, which ships alone"
        elif ! (cd "$wt" && branch=$b && undo_guard "$cur") >/dev/null 2>&1; then skip="the undo guard stops it on the train"
        fi
      else
        git -C "$wt" "${rr[@]}" rebase --abort >/dev/null 2>&1 || true
        skip="it doesn't rebase cleanly onto the train"
      fi
    fi
    if [ -n "$skip" ]; then say "ship train: $b stays in line ($skip)"; continue; fi
    [ -z "${early_memo:-}" ] || echo "$cur $r $c" >>"$early_memo"
    train_n+=("${t##*/}") train_br+=("$b") train_tip+=("$c") train_was+=("$r")
    train_say $((${#train_n[@]} - 1)) "riding $branch"
    cur=$c
  done 4< <(for t in "$@"; do printf '%s %s\n' - "$q/$t"; done; for t in "$q"/[0-9]*; do [[ ${t##*/} =~ ^[0-9]+$ ]] && printf '%s %s\n' "$(queue_key "${t##*/}")" "$t"; done | sort)
  [ -z "$wt" ] || git worktree remove --force "$wt" >/dev/null 2>&1 || true
  [ ${#train_n[@]} -gt 0 ] || return 0
  tip=$cur short=$(git rev-parse --short "$cur")
  say "ship train: $branch takes the $((${#train_n[@]})) ships waiting behind it (${train_br[*]}): CI runs once on all $((${#train_n[@]} + 1)), and they ship together"
  retro_log "ship train · $label · ${#train_n[@]} riders: ${train_br[*]}"
}

# The guard tests on the train's top (#1479), as guards() ran them on this one: a rider's break is as cheap to catch here as this
# one's own. Red: the prefixes are bisected with them, the first red rider is refused with their output before any CI run, and the
# train is built again without it, its new top checked the same way. Undecided: names nobody, CI runs them.
train_guards() {
  [ ${#train_n[@]} -gt 0 ] || return 0
  phase_ticker "running the guard tests on the train since $(date +%H:%M)"
  train_guards_run
  phase_ticker_end
}

# The ships held off the train on a guess, now that the train without them has a verdict. <files>: every file it was red on
# (train_failing). Nobody is refused here (#2098): a held ship was not red alone, so the train passing without it is no proof. One
# with a test among <files> goes back in line (the guess was wrong). The rest go back in line to ship alone (`alone`,
# train_verdict), so their own CI run is the proof; known flakes (train_flaky) only change the words. No files: it was green.
# A burn-in red ran no suite, so it says nothing of the tests of one held on a suite red.
train_settle() {
  local i f t red=" $* " again n=("${held_n[@]}") br=("${held_br[@]}") w=("${held_was[@]}") fs=("${held_files[@]}") run=("${held_run[@]}") kind=("${held_kind[@]}") how=("${held_how[@]}") log=("${held_log[@]}")
  held_n=() held_br=() held_was=() held_files=() held_run=() held_kind=() held_how=() held_log=()
  for ((i = 0; i < ${#n[@]}; i++)); do
    again=''
    for f in ${fs[$i]//,/ }; do [[ $red != *" $f "* ]] || again=1; done
    t=${br[$i]}
    [[ ! $t =~ ^ticket/([0-9]+)- ]] || t="#${BASH_REMATCH[1]}"
    if [ -n "$again" ]; then
      say "$t goes back in line: the train was red again on ${fs[$i]} without it, so the guess was wrong"
      rm -f "$train_dir/${n[$i]}"
    elif [ $# -gt 0 ] && [ -n "$burn_red" ] && [ "${kind[$i]}" != burn ]; then
      train_hold "${n[$i]}" "${br[$i]}" "${w[$i]}" "${fs[$i]}" "${run[$i]}" "${kind[$i]}" "${how[$i]}" "${log[$i]}"
    elif train_flaky "${fs[$i]}" "${br[$i]}"; then
      say "$t goes back in line to ship alone: ${fs[$i]//,/, } flaked on other ships, so the train passing without it proves nothing, and its own CI run decides"
      retro_log "ship train verdict · $label · $t back in line to ship alone on a guess: known flakes, so the pass without it proves nothing · ${fs[$i]} · ${run[$i]}"
      train_tell "${n[$i]}" "alone $branch ${fs[$i]} ${how[$i]}"
    else
      say "$t goes back in line to ship alone: it was pulled on a guess, and the train without it passed ${fs[$i]//,/, }, but no ship pulled for it failed it alone, so its own CI run decides"
      retro_log "ship train verdict · $label · $t back in line to ship alone on a guess: the train without it passed, and nothing proves it · ${fs[$i]} · ${run[$i]}"
      train_tell "${n[$i]}" "alone $branch ${fs[$i]} ${how[$i]}"
    fi
  done
}

# <files, comma-separated> <the held ship's branch>: every one a known flake (tools/known-flakes.ts, as known_flakes reads
# it: sightings on other branches in the retro log, or an open fix minion, and no broken test). A sighting from a run the
# held ship was in doesn't count. Anything it can't tell is no flake: the ship ships alone.
train_flaky() {
  local files=()
  [ -f "$tools/known-flakes.ts" ] || return 1
  IFS=, read -ra files <<<"$1"
  [ ${#files[@]} -gt 0 ] || return 1
  LAND_FLAKE_DB=${DEPLOY_DB:-$HOME/.local/share/claude-coordinator/coordinator.db} \
    "$tools/citadel-node" --no-warnings "$tools/known-flakes.ts" "$2" "${files[@]}" >/dev/null 2>&1 </dev/null
}

# The held ships back in line as they were, with no verdict (and on any exit).
train_release() {
  local n v
  for n in "${held_n[@]}"; do read -r v _ 2>/dev/null <"$train_dir/$n" && [ "$v" = riding ] && rm -f "$train_dir/$n"; done
  held_n=() held_br=() held_was=() held_files=() held_run=() held_kind=() held_how=() held_log=()
}

# The front (pid $1) hands its riders' lines to deploy.sh (DEPLOY_RIDERS): "<api> <token> <ticket> <train commit>".
# A failed write never stops a landing.
train_reporter() {
  [ -n "${COORDINATOR_API:-}" ] && [ -n "${COORDINATOR_TOKEN:-}" ] && [ -n "${COORDINATOR_TICKET:-}" ] || return 0
  (umask 077 && echo "$COORDINATOR_API $COORDINATOR_TOKEN $COORDINATOR_TICKET $2" >>"$state/riders-$1") || true
}

# Whether this ship would ride the quick train, and why not (#1912; tools/quick-train.ts): one retro line per ship. In a
# subshell, failures swallowed, 10 s at most, so it never decides a landing. LAND_RISK is the hand-off's label
# (src/ship-handoff.ts). shortcut: judged on the branch before its rebase.
quick_train_line() (
  set +e
  { [ "$mode" = land ] || [ "$mode" = build ]; } && [ -f "$tools/quick-train.ts" ] || exit 0
  base=$(under_of) && [ -n "$base" ] || base=$(git merge-base main HEAD)
  out=$(timeout 10 "$tools/citadel-node" "$tools/quick-train.ts" --main main --base "$base" --risk "${LAND_RISK:-}" --mode "$mode")
  retro_log "quick train · $label · ${out:-not: could not be judged}"
) >/dev/null 2>&1 9>&- 7>&- 6>&- 5>&- </dev/null || true

# <a red run's log>: what a refused rider hears of it, its last 40 lines, after the test it skipped, if any (the wake's
# kind is read from it, #1914).
train_tail() {
  local failed=$1 f
  ! f=$(skipped_tests) || echo "land: $(skipped_said "$f")"
  tail -n 40 <<<"$failed"
}

# <ticket> <branch> <tip> <files> <run> <kind> <how> <log>: held off the train until the train without it has a verdict.
train_hold() {
  held_n+=("$1") held_br+=("$2") held_was+=("$3") held_files+=("$4") held_run+=("$5") held_kind+=("$6") held_how+=("$7") held_log+=("$8")
}

# The train's last verdict: what becomes of the ships still held off it. One that ships past main's red or a known flake
# was red on those files all the same.
train_end() {
  local f=''
  [ ${#held_n[@]} -gt 0 ] || return 0
  if [ "$rc" = 1 ] || [ -n "${through_by[$tip]:-}${known_by[$tip]:-}" ]; then
    f=$(train_failing)
    # A log that doesn't name every failed file proves no file passed: the held go back in line.
    [ -n "$burn_red" ] || train_labels >/dev/null || { train_release; return 0; }
  fi
  # shellcheck disable=SC2086 # file names
  if [ "$rc" = 0 ] || { [ "$rc" = 1 ] && [ -n "$f" ]; }; then train_settle $f; fi
  train_release
}

# <most> <what>: waits until at most that many of train_each's runs are going. The phase moves at each end and every
# 5 min (the queue stall limit).
train_wait() {
  local n t
  while n=$(jobs -rp | wc -l) && [ "$n" -gt "$1" ]; do
    queue_phase "running the red tests alone here: $2, $n left at $(date +%H:%M)"
    t=$SECONDS
    while [ "$(jobs -rp | wc -l)" = "$n" ] && [ $((SECONDS - t)) -lt 300 ]; do read -rt .3 <> <(:) || true; done
  done
}

# <function> <what it looks for>: that function on each file of $real with a scratch worktree, LAND_PIN_JOBS at once; pins[<file>] = its answer.
train_each() {
  local k pd wts=()
  : >"$state/train-pin.log"
  pd=$(mktemp -d "${TMPDIR:-/tmp}/land-pins.XXXXXX")
  # The worktrees are added here, one at a time, not in the jobs: git's admin files don't take parallel adds.
  for ((k = 0; k < ${#real[@]}; k++)); do
    wts[$k]=$(mktemp -d "${TMPDIR:-/tmp}/land-pin.XXXXXX") && git worktree add -q --detach "${wts[$k]}" "$tip" 2>/dev/null || { rmdir "${wts[$k]}" 2>/dev/null; wts[$k]=''; }
  done
  for ((k = 0; k < ${#real[@]}; k++)); do
    train_wait $((${LAND_PIN_JOBS:-3} - 1)) "$2"
    (set +e; "$1" "${real[$k]}" "${wts[$k]}") >"$pd/$k" 2>/dev/null &
  done
  train_wait 0 "$2"
  for ((k = 0; k < ${#real[@]}; k++)); do
    pins[${real[$k]}]=$(cat "$pd/$k" 2>/dev/null)
    [ -z "${wts[$k]}" ] || git worktree remove --force "${wts[$k]}" >/dev/null 2>&1 || true
  done
  rm -rf "${pd:?}"
}

# <test file> <scratch worktree>: its guessed members (guess) run alone with it on main's tip here: "<m>" fails it (twice,
# so one load failure blames nobody), "-<m>" doesn't; "main" when it fails on main's tip itself. No word of one with no
# answer: a run or checkout that gave none, or a ship that doesn't rebase onto main by itself or sits on another ship of
# the train, since what fails there may be the other's.
train_solo() {
  local f=$1 wt=$2 m i c b x r=0
  [ -n "$wt" ] && [ -n "${guess[$f]:-}" ] || return 0
  train_alone "$wt" "$old" "$f" || r=$?
  [ "$r" != 1 ] || echo main
  [ "$r" = 0 ] || return 0
  for m in ${guess[$f]}; do
    c=$own
    if [ "$m" != 0 ]; then
      c=${train_was[$((m - 1))]}
      for x in "$pre" "$own" "${train_was[@]}"; do
        [ "$x" = "$c" ] || ! sits_on "$c" "$x" || continue 2
      done
      b=$(git merge-base "$old" "$c") && git -C "$wt" checkout -q --detach "$c" 2>/dev/null || continue
      git -C "$wt" "${rr[@]}" rebase -q --onto "$old" "$b" >/dev/null 2>&1 || { git -C "$wt" rebase --abort >/dev/null 2>&1; continue; }
      c=$(git -C "$wt" rev-parse HEAD)
    fi
    for i in 1 2; do
      r=0
      train_alone "$wt" "$c" "$f" || r=$?
      [ "$r" = 1 ] || break
    done
    if [ "$r" = 1 ]; then echo "$m"; elif [ "$r" = 0 ]; then echo "-$m"; fi
  done
}
