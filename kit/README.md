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
    background Bash job runs, at most twice per prompt. A running Grunt doesn't block it:
    `claude -p` holds the turn for the Grunt and wakes it with the result (#1031).
  - `answer-check.ts` (Stop, minions and Taskmasters; job-check.ts runs it on each stop it lets
    through): it sends back a proposal with no card, once per prompt (#1106); the other shapes only
    count. It writes a
    `would refuse` retro-log line when a turn of five or more tool calls ends on a thin last
    message (under 200 characters, or ending in a colon), or when its final text proposes work
    and it made no ask_question, propose_plan or message to the Taskmaster or a minion, or when
    it states live state (another minion's, CI's, a deploy's, or a card waiting on a person) without
    a call that reads it, such as live_facts, gh or git, or a report of it in its prompt (#1113). For
    minions only it also counts (#1154): a final reply with no status line or one Citadel would ignore,
    a first turn that ends with the title still its message's opening words (`CITADEL_MINION_TITLE`,
    which the runner sets), and a hand-off to ship in a session with no self-review in it. A turn a
    steer reached is skipped. The weekly process digest counts the lines to decide on refusal.
  - `retro-log.ts`: one line per tripwire or guard.sh refusal, red test (a test runner the command
    runs, counted from that runner's own summary), failed push, refused stop, would-refuse stop (answer-check.ts) or `process` line (a self-review's `Process:` line, also answer-check.ts) in `$COORDINATOR_SHARED_DIR/retro-log/<date>/<session>.md`, for the retro skill. `tools/land.sh` adds `land conflict` lines (the rebase's conflicted files) and `smoke` lines (a land its quick checks refused before the line) to `<date>/land.md`.
  - `test-first.ts` (PostToolUse on edits and Bash, never blocks): the first time a session edits
    a source file (not a test, doc, config or UI file) before any red test run, it adds one line
    saying to write the failing test first. Once per session; a red run first keeps it quiet.
  - `flail-brake.ts` (PostToolUse on edits and Bash, never blocks): when the same test command goes
    red three times in a row with no Edit, Write, MultiEdit or NotebookEdit between, it adds one
    line pointing at `citadel:diagnosing-bugs`. Once per streak; a green test run, another test command or an
    edit resets it; other Bash calls don't. A file changed from Bash (`sed -i`) is invisible to it.
  - `batch-nudge.ts` (a one-week trial from 2026-11-20, #1278; runs inside `flail-brake.ts`'s process, which is also
    registered for Read, Grep and Glob; never blocks): after a minion's third single read-only call in a row (Read,
    Grep, Glob, or a Bash that only reads) it adds one line saying to send independent lookups in one message. Only
    minions with an even number (the other half is the control); Grunts and Taskmasters never. A call sent with
    others in one message, an edit or a writing Bash ends the run. The trial's readout decides whether it stays.
  - `run.ts` (PostToolUse and PostToolUseFailure): test-first, flail-brake (with batch-nudge) and retro-log's
    after-call lines in one node process per call (#1296), each as it ran alone; one that throws says nothing.
  - `big-read.ts` (PreToolUse on Read and Bash, every Citadel turn, Grunts included; not in hooks.json: it runs inside
    the turn's one PreToolUse process, `src/hook-run.ts`, #1296): sends back a
    whole read of a big file (over 600 lines or 25k chars): a Read with no `limit`, or a plain
    `cat path` / `sed -n 'N,Mp' path` whose output isn't piped or redirected. The reason names the
    size and the cheaper way (grep -n, then offset/limit or a small sed range). `allow_large: true`
    on Read, or `# allow_large` in the command, gets past it; anything it can't read plainly goes through.
  - `grunt-model.ts` (PreToolUse on Agent, every session, Grunts included): sends back an Agent
    call whose Grunt would get no chosen model or effort (neither the call nor the agent's
    definition sets it, or the definition says `inherit`). The reason quotes the job table in
    `skills/subagents/SKILL.md`, the one place its rows live. Built-ins need both on the call; forks
    and agents it can't read (another plugin's) go through.
    A call it lets through without `run_in_background` gets `false`, so Grunts run in the
    foreground unless a call asks otherwise (#1031).
  - `after-compact.sh` (SessionStart, compact): the branch, head and uncommitted files, and a
    reminder to re-read the record rather than the summary.
- `schedules/<slug>.md` are the standard audits' templates (#799): a scheduled run whose row names one
  gets that body, `{scheme}` filled in, plus the scheme's own notes (`src/schedules.ts`). Frontmatter
  holds the defaults, the stagger and `applies:`, which the setup plan checks before adding one.
  A template names no repo's paths, as skills don't.
- `android-shell/` is Citadel's shared Android shell (#1138), a Capacitor plugin every contraption's Android app
  pins as a packed copy: Citadel links, the offline page, the update prompt and push. Not a skill: the
  `citadel:android-app` skill's "Shared shell" section and its `scripts/android-shell.mjs` pin it.
- A plugin can't carry `.claude/rules`: per-repo rules stay in each repo.
- A kit skill or agent names no repo's paths or commands. It reads them from the repo's CLAUDE.md
  "Project facts" section (check commands, glossary, decisions log, retro folder, high-risk files,
  how a change ships), and names other kit skills and agents as `citadel:<name>`. Every scheme's
  CLAUDE.md needs that section; Citadel's own is the example.

Shared Claude Code settings (compact window, Bash output cap, the merge asks) live in the runner's
per-turn `--settings` (`TURN_SETTINGS`), not here.
