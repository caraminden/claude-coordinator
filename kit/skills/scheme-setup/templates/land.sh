#!/usr/bin/env bash
# Land a minion's branch on main: run it from the minion's worktree once its work is committed.
#   tools/land.sh
# This is the route CLAUDE.md names under "Project facts", "How a change ships". One landing at a
# time, under a lock in the scheme repo's .git, in the order they asked: it says its place in line
# and waits as long as the line moves, so run it in the background with a long timeout (a run that
# is stopped loses its place).
# 1. Rebases the branch onto the local main. A conflict aborts the rebase and stops here.
# 2. Refuses when the branch takes a number main already has (a migration, a version, a ledger id),
#    as the "Numbered things" line in Project facts names them. No line, or "none": no check.
#    A refusal puts the branch back where it was, with main untouched.
# 3. Runs the check command on the rebased branch, within LAND_CHECK_TIMEOUT whole seconds (default
#    1800). A failure or overrun stops here, with main untouched.
# 4. Fast-forwards main in the scheme's main checkout to the branch.
# 5. Pushes main to origin from the main checkout, never forced. A failed push is reported and main
#    stays moved; the next landing pushes it again.
set -euo pipefail

# The check command, exactly as Project facts names it under "Check commands" ('true' while it has none).
CHECK='npm test'
# The scheme's main branch.
BRANCH=main
# The file whose Project facts may have a "Numbered things" line.
FACTS=CLAUDE.md

say() { echo "land: $*" >&2; }
refuse() { say "$*"; exit 1; }

# The line for the land lock. The lock itself is the flock on <.git>/land.lock, on fd 9: that alone
# keeps landings one at a time. The kernel grants a flock in no order, though, so several landings
# waiting on it meant some lost every round and timed out (2026-11-10). So waiters line up first:
# each takes a numbered ticket file in <.git>/land-queue, and only the oldest ticket tries the lock.
#   queue_lock <.git dir> <label>   wait in line, then hold the lock on fd 9. Returns 1 only when
#                                   nothing has moved for QUEUE_STALL seconds.
#   queue_phase <text>              say what the holder is doing now: the waiters' sign of progress
#   queue_done [ok]                 leave the line; ok: it went all the way, so its time counts
#                                   toward the waiters' estimate
# A ticket is four lines: "<pid> <the pid's start time>", when it got the lock (0 while it waits),
# its label, and its phase. A ticket whose process is gone is deleted by whoever waits behind it.
# A land.sh from a branch older than the line takes the flock directly; the head of the line waits
# for it like for anyone else.
# The same line as Citadel's own tools/deploy-queue.sh, kept inline so a scheme copies one file: a
# fix to either belongs in both.
QUEUE_POLL=${LAND_QUEUE_POLL:-1}
CHECK_LIMIT=${LAND_CHECK_TIMEOUT:-1800}
[[ $CHECK_LIMIT =~ ^[0-9]+$ ]] || refuse "LAND_CHECK_TIMEOUT is in whole seconds, not \"$CHECK_LIMIT\""
[[ ${LAND_QUEUE_SLACK:-300} =~ ^[0-9]+$ ]] || refuse "LAND_QUEUE_SLACK is in whole seconds, not \"$LAND_QUEUE_SLACK\""
# Give up after this long with no change at the head of the line. The holder's longest single phase
# is the check, so the limit is the check's own plus slack (the 30 s it gets to die, the 60 s push):
# it stays longer than the check's whatever a scheme sets that to.
# shortcut: a waiter counts with its own LAND_CHECK_TIMEOUT, not the holder's; write the holder's
# into its ticket if landings in one scheme ever run with different limits.
QUEUE_STALL=$((CHECK_LIMIT + ${LAND_QUEUE_SLACK:-300}))
QUEUE_TYPICAL=300 # a landing's length until some have been timed here
QUEUE_TICKET=

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

queue_write() { # <file> <pid and start> <got> <label> <phase>: by a rename, so nobody reads half a ticket
  printf '%s\n' "$2" "$3" "$4" "$5" >"$1.tmp$$" && mv -f "$1.tmp$$" "$1"
}

queue_phase() {
  local t=$QUEUE_TICKET l
  [ -n "$t" ] && [ -e "$t" ] || return 0
  mapfile -t l 2>/dev/null <"$t" || return 0
  queue_write "$t" "${l[0]:-}" "${l[1]:-0}" "${l[2]:-}" "$1" 2>/dev/null || true
}

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

