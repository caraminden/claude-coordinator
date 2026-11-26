# shellcheck shell=bash
# Before the line: the base a branch builds on, ship-time number merges, conflict fixes, rerere, early checks and the smoke run.
# Sourced by tools/land.sh up front: definitions only (#2099).

# A commit that came off main again (its restart was rolled back) while this branch was already rebased onto it
# (#566: the gate runs beside that restart) is still under this branch, and a plain rebase would carry it back onto
# main. It is left behind, unless it is this branch's own: this prints the newest such commit, for the rebase's --onto.
under_of() {
  local t b u=''
  [ "$mode" = land ] || return 0
  while read -r t b; do
    [ "$b" != "$branch" ] && git merge-base --is-ancestor "$t" HEAD 2>/dev/null && ! git merge-base --is-ancestor "$t" main 2>/dev/null || continue
    { [ -n "$u" ] && git merge-base --is-ancestor "$t" "$u"; } || u=$t
  done < <(cat "$state/taken-back" 2>/dev/null || true)
  echo "$u"
}

# Ship-time merges (#1221, #1418): git with the kit core's driver (tools/land-core.sh --merge, MERGES in land.local.sh) for
# the files tools/ship-numbers.attributes names: a SCHEMA_HISTORY number main took moves on (ship-numbers.ts), MIGRATIONS
# lines and README's Layout rows (#2104) both added stay, budgets, size caps and judges' counts add up, the prompt baseline is
# main's, measured again below. The rest conflicts as before. <main side>: main's or the build's (ours for merge-tree and a rebase, theirs for --build's
# merge of main). Not for a person's rebase. A tools/ without the core (mid-rebase) renumbers only, or merges as git would.
numbers_git() {
  local side=$1
  shift
  git -c "core.attributesFile=${regen_attrs:-$tools/ship-numbers.attributes}" -c "merge.citadel-regen.name=land.sh: a Regenerate file, made again after the rebase" -c merge.citadel-regen.driver=true \
    -c "merge.citadel-numbers.name=land.sh's ship-time merges" \
    -c "merge.citadel-numbers.driver=if [ -f '$tools/land-core.sh' ]; then CITADEL_TOOLS='$tools' bash '$tools/land-core.sh' --merge $side %O %A %B %P; elif [ -f '$tools/ship-numbers.ts' ]; then '$tools/citadel-node' --no-warnings '$tools/ship-numbers.ts' merge $side %O %A %B; else git merge-file %A %O %B; fi" "$@"
}

# A conflict in src/db.ts the driver couldn't sort out: the number to take, from <onto>'s history.
number_hint() {
  local n
  case ", $1, " in *", src/db.ts, "*) ;; *) return 0 ;; esac
  n=$(git show "$2:src/db.ts" 2>/dev/null | sed -n '/^export const SCHEMA_HISTORY = \[$/,/^\] as const;$/p' | grep -oE '^  \[[0-9]+' | tail -n 1 | tr -dc 0-9)
  [ -z "$n" ] || echo " SCHEMA_HISTORY ends at $n on ${2#refs/heads/}: number this branch's new lines from $((n + 1)), and its schema_version checks with them."
}

conflict_fix() {
  case $mode in
    land) echo "On conflicts: run git rebase ${under:+--onto }main${under:+ $(git rev-parse --short "$under")}, resolve them keeping the other minions' changes, re-test, commit, then run this again.$regen_hint" ;;
    into) echo "On conflicts: run git rebase $build, resolve them keeping the other feeders' changes, re-test, commit, then run this again.$regen_hint" ;;
    build) echo "Take main in on your branch by hand (tools/citadel-node tools/ship-numbers.ts take main: git merge main that renumbers the build's schema lines main took), resolve it keeping both sides, run tools/land.sh --into $build --full, then this again" ;;
  esac
}

