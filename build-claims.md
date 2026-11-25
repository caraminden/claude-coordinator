# Build 7: worker machines, who writes what

build: #1935

shared: src/runner.ts src/turn-launch.ts src/machines.ts src/routes/machines.ts public/machine-agent.mjs server.ts src/db.ts src/db/machines.ts src/mcp.ts README.md tools/affected-map.txt test/size-budget.test.ts test/typecheck-baseline.json test/machine-fakes.ts docs/adr/0024-runner-seams.md docs/design-system/index.html test/sync-calls.json test/judges.test.ts test/running-turn.test.ts test/access-matrix.snapshot.json test/config.test.ts src/config.ts src/http.ts

#1937: (merged in; its test/running-turn.test.ts is shared, for T2 to add its kind)
#1962: src/running-turn.ts public/machine-worker.mjs src/machine-turn.ts test/machine-turn.test.ts

A feeder's own line is added by #1935 when its number is known, before the next piece starts. The plan, by piece:

- T1 running-turn seam: merged in (#1937), so src/supervisor-client.ts, src/turn-supervisor.mjs and src/turn-run.mjs are free for T2.
- T2 worker agent: merged in (#1962). src/mcp-pool.ts, src/supervisor-client.ts, src/turn-supervisor.mjs and src/turn-run.mjs were not needed and are free.
- T2's files pass on when their pieces start: public/machine-worker.mjs, src/machine-turn.ts and test/machine-turn.test.ts to T3, src/running-turn.ts to T6. T4 replaces `runner.workerFor` in server.ts, lines #1962 wrote, so server.ts moves to T4 for its merge: T4 asks #1935 first.
- T3 state sync: its sync module and tests, src/sessions.ts, src/workspace.ts, src/routes/files.ts, src/land.ts.
- T4 pools per place: src/turn-line.ts, src/turn-limits.ts, src/pressure.ts, public/workers.js, test/turn-line.test.ts, test/worker-pool.test.ts, public/context-menu.js (the "Runs on" mark, Cara 2026-11-25).
- T5 join and self-test: public/settings-machines.js, public/machine-setup.js, public/machines.css, src/machine-lend.ts, the install files.
- T6 away and home: its away module and tests, src/worktree-sweep.ts. Merges last, after T3 and T4.
