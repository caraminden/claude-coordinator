# shellcheck shell=bash
# The gap train (quick train piece 3, #2243; Josh, 2026-11-24, on #1910's card: "Plan approved: build it this way.";
# specs/quick-train.md in the shared folder; docs/adr/0035-quick-train.md). Sourced by tools/land.sh up front:
# definitions only (#2099).
#
# Off unless <state>/quick-train-on exists (Cara, 2026-11-27, "Go, with both changes": it ships switched off, and a
# person turns it on after the recount). Off, every function here returns at once and the line ships as before. Also
# off: LAND_QUICK=0, the ship train off (LAND_TRAIN=0, <state>/train-off), or LAND_CI=0.
#
# Who qualifies is tools/quick-train.ts's answer as the ship joined the line (quick_train_line): with it on, kept in
# <state>/quick/<branch> as "<its head> <answer>".
#
# On, while a full train's CI runs (top_gate), its front plans the gap train before any early next train (quick_plan):
# the first qualifying ship waiting in line and up to LAND_QUICK_MAX (6) more qualifying ones behind it, in line order,
# stacked on the full train's top. Not while a ship a person placed waits (it keeps its spot), with an early run already
# stacked on this train (that full run is never thrown away), on a pipeline train, or with no side runner registered.
#   <state>/quick-train: "<the full top> <the quick top> <its front's ticket> <its front's branch> <riders' tickets, or ->
#                         <planner's pid and start>"
#   <state>/quick-stacked: the stacks, as <state>/stacked's lines ("<onto> <commit> <result>"), for stacked_of.
# Its riders read "riding <its front>"; its front takes the line's "quick" place (tools/deploy-queue.sh: right behind
# the ships a person placed, as a Regenerate ship's hold), so it goes right after the full train. While it waits, its
# front runs the quick check (quick_check_run: tools/light-check-run.sh through heavy-ci.ts on CI's side runner, as the
# light check does, on the quick top against the full top: the always tests and every ship's affected tests, once).
# The full train skips its early next train (early_next): the quick train's own deploy stacks the next full one on the
# quick top, so that early run counts.
# At the lock (quick_at_lock): main at the full top and the check green, the front rebuilds the same train from the stacks
# and ships it on that check with no CI run (land_gate's rc=quick), one deploy. A red check: each ship that touched a
# failing file leaves it, back in line, and the rest are checked once more here; with the front among them, or
# nothing pinned, or no verdict, the front goes on as a full train's front, taking them.
# At most one quick train between full trains: <state>/quick-untested holds a quick top on main no full train has run
# CI over since (a full ship clears it). With it, no quick train forms on main.
# Empty line (quick_alone): a qualifying front with no waiter that doesn't qualify and no early run of its own takes the
# qualifying waiters as a quick train at once, checked here.
# Piece 4 adds the full run behind; until then nothing runs the full suite over a quick top but the next full train.

QUICK_SIDE_LABEL=citadel-ci-linux-side

quick_on() {
  [ "${LAND_QUICK:-1}" != 0 ] && [ -e "$state/quick-train-on" ] && [ "$mode" = land ] && [ "${LAND_TRAIN:-1}" != 0 ] && [ ! -e "$state/train-off" ] && [ "${LAND_CI:-1}" != 0 ]
}

# <branch> <its head>: it qualified as it joined the line, and hasn't moved since.
quick_ok() {
  local sha v
  read -r sha v _ 2>/dev/null <"$state/quick/${1//\//-}" && [ "$sha" = "$2" ] && [ "$v" = would ]
}

# The plan, into q_base q_top q_tn q_br q_riders q_by. 1: none.
quick_read() { read -r q_base q_top q_tn q_br q_riders q_by 2>/dev/null <"$state/quick-train" && [ -n "${q_by:-}" ]; }

