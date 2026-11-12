#!/usr/bin/env bash
# Land a minion's branch on main: run it from the minion's worktree once its work is committed.
#   tools/land.sh
# This is the route CLAUDE.md names under "Project facts", "How a change ships". One landing at a
# time, under a lock in the scheme repo's .git, in the order they asked: it says its place in line
# and waits as long as the line moves, so run it in the background with a long timeout (a run that
# is stopped loses its place).
# 1. Rebases the branch onto the local main. A conflict stops here.
# 2. Refuses when the branch takes a number main already has (a migration, a version, a ledger id),
#    as the "Numbered things" line in Project facts names them. No line, or "none": no check.
# 3. Runs the check command on the rebased commit, within LAND_CHECK_TIMEOUT whole seconds (default
#    1800). A failure or overrun stops here.
# 4. With the CI gate on (below): pushes the commit to the scratch branch land/<branch> on origin and
#    waits for CI to pass exactly that commit. Red stops here. On the way out the scratch branch is
#    deleted and its unfinished runs cancelled, except those of a commit that landed: they finish, so
#    main's CI can reuse what they pass.
# 5. Fast-forwards main in the scheme's main checkout to the commit.
# 6. Pushes main to origin from the main checkout, never forced. A failed push is reported and main
#    stays moved; the next landing pushes it again.
# Until step 5 main is untouched. The branch itself only moves when it lands, or to the rebased
# commit when the check or CI was red on top of main (so the fix starts from there); anything else
# leaves it where it was. While this runs, the worktree sits on a detached commit: don't work in it.
# Exit: 0 landed; 1 refused (a conflict, a clash, a red check, red CI) or main moved but its push
# failed; 75 CI gave no verdict (no runner took the run, it ran too long, or it was lost twice; or,
# for LAND_CI_DOWN seconds after a landing waited out one of those limits, no runner has taken this one's yet):
# nothing is wrong with the branch and nothing landed, so park and run this again once a person says
# the runners are back.
set -euo pipefail

# The check command, exactly as Project facts names it under "Check commands" ('true' while it has none).
# With the CI gate on it is what runs here before anything is pushed: keep it light.
CHECK='npm test'
# The scheme's main branch.
BRANCH=main
# The file whose Project facts may have a "Numbered things" line.
FACTS=CLAUDE.md

# The CI gate: off while both of these are empty.
# CI_WORKFLOWS: the workflow files that must all be green on the exact commit that lands, split by
#   spaces: 'windows.yml' or 'ci.yml android.yml'. Each needs "land/**" among its push branches:
#     on:
#       push:
#         branches: [main, 'land/**']
#   and a concurrency group per ref (group: <name>-${{ github.ref }}), or the stacked runs below
#   wait for each other. A run that succeeded with a job skipped is not green, and is refused rather than
#   run again (it would skip again): a workflow whose jobs are skipped on purpose needs CI_STATUS.
# CI_STATUS: only when "every workflow green" is not the scheme's rule (a workflow that blocks only
#   when red, one that runs only for some paths): the scheme's own command. It gets the commit as
#   its one argument and answers by exit code: 0 green, 1 red, 2 running, 3 not started (no run yet,
#   or still queued), 4 ended without a verdict (cancelled, the runner lost, its jobs skipped);
#   anything else: no answer this time. What it prints is shown when CI is red. It must judge the
#   newest run on that commit.
CI_WORKFLOWS=''
CI_STATUS=''
# How many landings at the front of the line run CI at once, each on top of the ones ahead of it
# (below, "The stack"). 1: only the head of the line. Runners that can't carry three runs at once: 2.
CI_STACK=${LAND_STACK_DEPTH:-3}

say() { echo "land: $*" >&2; }
refuse() { say "$*"; exit 1; }
park() { say "$*"; exit 75; }

# A turn in its person's Claude container has its own pid namespace: this script there can't see the landings
# running on the host, so it would delete their places in line as dead, and they its own (Theory of Crafting,
# 2026-11-11). Citadel's land tool runs it on the host for such a turn.
[ "${COORDINATOR_CONTAINER:-}" != 1 ] || refuse "this turn runs in a container: call the land tool (mcp__thread) instead, which runs land.sh on the host"

