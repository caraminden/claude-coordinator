# The Citadel kit

A Claude Code plugin that every turn of every scheme loads: minions and Taskmasters alike
(`src/turn-launch.ts`, `KIT`). The server copies this folder when the server starts and each turn loads
its own copy with `--plugin-dir`, so the kit only changes through `tools/land.sh` and
`tools/deploy.sh`, and a branch's edits never reach other schemes' turns.

- `skills/<name>/SKILL.md` and `agents/<name>.md` show up namespaced as `citadel:<name>`.
- `hooks/hooks.json` holds soft hooks; refer to scripts as `${CLAUDE_PLUGIN_ROOT}/hooks/...`.
  Hard refusals belong in the tripwire (`src/tripwire.ts`), not here. A hook meant for minions
  only checks `COORDINATOR_ROLE` (`thread`), since Taskmasters load the kit too. Today's hooks:
  - `job-check.ts` (Stop, minions only): refuses to end the turn while the session's own
    background job runs, at most twice per prompt.
  - `answer-check.ts` (Stop, minions and Taskmasters; job-check.ts runs it on each stop it lets
    through): a trial that refuses nothing. It writes a
    `would refuse` retro-log line when a turn of five or more tool calls ends on a thin last
    message (under 200 characters, or ending in a colon), or when its final text proposes work
    and it made no ask_question, propose_plan or message to the Taskmaster or a minion. A turn a
    steer reached is skipped. The weekly process digest counts the lines to decide on refusal.
  - `retro-log.ts`: one line per tripwire or guard.sh refusal, red test (a test runner the command
    runs, counted from that runner's own summary), failed push, refused stop, would-refuse stop (answer-check.ts) or `process` line (a self-review's `Process:` line, also answer-check.ts) in `$COORDINATOR_SHARED_DIR/retro-log/<date>/<session>.md`, for the retro skill. `tools/land.sh` adds `land conflict` lines (the rebase's conflicted files) to `<date>/land.md`.
  - `test-first.ts` (PostToolUse on edits and Bash, never blocks): the first time a session edits
    a source file (not a test, doc, config or UI file) before any red test run, it adds one line
    saying to write the failing test first. Once per session; a red run first keeps it quiet.
  - `after-compact.sh` (SessionStart, compact): the branch, head and uncommitted files, and a
    reminder to re-read the record rather than the summary.
- `schedules/<slug>.md` are the standard audits' templates (#799): a scheduled run whose row names one
  gets that body, `{scheme}` filled in, plus the scheme's own notes (`src/schedules.ts`). Frontmatter
  holds the defaults, the stagger and `applies:`, which the setup plan checks before adding one.
  A template names no repo's paths, as skills don't.
- A plugin can't carry `.claude/rules`: per-repo rules stay in each repo.
- A kit skill or agent names no repo's paths or commands. It reads them from the repo's CLAUDE.md
  "Project facts" section (check commands, glossary, decisions log, retro folder, high-risk files,
  how a change ships), and names other kit skills and agents as `citadel:<name>`. Every scheme's
  CLAUDE.md needs that section; Citadel's own is the example.

Shared Claude Code settings (compact window, Bash output cap, the merge asks) live in the runner's
per-turn `--settings` (`TURN_SETTINGS`), not here.
