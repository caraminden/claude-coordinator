# The line for the deploy lock (#502). Sourced by tools/land.sh and tools/deploy.sh, never run.
#
# The lock itself is still the flock on <state>/lock, on fd 9: that alone keeps landings and deploys
# one at a time. The kernel grants a flock in no order, though, so ten landings waiting on it meant a
# small one could lose every round and time out (2026-11-10). So waiters line up first: each takes a
# numbered ticket file in <state>/queue, and only the oldest ticket tries the lock.
#   queue_lock <state dir> <label>   wait in line, then hold the lock on fd 9. Returns 1 only when
#                                    nothing has moved for DEPLOY_QUEUE_STALL seconds.
#   queue_phase <text>               say what the holder is doing now: the waiters' sign of progress
#   queue_done [ok]                  leave the line (the caller lets go of fd 9, or exits); ok: it went
#                                    all the way, so its time counts toward the waiters' estimate
# A ticket is four lines: "<pid> <the pid's start time>", when it got the lock (0 while it waits), its
# label, and its phase. A ticket whose process is gone is deleted by whoever waits behind it.
# Outside the line, the queued restart (deploy.sh restart) and a land.sh from a branch older than this
# take the flock directly; the head of the line waits for them like for anyone else.
# The kit's land.sh template (kit/skills/scheme-setup/templates/land.sh) carries a copy of these functions
# inline, so a scheme copies one file: a fix to either belongs in both.

QUEUE_POLL=${DEPLOY_QUEUE_POLL:-1}
# Give up after this long with no change at the head of the line. The floor is the holder's longest
# single phase: the test run, 630 s at most (tools/run-tests.sh); the boot check ends within 6 min.
QUEUE_STALL=${DEPLOY_QUEUE_STALL:-900}
QUEUE_TYPICAL=300 # a landing's length until some have been timed here

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
  local t=${DEPLOY_QUEUE_TICKET:-} l
  [ -n "$t" ] && [ -e "$t" ] || return 0
  mapfile -t l 2>/dev/null <"$t" || return 0
  queue_write "$t" "${l[0]:-}" "${l[1]:-0}" "${l[2]:-}" "$1" 2>/dev/null || true
}

queue_done() {
  local t=${DEPLOY_QUEUE_TICKET:-} l took
  [ -n "$t" ] && [ -e "$t" ] || return 0
  mapfile -t l 2>/dev/null <"$t" || true
  # How long it held the lock, for the next waiters' estimate (the newest 5 are kept). Not a run that
  # stopped early (a conflict, a red test): a few of those would promise everyone a one-minute wait.
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
  local q=$1/queue label=$2 n me t l ahead head headname sig last="" since=$SECONDS said="" typical sum count line
  mkdir -p -m 700 "$q"
  exec 9>"$1/lock"
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
  export DEPLOY_QUEUE_TICKET="$q/$n"
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
        [ -z "$said" ] || echo "queue: got the deploy lock" >&2
        queue_write "$DEPLOY_QUEUE_TICKET" "$me" "$(date +%s)" "$label" starting
        return 0
      fi
      head="outside $n" headname="a queued restart, or a landing started from a branch older than the line"
    fi

    # Progress is any change at the head of the line: a new head, or the head's next phase.
    sig="$ahead $head"
    if [ "$sig" != "$last" ]; then
      last=$sig since=$SECONDS
      line="$(queue_ordinal $((ahead + 1))) in line for the deploy lock"
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
      echo "queue: nothing has moved for $((QUEUE_STALL / 60)) min (ahead: $headname), so this gave up and nothing landed or deployed. A person needs to look at what holds the deploy lock ($1/lock) before anyone tries again" >&2
      queue_done
      return 1
    fi
    [ "$ahead" = 0 ] || sleep "$QUEUE_POLL"
  done
}

# What a kill leaves behind (#553). Not part of the line (and not in the kit's copy): two notes in <state>, written
# and read only by whoever holds the lock, so the next one to hold it can finish what a SIGKILL cut off.
#   unchecked   the commit the live checkout was on before a pull whose checks have not ended (tools/deploy.sh)
#   moving      "<main before> <tip>" of a landing that moved main and has not seen its deploy end (tools/land.sh)

# <state> <live>: a deploy died between its pull and the end of its checks, so the checkout goes back.
deploy_unchecked_back() {
  local prev
  [ -s "$1/unchecked" ] || return 0
  prev=$(cat "$1/unchecked")
  if git -C "$2" cat-file -e "$prev^{commit}" 2>/dev/null && [ "$(git -C "$2" rev-parse HEAD)" != "$prev" ]; then
    echo "queue: an earlier deploy was killed before its checks ended; putting the live checkout back to $(git -C "$2" log -1 --format='%h "%s"' "$prev")" >&2
    git -C "$2" reset -q --hard "$prev"
  fi
  rm -f "$1/unchecked"
}

# <state> <live> <source>: a landing died after it moved main, and the live checkout never took its commit
# (the deploy's checks failed, or never ran). Nothing has landed on top (main is still its tip), so main goes back.
main_moving_back() {
  local old tip
  [ -s "$1/moving" ] || return 0
  read -r old tip <"$1/moving" || true
  rm -f "$1/moving"
  [ -n "$tip" ] && [ "$(git -C "$3" rev-parse main)" = "$tip" ] || return 0
  ! git -C "$2" merge-base --is-ancestor "$tip" HEAD 2>/dev/null || return 0
  git -C "$3" reset -q --keep "$old" || return 0
  echo "queue: an earlier landing was killed after it moved main to $(git -C "$3" log -1 --format='%h "%s"' "$tip") and before its deploy went through; main is back at $(git -C "$3" log -1 --format=%h "$old")" >&2
}
