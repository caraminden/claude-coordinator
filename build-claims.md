# Build 7: worker machines, who writes what

build: #1935

shared: src/turn-launch.ts src/machines.ts src/runner.ts public/machine-agent.mjs src/db.ts src/db/machines.ts src/mcp.ts tools/affected-map.txt test/size-budget.test.ts test/typecheck-baseline.json test/machine-fakes.ts docs/adr/0024-runner-seams.md docs/design-system/index.html test/sync-calls.json test/judges.test.ts test/running-turn.test.ts test/access-matrix.snapshot.json src/http.ts src/routes/tickets.ts src/config.ts test/config.test.ts README.md

#1937: (merged in; its test/running-turn.test.ts is shared, for T2 to add its kind)
#1962: (merged in)
#1972: (merged in)
#1973: (merged in)
#2011: public/machine-worker.mjs src/machine-turn.ts test/machine-turn.test.ts src/machine-sync.ts test/machine-sync.test.ts src/sessions.ts src/routes/files.ts public/machine-sync.mjs src/running-turn.ts src/worktree-sweep.ts
#2006: public/settings-machines.js public/machine-setup.js public/machines.css src/machine-lend.ts public/worker-agent.mjs public/machine-worker-row.js src/worker-join.ts test/worker-join.test.ts test/worker-install.test.ts test/machine-worker-browser.test.ts tools/worker/ server.ts src/machine-pools.ts test/machine-pools.test.ts src/routes/machines.ts

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
