# Build 7: worker machines, who writes what

build: #1935

shared: src/turn-launch.ts src/machines.ts public/machine-agent.mjs src/db.ts src/db/machines.ts src/mcp.ts tools/affected-map.txt test/size-budget.test.ts test/typecheck-baseline.json test/machine-fakes.ts docs/adr/0024-runner-seams.md docs/design-system/index.html test/sync-calls.json test/running-turn.test.ts test/access-matrix.snapshot.json src/http.ts src/routes/tickets.ts src/config.ts test/config.test.ts README.md server.ts src/routes/machines.ts test/judges.test.ts test/db-areas.test.ts src/runner.ts

#1937: (merged in; its test/running-turn.test.ts is shared, for T2 to add its kind)
#1962: (merged in)
#1972: (merged in)
#1973: (merged in)
#2011: (merged in)
#2006: (merged in)
#2070: (merged in)
#2044: public/settings-machines.js public/machine-remove.js test/machine-remove-browser.test.ts
#2052: src/machine-roles.ts test/machine-roles.test.ts src/machine-pools.ts test/machine-pools.test.ts src/machine-lend.ts test/machine-relay.test.ts

A feeder's own line is added by #1935 when its number is known, before the next piece starts. The plan, by piece:

- T1 running-turn seam: merged in (#1937), so src/supervisor-client.ts, src/turn-supervisor.mjs and src/turn-run.mjs are free for T2.
- T2 worker agent: merged in (#1962). src/mcp-pool.ts, src/supervisor-client.ts, src/turn-supervisor.mjs and src/turn-run.mjs were not needed and are free.
- T2's files passed on: public/machine-worker.mjs, src/machine-turn.ts and test/machine-turn.test.ts are T3's (#1972); src/running-turn.ts goes to T6 when it starts. A fix from #1962's real run in one of them asks #1935 first. T4 replaces `runner.workerFor` in server.ts, lines #1962 wrote, so server.ts moves to T4 for its merge: T4 asks #1935 first. The same goes for T4's few lines in public/machine-worker.mjs and src/machine-turn.ts (the agent's load and sign-in in the sync's `worker` facts): they move to T4 for its merge, then back to T3.
- T3 state sync (#1972): src/machine-sync.ts or the name it picks (tell #1935 another name), its sync module and tests, src/sessions.ts, src/routes/files.ts, public/machine-sync.mjs (src/workspace.ts and src/land.ts released).
- T4 pools per place (#1973; src/machine-pools.ts or the name it picks; create_ticket's `runs_on` goes where #1843's split leaves that tool): src/turn-line.ts, src/turn-limits.ts, src/pressure.ts, public/workers.js, test/turn-line.test.ts, test/worker-pool.test.ts, public/context-menu.js (the "Runs on" mark, Cara 2026-11-25).
- T5 join and self-test (#2006): public/settings-machines.js, public/machine-setup.js, public/machines.css, src/machine-lend.ts, the install files (a name of its own goes on #2006's line: tell #1935).
- T6 away and home (#2011): its away module (a name of its own goes on #2011's line: tell #1935) and tests, src/worktree-sweep.ts. Merges last, after T3 and T4.
- T4 (#1973) merged in on 2026-11-25; the eight files it borrowed are back, the first three with #1972, the rest shared. Its own files (src/turn-line.ts and the rest) are free: a later piece that needs one asks #1935.
- #1962's three real-run fixes merged in on 2026-11-25 (8de6e66e7); the two files it borrowed are back on #1972's line.
- Lent to #2006 for its merge (2026-11-25): server.ts (the `online` lines of T2 and T4; then shared again), src/machine-pools.ts and test/machine-pools.test.ts (T4's `away()`; then T6's).
- T3 (#1972) merged in on 2026-11-25; src/runner.ts, lent for it, is shared again; src/routes/machines.ts is lent on to #2006 for its merge (it changes #1962's sync route line), then shared. Its line's files and #1962's src/running-turn.ts are T6's (#2011).
- When T5 (#2006) is in: server.ts and src/routes/machines.ts go to #2011 for its merge (T6 changes lines in both), src/runner.ts too (lines of #1973), src/machine-pools.ts and its test too; then all back to shared.
- T5 (#2006) merged in on 2026-11-25. Lent to #2011 for its merge, as planned: server.ts, src/routes/machines.ts, src/runner.ts, test/judges.test.ts, src/machine-pools.ts and its test; all but machine-pools are shared again after it.
- T8 host reach (#2070) started 2026-11-25 from build/7 6f3b3b384. Its new files go on its line (tell #1935 the names). public/machine-agent.mjs stays shared (added lines only). Its `extraMounts` lines in public/machine-worker.mjs are #2011's file: T8 asks #1935, who lends them after T6 merges or arranges them with #2011. The same goes for any line T8 needs in src/machine-turn.ts, src/machine-pools.ts or src/runner.ts (where a marked turn's mount list is built and its per-turn host-folder line is written): ask #1935 first. T5's files on T8's line (settings-machines.js, machine-worker-row.js, machines.css, worker-agent.mjs, machine-lend.ts) are free since T5 merged in.
- T6 (#2011) merged in on 2026-11-25 (9fb95e876, Josh's go). server.ts, src/routes/machines.ts, src/runner.ts and test/judges.test.ts are shared again. Its other files (public/machine-worker.mjs, src/machine-turn.ts, src/machine-pools.ts, src/machine-away.ts and the rest of its old line) are unclaimed, so they count as #2011's: a later piece (T8 #2070, M1-M6 #2052-#2057) that changes a line in one asks #1935 to put it on its line.
- T6 being in, public/machine-worker.mjs (the container's `extraMounts`) moves to T8 (#2070) now; M1-M6 ask #1935 for it after T8 merges or for lines of their own.
- 2026-11-25 evening: T8 (#2070) takes src/machine-turn.ts and tools/worker/ (its host launch, WHOLE's host-writes.json); public/settings-machines.js goes to the Remove-a-machine screen (#2044), which builds the uninstall command T6 left out; M1 (#2052) takes src/machine-pools.ts, its test and src/machine-lend.ts. M1 also changes lines other feeders wrote in src/machines.ts and src/routes/machines.ts, and T8 one line in src/runner.ts (placeTurn's call): both stay shared and are lent for that one merge, when the feeder messages #1935 just before it merges.
- Lent to T8 (#2070) for its merge (2026-11-25): src/runner.ts (placeTurn's call passes `host`); shared again after it.
- T8 (#2070) merged in on 2026-11-25; src/runner.ts is shared again. Its other files are unclaimed (so #2070's, or their first feeder's): a later piece that changes a line in one asks #1935.