# The plan goes, and its riders back in line as they were (the ones still riding it).
quick_void() {
  local q_base q_top q_tn q_br q_riders q_by t v x
  quick_read || { rm -f "$state/quick-train"; return 0; }
  for t in ${q_riders//,/ }; do
    [ "$t" != - ] && read -r v x _ 2>/dev/null <"$train_dir/$t" && [ "$v $x" = "riding $q_br" ] && rm -f "$train_dir/$t"
  done
  rm -f "$state/quick-train" "$state/quick-stacked" "$state/quick-verdict"
  [ -z "${1:-}" ] || retro_log "quick train · $q_br · dropped · $1"
  return 0
}

# Whether a quick train is planned on <commit>, so the early next train stays off it.
quick_planned() { local q_base q_top q_tn q_br q_riders q_by; quick_on && quick_read && [ "$q_base" = "$1" ]; }

# <base> <front ticket> <front branch> [<rider tickets>]: the front, then the qualifying waiters behind it, stacked on
# <base> as train_build stacks a train (the riders named only, when named). Prints "<top> <riders, or -> <branches>",
# the stacks into <state>/quick-stacked.tmp$$. 1: the front doesn't stack.
quick_stack() {
  local base=$1 tn=$2 br=$3 r wt own_q out
  shift 3
  r=$(git rev-parse -q --verify "refs/heads/$br^{commit}") || return 1
  wt=$(mktemp -d "${TMPDIR:-/tmp}/land-quick.XXXXXX") || return 1
  own_q=''
  if git worktree add -q --detach "$wt" "$r" >/dev/null 2>&1 && numbers_git ours -C "$wt" "${rr[@]}" rebase -q "$base" >/dev/null 2>&1 &&
    train_steps "$wt" "$base" "$br" "$(git merge-base "$base" "$r")" "$r" >/dev/null 2>&1; then
    own_q=$(git -C "$wt" rev-parse HEAD)
  else
    git -C "$wt" "${rr[@]}" rebase --abort >/dev/null 2>&1 || true
  fi
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
  rmdir "$wt" 2>/dev/null || true
  [ -n "$own_q" ] && [ "$own_q" != "$base" ] && ! pipeline_touch "$base" "$own_q" || return 1
  echo "$base $r $own_q" >"$state/quick-stacked.tmp$$"
  out=$(
    early_memo=$state/quick-stacked.tmp$$ quick_pick=1 branch=$br own=$own_q old=$base lane=full tip=$own_q DEPLOY_QUEUE_TICKET=$tn LAND_TRAIN_MAX=${LAND_QUICK_MAX:-6}
    train_n=() train_br=() train_tip=() train_was=() train_held_tips='' QUEUE_TRAIN=train
    train_only=''
    [ $# = 0 ] || train_only=" $* "
    say() { :; }
    retro_log() { :; }
    train_say() { :; }
    train_build $train_only >/dev/null 2>&1 || true
    t=$(IFS=,; echo "${train_n[*]}")
    echo "$tip ${t:--} ${train_br[*]}"
  ) || out=''
  [ -n "$out" ] || { rm -f "$state/quick-stacked.tmp$$"; return 1; }
  echo "$out"
}

# How many side runners are registered (any state), or nothing when GitHub can't say.
quick_side() {
  declare -F own_hub >/dev/null || . "$tools/own-check.sh"
  own_hub gh api "repos/$(early_slug)/actions/runners?per_page=100" --jq "[.runners[] | select(any(.labels[]; .name == \"$QUICK_SIDE_LABEL\"))] | length" 2>/dev/null
}

# The full train's front, in top_gate before early_next: plans the gap train on its top ($tip).
quick_plan() {
  local q=$state/queue t x l b r n out top riders brs me
  quick_on && [ -z "${quick_tried:-}" ] || return 0
  quick_tried=1
  quick_void "$branch's train was built again"
  [ -z "$split_of" ] && [ -n "$REMOTE" ] || return 0
  ! early_kept || return 0 # the next full train's run is stacked on this top already: never thrown away
  ! pipeline_touch "$old" "$tip" || return 0
  local -A QUEUE_RANK=()
  local QUEUE_OLD=() QUEUE_ORDER_BY='' QUEUE_HOLD=' ' QUEUE_PIN=0 regen_attrs=''
  queue_order "$q"
  [ "$QUEUE_PIN" = 0 ] || { say "quick train: a ship a person placed waits in line, so it keeps its spot and no quick train goes ahead of it"; return 0; }
  # The first qualifying waiter not on this train.
  b='' t=''
  while read -r x t; do
    [ "${t##*/}" != "${DEPLOY_QUEUE_TICKET##*/}" ] && mapfile -t l 2>/dev/null <"$t" || continue
    [ "${l[1]:-}" = 0 ] && [ "${l[5]:-}" = train ] && [ -n "${l[0]:-}" ] && [ "$(queue_proc "${l[0]%% *}")" = "${l[0]}" ] || continue
    [[ $(queue_state "${l[0]%% *}") != [Tt] ]] || continue
    ! read -r x _ 2>/dev/null <"$train_dir/${t##*/}" || continue # on this train, or on its way out
    b=${l[2]:-}
    [ -n "$b" ] && [[ $b != build/* ]] && r=$(git rev-parse -q --verify "refs/heads/$b^{commit}") && quick_ok "$b" "$r" && break
    b=''
  done < <(for t in "$q"/[0-9]*; do [[ ${t##*/} =~ ^[0-9]+$ ]] && printf '%s %s\n' "$(queue_key "${t##*/}")" "$t"; done | sort)
  [ -n "$b" ] || return 0
  n=$(quick_side) || n=''
  [[ $n =~ ^[1-9][0-9]*$ ]] || { say "quick train: CI's side runner $([ "$n" = 0 ] && echo "isn't registered" || echo "couldn't be read"), so $b waits for the full train"; retro_log "quick train · $b · not planned: no side runner"; return 0; }
  out=$(quick_stack "$tip" "${t##*/}" "$b") || { say "quick train: $b doesn't stack on this train's top, so it waits for the full train"; return 0; }
  read -r top riders brs <<<"$out"
  mv -f "$state/quick-stacked.tmp$$" "$state/quick-stacked"
  for x in ${riders//,/ }; do [ "$x" = - ] || train_tell "$x" "riding $b"; done
  me=$(queue_proc $$)
  echo "$tip $top ${t##*/} $b $riders ${me// /:}" >"$state/quick-train.tmp$$" && mv -f "$state/quick-train.tmp$$" "$state/quick-train"
  say "quick train: $b${brs:+ (with $brs)} goes right after this train, on a quick check on CI's side runner ($(git rev-parse --short "$top"))"
  retro_log "quick train · $b · planned onto $label's train ($(git rev-parse --short "$tip")) · riders: ${brs:-none}"
}

# The full front, at its ship: the quick front has taken its place in line (within 10 s), else the plan goes.
quick_ready() {
  local q_base q_top q_tn q_br q_riders q_by l i
  quick_on && quick_read && [ "$q_base" = "$tip" ] || return 0
  for ((i = 0; i < 40; i++)); do
    mapfile -t l 2>/dev/null <"$state/queue/$q_tn" || break
    [ "${l[5]:-}" != quick ] || return 0
    sleep 0.25
  done
  quick_void "its front didn't take its place in line"
}

# <top> <base>: the quick check. Prints "green", "red: <files>" or "none: <why>".
quick_check_run() {
  local top=$1 base=$2 wt v rc=0 heavy limit=${LAND_QUICK_LIMIT:-720} queue n t1=$SECONDS
  n=$(quick_side) || n=''
  [[ $n =~ ^[1-9][0-9]*$ ]] || { echo "none: CI's side runner isn't registered"; return 0; }
  wt=$(mktemp -d "${TMPDIR:-/tmp}/land-quick-check.XXXXXX") || { echo "none: no scratch folder"; return 0; }
  git worktree add -q --detach "$wt" "$top" >/dev/null 2>&1 || { rmdir "$wt" 2>/dev/null; echo "none: no scratch worktree"; return 0; }
  # One at a time on the side runner, with the light checks (tools/light-check.sh).
  if ! { exec 4>"$state/light-check.lock" && flock -w "${LAND_LIGHT_CHECK_LOCK_WAIT:-300}" 4; }; then
    exec 4>&-
    git worktree remove --force "$wt" >/dev/null 2>&1 || true
    echo "none: another check held the side runner for $((SECONDS - t1)) s"
    return 0
  fi
  limit=$((limit - SECONDS + t1))
  [ "$limit" -ge 60 ] || limit=60
  queue=$((limit - 150 < ${LAND_LIGHT_CHECK_QUEUE:-360} ? limit - 150 : ${LAND_LIGHT_CHECK_QUEUE:-360}))
  [ "$queue" -ge 30 ] || queue=30
  heavy=("$tools/citadel-node" "$tools/heavy-ci.ts")
  [ -z "${LAND_QUICK_HEAVY:-}" ] || read -ra heavy <<<"$LAND_QUICK_HEAVY"
  (cd "$wt" && exec env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh" GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 \
    CITADEL_HEAVY_SHIP=1 CITADEL_HEAVY_CI_QUEUE="$queue" CITADEL_HEAVY_FALLBACK_FILE="$wt.why" \
    CITADEL_HEAVY_WHAT="quick check of $branch's quick train" CITADEL_HEAVY_WHO=land.sh \
    timeout -k 30 "$limit" "${heavy[@]}" bash tools/light-check-run.sh "$base") >"$wt.out" 2>&1 9>&- 7>&- 6>&- 5>&- 4>&- </dev/null || rc=$?
  exec 4>&-
  v=$(sed -n 's/^light check: //p' "$wt.out" 2>/dev/null | tail -n 1) || v=''
  [ -n "$v" ] || v="no verdict: nothing ran on CI ($(head -n 1 "$wt.why" 2>/dev/null || echo "exit $rc"))"
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
  rmdir "$wt" 2>/dev/null || true
  rm -f "$wt.out" "$wt.why"
  case $v in
    green | red:\ *) echo "$v" ;;
    *) echo "none: ${v#no verdict: }" ;;
  esac
}

# The quick front's side while it waits (queue_wait_check): takes its place once a plan names it, and starts its check.
quick_wait() {
  local q_base q_top q_tn q_br q_riders q_by
  quick_on || return 0
  if quick_read && [ "$q_tn" = "${DEPLOY_QUEUE_TICKET##*/}" ] && [ "$q_br" = "$branch" ]; then
    if [ "${QUEUE_TRAIN:-}" != quick ]; then
      QUEUE_TRAIN=quick
      queue_phase "next: a quick train right after the full train ahead"
      say "quick train: $branch goes right after the full train ahead, on a quick check, with ${q_riders//,/, } riding"
    fi
    if [ "${quick_checked:-}" != "$q_top" ]; then
      quick_stop
      quick_checked=$q_top
      rm -f "$state/quick-verdict"
      (quick_check_run "$q_top" "$q_base" | sed "s/^/$q_top /" >"$state/quick-verdict.tmp$$" && mv -f "$state/quick-verdict.tmp$$" "$state/quick-verdict") </dev/null 9>&- 7>&- 6>&- 5>&- 4>&- &
      quick_pid=$!
    fi
  elif [ "${QUEUE_TRAIN:-}" = quick ]; then
    quick_stop
    QUEUE_TRAIN=train quick_checked=''
    queue_phase waiting
    say "quick train: its plan went, so $branch is back in line"
  fi
  return 0
}

# Its check, still going, is stopped (and on the way out).
quick_stop() {
  [ -n "${quick_pid:-}" ] || return 0
  quick_kill "$quick_pid"
  wait "$quick_pid" 2>/dev/null || true
  quick_pid=''
}

# <pid>: it and everything under it (the check's heavy-ci.ts, which cancels its CI run on TERM).
quick_kill() {
  local c
  for c in $(ps -o pid= --ppid "$1" 2>/dev/null); do quick_kill "$c"; done
  kill -TERM "$1" 2>/dev/null || true
}

# <files, comma-separated>: which of the plan's ships changed one of them, by its own stacked commit: "front", and
# the riders' tickets.
quick_pinned() {
  local f c prev i=0 out='' riders=()
  IFS=, read -ra riders <<<"$q_riders"
  while read -r prev _ c; do
    for f in ${1//,/ }; do
      git diff --name-only --no-renames "$prev" "$c" 2>/dev/null | grep -qxF "$f" || continue
      if [ "$i" = 0 ]; then out+=' front'; else out+=" ${riders[$((i - 1))]:-}"; fi
      break
    done
    i=$((i + 1))
  done <"$state/quick-stacked" 2>/dev/null
  echo "$out"
}

# The quick front, holding the lock: whether it ships as a quick train. Sets quick_go and quick_only (its riders);
# quick_again: some riders left it on a red, so land_gate checks what is left once more.
quick_at_lock() {
  local q_base q_top q_tn q_br q_riders q_by v x t pins left=''
  quick_go='' quick_again='' quick_only=''
  [ "${QUEUE_TRAIN:-}" = quick ] || return 0
  QUEUE_TRAIN=train
  quick_read && [ "$q_tn" = "${DEPLOY_QUEUE_TICKET##*/}" ] || { quick_stop; return 0; }
  if [ "$(git -C "$SOURCE" rev-parse main)" != "$q_base" ]; then
    quick_stop
    say "quick train: main isn't at the full train's top it was checked on, so $branch goes on as a full train's front"
    quick_void "main isn't at the top it was planned on"
    return 0
  fi
  if [ -n "${quick_pid:-}" ]; then
    queue_phase "waiting for its quick check on CI's side runner"
    say "quick train: waiting for its quick check on CI's side runner"
    wait "$quick_pid" 2>/dev/null || true
    quick_pid=''
  fi
  read -r t v 2>/dev/null <"$state/quick-verdict" && [ "$t" = "$q_top" ] || v=''
  [ -n "$v" ] || v=$(quick_check_run "$q_top" "$q_base")
  rm -f "$state/quick-verdict"
  case $v in
    green)
      say "quick train: its quick check is green on $(git rev-parse --short "$q_top")"
      retro_log "quick train · $branch · green · riders: $q_riders" ;;
    red:\ *)
      x=${v#red: } x=${x//, /,}
      pins=$(quick_pinned "$x")
      retro_log "quick train · $branch · red: $x · pinned:${pins:- nothing}"
      if [ -z "$pins" ] || [[ " $pins " == *" front "* ]]; then
        say "quick train: its quick check was red in ${x//,/, }$([ -z "$pins" ] && echo ", which no ship on it changed" || echo ", which $branch changed"), so it goes on as a full train's front"
        quick_void
        return 0
      fi
      for t in ${q_riders//,/ }; do
        if [[ " $pins " == *" $t "* ]]; then
          rm -f "$train_dir/$t"
          say "quick train: $(sed -n 3p "$state/queue/$t" 2>/dev/null) changed ${x//,/, }, red in its quick check, so it leaves the quick train for the full one"
        else left+=" $t"; fi
      done
      q_riders=$(echo $left | tr ' ' ,)
      quick_again=1 ;;
    *)
      say "quick train: its quick check gave no verdict (${v#none: }), so it goes on as a full train's front"
      retro_log "quick train · $branch · no verdict: ${v#none: }"
      quick_void
      return 0 ;;
  esac
  quick_go=1 quick_pick=1
  quick_only=" ${q_riders//,/ } " # land_gate's train_only (land_settings clears it before)
  [ -n "${q_riders//-/}" ] || quick_only=' '
  return 0
}

# land_gate's side, train built: 0 with rc=quick when it ships on the quick check, else the full gate decides.
quick_gate() {
  local q_base q_top q_tn q_br q_riders q_by v
  [ -n "${quick_go:-}" ] || return 1
  quick_read || [ -n "$quick_again" ] || return 1
  if [ -n "$quick_again" ]; then
    v=$(quick_check_run "$tip" "$old")
    [ "$v" = green ] || { say "quick train: checked again without the ships it pointed at, it wasn't green ($v), so CI runs on it as a full train"; quick_void; return 1; }
    say "quick train: checked again without them, green on $(git rev-parse --short "$tip")"
  elif [ "$tip" != "$q_top" ]; then
    say "quick train: it came out different from the train its quick check ran on, so CI runs on it as a full train"
    quick_void
    return 1
  fi
  rc=quick
  return 0
}

# A qualifying front with an empty line (no waiter that doesn't qualify) ships its quick train at once. Sets quick_go.
quick_alone() {
  local q=$state/queue t x l b r n b2 at
  quick_on && [ -z "${quick_go:-}" ] && [ -z "$split_of" ] && [ -z "$train_only" ] && quick_ok "$branch" "$pre" || return 0
  ! quick_last_on_main || return 0
  # Its own early run, stacked by the train ahead: that full run counts, never thrown away.
  ! { read -r _ b2 at _ 2>/dev/null <"$state/early" && [ "$b2" = "$branch" ]; } || return 0
  local -A QUEUE_RANK=()
  local QUEUE_OLD=() QUEUE_ORDER_BY='' QUEUE_HOLD=' ' QUEUE_PIN=0 regen_attrs=''
  queue_order "$q"
  for t in "$q"/[0-9]*; do
    [[ ${t##*/} =~ ^[0-9]+$ ]] && [ "${t##*/}" != "${DEPLOY_QUEUE_TICKET##*/}" ] && mapfile -t l 2>/dev/null <"$t" || continue
    [ "${l[1]:-}" = 0 ] && [ -n "${l[0]:-}" ] && [ "$(queue_proc "${l[0]%% *}")" = "${l[0]}" ] || continue
    ! read -r x _ 2>/dev/null <"$train_dir/${t##*/}" || continue # another train's
    b=${l[2]:-}
    r=$(git rev-parse -q --verify "refs/heads/$b^{commit}" 2>/dev/null) && quick_ok "$b" "$r" || return 0
  done
  n=$(quick_side) || n=''
  [[ $n =~ ^[1-9][0-9]*$ ]] || return 0
  quick_go=1 quick_again=1 quick_pick=1
  say "quick train: nothing in line needs the full suite, so $branch ships at once on a quick check on CI's side runner"
  retro_log "quick train · $branch · at once, the line empty"
}

# <state>/quick-untested holds a quick top still on main with no full train since.
quick_last_on_main() { local c; read -r c 2>/dev/null <"$state/quick-untested" && git -C "$SOURCE" merge-base --is-ancestor "$c" main 2>/dev/null; }

# At its ship: a quick train marks main; a full train's CI run clears the mark.
quick_landed() {
  if [ "${rc:-}" = quick ]; then
    echo "$tip" >"$state/quick-untested"
    rm -f "$state/quick-train" "$state/quick-stacked"
    retro_log "quick train shipped · $label · $((${#train_n[@]} + 1)) ships · $(git rev-parse --short "$tip") · no CI run"
  elif [ "${rc:-}" != light ]; then
    rm -f "$state/quick-untested"
  fi
  return 0
}

# On the way out: its check stops, and a plan of its own that didn't ship goes.
quick_end() {
  local q_base q_top q_tn q_br q_riders q_by
  quick_stop
  quick_read || return 0
  [ "${q_by//:/ }" != "$(queue_proc $$)" ] || [ "$(git -C "$SOURCE" rev-parse main 2>/dev/null)" = "$q_base" ] || quick_void "$branch's train didn't ship"
  [ "$q_tn" != "${DEPLOY_QUEUE_TICKET##*/}" ] || [ "$q_br" != "$branch" ] || [ "${rc:-}" = quick ] || quick_void
  return 0
}