# <onto>: git merge-tree's trial of that rebase. 1 on a conflict, its files (comma-separated) in $mt_files.
trial() {
  local out rc=0 at gd
  mt_files=''
  gd=$(git rev-parse --absolute-git-dir) && at=$(attrs_of "$1") || return 0
  out=$(top=$(git rev-parse --show-toplevel) && cd "$at" && LAND_TOP=$top GIT_INDEX_FILE=$at/.index numbers_git ours --git-dir="$gd" --work-tree="$at" merge-tree --write-tree --name-only --no-messages ${under:+"--merge-base=$under"} "$1" HEAD 2>/dev/null) || rc=$?
  rm -rf "$at"
  [ "$rc" = 1 ] || return 0
  mt_files=$(sed -n '2,${/^$/q;p}' <<<"$out" | sort -u | sed ':a;N;$!ba;s/\n/, /g')
  return 1
}

# <dir> <git or numbers_git ours>: after a rebase in <dir> stopped, go on while every stop is one rerere resolved in full
# (git stops even then): no file left unmerged. 1 at any other stop, the rebase left for the caller.
rerere_on() {
  local d=$1 n step
  shift
  [ ${#rr[@]} -gt 0 ] || return 1
  for ((n = 0; n < 1000; n++)); do
    [ -d "$(git -C "$d" rev-parse --absolute-git-dir)/rebase-merge" ] && [ -z "$(git -C "$d" diff --name-only --diff-filter=U)" ] || return 1
    # Nothing staged: the recorded fix kept the other side whole, so this commit is empty now and drops out.
    if git -C "$d" diff --cached --quiet; then step=--skip; else step=--continue; fi
    GIT_EDITOR=true "$@" -C "$d" "${rr[@]}" rebase "$step" >/dev/null 2>&1 && return 0
  done
  return 1
}

# <onto> <commit>: the stack the early next train (early_next, below) or a ship's own check (tools/own-check.sh) made of
# that commit on that one, if it is still there.
stacked_of() {
  local c
  c=$({ cat "$state/stacked" "$state/own-checked" 2>/dev/null || true; } | awk -v k="$1 $2" '$1 " " $2 == k { print $3; exit }') && [ -n "$c" ] && git cat-file -e "$c^{commit}" 2>/dev/null && echo "$c"
}

# <onto>: whether the rebase onto <onto>, which trial() says stops, goes through with the fixes recorded with git rerere.
# Replayed in a scratch worktree, so no ref or worktree of the minion's moves. shortcut: a checkout each time (about 1 s
# for Citadel's 18 MB), only after trial() found a conflict; cache by commits if that ever runs often.
rerere_covers() {
  local wt base ok=1
  [ ${#rr[@]} -gt 0 ] && base=${under:-$(git merge-base "$1" HEAD)} && wt=$(mktemp -d "${TMPDIR:-/tmp}/land-prep.XXXXXX") || return 1
  if git worktree add -q --detach "$wt" HEAD >/dev/null 2>&1; then
    { numbers_git ours -C "$wt" "${rr[@]}" rebase -q --onto "$1" "$base" >/dev/null 2>&1 || rerere_on "$wt" numbers_git ours; } && ok=0
    git -C "$wt" "${rr[@]}" rebase --abort >/dev/null 2>&1 || true # with rerere on, so it drops the preimage it left
    git worktree remove --force "$wt" >/dev/null 2>&1 || true
  fi
  rmdir "$wt" 2>/dev/null || true
  return $ok
}

early_check() {
  local files at
  trial "$1" && return 0
  files=$mt_files
  if rerere_covers "$1"; then
    say "$branch conflicts with ${1#refs/heads/} by git merge-tree $2 (${files:-no files named}), but a fix recorded ahead of time (git rerere, conflict prep) resolves it"
    return 0
  fi
  at=$(git log -1 --format='%h "%s"' "$1")
  retro_log "land conflict · $label onto ${at%% *}: ${files:-no conflicted files named} · $2"
  say "$branch won't $([ "$mode" = build ] && echo "merge ${1#refs/heads/} in" || echo "rebase onto ${1#refs/heads/}") ($at) cleanly, by git merge-tree $2, so nothing landed${files:+; conflicted files: $files}.$(number_hint "$files" "$1") $(conflict_fix)"
  return 1
}

# The smoke check (#1012): before the line, the checks that fail in seconds, so a land they refuse never waits in line
# or for CI (#1006: about 40 of 86 refusals at the lock were these). It reads the branch's own tools (a repo without
# one skips that check). Tests that run past LAND_SMOKE_TIMEOUT (300 s) don't decide: CI still runs everything.
# shortcut: the tests run on the branch as it is, not on its rebase onto main; a break only the two together make
# still meets CI in line. Run them on a merge-tree commit if those show up. Off: LAND_SMOKE=0.
smoke() {
  local t0=$SECONDS out rc=0 tests=() f lost left=()
  smoke_fail() {
    retro_log "smoke · $label · $1 · $((SECONDS - t0))s"
    refuse "smoke: $1, before the line ($((SECONDS - t0)) s), so nothing landed and nobody waited on it. Fix it, re-test (citadel-test), commit, then run this again${formatted:+. tools/land.sh $formatted}"
  }
  say "smoke: checking $branch before it queues"
  if [ "$mode" != full ]; then
    under=$(under_of)
    early_check main "before the line" || smoke_fail "it conflicts with main"
  fi
  # What waited in line to hear it (#1983). A plain ship's without the same patches on main, and under_of's, which its rebase leaves out; one it would empty is named.
  [ "$mode" != land ] || left=(--cherry-pick --right-only main...HEAD ${under:+"^$under"})
  lost_title "${left[@]}" || { say "smoke: $lost. If main already has that commit's change, git rebase main drops it"; smoke_fail "a commit title is wrong"; }
  if [ -f tools/parse-check.ts ]; then
    out=$("$tools/citadel-node" --no-warnings tools/parse-check.ts 2>/dev/null) || true
    [ -z "$out" ] || { sed 's/^/land: smoke: /' <<<"$out" >&2; smoke_fail "a .ts file does not parse"; }
  fi
  # Instruction files that name a repo path that is gone (#1395): only the dead paths this branch adds, so a scheme's old debt
  # never blocks a ship. Every scheme's repo; a tool that is missing or errors is skipped, never a refusal.
  if [ -x "$tools/stale-docs" ] && [ "$mode" = land ]; then
    out=$("$tools/citadel-node" "$tools/stale-docs" refs --new-since "$(git merge-base main HEAD)" 2>/dev/null) && rc=0 || rc=$?
    if [ "$rc" = 1 ]; then sed 's/^/land: smoke: /' <<<"$out" >&2; smoke_fail "an instruction file names a path that is not in the repo (tools/stale-docs refs: fix the line, or allow-list it in .stale-docs-allow with a reason)"; fi
    rc=0
  fi
  if [ -x tools/citadel-test ] && [ -f tools/always-tests.txt ]; then
    # The always-tests, and in a plain land the test files the branch adds or changes; citadel-test drops repeats.
    mapfile -t tests < <(grep -vE '^[[:space:]]*(#|$)' tools/always-tests.txt; [ "$mode" != land ] || git diff --name-only --diff-filter=d "$(git merge-base main HEAD)" HEAD -- 'test/*.test.ts'; [ -z "$formatted" ] || ls test/size-budget.test.ts 2>/dev/null)
    # The map's @pinned tests when it picks them for this branch's changes (#1544, #2037; an older map: the route test alone).
    if [ -f tools/affected.ts ]; then
      local pinned=" $(sed -n 's/^@pinned[[:space:]]//p' tools/affected-map.txt 2>/dev/null | tr '\n' ' ') " && [ -n "${pinned// /}" ] || pinned=" test/access-matrix.test.ts "
      if aff=$("$tools/citadel-node" --no-warnings tools/affected.ts --root . --base "$(git merge-base main HEAD)" 2>/dev/null); then
        for f in $(awk -F'\t' '$1 == "run" { print $2 }' <<<"$aff"); do case "$pinned" in *" $f "*) [ ! -f "$f" ] || tests+=("$f") ;; esac; done
      else
        say "smoke: the affected map couldn't answer, so its pinned tests run"; for f in $pinned; do [ ! -f "$f" ] || tests+=("$f"); done
      fi
    fi
    # Sent back by its last ship for these (pulled_out): they pass here before it boards again.
    while read -r f; do
      [ ! -f "$f" ] || { say "smoke: $f failed $branch's last ship, so it runs here first"; tests+=("$f"); }
    done < <(cat "$state/pulled/${branch//\//-}" 2>/dev/null)
    if [ ${#tests[@]} -gt 0 ]; then
      say "smoke: running ${#tests[@]} test files"
      out=$(CITADEL_TEST_FILES=0 tools/citadel-test --timeout "${LAND_SMOKE_TIMEOUT:-300}" "${tests[@]}" 2>&1) || rc=$?
      if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
        say "smoke: the tests ran past ${LAND_SMOKE_TIMEOUT:-300} s, so they don't decide: getting in line, and CI runs them all"
      elif [ "$rc" = 2 ]; then # citadel-test couldn't start them (its usage and setup errors), which says nothing about the branch
        say "smoke: citadel-test couldn't run the tests ($(grep -m1 '^citadel-test: ' <<<"$out" || echo exit 2)), so they don't decide: getting in line"
      elif [ "$rc" != 0 ]; then
        # Each failed file once more on its own (no always-tests), as run-tests.sh does: one that passes alone is a
        # likely flake from load, which doesn't decide here (ADR 0006) and gets a flake line. A failure no file names fails.
        local failed=() still=()
        mapfile -t failed < <(sed -nE 's/^✖ ([^ :]+\.test\.ts)(:[0-9]+)? › .*/\1/p' <<<"$out" | sort -u)
        for f in "${failed[@]}"; do
          CITADEL_TEST_FILES=0 CITADEL_TEST_ALWAYS=/dev/null tools/citadel-test --timeout "${LAND_SMOKE_TIMEOUT:-300}" "$f" >/dev/null 2>&1 || still+=("$f")
        done
        if [ ${#failed[@]} -gt 0 ] && [ ${#still[@]} -eq 0 ]; then
          for f in "${failed[@]}"; do retro_log "flake · $f · smoke · $label"; say "flake: $f · smoke"; done
          say "smoke: ${failed[*]} failed, then passed alone: likely load, not your change, so it doesn't decide: getting in line"
        else
          grep -v '^full output: ' <<<"$out" | tail -n 60 | sed 's/^/land: smoke: /' >&2
          smoke_fail "tests failed (exit $rc)"
        fi
      fi
    fi
  fi
  [ "$rc" != 0 ] || rm -f "$state/pulled/${branch//\//-}" # past its time limit, they haven't passed
  say "smoke: passed in $((SECONDS - t0)) s"
}

prep_check() {
  local top fb fp key files c b cause='' head base
  [ ${#rr[@]} -gt 0 ] && read -r top fb fp 2>/dev/null <"$state/train-top" && [ -n "$top" ] && [ "$fb" != "$branch" ] && kill -0 "$fp" 2>/dev/null || return 0
  [ "$top" != "$(git rev-parse -q --verify refs/heads/main)" ] && git cat-file -e "$top^{commit}" 2>/dev/null || return 0
  head=$(git rev-parse HEAD)
  key="$top $head $(find "$(git rev-parse --path-format=absolute --git-common-dir)/rr-cache" -name 'postimage*' 2>/dev/null | wc -l)"
  [ "$key" != "$prepped" ] || return 0
  prepped=$key under=$(under_of)
  trial "$top" && return 0
  files=$mt_files
  while read -r c b; do trial "$c" || { cause=$b; break; }; done < <(tail -n +2 "$state/train-top" 2>/dev/null)
  if rerere_covers "$top"; then
    say "prep: $branch conflicts with ${cause:-a ship} on $fb's ship train ($files), but the fix recorded ahead of time (git rerere) resolves it, so its rebase goes through once that train ships"
    return 0
  fi
  base=${under:-$(git merge-base "$top" HEAD)}
  retro_log "train prep conflict · $label onto $fb's train ($(git rev-parse --short "$top")) · ${cause:-?}: $files"
  say "prep: $branch will conflict with ${cause:-a ship} once $fb's ship train ships; conflicted files: ${files:-none named}; record the fix against $top from $base to $head"
  return 0
}

# <onto> <rebase|merge> <refusal>: a rebase or merge that stopped. Which files collide is worth a retro-log
# line (the architecture check counts them).
conflict() {
  local conflicted what
  conflicted=$(git diff --name-only --diff-filter=U 2>/dev/null | sed ':a;N;$!ba;s/\n/, /g' || true)
  if [ -n "$conflicted" ]; then what=" onto $(git log -1 --format=%h "$1"): $conflicted"; else what=": no conflicted files found (the $2 may not have started)"; fi
  retro_log "land conflict · $label$what"
  git "${rr[@]}" "$2" --abort 2>/dev/null || true # nothing to abort if it never started (an untracked file in the way)
  refuse "$3${conflicted:+; conflicted files: $conflicted}.$(number_hint "$conflicted" "$1") $(conflict_fix)"
}

# <commit title> <command> <patterns...>: run a Regenerate command (land.sh's Regenerate comment) on the rebased branch and commit what it
# changed, if anything. It may change only files the patterns (all the branch declared) name: when it fails or writes
# elsewhere, the worktree is put back and the land refused. Its fds 6, 7 and 9 (the locks) are closed, so a process it
# leaves behind can't hold the line.
regen_run() {
  local title=$1 cmd=$2 log rc=0 was chk out=() bad=() new=() why
  shift 2
  was=$(git -c core.quotePath=false ls-files --others --exclude-standard)
  log=$(mktemp "${TMPDIR:-/tmp}/land-regen.XXXXXX")
  [ -n "$quiet" ] || say "making ${*} again on main ($(git rev-parse --short HEAD)): $cmd"
  (timeout "${LAND_REGEN_TIMEOUT:-900}" bash -c "$cmd") </dev/null >"$log" 2>&1 9>&- 7>&- 6>&- || rc=$?
  mapfile -t new < <(comm -13 <(sort <<<"$was") <(git -c core.quotePath=false ls-files --others --exclude-standard | sort) | awk NF)
  mapfile -t out < <({ git -c core.quotePath=false diff --name-only HEAD; printf '%s\n' "${new[@]}"; } | awk 'NF && !seen[$0]++')
  if [ ${#out[@]} -gt 0 ]; then
    chk=$(git rev-parse --absolute-git-dir)/land-regen-check.attributes
    printf '%s citadel-regen\n' "$@" >"$chk"
    mapfile -t bad < <(printf '%s\n' "${out[@]}" | git -c "core.attributesFile=$chk" check-attr --stdin citadel-regen | awk -F': ' '$NF != "set" { print $1 }')
  fi
  if [ "$rc" != 0 ] || [ ${#bad[@]} -gt 0 ]; then
    git reset -q --hard HEAD
    [ ${#new[@]} -eq 0 ] || git --literal-pathspecs clean -fq -- "${new[@]}"
    why=$(tail -n 5 "$log" | tr '\n' ' ')
    rm -f "$log"
    [ "$rc" = 0 ] || refuse "the Regenerate command \`$cmd\` $([ "$rc" = 124 ] && echo "ran past ${LAND_REGEN_TIMEOUT:-900} s" || echo "failed (exit $rc)") on main ($(git rev-parse --short HEAD)), so nothing landed and what it wrote was put back${why:+. Its output ended: $why}. Run it on your rebased branch, fix it, commit, then this again"
    refuse "the Regenerate command \`$cmd\` changed files outside Regenerate-files ($*): $(echo "${bad[@]}"), so nothing landed and they were put back. Add them to Regenerate-files: or stop the command writing them, then this again"
  fi
  rm -f "$log"
  [ ${#out[@]} -gt 0 ] || return 0
  git --literal-pathspecs add -A -- "${out[@]}"
  git diff --cached --quiet || git commit -q -m "$title" -m "Made again on main ($(git rev-parse --short main)) by tools/land.sh (#1827)."
}

# The undo guard (#677, after Peek Auras #361's tools/undo-guard.sh): prints, and exits 1 on, the commits among
# <onto>'s last 60 that this branch reverts without seeing them. A stale squash does that behind a clean
# fast-forward with CI green: `git reset --soft main` from a branch that started further back keeps its old files
# (Peek Auras #309 undid six landings so). A commit counts when the branch removes 90% of the lines it added (4 or
# more, repeats included, of 12+ characters, compared trimmed; a removed line is a move, not a removal, only as
# many times as the branch adds that text back in any file, so a revert that also puts back older copies of a
# repeated line like "linked: null" still counts: The Trans Agenda #66) and, if it removed lines, puts at least half
# of those back. shortcut: the add-backs go to the branch's other removals of that text first, so merging two
# identical files, one of them recent, reads as undoing it (none in ~1,090 landings); if one shows up, credit the
# add-backs to the commit's own lines first, which scores a stale squash of several exports lower (96% to 93%).
# Commits of the branch's own ticket don't count (ticket/N-… against a subject's leading "#N" or "WIP #N" or last
# "#N)"); an undo that is meant names each one in a message line "Undoes: <sha>" (git revert's "This reverts commit
# <sha>" counts too). Tried on 2026-11-14 over ~690 landings in four schemes: it refused the stale squash, two
# deliberate removals of another minion's work (what the trailer is for), and nothing else; the line counts of
# 2026-11-15 refused the same over ~1,090 landings in seven.
undo_guard() {
  local base
  base=$(git merge-base HEAD "$1") || return 2
  perl -e '
    use strict; use warnings; use List::Util qw(min max);
    my ($base, $ticket) = @ARGV;
    sub run { my $out = `$_[0]`; $? == 0 or die "undo guard: $_[0] failed\n"; $out }
    sub lines { # how many times a diff adds (+) or removes (-) each trimmed line of 12+ characters, keyed by file
      my ($sign, $cmd) = @_; my (%set, $f);
      for (split /\n/, run("git -c core.quotePath=false $cmd")) {
        if (/^diff /) { undef $f; next }
        if (/^--- (?:a\/(.*)|\/dev\/null)$/) { $f = $1; next } # a deleted file is named here only
        if (/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/) { $f = $1 // $f; next }
        next if /^@@/ || !defined $f;
        $set{"$f\0$1"}++ if /^\Q$sign\E\s*(.*?)\s*$/ && length $1 >= 12;
      }
      \%set;
    }
    sub text { (split /\0/, $_[0], 2)[1] }
    sub ticket { my $s = shift; return $1 if $s =~ /^(?:WIP:? )?#(\d+)\b/; my @t = $s =~ /#(\d+)\)/g; @t ? $t[-1] : "" }
    my @named = run("git log --format=%B $base..HEAD") =~ /^(?:Undoes: *|This reverts commit )([0-9a-f]{7,40})\b/mg;
    my $diff = "diff -U0 --no-renames --no-color $base HEAD";
    my ($removed, $added) = (lines("-", $diff), lines("+", $diff));
    my %net; # per text, how many more lines the branch removes than adds back anywhere
    $net{text($_)} += $removed->{$_} for keys %$removed;
    $net{text($_)} -= $added->{$_} for keys %$added;
    my @bad;
    for (split /\n/, run("git log --no-merges --format=\"%H %s\" -60 $base")) {
      my ($c, $s) = /^(\S+) (.*)/ or next;
      next if $ticket ne "" && ticket($s) eq $ticket;
      next if grep { index($c, $_) == 0 } @named;
      my $show = "diff-tree -p --root -U0 --no-renames --no-color --format= $c";
      my $put = lines("+", $show);
      my ($n, $gone, %here) = (0, 0);
      for (keys %$put) { $n += $put->{$_}; $here{text($_)} += min($put->{$_}, $removed->{$_} // 0) }
      next if $n < 4;
      $gone += min($here{$_}, max(0, $net{$_} // 0)) for keys %here;
      next if $gone < 0.9 * $n;
      my $took = lines("-", $show);
      my $back = grep { $added->{$_} } keys %$took;
      next if keys %$took && $back < 0.5 * keys %$took;
      push @bad, sprintf("  %s %s (%d of the %d lines it added are removed here)", substr($c, 0, 12), $s, $gone, $n);
    }
    exit 0 unless @bad;
    print join("\n", @bad), "\n";
    exit 1;
  ' "$base" "$(sed -nE 's|^ticket/([0-9]+)-.*|\1|p' <<<"$branch")"
}
