# The Citadel kit

A Claude Code plugin that every turn of every scheme loads: minions and Taskmasters alike
(`src/runner.ts`, `KIT`). The runner copies this folder when the server starts and each turn loads
its own copy with `--plugin-dir`, so the kit only changes through `tools/land.sh` and
`tools/deploy.sh`, and a branch's edits never reach other schemes' turns.

- `skills/<name>/SKILL.md` and `agents/<name>.md` show up namespaced as `citadel:<name>`.
- `hooks/hooks.json` holds soft hooks; refer to scripts as `${CLAUDE_PLUGIN_ROOT}/hooks/...`.
  Hard refusals belong in the tripwire (`src/tripwire.ts`), not here.
- A plugin can't carry `.claude/rules`: per-repo rules stay in each repo, and per-scheme facts
  (check commands, glossary, retro folder) in its CLAUDE.md.

Shared Claude Code settings (compact window, Bash output cap, the merge asks) live in the runner's
per-turn `--settings` (`TURN_SETTINGS`), not here.
