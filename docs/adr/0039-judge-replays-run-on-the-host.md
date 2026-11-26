# A container minion's judge replay runs its own branch on the host

Status: accepted, 2026-11-25 (#2074).

A minion whose turn runs in a person's container couldn't re-record a judge replay (`node tools/judge-replay.ts <judge>
--record`): the live database isn't mounted there, so a person ran it on perigee by hand (#613, #1095, #2049). The record
is a hash of the branch's pinned judge code, so the branch's code has to run, not the live checkout's.

The host_check tool's `what: "judge_replay"` runs the calling minion's own `tools/judge-replay.ts --record` in its worktree,
on the host, over the live database, with the environment a land gets (`Runner.hostEnv`). It is stopped after 15 minutes
(#2100: the flake counter's 3 days take about 10); past a minute the answer beats (`slowJson`) so the caller's fetch,
which gives up after 5 minutes of silence, keeps waiting. The same people as `db` may run
it (`adminAskRefusal`). On #2074's card Josh picked, 2026-11-25: "Ship it as built", over a Node permission-model sandbox
(no fence on SQLite writes, and the judges that call git or gh couldn't run) and dropping it.

Consequences: unlike ADR 0037's app data copies ("Not a minion's script run on the host"), this does run branch code with
the server account's reach, as `tools/land.sh` does on every ship. The database stays read-only because the replay opens it
that way (`tools/judge-replays/store.ts`), not because the host enforces it. The tool returns the replay's whole report, hit
lines included, which the same people can already read with `db`. Copying Citadel's database into the container stays out:
it holds every scheme's chat.