queue_lock() {
  local q=$1/land-queue label=$2 n me t l ahead head headname sig last="" since=$SECONDS said="" typical sum count line
  mkdir -p -m 700 "$q"
  exec 9>"$1/land.lock"
  me=$(queue_proc $$)
  # The ticket and its number, under a lock of its own that is only ever held for these few lines: the
  # ticket is in the folder before the next number goes out, so nobody behind it can miss it.
  n=$(
    exec 8>"$q/.seq.lock"
    flock 8
    n=$(printf '%010d' $(($(cat "$q/.seq" 2>/dev/null || echo 0) + 1)))
    queue_write "$q/$n" "$me" 0 "$label" waiting
    echo "$((10#$n))" >"$q/.seq"
    echo "$n"
  )
  QUEUE_TICKET="$q/$n"
  trap queue_done EXIT

  while :; do
    ahead=0 head=""
    for t in "$q"/[0-9]*; do
      [[ ${t##*/} =~ ^[0-9]+$ ]] || continue # not a ticket half-written, or the glob itself
      [[ ${t##*/} < $n ]] || break
      mapfile -t l 2>/dev/null <"$t" || continue
      # Its process is gone (killed, or its turn was stopped): it leaves the line.
      if [ -z "${l[0]:-}" ] || [ "$(queue_proc "${l[0]%% *}")" != "${l[0]}" ]; then
        rm -f "$t"
        continue
      fi
      ahead=$((ahead + 1))
      [ -n "$head" ] || { head="${l[*]}" headname="${l[2]:-?}, ${l[3]:-?}"; }
    done

    if [ "$ahead" = 0 ]; then
      # A short blocking wait, not a poll: the lockers outside the line block in the kernel, and a poller would lose to every one of them.
      if flock -w "$QUEUE_POLL" 9; then
        [ -z "$said" ] || echo "queue: got the land lock" >&2
        queue_write "$QUEUE_TICKET" "$me" "$(date +%s)" "$label" starting
        return 0
      fi
      head="outside $n" headname="a landing started from a branch whose land.sh is older than the line"
    fi

    # Progress is any change at the head of the line: a new head, or the head's next phase.
    sig="$ahead $head"
    if [ "$sig" != "$last" ]; then
      last=$sig since=$SECONDS
      line="$(queue_ordinal $((ahead + 1))) in line for the land lock"
      if [ "$ahead" -gt 0 ]; then
        sum=0 count=0
        [ ! -f "$q/.took" ] || while read -r typical; do [[ $typical =~ ^[0-9]+$ ]] && sum=$((sum + typical)) count=$((count + 1)); done <"$q/.took" || true
        typical=$((count ? sum / count : QUEUE_TYPICAL))
        [ "$typical" -gt 0 ] || typical=1
        line="$line, about $(((ahead * typical + 59) / 60)) min"
      fi
      echo "queue: $line (ahead: $headname)" >&2
      [ -n "$said" ] || echo "queue: the wait has no time limit while the line moves, so run this in the background with a long timeout rather than under a 10 min limit: a run that is stopped loses its place" >&2
      said=1
    elif [ $((SECONDS - since)) -ge "$QUEUE_STALL" ]; then
      echo "queue: nothing has moved for $(((QUEUE_STALL + 59) / 60)) min (ahead: $headname), so this gave up and nothing landed. A person needs to look at what holds the land lock ($1/land.lock) before anyone tries again" >&2
      queue_done
      return 1
    fi
    [ "$ahead" = 0 ] || sleep "$QUEUE_POLL"
  done
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
branch=$(git branch --show-current)
{ [ -n "$branch" ] && [ "$branch" != "$BRANCH" ]; } || refuse "run it from a minion's branch, not $BRANCH or a detached HEAD"
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "$here has uncommitted changes: commit them first"
# The main checkout is the first entry of the worktree list.
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')

state=$(git -C "$MAIN" rev-parse --absolute-git-dir)
queue_lock "$state" "$branch" || exit 1
# Under the lock: another landing fast-forwarding main there looks like uncommitted changes while it runs.
[ "$(git -C "$MAIN" branch --show-current)" = "$BRANCH" ] || refuse "$MAIN is not on $BRANCH; a person needs to look"
[ -z "$(git -C "$MAIN" status --porcelain --untracked-files=no)" ] || refuse "$MAIN has uncommitted changes; a person needs to look"

pre=$(git rev-parse HEAD)
fork=$(git merge-base "$BRANCH" HEAD)
queue_phase "rebasing onto $BRANCH"
say "rebasing $branch onto $BRANCH ($(git log -1 --format='%h "%s"' "$BRANCH"))"
if ! git rebase -q "$BRANCH"; then
  git rebase --abort 2>/dev/null || true # nothing to abort if it never started
  refuse "the rebase onto $BRANCH failed (see git's output above), so nothing landed. On conflicts: run git rebase $BRANCH, resolve them keeping the other minions' changes, re-test, commit, then run this again"
fi

queue_phase "checking numbered things"
rc=0
clashes=$(numbered_clashes "$BRANCH" "$fork" "$pre") || rc=$?
if [ "$rc" != 0 ]; then
  git reset -q --keep "$pre"
  printf '%s\n' "$clashes" | sed 's/^/land:   /' >&2
  [ "$rc" != 2 ] || refuse "fix that line in $FACTS (commit it on this branch), then run this again. Nothing landed and $branch is back where it was"
  [ "$rc" = 1 ] || refuse "the numbered-things check itself failed (exit $rc), so nothing landed and $branch is back where it was; a person needs to look"
  refuse "this branch takes a number main already has (above), so nothing landed and $branch is back where it was. Renumber yours past main's highest (bump the version past main's), commit, then run this again"
fi

say "running $CHECK"
queue_phase "running the check since $(date +%H:%M)"
log="$state/land-check.log"
# It runs under the lock, so it has a time limit (LAND_CHECK_TIMEOUT, in seconds), and 9>&- keeps a
# process it leaves running from holding the lock after this script ends.
limit=$CHECK_LIMIT
rc=0
timeout -k 30 "$limit" bash -c "$CHECK" >"$log" 2>&1 9>&- || rc=$?
if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
  echo "land: the check ran past ${limit}s and was stopped: something in it hung" >>"$log" # the tail below shows it
fi
if [ "$rc" != 0 ]; then
  tail -n 40 "$log" >&2
  refuse "the check failed on the rebased branch (full log: $log), so $BRANCH is untouched"
fi

tip=$(git rev-parse HEAD)
git -C "$MAIN" merge -q --ff-only "$tip" || refuse "could not fast-forward $BRANCH to $branch; nothing landed"
say "$BRANCH is now at $(git log -1 --format='%h "%s"' "$tip")"
trap 'queue_done ok' EXIT # it landed, so its time counts toward the estimate, whatever the push does

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
