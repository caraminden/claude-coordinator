# Build 7: worker machines, who writes what

build: #1935

shared: src/runner.ts src/turn-launch.ts src/machines.ts src/routes/machines.ts public/machine-agent.mjs server.ts src/db.ts src/db/machines.ts src/mcp.ts README.md tools/affected-map.txt test/size-budget.test.ts test/typecheck-baseline.json test/machine-fakes.ts docs/adr/0024-runner-seams.md docs/design-system/index.html

A feeder's own line is added by #1935 when its number is known, before the next piece starts. The plan, by piece:

- T1 running-turn seam: its new seam module and that module's test, src/supervisor-client.ts, src/turn-supervisor.mjs, src/turn-run.mjs. Merges first and alone; its lines in src/runner.ts pass to T2 after that.
- T2 worker agent: the machine-turn module and its tests, src/mcp-pool.ts; src/turn-supervisor.mjs and src/turn-run.mjs once T1 is in. Merges alone; T3, T4 and T5 start after it.
- T3 state sync: its sync module and tests, src/sessions.ts, src/workspace.ts, src/routes/files.ts, src/land.ts.
- T4 pools per place: src/turn-line.ts, src/turn-limits.ts, src/pressure.ts, public/workers.js, test/turn-line.test.ts, test/worker-pool.test.ts.
- T5 join and self-test: public/settings-machines.js, public/machine-setup.js, public/machines.css, src/machine-lend.ts, the install files.
- T6 away and home: its away module and tests, src/worktree-sweep.ts. Merges last, after T3 and T4.
