# A turn launch module, cut out of runner.ts

`src/runner.ts` was the repo's most edited file, and 45% of its commits touched turn launch: what a
turn is started with (argv, env, hooks, settings, mcp.json, the pinned copies of the server files).
The November 2026 architecture check (#444) proposed moving that into `src/turn-launch.ts`, and Josh
picked "All five, sequenced" for its candidates on 2026-11-10. Cara decided the shape the same day,
on #444's card:

1. How far the cut goes: "Whole launch plan". One function turns a turn's facts into its launch plan
   as plain data; `startTurn` shrinks to choosing the facts, writing the files and spawning.
2. When the pinned copies are made: "Explicit call at start". `server.ts` calls one function that
   makes them. Importing the module, or runner.ts, writes nothing.
3. Contraption turns: "Share the pieces only". `src/contraption-turns.ts` takes env, tripwire config
   and the usage-limit text from the new module and keeps building its own argv and settings. The
   plan function does not build contraption launches.
4. A go before each land: "Yes, ask each land". This code runs every turn of every minion, and a wrong
   launch does not trip the deploy's rollback, so each of the three lands (#460) waits for a person's
   go whatever its self-review label, at a time someone can watch the first turns after the restart.

## Consequences

- The `Runner` class itself is not split: its queue, resume and stream code share too many Maps and
  store keys for this cut.
- `USAGE_LIMIT` lives in `src/turn-launch.ts` although it reads a turn's output, so that
  contraption turns need nothing from runner.ts (decision 3).