# The line for the land lock. The lock itself is the flock on <.git>/land.lock, on fd 9: that alone
# keeps landings one at a time. The kernel grants a flock in no order, though, so several landings
# waiting on it meant some lost every round and timed out (2026-11-10). So waiters line up first:
# each takes a numbered ticket file in <.git>/land-queue, and only the oldest ticket tries the lock.
#   queue_join <.git dir> <label>   take a ticket at the end of the line
#   queue_look                      one look at the line: Q_AHEAD is how many are ahead; with none,
#                                   it takes the lock (Q_HELD). Returns 1 only when nothing has moved
#                                   for QUEUE_STALL seconds.
#   queue_phase <text>              say what this one is doing now: the waiters' sign of progress
#   queue_done [ok]                 leave the line; ok: it went all the way, so its time counts
#                                   toward the waiters' estimate
# A ticket is five lines: "<pid> <the pid's start time>", when it got the lock (0 while it waits),
# its label, its phase, and the commit it built ("-" while it has none, "skip" when it can't land where
# it sits; see "The stack"). A ticket
# whose process is gone is deleted by whoever waits behind it.
# A land.sh from a branch older than the line takes the flock directly; the head of the line waits
# for it like for anyone else.
# The same line as Citadel's own tools/deploy-queue.sh, kept inline so a scheme copies one file: a
# fix to either belongs in both (the stack is only here).
#
# The stack (CI gate on, CI_STACK over 1). A landing can't know its commit until the one ahead has
# landed, so with CI in the way every landing would wait a whole CI round alone. Instead the first
# CI_STACK in line each build now: the head on main, each one behind on the commit in the ticket
# directly ahead of it, and CI runs them side by side. Only the head lands, holding the land lock
# from the moment it is head, and only a commit CI passed that sits exactly on main. When it lands,
# the next one's commit already sits on the new main, so it lands as soon as its own run is green.
# When one leaves without landing (red, a conflict, killed), the commit ahead of everyone behind it
# changes: each of them builds again on the new one and CI runs again. The ones ahead never notice.
# A ticket with no fifth line is from a land.sh older than the stack: nobody builds on it, they
# wait for it to leave.
# The commit is built on a detached HEAD from the branch as it was, so the branch never holds
# another minion's unlanded commits, whatever stops this script.
QUEUE_POLL=${LAND_QUEUE_POLL:-1}
CHECK_LIMIT=${LAND_CHECK_TIMEOUT:-1800}
[[ $CHECK_LIMIT =~ ^[0-9]+$ ]] || refuse "LAND_CHECK_TIMEOUT is in whole seconds, not \"$CHECK_LIMIT\""
[[ ${LAND_QUEUE_SLACK:-300} =~ ^[0-9]+$ ]] || refuse "LAND_QUEUE_SLACK is in whole seconds, not \"$LAND_QUEUE_SLACK\""
# CI's limits, in whole seconds, counted for the head of the line only (a run behind it may just be
# waiting for a runner the ones ahead are using): a runner takes the run within CI_START, and the run
# ends within CI_LIMIT. CI is asked every CI_POLL. For CI_GRACE after a push, an older run of the
# same commit may still be the one that answers, so red or lost is not believed yet. For CI_DOWN after a
# landing waited out CI_START or CI_LIMIT, the next ones park as soon as no runner has taken theirs.
for v in LAND_CI_START LAND_CI_TIMEOUT LAND_CI_POLL LAND_CI_GRACE LAND_CI_DOWN; do
  [[ ${!v:-0} =~ ^[0-9]+$ ]] || refuse "$v is in whole seconds, not \"${!v}\""
done
CI_START=${LAND_CI_START:-600} CI_LIMIT=${LAND_CI_TIMEOUT:-2700} CI_POLL=${LAND_CI_POLL:-20} CI_GRACE=${LAND_CI_GRACE:-60} CI_DOWN=${LAND_CI_DOWN:-600}
[[ $CI_STACK =~ ^[1-9][0-9]*$ ]] || refuse "CI_STACK is a number from 1 up, not \"$CI_STACK\""
CI_ON=1
[ -n "$CI_WORKFLOWS$CI_STATUS" ] || CI_ON='' CI_STACK=1 CI_LIMIT=0
# Give up after this long with no change at the head of the line. The head's longest single phases
# are the check (which may wait for the checks of the ones stacked behind it) and the CI run, so the
# limit is those plus slack (the 30 s a check gets to die, the 60 s push): it stays longer than them
# whatever a scheme sets them to.
# shortcut: a waiter counts with its own limits, not the holder's; write the holder's into its
# ticket if landings in one scheme ever run with different limits.
QUEUE_STALL=$((CHECK_LIMIT * CI_STACK + CI_LIMIT + ${LAND_QUEUE_SLACK:-300}))
QUEUE_TYPICAL=300 # a landing's length until some have been timed here
QUEUE_TICKET='' Q_DIR='' Q_N='' Q_ME='' Q_LABEL='' Q_AHEAD=0 Q_PRED='' Q_PREDNAME='' Q_HELD='' Q_LAST='' Q_SINCE=0 Q_SAID=''

# "<pid> <start time>" of a live process, or nothing. The start time tells a reused pid apart.
queue_proc() {
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 0
  stat=${stat##*) } # the command's name may hold spaces
  # shellcheck disable=SC2086
  set -- "$1" $stat
  # A zombie (Z, or X while it is reaped) is dead, though its /proc entry stays until its parent waits on it.
  case $2 in Z | X | x) return 0 ;; esac
  echo "$1 ${21}"
}

# The state letter of a process: T or t is stopped (a frozen unit or container, a SIGSTOP).
queue_state() {
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 0
  stat=${stat##*) }
  echo "${stat%% *}"
}

queue_write() { # <file> <pid and start> <got> <label> <phase> <commit>: by a rename, so nobody reads half a ticket
  printf '%s\n' "$2" "$3" "$4" "$5" "$6" >"$1.tmp$$" && mv -f "$1.tmp$$" "$1"
}

queue_set() { # <line, from 0> <text>: change one line of this landing's ticket
  local t=$QUEUE_TICKET l
  [ -n "$t" ] && [ -e "$t" ] || return 0
  mapfile -t l 2>/dev/null <"$t" || return 0
  l[$1]=$2
  queue_write "$t" "${l[0]:-}" "${l[1]:-0}" "${l[2]:-}" "${l[3]:-}" "${l[4]:--}" 2>/dev/null || true
}

queue_phase() { queue_set 3 "$1"; }

queue_done() {
  local t=$QUEUE_TICKET l took
  [ -n "$t" ] && [ -e "$t" ] || return 0
  mapfile -t l 2>/dev/null <"$t" || true
  # How long it held the lock, for the next waiters' estimate (the newest 5 are kept). Not a run that
  # stopped early (a conflict, a red check): a few of those would promise everyone a one-minute wait.
  if [ "${1:-}" = ok ] && [ "${l[1]:-0}" -gt 0 ] 2>/dev/null; then
    took=$(dirname "$t")/.took
    { tail -n 4 "$took" 2>/dev/null; echo $(($(date +%s) - l[1])); } >"$took.tmp$$" && mv -f "$took.tmp$$" "$took"
  fi 2>/dev/null
  rm -f "$t"
}

queue_ordinal() {
  case $1 in 1) echo next ;; 2) echo 2nd ;; 3) echo 3rd ;; *) echo "${1}th" ;; esac
}

