# The Citadel kit

A Claude Code plugin that every turn of every scheme loads: minions and Taskmasters alike
(`src/runner.ts`, `KIT`). The runner copies this folder when the server starts and each turn loads
its own copy with `--plugin-dir`, so the kit only changes through `tools/land.sh` and
`tools/deploy.sh`, and a branch's edits never reach other schemes' turns.

- `skills/<name>/SKILL.md` and `agents/<name>.md` show up namespaced as `citadel:<name>`.
- `hooks/hooks.json` holds soft hooks; refer to scripts as `${CLAUDE_PLUGIN_ROOT}/hooks/...`.
  Hard refusals belong in the tripwire (`src/tripwire.ts`), not here. A hook meant for minions
  only checks `COORDINATOR_ROLE` (`thread`), since Taskmasters load the kit too. Today's hooks:
  - `job-check.ts` (Stop, minions only): refuses to end the turn while the session's own
    background job runs, at most twice per prompt.
  - `retro-log.ts`: one line per tripwire or guard.sh refusal, red test (a test runner the command
    runs, counted from that runner's own summary), failed push or refused stop in `$COORDINATOR_SHARED_DIR/retro-log/<date>/<session>.md`, for the retro skill. `tools/land.sh` adds `land conflict` lines (the rebase's conflicted files) to `<date>/land.md`.
  - `after-compact.sh` (SessionStart, compact): the branch, head and uncommitted files, and a
    reminder to re-read the record rather than the summary.
- A plugin can't carry `.claude/rules`: per-repo rules stay in each repo.
- A kit skill or agent names no repo's paths or commands. It reads them from the repo's CLAUDE.md
  "Project facts" section (check commands, glossary, decisions log, retro folder, high-risk files,
  how a change ships), and names other kit skills and agents as `citadel:<name>`. Every scheme's
  CLAUDE.md needs that section; Citadel's own is the example.

Shared Claude Code settings (compact window, Bash output cap, the merge asks) live in the runner's
per-turn `--settings` (`TURN_SETTINGS`), not here.
