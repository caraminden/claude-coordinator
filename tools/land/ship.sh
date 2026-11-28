# shellcheck shell=bash
# After the gate: main moves, the deploy, and main going back (sourced by land.sh).
# Sourced by tools/land.sh up front: definitions only (#2099).

main_back() {
  [ -n "$moved" ] || return 0
  # A deploy killed outright never put the checkout back; only with the lock, which a deploy that queued its restart has let go of.
  # Nor beside a restart being judged on that checkout (#566): then the next landing does it, with both locks.
  ! flock -n 9 2>/dev/null || ! flock -n 7 2>/dev/null || deploy_unchecked_back "$state" "$LIVE"
  git -C "$LIVE" merge-base --is-ancestor "$tip" HEAD 2>/dev/null && return 0
  if [ "$(git -C "$SOURCE" rev-parse main)" = "$tip" ]; then
    while read -r c b; do taken_back "$state" "$c" "$b"; done < <(train_others)
    taken_back "$state" "$tip" "$train_owner" # first: the landing behind looks for it the moment main goes back
    git -C "$SOURCE" reset -q --keep "$old"
  fi
  # Also when the landing behind this one took it off main first (it does once the restart has its verdict).
  if ! git -C "$SOURCE" merge-base --is-ancestor "$tip" main 2>/dev/null; then
    refuse "the live checkout doesn't have it (the deploy stopped before taking it, or its restart was rolled back), so main is back at $(git log -1 --format=%h "$old"); $branch keeps the rebased work. Fix it and land again"
  fi
}

# A rider that left the line while the train was tested (its minion was stopped) doesn't ship: the train ships up to
# the ship before it, and the ones after it go back in line. That commit is tested only if CI passed on it.
ship_riders_left() {
  for ((i = 0; i < ${#train_n[@]}; i++)); do
    tl=() tv=''
    mapfile -t tl 2>/dev/null <"$state/queue/${train_n[$i]}" || true
    read -r tv _ 2>/dev/null <"$train_dir/${train_n[$i]}" || true
    [ -z "${tl[0]:-}" ] || [ "$(queue_proc "${tl[0]%% *}")" != "${tl[0]}" ] || [ "$tv" != riding ] || continue
    say "ship train: ${train_br[$i]} left the line while the train was tested, so it ships without it and the ships after it go back in line"
    train_drop "$i"
    tip=$(train_at "$i") short=$(git rev-parse --short "$(train_at "$i")")
    top_say
    [[ $greens == *" $tip "* ]] || tested=''
    break
  done
  train_owner=$branch
  [ ${#train_n[@]} = 0 ] || train_owner=${train_br[-1]}
  return 0
}

# gc.auto=0: a git gc --auto detaches and would keep the lock it inherits.
ship_main() {
  git -C "$SOURCE" -c gc.auto=0 merge -q --ff-only "$tip" || refuse "could not fast-forward main to $branch; nothing landed"
  say "main is now at $(git log -1 --format='%h "%s"' "$tip")"
  [ -z "${known_by[$tip]:-}" ] || say "shipped past known flakes ${known_by[$tip]}"
  [ -z "${through_by[$tip]:-}" ] || say "shipped through main's red on ${through_by[$tip]}"
  if [ ${#train_n[@]} -gt 0 ]; then
    # Each rider moves its own branch (its worktree is its own) within a poll of the line, before the deploy writes the
    # release row, which finds each ship by its branch's tip (src/releases.ts landedIn).
    me=$(queue_proc $$)
    rm -f "$state/riders-$$" # a killed landing's, with this pid
    for ((i = 0; i < ${#train_n[@]}; i++)); do train_say "$i" "moving ${train_tip[$i]} $branch ${train_was[$i]} $me"; done
    for ((w = 0; w < 20; w++)); do
      late=''
      for ((i = 0; i < ${#train_n[@]}; i++)); do
        [ "$(git rev-parse -q --verify "refs/heads/${train_br[$i]}")" = "${train_tip[$i]}" ] || late="$late ${train_br[$i]}"
      done
      [ -n "$late" ] || break
      sleep 0.5
    done
    [ -z "$late" ] || say "ship train:$late didn't move to its train commit within 10 s, so the release row may leave it out"
  fi
  quick_ready # the quick train planned on this top has its front next in line
  # In the background, so set -e still holds inside it, but a slip there can't stop this deploy with main moved.
  early_drop "$tip" "the train ahead changed after its run started"
  early_kept || { early_next 'this one deploys' </dev/null 9>&- 7>&- 6>&- & wait $!; } || say "early next train: it stopped part way (exit $?), so the next ship's CI waits for its turn"
  queue_phase "deploying"
  land_mark deploy deploy

  if ! DEPLOY_LOCKED=1 DEPLOY_TESTED="$tested" DEPLOY_TIMES="$times" DEPLOY_RIDERS="$state/riders-$$" "$here/tools/deploy.sh" 6>&-; then
    main_back
    refuse "the deploy failed after main moved; main keeps $(git log -1 --format=%h "$tip"). The deploy's lines above say why and what to do"
  fi
  return 0
}

ship_landed() {
  land_mark landed
  quick_landed
  if [ ${#train_n[@]} -gt 0 ]; then
    for ((i = 0; i < ${#train_n[@]}; i++)); do train_landed "$i"; done
    say "ship train: ${train_br[*]} shipped with $branch, each with its own shipped line"
    retro_log "ship train shipped · $label · $((${#train_n[@]} + 1)) ships · $(git rev-parse --short "$tip")"
    train_n=() train_br=() train_tip=() train_was=()
  fi
  if [ "$mode" = build ]; then
    # Landed: the branch goes, so the app stops calling it open. Its tip stays in the log line, for a rollback.
    if git update-ref -d "refs/heads/$build" "$base"; then
      say "deleted $build, which is on main now (to make it again if its restart is rolled back: git branch $build $(git rev-parse --short "$base"))"
    else
      say "$build moved during the land (not by land.sh), so it stays: what is in it after $(git rev-parse --short "$base") isn't on main"
    fi
    if [ -n "$REMOTE" ] && git show-ref -q --verify "refs/remotes/$REMOTE/$build"; then
      hub git push -q "$REMOTE" ":refs/heads/$build" 2>/dev/null || say "couldn't delete $build on $REMOTE: delete it there by hand, or the app still counts the build as open"
    fi
  fi
  queue_done ok
  [ -z "$fellback" ] || say "landed on perigee's own test run, not CI: $fellback"
  return 0
}