queue_join() {
  Q_DIR=$1/land-queue Q_LABEL=$2
  mkdir -p -m 700 "$Q_DIR"
  # Unopened, it leaves a bare shell error, or a flock one a second (Citadel's drill, F12b).
  if ! { exec 9>"$1/land.lock"; } 2>/dev/null; then
    echo "queue: can't open the land lock $1/land.lock for writing, so nothing landed: a person needs to look at it" >&2
    return 1
  fi
  Q_ME=$(queue_proc $$)
  # The ticket and its number, under a lock of its own that is only ever held for these few lines: the
  # ticket is in the folder before the next number goes out, so nobody behind it can miss it.
  Q_N=$(
    exec 8>"$Q_DIR/.seq.lock"
    flock 8
    n=$(cat "$Q_DIR/.seq" 2>/dev/null) || n=0
    # Junk in it (F12c) gave out a number already in line: number on from the newest ticket instead (an empty one,
    # from a write cut off, quietly).
    if ! [[ $n =~ ^[0-9]{1,10}$ ]]; then
      t=$(find "$Q_DIR" -maxdepth 1 -regex '.*/[0-9]+' -printf '%f\n' 2>/dev/null | sort | tail -n 1)
      [ -z "$n" ] || echo "queue: $Q_DIR/.seq held no ticket number (\"$(head -c 40 <<<"$n")\"); numbering goes on from the newest ticket, $((10#${t:-0}))" >&2
      n=${t:-0}
    fi
    n=$(printf '%010d' $((10#$n + 1)))
    queue_write "$Q_DIR/$n" "$Q_ME" 0 "$Q_LABEL" waiting -
    echo "$((10#$n))" >"$Q_DIR/.seq"
    echo "$n"
  )
  QUEUE_TICKET="$Q_DIR/$Q_N" Q_SINCE=$SECONDS
}

queue_look() {
  local q=$Q_DIR t l ahead=0 head="" headname="" headpid="" sig typical sum count line detail look
  Q_PRED='' Q_PREDNAME=''
  for t in "$q"/[0-9]*; do
    [[ ${t##*/} =~ ^[0-9]+$ ]] || continue # not a ticket half-written, or the glob itself
    [[ ${t##*/} < $Q_N ]] || break
    mapfile -t l 2>/dev/null <"$t" || continue
    # Its process is gone (killed, or its turn was stopped): it leaves the line.
    if [ -z "${l[0]:-}" ] || [ "$(queue_proc "${l[0]%% *}")" != "${l[0]}" ]; then
      rm -f "$t"
      continue
    fi
    # A waiter that is stopped holds nothing, so it is passed over; it tries for the lock like the head once it wakes.
    # Those this one passed so are waiting on its lock, not ahead of it.
    if [ "${l[1]:-0}" = 0 ] && { [ -n "$Q_HELD" ] || [[ $(queue_state "${l[0]%% *}") == [Tt] ]]; }; then continue; fi
    ahead=$((ahead + 1))
    [ -n "$head" ] || { head="${l[*]}" headname="${l[2]:-?}, ${l[3]:-?}" headpid=${l[0]%% *}; }
    # The last one seen is the one directly ahead. "skip": that one is red or in conflict where it sits, and
    # lands only if what is ahead of it fails, so the ones behind build on the one ahead of it meanwhile.
    [ "${l[4]:-}" = skip ] || { Q_PRED=${l[4]:-} Q_PREDNAME=${l[2]:-?}; }
  done
  Q_AHEAD=$ahead
  [[ $Q_PRED =~ ^[0-9a-f]{40,}$ ]] || Q_PRED='' # "-": it has built nothing yet; no line: older than the stack

  if [ "$ahead" = 0 ]; then
    [ -z "$Q_HELD" ] || return 0
    # A short blocking wait, not a poll: the lockers outside the line block in the kernel, and a poller would lose to every one of them.
    if flock -w "$QUEUE_POLL" 9; then
      [ -z "$Q_SAID" ] || echo "queue: got the land lock" >&2
      Q_HELD=1
      queue_set 1 "$(date +%s)"
      return 0
    fi
    # Held by a landing behind this one in line: it passed this one while it was stopped.
    head="outside $Q_N" headname="a landing started from a branch whose land.sh is older than the line"
    for t in "$q"/[0-9]*; do
      [[ ${t##*/} =~ ^[0-9]+$ ]] && mapfile -t l 2>/dev/null <"$t" || continue
      [ "${l[1]:-0}" != 0 ] && [ "$(queue_proc "${l[0]%% *}")" = "${l[0]:-}" ] || continue
      head="${l[*]}" headname="${l[2]:-?}, ${l[3]:-?}"
      break
    done
  fi

  # Progress is any change at the head of the line: a new head, or the head's next phase.
  sig="$ahead $head"
  if [ "$sig" != "$Q_LAST" ]; then
    Q_LAST=$sig Q_SINCE=$SECONDS
    line="$(queue_ordinal $((ahead + 1))) in line for the land lock"
    if [ "$ahead" -gt 0 ]; then
      sum=0 count=0
      [ ! -f "$q/.took" ] || while read -r typical; do [[ $typical =~ ^[0-9]+$ ]] && sum=$((sum + typical)) count=$((count + 1)); done <"$q/.took" || true
      typical=$((count ? sum / count : QUEUE_TYPICAL))
      [ "$typical" -gt 0 ] || typical=1
      line="$line, about $(((ahead * typical + 59) / 60)) min"
    fi
    echo "queue: $line (ahead: $headname)" >&2
    [ -n "$Q_SAID" ] || echo "queue: the wait has no time limit while the line moves, so run this in the background with a long timeout rather than under a 10 min limit: a run that is stopped loses its place" >&2
    Q_SAID=1
  elif [ $((SECONDS - Q_SINCE)) -ge "$QUEUE_STALL" ]; then
    detail="" look="what holds the land lock (${q%/land-queue}/land.lock)"
    if [ "$ahead" -gt 0 ]; then
      detail=$(queue_state "$headpid")
      case $detail in T | t) detail="; pid $headpid, stopped" ;; *) detail="; pid $headpid, state ${detail:-?}" ;; esac
      if flock -n 9; then
        flock -u 9
        detail="$detail; the lock is free" look="pid $headpid, which is first in line and is not taking the lock,"
      else
        detail="$detail; the lock is held"
      fi
    fi
    echo "queue: nothing has moved for $(((QUEUE_STALL + 59) / 60)) min (ahead: $headname$detail), so this gave up and nothing landed. A person needs to look at $look before anyone tries again" >&2
    return 1
  fi
}

# Numbered things: what minions number in parallel, so two can take the same "next" one and both
# land it (git merges two identical version bumps without a word). The Project facts line lists
# entries split by ';', each a kind, a path glob and, for ids and version, a Perl regex in quotes:
#   - **Numbered things:** files src/db/migrations/NNNN-*.sql; ids docs/unproven.md "\*\*U(\d+)\.";
#     version addons/*/*.toc "^## Version: (.+)"
# files: the digits in place of NNNN in a file name; two files with one number clash.
# ids: what the regex's group matches, line by line, across the glob's files; an id the branch
#   makes appear twice clashes (duplicates main already had are left alone).
# version: the first match in each file; it clashes when the branch and main both changed it since
#   the branch started. In globs, * and ? stop at '/'. Backticks are ignored.
# Args: the revisions main is, the branch started from and the branch was before the rebase. Prints
# one line per clash and exits 1; exits 0 when there are none and 2 when the line doesn't parse.
numbered_clashes() {
  # No single quote anywhere in the Perl, comments included: it would end the bash string.
  perl -e '
    use strict; use warnings;
    my ($facts, $main, $fork, $pre) = @ARGV;
    sub git { # its output, or undef when it fails; its errors are not shown
      my @args = @_;
      my $pid = open(my $fh, "-|") // die "fork: $!\n";
      if (!$pid) { open STDERR, ">", "/dev/null"; exec "git", @args or exit 127 }
      local $/; my $out = <$fh>; close $fh;
      return $? ? undef : ($out // "");
    }
    sub git_or_die { my $out = git(@_); defined $out or die "git @_ failed\n"; $out }
    sub norm { $_[0] =~ /^\d+$/ ? $_[0] + 0 : $_[0] }
    sub glob_re { # a glob as an anchored regex; with $nums, NNNN captures digits
      my ($glob, $nums) = @_;
      my $re = join "", map { $_ eq "*" ? "[^/]*" : $_ eq "?" ? "[^/]" : ($nums && /^N{2,}$/) ? "(\\d+)" : quotemeta }
        $glob =~ /(N{2,}|[*?]|[^*?N]+|N)/g;
      qr/^$re$/;
    }
    sub highest { my @n = grep /^\d+$/, @_; @n ? " (the highest so far is " . (sort { $b <=> $a } @n)[0] . ")" : "" }

    my %head = map { $_ => 1 } split /\0/, git_or_die("ls-tree", "-rz", "--name-only", "HEAD");
    exit 0 unless $head{$facts};
    my $line;
    for (split /\n/, git_or_die("show", "HEAD:$facts")) { # a wrapped line goes on until the next bullet
      if (defined $line) { last if /^\s*-/ || /^\s*\z/ || /^\S/; $line .= " $_"; next }
      $line = $1 if /^\s*-\s*\*\*Numbered things:\*\*\s*(.*)/;
    }
    exit 0 unless defined $line;
    $line =~ tr/`//d; $line =~ s/^\s+|\s+$//g;
    exit 0 if $line eq "" || $line =~ /^none\b/i;
    my $bad = sub { print "the Numbered things line in $facts does not parse: $_[0]\n"; exit 2 };
    my @entries = ([]);
    while ($line =~ /\G\s*(?:"((?:[^"\\]|\\.)*)"|(;)|([^\s;"]+))/gc) {
      if (defined $2) { push @entries, []; next }
      push @{$entries[-1]}, defined $1 ? $1 =~ s/\\"/"/gr : $3;
    }
    $line =~ /\G\s*$/gc or $bad->("an unclosed quote or a stray character");
    my $files = join "", map "$_\n", sort keys %head;
    my %added = map { $_ => 1 } split /\0/, git_or_die("diff", "-z", "--name-only", "--no-renames", "--diff-filter=A", $main, "HEAD");
    my @clashes;
    for my $e (grep @$_, @entries) {
      my ($kind, $glob, $rx, @rest) = @$e;
      my $what = join " ", @$e;
      if ($kind eq "files") {
        (defined $glob && !defined $rx && $glob =~ /N{2,}/) or $bad->("\"$what\": files takes one glob with NNNN where the number goes");
        my $re = glob_re($glob, 1); my %by;
        for (sort keys %head) { push @{$by{$1 + 0}}, $_ if $_ =~ $re }
        for my $f (grep { $added{$_} && $_ =~ $re } sort keys %head) {
          my $n = ($f =~ $re)[0] + 0;
          my @others = grep $_ ne $f, @{$by{$n}};
          push @clashes, "$f takes number $n, which @others already has" . highest(keys %by) if @others;
        }
        next;
      }
      ($kind eq "ids" || $kind eq "version") && defined $rx && !@rest or $bad->("\"$what\": the kinds are files <glob>, ids <glob> \"<regex>\" and version <glob> \"<regex>\"");
      my $re = eval { qr/$rx/m } or $bad->("\"$what\": the regex does not compile: $@");
      my $path_re = glob_re($glob, 0);
      my @matched = grep { $_ =~ $path_re } sort keys %head;
      if ($kind eq "ids") {
        # A clash is an id the branch has more of than main, past one: old duplicates on main are left alone.
        my (%count, %was, %where);
        for my $f (@matched) {
          for (map { /$re/g } split /\n/, git_or_die("show", "HEAD:$f")) { $count{norm($_)}++; $where{norm($_)} = $f }
          $was{norm($_)}++ for map { /$re/g } split /\n/, git("show", "$main:$f") // "";
        }
        push @clashes, "$where{$_} has id $_ " . ($was{$_} ? "twice: this branch adds one and main already has it" : "$count{$_} times, all from this branch") . highest(keys %count)
          for grep { $count{$_} > 1 && $count{$_} > ($was{$_} // 0) } sort keys %count;
        next;
      }
      for my $f (@matched) {
        my ($was, $mine, $theirs) = map { my $t = git("show", "$_:$f"); defined $t && $t =~ $re ? ($1 // $&) : "" } $fork, $pre, $main;
        push @clashes, "$f: this branch moves its version from $was to $mine, but main moved it to $theirs since the branch started"
          if $mine ne $was && $theirs ne $was;
      }
    }
    print "$_\n" for @clashes;
    exit(@clashes ? 1 : 0);
  ' "$FACTS" "$@"
}

[ $# -eq 0 ] || refuse "takes no arguments"
here=$(git rev-parse --show-toplevel)
cd "$here"
gitdir=$(git rev-parse --absolute-git-dir)
branch=$(git branch --show-current)
# A landing that was killed outright left this worktree on its detached commit, and the branch where it was.
if [ -z "$branch" ] && [ -s "$gitdir/land-branch" ]; then
  git rebase --abort 2>/dev/null || true
  { read -r branch; read -r left; } <"$gitdir/land-branch" || true
  # Anything committed here since would be lost with the detached commit, which may also hold other minions' unlanded work.
  [ "$(git rev-parse HEAD)" = "$left" ] || refuse "an earlier landing was stopped mid-way and left $here on a detached commit (${left:0:12}), and HEAD has moved since. If you committed here, put those commits on $branch (git checkout $branch, then git cherry-pick each one of yours); otherwise just git checkout $branch. Then run this again"
  git checkout -q "$branch" || refuse "an earlier landing was stopped mid-way and $here could not go back onto $branch (above); a person needs to look"
  say "an earlier landing here was stopped mid-way: $here is back on $branch as it was"
fi
rm -f "$gitdir/land-branch"
{ [ -n "$branch" ] && [ "$branch" != "$BRANCH" ]; } || refuse "run it from a minion's branch, not $BRANCH or a detached HEAD"
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "$here has uncommitted changes: commit them first"
# The main checkout is the first entry of the worktree list.
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
state=$(git -C "$MAIN" rev-parse --absolute-git-dir)

CI_REF=land/$branch
slug=''
if [ -n "$CI_ON" ]; then
  slug=$(git -C "$MAIN" remote get-url origin 2>/dev/null) || refuse "the CI gate is on, but there is no origin remote to run CI from"
  slug=${slug#*github.com[:/]} slug=${slug%.git}
fi
cilog="$state/land-ci-${branch//\//-}.log"
# Never holding the lock: a gh or git left hanging after its timeout mustn't keep it.
hub() { GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 timeout 30 "$@" 9>&-; }

pre=$(git rev-parse HEAD) # the branch as it was: every build starts from here
base=''    # the commit the build sits on: main, or the commit of the one directly ahead
tip=''     # the build: $pre rebased onto $base, once it passed the check
blocked='' # why it can't land on $base (a conflict, a clash, a red check, red CI). Final only once it is the head
           # and $base is main: until then the fault may lie in an unlanded commit it sits on, so it waits.
           # shortcut: it waits for the ones ahead to land, not just to turn green; read their verdicts
           # from their tickets if a red landing holding up the ones behind it ever costs real time.
keep=''    # the rebased commit the branch moves to on the way out, if it sits on main by then
green='' pushed='' pushed_at='' retried='' ci_clock=0 ci_begun='' ci_last=-1 landed='' ci_skipped=''

# CI's verdict on $tip, by the exit codes in the header at CI_STATUS; what it found goes to $cilog.
ci_verdict() {
  local runs w path id status result one failed skipped rank worst=0 worst_rank=0
  : >"$cilog"
  ci_skipped=''
  if [ -n "$CI_STATUS" ]; then
    timeout 120 bash -c "$CI_STATUS \"\$1\"" _ "$tip" >"$cilog" 2>&1 9>&-
    return
  fi
  runs=$(hub gh api "repos/$slug/actions/runs?head_sha=$tip&per_page=100" --jq '.workflow_runs | sort_by(.created_at) | reverse | .[] | [.path, .id, .status, .conclusion // "-", .html_url] | @tsv' 2>>"$cilog") || return 5
  for w in $CI_WORKFLOWS; do
    one=3
    while IFS=$'\t' read -r path id status result url; do
      [[ ${path%%@*} == */"$w" ]] || continue
      case $status:$result in
        completed:success)
          # Green only when every job ran: a run whose jobs were skipped (an `if:` that came out false) concludes success too.
          skipped=$(hub gh api "repos/$slug/actions/runs/$id/jobs?per_page=100" --jq '[.jobs[] | select(.conclusion == "skipped")] | length' 2>>"$cilog") || return 5
          # Only a plain 0 is green; a count is told apart from no answer (ci_ask), which is handled as a lost run.
          if [ "$skipped" = 0 ]; then one=0; else one=4; [ "$skipped" -gt 0 ] 2>/dev/null && ci_skipped="$skipped of the jobs in $w's run"; fi ;;
        completed:failure)
          # Red only when a step failed. A runner that went away mid-run fails its job with the step it was in never finished.
          failed=$(hub gh api "repos/$slug/actions/runs/$id/jobs?per_page=100" --jq '[.jobs[].steps[]? | select(.conclusion == "failure")] | length' 2>>"$cilog") || return 5
          if [ "$failed" -gt 0 ] 2>/dev/null; then one=1; else one=4; fi ;;
        completed:timed_out) one=1 ;;
        completed:*) one=4 ;;
        in_progress:*) one=2 ;;
      esac
      echo "$w: $status $result $url" >>"$cilog"
      break # the newest run of this workflow on the commit
    done <<<"$runs"
    [ "$one" != 3 ] || echo "$w: not started on ${tip:0:12}" >>"$cilog"
    # The worst of the workflows: red, then no verdict, not started, running, green.
    case $one in 1) rank=4 ;; 4) rank=3 ;; 3) rank=2 ;; 2) rank=1 ;; *) rank=0 ;; esac
    [ "$rank" -le "$worst_rank" ] || worst=$one worst_rank=$rank
  done
  return "$worst"
}

# The commit goes to the scratch branch, which starts CI on it. Deleted first: a push of the commit
# the branch already has (a run to repeat) would start nothing. Forced on purpose: only this script
# writes land/<branch>, so there is no one's work to overwrite. --no-verify: the check ran above.
ci_push() {
  [ -n "$pushed" ] || ci_cancel # what a landing of this branch that was killed left running (a landed one's runs go on)
  hub git push -q --no-verify origin ":refs/heads/$CI_REF" 2>/dev/null || true
  hub git push -q --no-verify origin "+$tip:refs/heads/$CI_REF" || refuse "couldn't push ${tip:0:12} to origin's $CI_REF, so CI can't run on it and nothing landed"
  pushed=1 pushed_at=$SECONDS ci_clock=$SECONDS ci_begun=''
  say "waiting for CI on ${tip:0:12} (origin's $CI_REF)"
}

# Stops the scratch branch's runs nobody waits for now, so they don't hold a runner. Best effort. A run of a
# commit already on main is left to finish: main's CI may reuse what it passes.
ci_cancel() {
  local id sha
  while read -r id sha; do
    [ -z "$id" ] || git merge-base --is-ancestor "$sha" "refs/heads/$BRANCH" 2>/dev/null || hub gh api -X POST "repos/$slug/actions/runs/$id/cancel" >/dev/null 2>&1 || true
  done < <(hub gh api "repos/$slug/actions/runs?branch=$CI_REF&per_page=20" --jq '.workflow_runs[] | select(.status != "completed") | [.id, .head_sha] | @tsv' 2>/dev/null)
}

# A CI outage is paid once: a landing that waited out a limit leaves <state>/ci-down ("<when> <why>"), so the ones of
# the next CI_DOWN seconds don't each wait to learn the same thing. ci_down <why> writes it; ci_down_fresh puts what
# to say into $down while it is fresh.
ci_down() { printf '%s %s\n' "$(date +%s)" "$1" >"$state/ci-down" 2>/dev/null || true; }
ci_down_fresh() {
  local at why now
  read -r at why 2>/dev/null <"$state/ci-down" || return 1
  now=$(date +%s)
  [[ $at =~ ^[0-9]+$ ]] && [ $((now - at)) -lt "$CI_DOWN" ] || return 1
  down="CI gave no answer to a landing $((now - at)) s ago ($why), so this one doesn't wait for it and nothing landed; CI is asked again from $(date -d "@$((at + CI_DOWN))" +%H:%M)"
}

# Asks CI about $tip, at most every CI_POLL seconds: sets green, refuses on red, repeats a lost run once, parks at the limits.
ci_ask() {
  local rc=0 waited busy down=''
  [ $((SECONDS - ci_last)) -ge "$CI_POLL" ] || return 0
  ci_last=$SECONDS
  ci_verdict || rc=$?
  if [ -n "$pushed_at" ] && [ $((SECONDS - pushed_at)) -lt "$CI_GRACE" ]; then
    case $rc in 1 | 4) rc=3 ;; esac
  fi
  case $rc in
    0)
      green=1
      rm -f "$state/ci-down"
      say "CI is green on ${tip:0:12}"
      queue_phase "CI passed ${tip:0:12}"
      return 0 ;;
    1)
      cat "$cilog" >&2
      say "CI is red on ${tip:0:12}"
      [ "$Q_AHEAD" = 0 ] || say "that commit sits on $Q_PREDNAME's, which hasn't landed: waiting to see whether it does before giving up"
      blocked="CI is red on ${tip:0:12} (above), so $BRANCH is untouched. Fix it, commit, then run this again"
      keep=$tip tip=''
      queue_set 4 skip # nobody builds on a red commit
      queue_phase "CI is red"
      return 0 ;;
    4)
      cat "$cilog" >&2
      [ -z "$ci_skipped" ] || refuse "$ci_skipped on ${tip:0:12} were skipped, so the commit's checks did not all run and nothing landed. Nothing is wrong with the runners, and running it again would skip them again. A workflow with jobs that are skipped on purpose needs the scheme's own CI_STATUS script (see the top of tools/land.sh)"
      [ -z "$retried" ] || park "CI's run on ${tip:0:12} ended without a verdict a second time (a runner lost mid-run, or the run cancelled), so nothing landed. The runners need a person's look; park, and run this again after"
      retried=1
      say "CI's run on ${tip:0:12} ended without a verdict (a runner lost mid-run, or the run cancelled): running it again, once. The commit is the same, so the ones stacked on it keep their runs"
      ci_push
      queue_phase "waiting for CI on ${tip:0:12} again since $(date +%H:%M)"
      return 0 ;;
  esac
  [ "$Q_AHEAD" = 0 ] || return 0
  waited=$((SECONDS - ci_clock))
  [ "$rc" != 2 ] || ci_begun=1
  if [ -z "$ci_begun" ] && { [ "$waited" -ge "$CI_START" ] || { [ "$rc" = 3 ] && ci_down_fresh; }; }; then
    cat "$cilog" >&2
    [ "$rc" = 3 ] || park "CI gave no answer about ${tip:0:12} for $(((CI_START + 59) / 60)) min (exit $rc from ${CI_STATUS:-gh}; above), so nothing landed. That is GitHub or this box's gh login, not the runners or the branch: a person needs to look. Park, and run this again after"
    # Runs going elsewhere in the repo mean the runners are there and busy (the ones stacked behind this, say): the
    # run is waiting its turn. CI_LIMIT still ends the wait.
    busy=$(hub gh api "repos/$slug/actions/runs?status=in_progress&per_page=1" --jq .total_count 2>/dev/null) || busy=0
    if [ "$busy" -gt 0 ] 2>/dev/null; then
      say "CI hasn't started on ${tip:0:12} yet, but the runners are busy with other runs: still waiting"
      ci_begun=1
      return 0
    fi
    [ -z "$down" ] || park "$down. Park, and run this again once a person says the runners are back"
    ci_down "no runner started CI on ${tip:0:12} within $(((CI_START + 59) / 60)) min"
    park "no runner has started CI on ${tip:0:12} within $(((CI_START + 59) / 60)) min (the machine they run on is probably off or asleep), so nothing landed. Park, and run this again once a person says the runners are back"
  fi
  if [ "$waited" -ge "$CI_LIMIT" ]; then
    cat "$cilog" >&2
    ci_down "CI on ${tip:0:12} didn't finish within $(((CI_LIMIT + 59) / 60)) min"
    park "CI on ${tip:0:12} hasn't finished within $(((CI_LIMIT + 59) / 60)) min, so nothing landed. Park, and run this again later"
  fi
}

# The branch as it was, rebased onto <commit> and checked: sets base, and tip when it passed (with the
# CI gate on, CI then runs on it), or blocked when it can't sit on that commit.
build() {
  local want=$1 on phase rc=0 clashes fork log
  [ -z "$pushed" ] || ci_cancel # its run is on a commit that will never land now
  base=$want tip='' blocked='' keep='' green='' retried='' pushed_at=''
  queue_set 4 -
  if [ "$Q_AHEAD" = 0 ]; then
    on="$BRANCH ($(git log -1 --format='%h "%s"' "$want"))" phase="rebasing onto $BRANCH"
  else
    phase="rebasing onto $Q_PREDNAME's commit"
    on="$Q_PREDNAME's commit ${want:0:12}, $(queue_ordinal $((Q_AHEAD + 1))) in line: CI runs on both at once, and this lands once $Q_PREDNAME has"
  fi
  queue_phase "$phase"
  say "rebasing $branch onto $on"
  # The branch, and the commit this leaves the worktree on: how the next run puts things back if this one is killed.
  printf '%s\n' "$branch" "$pre" >"$gitdir/land-branch"
  # 9>&- on git: a git gc --auto it starts detaches, and mustn't keep the lock.
  git checkout -q --detach "$pre" 9>&-
  if git rebase -q "$want" 9>&-; then
    printf '%s\n' "$branch" "$(git rev-parse HEAD)" >"$gitdir/land-branch"
  else
    git rebase --abort 2>/dev/null || true # nothing to abort if it never started
    blocked="the rebase onto $BRANCH failed (see git's output above), so nothing landed. On conflicts: run git rebase $BRANCH, resolve them keeping the other minions' changes, re-test, commit, then run this again"
    return 0
  fi

  queue_phase "checking numbered things"
  fork=$(git merge-base "$want" "$pre")
  clashes=$(numbered_clashes "$want" "$fork" "$pre") || rc=$?
  if [ "$rc" != 0 ]; then
    printf '%s\n' "$clashes" | sed 's/^/land:   /' >&2
    [ "$rc" != 2 ] || refuse "fix that line in $FACTS (commit it on this branch), then run this again. Nothing landed and $branch is back where it was"
    [ "$rc" = 1 ] || refuse "the numbered-things check itself failed (exit $rc), so nothing landed and $branch is back where it was; a person needs to look"
    blocked="this branch takes a number main already has (above), so nothing landed and $branch is back where it was. Renumber yours past main's highest (bump the version past main's), commit, then run this again"
    return 0
  fi

  say "running $CHECK"
  queue_phase "waiting to run the check"
  log="$state/land-check-${branch//\//-}.log"
  # It runs under the lock when this is the head, so it has a time limit (LAND_CHECK_TIMEOUT, in seconds), and
  # 9>&- keeps a process it leaves running from holding the lock after this script ends. One check at a time,
  # under a lock of its own (fd 7): the ones stacked behind the head check too, and the box is shared.
  (
    flock 7
    queue_phase "running the check since $(date +%H:%M)"
    timeout -k 30 "$CHECK_LIMIT" bash -c "$CHECK" >"$log" 2>&1 9>&- 7>&-
  ) 7>"$state/land-check.lock" 9>&- || rc=$? # 9>&-: this subshell outlives a killed landing, and mustn't keep its lock
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    echo "land: the check ran past ${CHECK_LIMIT}s and was stopped: something in it hung" >>"$log" # the tail below shows it
  fi
  if [ "$rc" != 0 ]; then
    tail -n 40 "$log" >&2
    keep=$(git rev-parse HEAD)
    blocked="the check failed on the rebased branch (full log: $log), so $BRANCH is untouched"
    return 0
  fi

  tip=$(git rev-parse HEAD)
  if [ -n "$CI_ON" ]; then
    ci_clock=$SECONDS ci_last=$SECONDS ci_begun=''
    # A run of this very commit that is green or going (its pull request's, say) will do; otherwise a new one.
    ci_verdict || rc=$?
    case $rc in
      0) green=1 && rm -f "$state/ci-down" && say "CI already passed ${tip:0:12}" ;;
      2) say "CI is already running on ${tip:0:12}" ;;
      *) ci_push ;;
    esac
    queue_phase "waiting for CI on ${tip:0:12} since $(date +%H:%M)"
  fi
  queue_set 4 "$tip"
}

# On the way out, however it ends: the worktree goes back on the branch, the place in line and the lock
# go, then the scratch branch and its runs, except a landed commit's own runs, which finish (main's CI
# may skip what they passed).
leave() {
  local rc=$? main
  trap - EXIT
  set +e
  if [ -z "$(git branch --show-current)" ]; then
    git rebase --abort 2>/dev/null
    # The branch takes the rebased commit only when that landed or was built on main itself: never one stacked on
    # someone's unlanded work.
    main=$(git rev-parse "refs/heads/$BRANCH")
    if [ "$(git rev-parse "refs/heads/$branch")" != "$pre" ]; then
      say "$branch moved while this ran, so it is left as it is now"
      git checkout -q "$branch" 9>&-
    elif [ -n "$keep" ] && { [ "$keep" = "$main" ] || [ "$base" = "$main" ]; }; then
      git checkout -q -B "$branch" "$keep" 9>&-
    else
      git checkout -q "$branch" 9>&-
    fi
  fi
  rm -f "$gitdir/land-branch"
  queue_done $landed
  exec 9>&-
  if [ -n "$pushed" ]; then
    ci_cancel
    hub git push -q --no-verify origin ":refs/heads/$CI_REF" 2>/dev/null
  fi
  exit "$rc"
}

queue_join "$state" "$branch"
trap leave EXIT
seen_main=''
while :; do
  queue_look || exit 1
  if [ "$Q_AHEAD" = 0 ]; then
    [ -n "$Q_HELD" ] || continue # queue_look waited on the lock, so this is no busy loop
    if [ -z "$seen_main" ]; then
      # Under the lock: another landing fast-forwarding main there looks like uncommitted changes while it runs.
      [ "$(git -C "$MAIN" branch --show-current)" = "$BRANCH" ] || refuse "$MAIN is not on $BRANCH; a person needs to look"
      [ -z "$(git -C "$MAIN" status --porcelain --untracked-files=no)" ] || refuse "$MAIN has uncommitted changes; a person needs to look"
      seen_main=1 ci_clock=$SECONDS ci_begun='' # the limits on CI count from here: until now its run could be waiting on the ones ahead
    fi
    want=$(git rev-parse "refs/heads/$BRANCH")
  elif [ "$Q_AHEAD" -lt "$CI_STACK" ] && [ -n "$Q_PRED" ]; then
    want=$Q_PRED
  else
    want='' # too far back to build yet, or the one ahead has nothing built
  fi

  if [ -z "$want" ]; then
    # What it was built on is gone: wait for the one ahead to build again. Unless that was main's tip: the one
    # it sat on has landed and only skipped ones are ahead for a moment, so the build and its CI run still stand.
    if [ -n "$base" ] && [ "$base" != "$(git rev-parse "refs/heads/$BRANCH")" ]; then
      [ -z "$pushed" ] || ci_cancel
      base='' tip='' blocked='' green=''
      queue_set 4 -
      queue_phase waiting
    fi
  elif [ "$want" != "$base" ]; then
    build "$want"
    [ -z "$blocked" ] || [ "$Q_AHEAD" = 0 ] || queue_set 4 skip
    [ -z "$blocked" ] || [ "$Q_AHEAD" = 0 ] || say "that was on top of $Q_PREDNAME's commit, which hasn't landed: ${blocked%%, so *}. Not final: waiting to see whether that one lands"
  fi

  if [ -n "$blocked" ]; then
    [ "$Q_AHEAD" != 0 ] || refuse "$blocked"
  elif [ -n "$tip" ]; then
    [ -z "$CI_ON" ] || [ -n "$green" ] || ci_ask
    if [ "$Q_AHEAD" = 0 ] && { [ -z "$CI_ON" ] || [ -n "$green" ]; }; then break; fi
  fi
  sleep "$QUEUE_POLL"
done

# The head of the line, holding the lock, with $tip checked (and green in CI) on exactly today's main.
# The merge keeps the lock, so nobody sees main half moved if this script is killed; gc.auto=0, so no git gc
# detaches from it holding the lock.
# A commit made here or on the branch while this waited is not in $tip: CI never saw it.
{ [ "$(git rev-parse HEAD)" = "$tip" ] && [ "$(git rev-parse "refs/heads/$branch")" = "$pre" ]; } || refuse "$branch or this worktree's HEAD moved while the landing waited, so what CI passed is not what is here now and nothing landed. Put any commit made meanwhile on $branch, then run this again"
git -C "$MAIN" -c gc.auto=0 merge -q --ff-only "$tip" || refuse "could not fast-forward $BRANCH to $branch; nothing landed"
keep=$tip landed=ok # it landed, so its time counts toward the estimate, whatever the push does
say "$BRANCH is now at $(git log -1 --format='%h "%s"' "$tip")"

if ! git -C "$MAIN" remote get-url origin >/dev/null 2>&1; then
  say "no origin remote, so $BRANCH stays local"
  exit 0
fi
queue_phase "pushing $BRANCH to origin"
# --no-verify: .githooks/pre-push refuses every push to main on purpose; this script is the one
# route that may make it.
if out=$(GIT_TERMINAL_PROMPT=0 timeout 60 git -C "$MAIN" push -q --no-verify origin "$BRANCH" 2>&1); then
  say "pushed $BRANCH to origin"
else
  say "$BRANCH moved, but the push to origin failed: $out"
  say "the next landing retries it; if origin's $BRANCH moved on its own (rejected as non-fast-forward), a person merges it into $MAIN first"
  exit 1
fi
