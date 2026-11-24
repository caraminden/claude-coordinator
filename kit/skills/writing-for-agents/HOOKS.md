# The checks we already run

Every hook and in-tool check Citadel runs, for the first step of `SKILL.md`: before writing a rule, find the
shape below that could hold it, and extend that file rather than starting a new hook. `test/kit-hooks.test.ts`
fails when a hook file is missing from this list. The `src/`, `tools/` and `kit/` paths are in Citadel's repo: from another
scheme, ask your Taskmaster to relay a request to extend one to Citadel's; your repo's own hooks are the last table.

**Modes**, cheapest for the agent first: *counts* (a `would refuse` line in the retro log, which the weekly process
digest reads; nothing reaches the agent), *reminds* (adds a line to the agent's context, never blocks), *sends back
once* (the call or the stop is refused once, then goes through: one extra model round trip when it fires), *refuses*
(always blocks; reserved for accidents nobody should be able to make).

**Cost**: every hook is a Node process, about 150 to 350 ms each time it runs (measured on perigee, 2026-11-19), on
every call its matcher catches. A Stop hook runs once per stop; a PreToolUse hook on `Bash` runs on every command.
Prefer a narrow matcher and the end of a turn over every call.

## Kit hooks (`kit/hooks/`, `hooks.json`): every scheme, every session

| Hook | When | What it does | Mode |
| --- | --- | --- | --- |
| `job-check.ts` | Stop, minions | Turn ends while its own background Bash job runs | sends back, twice at most per prompt |
| `answer-check.ts` | Stop (run by job-check.ts) | Proposal with no card | sends back once per prompt |
| | | Thin last message, `<placeholder>` in a command, live-state claim with no read; minions: no or unreadable status line, title still the opening words, ship with no self-review | counts |
| `grunt-model.ts` | PreToolUse on Agent | A Grunt's model or effort left to chance | sends back |
| `big-read.ts` | PreToolUse on Read, Bash (runs inside the turn's `hook-run.ts`; not in hooks.json) | A whole read of a big file | sends back |
| `heavy-nudge.ts` | PreToolUse on Bash (runs inside the turn's `hook-run.ts`; not in hooks.json) | A whole-workspace cargo build/test/check/clippy, a release or cross-target build, a full `npm test`: adds the citadel-heavy line (#1577) | adds context |
| `test-first.ts` | PostToolUse on edits, Bash (runs inside `run.ts`) | A source edit before any red test run | reminds, once per session |
| `any-nudge.ts` | PostToolUse on Write, Edit, MultiEdit to a `.ts`/`.tsx` file (runs inside `run.ts`) | An edit that raises the file's count of explicit `any` and `@ts-ignore`-style comments (#1789) | adds context, each time |
| `flail-brake.ts` | PostToolUse on edits, Bash (runs inside `run.ts`) | Same test red three times with no edit | reminds, once per streak |
| `batch-nudge.ts` | PostToolUse on Read, Grep, Glob, Bash, edits (runs inside flail-brake.ts) | Third single read-only call in a row, even-numbered minions only; a one-week trial (#1278) | reminds, once per run |
| `retro-log.ts` | PostToolUse on Bash (inside `run.ts`), Stop, SubagentStop | Writes the retro log the other modes count into | counts |
| `run.ts` | PostToolUse on Bash, file tools, Read, Grep, Glob | Runs test-first, any-nudge, flail-brake (with batch-nudge) and retro-log in one node process, in hooks.json's old order (#1296) | as each check |
| `hook-input.ts` | none: not a hook | The types of the hook input and transcript lines the hooks read (#1799) | none |
| `after-compact.sh` | SessionStart after a compaction | Puts back the branch, head and what to re-read | reminds |

## Citadel's turn hooks (`src/`, installed per turn by `src/turn-launch.ts`): every scheme

| Hook | When | What it does | Mode |
| --- | --- | --- | --- |
| `hook-run.ts` | PreToolUse on what its checks read | Runs the side guard, tripwire, wording, scheme-refs and the kit's big-read and heavy-nudge in one node process, each on its own matcher, in that order (#1296) | as each check; a hard check's crash blocks |
| `tripwire.ts` | PreToolUse on Bash, file tools, Skill (inside `hook-run.ts`) | Writes outside the turn's folders, live data, destructive git, kills by name | refuses (a few go to a person's card) |
| `link-check.ts` | Stop, minions and Taskmasters | A file link that won't open; a card mentioned without its link (`card-links.ts`); a choice asked in prose with no card; a choices page no card opens | sends back once |
| `wording.ts` | PreToolUse on messages, cards, shared-folder writes; and in link-check | A retired or misused word ("fold", "merge" for main) | sends back once per sentence |
| `scheme-refs.ts` | PreToolUse on messages and cards; and in link-check | A bare #N that likely means another scheme's minion | sends back once per number |
| `side-guard.ts` | PreToolUse, side-question forks only | Any write | refuses |

## Checks inside tools and the server

| Check | Where | What it does |
| --- | --- | --- |
| Brief lint | `src/brief-lint.ts`, on create_ticket | Warns when a brief has no person's quoted words or no "Done when" |
| Status line | `src/status-trailer.ts`, at a turn's end | Reads the reply's status line; clips an over-long note, reads `null` as state null |
| Land preflight | `src/routes/tickets.ts`, on hand_off_land | Refuses a ship land.sh would refuse at once |

## A repo's own

| Hook | Where | What it does |
| --- | --- | --- |
| Push guard | `tools/guard.sh` (`.claude/settings.json`, PreToolUse on Bash) and `.githooks/pre-push` | Refuses a push to main and a plain force push |

Other schemes add theirs in their own `.claude/settings.json` and `.githooks/` (the `citadel:scheme-setup` push guard
is one); read the repo's before adding.
