# Models

Small formal models of Citadel's designs, checked with [Quint](https://quint-lang.org). They are **design checks,
not mirrors of the code**: write the next rule change into the model, run the checker, fix the design, then let the
model go stale. Nothing ties them to the code, on purpose (#1658, from the formal-verification report of #1654).

## ship_line.qnt: the ship line's queue and lock rules

Matches the rules as of 2026-11-22 (commit efb880c6e). **Not kept in step with `tools/land.sh` or the kit's
`land.sh` template.** Its header says what it models and what it leaves out (fds, signals, cgroup freezes, pid
reuse, `.order`, time).

### Run it

Needs Java 17 or newer on PATH (on perigee: mise's `temurin-21`). Quint isn't a repo dependency; `npx` fetches it.
Run from `docs/models/`, on its own, since TLC uses every core it's given:

```bash
npx @informalsystems/quint@0.34.0 verify --backend=tlc --main=today      --invariant=Safe ship_line.qnt
npx @informalsystems/quint@0.34.0 verify --backend=tlc --main=todayLocks --invariant=Safe ship_line.qnt
npx @informalsystems/quint@0.34.0 verify --backend=tlc --main=pre499     --invariant=NoLockedWait ship_line.qnt
npx @informalsystems/quint@0.34.0 verify --backend=tlc --main=pre499     --invariant=NoDeadlock ship_line.qnt
```

`npx @informalsystems/quint@0.34.0 run --main=today --invariant=Safe --max-steps=40 ship_line.qnt` is the quick
random simulation for a draft; the `verify` runs check every state.

### The properties (`Safe`)

1. **MainGreen:** main only moves to a commit CI passed (or the perigee suite, the CI fallback).
2. **NoLockedWait:** nobody holding the land (deploy) lock or the restart lock waits *with no time limit* for a
   slot or a lock. **NoDeadlock:** no cycle of such waits.
3. **OrderKept:** a ship lands no later than one that joined behind it, unless it couldn't join a batch and that
   batch, headed by a ship ahead of it, passed over it (the pick on #1605's page). **NoTwice:** nothing lands twice.

The brief asked for "no one waits for a slot or lock while holding the land or deploy lock". Today's rules break
that literally, by design: the head waits under the lock for the restart lock (#566, `DEPLOY_RESTART_WAIT`) and, in
the CI fallback, for a heavy slot (`CITADEL_HEAVY_MAX_WAIT`). Both waits give up, so the model checks the version
that matters: no wait without a limit while holding a lock, and no deadlock.

What that means for today's results: every wait under a lock today gives up, so it's modelled as a give-up action,
not in `hardWaits`, and NoLockedWait can't fail on `today` or `todayLocks`. It bites when a design adds a wait with
no limit, and that wait has to be written into `hardWaits` as well as into the actions (see the mutation runs
below). Likewise MainGreen is close to true by construction (`Land` needs a green ticket); what it really guards
is `deepest`'s "the commit sits on main with every member ahead of it" test.

### Results, 2026-11-22

| Instance | What | Result |
|---|---|---|
| `today` | 3 ships, batches of 2, stack of 2, 2 flake reruns, pass-over | `Safe` holds: 732,832 states, depth 33, 9 min 18 s |
| `todayLocks` | 2 ships, deploy by hand (maybe inside citadel-heavy), another scheme's build holding the slot, the restart unit | `Safe` holds: 72,618 states, depth 23, 26 s |
| `pre499` | the rules #497 found: the head runs the suite in a heavy slot under the deploy lock, with no limit | **both found, 6 steps each** (below) |

`pre499`, NoLockedWait (#497 itself):
`Join(1) → Build(1) → Acquire(1) → NeedSuite(1) → HTake`. Ship 1 holds the deploy lock and waits, with no limit,
for the one slot another scheme's build has taken.

`pre499`, NoDeadlock: `Join(1) → Build(1) → Acquire(1) → NeedSuite(1) → JoinD(true)`. A `deploy.sh` run by hand
from inside citadel-heavy holds the only slot and waits in line behind ship 1, which waits for that slot.

**The checks bite (mutation runs):** dropping the "the commit sits on main with every member ahead" test from
`deepest` makes TLC find a MainGreen break in `today` (1 min); letting a passed-over ship wait behind every later
batch instead of shipping right after the one that passed it makes it find an OrderKept break (6 min); making the
restart-lock wait unbounded (no give-up, and written into `hardWaits`) makes it find a NoLockedWait break in
`todayLocks` (11 s): a deploy by hand takes the land lock while the restart unit runs, then waits on it. The
witnesses `NoBatchShips`, `NoPassOver` and `NoFlakeGreen` are each violated in simulation, so batches, pass-over
and flake reruns are really reached.

### Noticed while modelling (not changed)

- `tools/land.sh` refuses to run under citadel-heavy (`CITADEL_HEAVY_HELD`); `tools/deploy.sh` has no such guard.
  Today that's a bounded wait, but it's the same shape as the `pre499` deadlock trace.
- Citadel's flake setting is `FLAKE_RUNS = 1 + CITADEL_FLAKE_KEEP_MAX(2)`: three runs in all, which the model
  writes as `FLAKE_RERUNS = 2` (two fresh runs after the first red).
