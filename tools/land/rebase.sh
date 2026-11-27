# shellcheck shell=bash
# The rebase and the rewrites after it: regenerated files, ADR numbers, the prompt baseline, the undo guard (sourced by land.sh).
# Sourced by tools/land.sh up front: definitions only (#2099).

# Regenerated files (#1827). A ship whose diff is a command's output says so with trailers on its own commits:
#   Regenerate: <a command, run with bash from the repo's top>
#   Regenerate-files: <the files it writes, as .gitattributes patterns, space-separated>
# Every merge numbers_git makes for it then takes main's side of those files (the citadel-regen driver), so the early
# checks pass it too; after the rebase each command runs again on main and what it wrote is committed (regen_run). A
# conflict in any other file stops as before. Such a ship holds the line (QUEUE_HOLD). Land and --into only; the prompt
# baseline is this step's built-in case. shortcut: a modify/delete conflict in a declared file, or a .gitattributes
# merge= on one, still stops, and a hand edit to a declared file is lost when main changed it too.
regen_setup() {
  regen_cmds=() regen_pats=() regen_attrs=''
  if [[ $mode = land || $mode = into ]]; then
    regen_from=main
    [ "$mode" = land ] || regen_from=refs/heads/$build
    # From the branch as it was before the rebase on a re-run: a declared commit whose files main already has drops out of it.
    mapfile -t regen_cmds < <(git log --reverse --format='%(trailers:key=Regenerate,valueonly,unfold)' "$regen_from..${LAND_PRE:-HEAD}" |
      awk 'NF && !seen[$0]++')
    read -ra regen_pats <<<"$(git log --format='%(trailers:key=Regenerate-files,valueonly,unfold)' "$regen_from..${LAND_PRE:-HEAD}" | tr '\n' ' ')" || true
    [ ${#regen_cmds[@]} -gt 0 ] || [ ${#regen_pats[@]} -eq 0 ] || refuse "$branch has a Regenerate-files: trailer but no Regenerate: <command> one: add the command that writes them (git commit --allow-empty with both trailers), then this again. Nothing landed"
    [ ${#regen_pats[@]} -gt 0 ] || [ ${#regen_cmds[@]} -eq 0 ] || refuse "$branch has a Regenerate: trailer but no Regenerate-files: <patterns> one naming what the command writes: add it (git commit --allow-empty with both trailers), then this again. Nothing landed"
    for p in "${regen_pats[@]}"; do
      case $p in '!'* | '#'* | *=*) refuse "Regenerate-files: takes plain .gitattributes patterns, not \"$p\". Nothing landed" ;; esac
    done
    if [ ${#regen_cmds[@]} -gt 0 ]; then
      regen_attrs=$(git rev-parse --absolute-git-dir)/land-regen.attributes
      { cat "$tools/ship-numbers.attributes"; printf '%s citadel-regen merge=citadel-regen\n' "${regen_pats[@]}"; } >"$regen_attrs.$$"
      mv -f "$regen_attrs.$$" "$regen_attrs"
    fi
  fi
  # What to do about a conflict, the same for a rebase or merge that stopped and for the early check below.
  regen_hint=" If every conflicted file is a command's output (a reformat, a baseline, generated files), declare it instead: a commit with the trailers Regenerate: <command> and Regenerate-files: <those files>, and the ship makes them again on main"
  return 0
}

land_rebase() {
  old=$(git -C "$SOURCE" rev-parse main)
  if [ "$mode" = build ] && [ "$redo" = 1 ]; then
    git reset -q --keep "$base" # main went back while this waited: main is merged in again without what came off it
  fi
  under=$(under_of) # under_of (tools/land/prepare.sh): a commit that came off main, which the rebase leaves behind
  [ -n "$pre" ] || pre=$(git rev-parse HEAD)
  case $mode in
    land)
      [ -z "$under" ] || say "$branch sits on $(git log -1 --format='%h "%s"' "$under"), which came off main when its deploy was rolled back: leaving it behind"
      [ -n "$quiet" ] || queue_phase "rebasing onto main"
      [ -n "$quiet" ] || say "rebasing $branch onto main ($(git log -1 --format='%h "%s"' main))"
      # The same rebase, made by the early next train (early_next), so CI may have run it already. --keep refuses to
      # overwrite an edit or an untracked file: then the rebase runs and says why.
      if [ -z "$under" ] && c=$(stacked_of "$(git rev-parse main)" "$(git rev-parse HEAD)") && git reset -q --keep "$c" 2>/dev/null; then :
      elif numbers_git ours "${rr[@]}" rebase -q ${under:+--onto} main ${under:+"$under"}; then :
      elif rerere_on . numbers_git ours; then say "the fix recorded ahead of time (git rerere, conflict prep) resolved the rebase's conflicts"; retro_log "train prep replayed · $label onto main ($(git rev-parse --short main))"
      else conflict main rebase "the rebase onto main failed (see git's output above), so nothing landed"; fi ;;
    into | full)
      if git merge-base --is-ancestor "$base" HEAD; then
        say "$build is already under $branch: no rebase"
      else
        # A rebase would flatten the build minion's merge of main.
        [ "$mode" = into ] || refuse "$build has commits this branch doesn't: run git merge $build (not a rebase), re-test, then run this again. Nothing merged"
        say "rebasing $branch onto $build ($(git log -1 --format='%h "%s"' "$base"))"
        numbers_git ours rebase -q "$base" ||
          conflict "refs/heads/$build" rebase "the rebase onto $build failed (see git's output above), so $build is untouched"
      fi
      claims_check main ;; # again under the lock: a feeder that merged while this waited may own a file now
    build)
      # The same commit under a build sits below its merges of main and can't be left behind, so it is reverted by hand.
      while read -r t b; do
        git merge-base --is-ancestor "$t" HEAD 2>/dev/null && ! git merge-base --is-ancestor "$t" main 2>/dev/null || continue
        # Not `git log | grep -q` (#646): grep stops at its match, git log dies of SIGPIPE, and pipefail reads that as "not there".
        said=$(git log --format=%B main..HEAD)
        ! grep -qF "This reverts commit $t" <<<"$said" || continue
        refuse "$build carries $(git log -1 --format='%h "%s"' "$t"), which came off main when its deploy was rolled back, so landing it would put that back live. Nothing landed: on your branch, revert what it brought (git revert --no-edit main..$(git rev-parse --short "$t")), run tools/land.sh --into $build --full, then this again"
      done < <(cat "$state/taken-back" 2>/dev/null || true)
      if git merge-base --is-ancestor main HEAD; then
        [ -n "$quiet" ] || say "$build already has main ($(git log -1 --format='%h "%s"' main))"
      else
        [ -n "$quiet" ] || queue_phase "merging main into $build"
        say "merging main ($(git log -1 --format='%h "%s"' main)) into $build on $branch"
        numbers_git theirs merge -q --no-edit main || conflict main merge "merging main into $build failed (see git's output above), so nothing landed"
      fi ;;
  esac
  return 0
}

land_regen() {
  adr_onto=
  case $mode in land | build) adr_onto=main ;; into) adr_onto=refs/heads/$build ;; esac # the build's lock holds it at $base
  if [ -n "$adr_onto" ]; then
    adr_commit "$adr_onto" "$branch" || refuse "renumbering this branch's ADRs failed (see above), so nothing landed. Run git status, put back what it left, then this again"
    [ -z "$renamed" ] || [ "$mode" != into ] || claims_check main # its link rewrites may reach a file another feeder claims
  fi
  n=${branch#ticket/} n=${n%%-*}
  for c in "${regen_cmds[@]}"; do regen_run "${n:+#$n: }regenerated at ship time: $c" "$c" "${regen_pats[@]}"; done
  # The prompt baseline (#1418), the built-in case: a branch that changed it got main's copy from the merge, so it is
  # measured again on the merged prompts. shortcut: not for --build, whose merge keeps main's baseline; upgrade if that goes stale and bites.
  if [[ $mode = land || $mode = into ]] && [ -f test/prompt-budget.test.ts ] && ! git diff --quiet "$(git merge-base "$adr_onto" "$pre")" "$pre" -- test/prompt-baseline.json; then
    regen_run "${n:+#$n: }test/prompt-baseline.json measured again at ship time" "PROMPT_BASELINE=write $(printf %q "$tools/citadel-node") --no-warnings --test test/prompt-budget.test.ts >/dev/null 2>&1 || true" test/prompt-baseline.json
  fi
  # The type baseline (#2141): a commit that only lowered it took main's (ship-numbers.ts), so --update lowers it again.
  # shortcut: not for --build, whose lowerings wait for the next --update; upgrade if a build's slack baseline bites.
  if [[ $mode = land || $mode = into ]] && [ -f tools/typecheck.ts ] &&
    ! git diff --quiet "$(git merge-base "$adr_onto" "$pre")" "$pre" -- test/typecheck-baseline.json; then
    regen_why="after the rebase onto ${adr_onto#refs/heads/}, node tools/typecheck.ts --update refused on $branch, so nothing"
    regen_why+=" landed and $untouched. Fix it on your rebased branch, commit, then this again. It said"
    regen_run "${n:+#$n: }test/typecheck-baseline.json measured again at ship time" \
      "CITADEL_TEST_FILES=0 $(printf %q "$tools/citadel-node") --no-warnings tools/typecheck.ts --update" test/typecheck-baseline.json
    regen_why=
  fi

  lost_title || refuse "$lost. Nothing landed" # again on the rebased commit, after the smoke check

  if [ "$mode" = land ] || [ "$mode" = into ]; then
    onto=main
    [ "$mode" = land ] || onto=$base
    urc=0
    undone=$(undo_guard "$onto") || urc=$?
    if [ "$urc" != 0 ]; then
      [ "$urc" = 1 ] || refuse "the undo check itself failed (exit $urc, above), so nothing landed and $untouched; a person needs to look"
      printf 'land: %s\n' "$branch removes what these landed, without naming them:" >&2
      printf 'land: %s\n' "$undone" >&2
      refuse "nothing landed and $untouched. A squash onto a newer ${build:-main} keeps the branch's old files, which reverts what landed since (git reset --soft from a branch that started further back). Find the branch's last commit before the squash (git reflog), rebase that onto ${build:-main}, and squash only then: git reset --soft \$(git merge-base HEAD ${build:-main}). If the undo is meant, add a line \"Undoes: <sha>\" to a commit message for each commit above, then run this again"
    fi
  fi

  [ "$mode" = into ] || [ "$mode" = full ] || bad_check
  return 0
}
