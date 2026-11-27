# shellcheck shell=bash
# Early runs: a ship's CI started while it waits in line, and the gate that reuses it.
# Sourced by tools/land.sh up front: definitions only (#2099).

early_slug() { local url; url=$(git remote get-url "$REMOTE" 2>/dev/null) || return 1; url=${url#*github.com[:/]}; echo "${url%.git}"; }

# [<what this train is doing>]: the words for the say line, at its deploy (default: while its CI runs, top_gate).
early_next() {
  local q=$state/queue t x c l nb='' nt='' r own_e wt lane_e slug free out top n riders st skip='' waited=$SECONDS
  [ "$mode" = land ] && [ "${LAND_EARLY:-1}" != 0 ] && [ ! -e "$state/early-off" ] && { [ -e "$state/hold-off" ] || [ -n "${1:-}" ]; } && [ "${LAND_CI:-1}" != 0 ] && [ -n "$REMOTE" ] || return 0
  [ -z "$split_of" ] || return 0 # a red train being split (train_bisect): its next ships may be the red one's, and a red early run runs again
  ! pipeline_touch "$old" "$tip" || return 0 # the next one runs this train's own land.sh, not this one
  local -A QUEUE_RANK=()
  local QUEUE_OLD=() QUEUE_ORDER_BY='' QUEUE_HOLD=' ' QUEUE_PIN=0 regen_attrs='' # another ship's merges get no Regenerate files of this one's
  queue_order "$q"
  while read -r x t; do # the first in line that isn't on this train
    [ "${t##*/}" != "${DEPLOY_QUEUE_TICKET##*/}" ] && mapfile -t l 2>/dev/null <"$t" || continue
    [ "${l[1]:-}" = 0 ] && [ -n "${l[0]:-}" ] && [ "$(queue_proc "${l[0]%% *}")" = "${l[0]}" ] || continue
    read -r x _ 2>/dev/null <"$train_dir/${t##*/}" && [[ $x = riding || $x = moving || $x = refused ]] && continue # refused: on its way out
    [ "${l[5]:-}" = train ] && [[ $(queue_state "${l[0]%% *}") != [Tt] ]] && nt=${t##*/} nb=${l[2]:-}
    break
  done < <(for t in "$q"/[0-9]*; do [[ ${t##*/} =~ ^[0-9]+$ ]] && printf '%s %s\n' "$(queue_key "${t##*/}")" "$t"; done | sort)
  [ -n "$nb" ] && [ "$nb" != "$branch" ] && [[ $nb != build/* ]] && r=$(git rev-parse -q --verify "refs/heads/$nb^{commit}") || return 0
  while read -r x c; do # it would leave a commit that came off main behind: not the plain rebase stacked here
    [ "$c" != "$nb" ] && git merge-base --is-ancestor "$x" "$r" 2>/dev/null && ! git merge-base --is-ancestor "$x" main 2>/dev/null && return 0
  done < <(cat "$state/taken-back" 2>/dev/null || true)
  slug=$(early_slug) || return 0
  wt=$(mktemp -d "${TMPDIR:-/tmp}/land-early.XXXXXX") || return 0
  if git worktree add -q --detach "$wt" "$r" >/dev/null 2>&1 && { numbers_git ours -C "$wt" "${rr[@]}" rebase -q "$tip" >/dev/null 2>&1 || { rerere_on "$wt" numbers_git ours && retro_log "train prep replayed · $nb onto $label's train ($(git rev-parse --short "$tip")), early"; }; }; then
    # With what its own rebase will add (#1864, LA1): a stack without it would never be the commit it ships.
    if train_steps "$wt" "$tip" "$nb" "$(git merge-base "$tip" "$r")" "$r" >/dev/null 2>&1; then own_e=$(git -C "$wt" rev-parse HEAD); else own_e=''; fi
  else
    git -C "$wt" "${rr[@]}" rebase --abort >/dev/null 2>&1 || true
    own_e=''
  fi
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
  rmdir "$wt" 2>/dev/null || true
  [ -n "$own_e" ] && [ "$own_e" != "$tip" ] || return 0 # a conflict is its own rebase's to report, after this ships
  read -r lane_e _ < <(git diff --no-renames --name-only "$tip" "$own_e" | "$tools/lane.sh" "$tip") || lane_e=full
  [ "$lane_e" != light ] || return 0 # it runs no CI
  echo "$tip $r $own_e" >"$state/stacked.tmp$$"
  # The train it would take, as train_build builds it: no verdicts said, nothing logged.
  out=$(
    early_memo=$state/stacked.tmp$$ branch=$nb own=$own_e old=$tip lane=$lane_e tip=$own_e DEPLOY_QUEUE_TICKET=$nt
    train_n=() train_br=() train_tip=() train_was=() train_only='' train_held_tips=''
    say() { :; }
    retro_log() { :; }
    train_say() { :; }
    train_build >/dev/null 2>&1 || true
    t=$(IFS=,; echo "${train_n[*]}")
    echo "$tip ${#train_n[@]} ${t:--} ${train_br[*]}"
  ) || out=''
  read -r top n riders x <<<"$out" && [ -n "$top" ] || { rm -f "$state/stacked.tmp$$"; return 0; }
  mv -f "$state/stacked.tmp$$" "$state/stacked"
  # Not on a top the guard tests fail (#1479): its front's own train_guards refuses the ship that broke them.
  guard_at "$top" || [ $? != 1 ] || { say "early next train: the guard tests fail on $nb's train, so its CI waits for its turn"; return 0; }
  # Not before this train's own run has a runner, which it must not lose; only on a free one.
  while [ -z "${1:-}" ]; do
    [ ! -e "$state/early-stop.$$" ] || return 0 # this train's gate ended without a green, or the landing is ending
    st=$(hub gh api "repos/$slug/actions/runs?head_sha=$tip&per_page=20" --jq "[.workflow_runs[] | select(.path | startswith(\"$CI_WORKFLOW\"))][0] // empty | [.id, .status] | @tsv" 2>/dev/null) || st=''
    read -r _ st _ <<<"$st" || true
    [[ $st != in_progress && $st != completed ]] || break
    [ $((SECONDS - waited)) -lt "${LAND_EARLY_WAIT:-600}" ] || { say "early next train: this train's run had no runner within ${LAND_EARLY_WAIT:-600} s, so $nb's CI waits for its turn"; return 0; }
    sleep "$CI_POLL"
  done
  free=$(hub gh api "repos/$slug/actions/runners?per_page=100" --jq "[.runners[] | select(.status == \"online\" and .busy == false and any(.labels[]; .name == \"$CI_LABEL\"))] | length" 2>/dev/null) || free=''
  ! ci_busy hub "$slug" || { say "early next train: another Citadel job is on the CI desktop or queued, so $nb's CI waits for its turn"; return 0; }
  [[ $free =~ ^[1-9][0-9]*$ ]] || { say "early next train: no free $CI_LABEL runner, so $nb's CI waits for its turn"; return 0; }
  [ ! -e "$state/early-stop.$$" ] || return 0
  # With its base, atomic, as ci_gate pushes it (burn-in, #1443). Its record goes first: a stop after the push leaves the run to count or drop (#1894).
  echo "$top $nb $(date +%s) $branch $tip $riders" >"$state/early"
  hub git push -q --atomic "$REMOTE" "+$top:refs/heads/early/$nb" "+$tip:refs/heads/early-base/$nb" 2>"$state/early.err" || { rm -f "$state/early"; say "early next train: pushing $nb's train to GitHub failed$(ci_said "$state/early.err"), so its CI waits for its turn"; return 0; }
  say "early next train: $nb${x:+ (with $x riding)} is stacked on this train's top and its CI starts now, while ${1:-"this one's CI runs"} ($(git rev-parse --short "$top")); if its train comes out the same, that run is its CI"
  retro_log "early train · $nb${x:+ + $n riders} onto $label's train ($(git rev-parse --short "$tip")) · pushed $(git rev-parse --short "$top")"
}

# Before this landing builds its train: one stacked early for it rides the riders it was stacked with, and only those.
early_look() {
  local top b at fb onto riders id st w slug
  read -r top b at fb onto riders 2>/dev/null <"$state/early" && [ "$b" = "$branch" ] && [ -n "$riders" ] && [[ $at =~ ^[0-9]+$ ]] && slug=$(early_slug) || return 0
  read -r id st w _ <<<"$(early_run "$slug" "$top")" || true
  [[ $id =~ ^[0-9]+$ ]] && { [ "$st" != completed ] || [ "$w" = success ]; } || return 0 # one that won't count holds no one back
  train_only=" ${riders//,/ } "
  [ "$riders" != - ] || train_only=' '
}

# <slug> <commit>: the workflow's newest run, "<id> <status> <conclusion or ->"; nothing when GitHub has none or is silent.
early_run() { hub gh api "repos/$1/actions/runs?head_sha=$2&per_page=20" --jq "[.workflow_runs[] | select(.path | startswith(\"$CI_WORKFLOW\"))][0] // empty | [.id, .status, .conclusion // \"-\"] | @tsv" 2>/dev/null || true; }

# <top> <id> <its branch> <why>: an early run nobody will count is cancelled and its scratch branches go (a later push starts a fresh run).
early_cancel() {
  [[ ! $2 =~ ^[0-9]+$ ]] || hub gh api -X POST "repos/$(early_slug)/actions/runs/$2/cancel" >/dev/null 2>&1 || true
  hub git push -q "$REMOTE" ":refs/heads/early/$3" ":refs/heads/early-base/$3" >/dev/null 2>&1 || true
  say "early next train: dropped the early CI run on $3's train ($4)"
  retro_log "early train · $label · discarded · $4"
}

# <the top to keep it on> <why>: this landing's early run stacked on any other top goes (a red, a train built again).
early_drop() {
  local top b at fb onto riders id
  read -r top b at fb onto riders 2>/dev/null <"$state/early" && [ "$fb" = "$branch" ] && [ "$onto" != "$1" ] || return 0
  rm -f "$state/early"
  id=$(hub gh api "repos/$(early_slug)/actions/runs?head_sha=$top&per_page=20" --jq "[.workflow_runs[] | select(.path | startswith(\"$CI_WORKFLOW\"))][0] // empty | select(.status != \"completed\") | .id" 2>/dev/null) || id=''
  early_cancel "$top" "$id" "$b" "$2"
}

# 0 when this landing has an early run stacked on its train's top.
early_kept() { local top b at fb onto; read -r top b at fb onto _ 2>/dev/null <"$state/early" && [ "$fb" = "$branch" ] && [ "$onto" = "$tip" ]; }

# The gate on the train's top, with the next train's early run beside it; a red ahead drops it, a rebuilt train stacks anew. rc as gate's.
top_gate() {
  local x
  early_drop "$tip" "the train ahead was built again"
  rm -f "$state/early-stop.$$"
  if ! early_kept; then
    early_next </dev/null 9>&- 7>&- 6>&- & # not the lock's fds: a land.sh killed mid-gate mustn't leave it held
    early_pid=$!
  fi
  rc=0
  gate "$tip" || rc=$?
  [ "$rc" = 0 ] || : >"$state/early-stop.$$" # no green: it pushes nothing more, and goes
  [ -z "$early_pid" ] || wait "$early_pid" || { x=$?; say "early next train: it stopped part way (exit $x), so the next ship's CI waits for its turn"; }
  early_pid=''
  rm -f "$state/early-stop.$$"
  [ "$rc" != 1 ] || early_drop '' "the train ahead went red"
  return "$rc"
}

# On the way out: an early_next still going pushes nothing more, and is waited for (it may hold a scratch worktree).
early_end() {
  [ -n "$early_pid" ] || return 0
  : >"$state/early-stop.$$"
  wait "$early_pid" 2>/dev/null || true
  rm -f "$state/early-stop.$$"
}

# At this landing's gate, train built: an early run on it counts (early_ahead: its age; early_top: the first gate's scratch branches); any other is cancelled.
early_gate() {
  local top b at fb onto riders slug id st w
  train_only=''
  read -r top b at fb onto riders 2>/dev/null <"$state/early" || return 0
  [ "$fb" != "$branch" ] || return 0 # this landing's own, from a stopped gate it starts again: top_gate's to keep or drop
  rm -f "$state/early"
  [[ $at =~ ^[0-9]+$ ]] && slug=$(early_slug) || return 0
  read -r id st w _ <<<"$(early_run "$slug" "$top")" || true
  while [[ ! $id =~ ^[0-9]+$ ]] && [ $(($(date +%s) - at)) -lt "$CI_LATE" ]; do # pushed a moment ago: not listed yet (#1894)
    sleep "$CI_LATE_POLL"
    read -r id st w _ <<<"$(early_run "$slug" "$top")" || true
  done
  if [ "$b" = "$branch" ] && [ "$top" = "$tip" ] && [[ $id =~ ^[0-9]+$ ]] && { [ "$st" != completed ] || [ "$w" = success ]; }; then
    early_ahead=$(($(date +%s) - at)) early_top=$top
    say "early next train: CI started on this train at $(date -d "@$at" +%H:%M) beside $fb's, and it came out the same, so that run is its CI ($early_ahead s head start)"
    retro_log "early train · $label · counted · ${early_ahead}s head start"
    return 0
  fi
  if [ "$b" != "$branch" ]; then w="$b wasn't next in line after all"
  elif [ "$top" != "$tip" ]; then w="its train came out different from the one stacked early"
  elif [[ $id =~ ^[0-9]+$ ]]; then w="the early run failed, so it runs again" # as for a run on the same commit from a landing started again
  else w="GitHub has no run of it"; fi
  [ "$st" != completed ] || id=''
  early_cancel "$top" "$id" "$b" "$w"
}
